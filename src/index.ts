import { HttpError, json, readBody, readFields } from './http';
import {
  barkResponse,
  matchBarkRoute,
  formatBarkMessage,
  readBarkFields,
} from './bark';
import { sliceEntities, type FormattedMessage } from './message';

const MAX_TEXT_LENGTH = 16_000;
const MESSAGE_LENGTH = 4096;

type RequestStats = {
  route: 'health' | 'send_message' | 'get_me' | 'bark' | 'unknown';
  sent: number;
};

async function authenticate(
  request: Request,
  url: URL,
  env: Env,
  barkKey?: unknown,
) {
  const authorization = request.headers.get('authorization');
  let key = '';
  if (authorization !== null) {
    key = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] ?? '';
  } else if (env.ALLOW_QUERY_AUTH === 'true' && typeof barkKey === 'string') {
    key = barkKey;
  } else if (
    env.ALLOW_QUERY_AUTH === 'true' &&
    request.method === 'GET' &&
    url.pathname === '/sendMessage' &&
    url.searchParams.getAll('key').length === 1
  ) {
    key = url.searchParams.get('key') ?? '';
  }
  if (key.length > 512) throw new HttpError(401, 'Invalid access key');
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(key)),
    crypto.subtle.digest('SHA-256', encoder.encode(env.NOTIFY_KEY)),
  ]);
  if (!crypto.subtle.timingSafeEqual(actual, expected)) {
    throw new HttpError(401, 'Invalid access key');
  }
}

function validateConfig(env: Env) {
  if (
    !env.NOTIFY_KEY ||
    env.NOTIFY_KEY.length < 32 ||
    env.NOTIFY_KEY.length > 512 ||
    /\s/.test(env.NOTIFY_KEY) ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN ?? '') ||
    !/^-?\d+$/.test(env.CHAT_ID ?? '')
  ) {
    throw new HttpError(503, 'Notification service is not configured');
  }
}

async function checkRequestLimit(env: Env) {
  const { success } = await env.SEND_LIMITER.limit({ key: 'requests' });
  if (!success)
    return json({ ok: false, error: 'Request rate limit exceeded' }, 429, {
      'Retry-After': '60',
    });
}

function getText(fields: Record<string, unknown>) {
  if (fields.parse_mode !== undefined || fields.entities !== undefined) {
    throw new HttpError(400, 'Only plain text is supported');
  }
  if (fields.title !== undefined && typeof fields.title !== 'string') {
    throw new HttpError(400, 'title must be a string');
  }
  const content = fields.text ?? fields.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new HttpError(400, 'text must be a non-empty string');
  }
  const text = fields.title ? `${fields.title}\n${content}` : content;
  if (text.length > MAX_TEXT_LENGTH) {
    throw new HttpError(413, 'Text exceeds 16000 UTF-16 units');
  }
  return text;
}

function splitText(text: string) {
  const parts: string[] = [];
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let current = '';
  for (const { segment } of segments.segment(text)) {
    if (segment.length > MESSAGE_LENGTH) {
      throw new HttpError(
        413,
        'A single text segment exceeds the message limit',
      );
    }
    if (current.length + segment.length > MESSAGE_LENGTH) {
      parts.push(current);
      current = '';
    }
    current += segment;
  }
  if (current) parts.push(current);
  return parts;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function callTelegram(
  method: 'getMe' | 'sendMessage',
  body: object,
  env: Env,
) {
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    // A failed connection may have delivered the message; automatic retries can duplicate it.
    throw new HttpError(
      502,
      'Telegram request failed; delivery status is unknown',
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new HttpError(502, 'Unexpected Telegram redirect');
  }
  let data: unknown;
  try {
    data = JSON.parse(
      await readBody(
        new Request('https://response.invalid', {
          method: 'POST',
          body: response.body,
        }),
      ),
    );
  } catch {
    throw new HttpError(
      502,
      'Invalid Telegram response; delivery status is unknown',
    );
  }
  if (!isObject(data) || typeof data.ok !== 'boolean') {
    throw new HttpError(
      502,
      'Invalid Telegram response; delivery status is unknown',
    );
  }
  if (!response.ok || !data.ok) {
    const retryAfter = isObject(data.parameters)
      ? data.parameters.retry_after
      : undefined;
    return {
      error: true as const,
      status: response.status === 429 || data.error_code === 429 ? 429 : 502,
      retryAfter:
        typeof retryAfter === 'number' && retryAfter > 0
          ? Math.ceil(retryAfter)
          : undefined,
    };
  }
  return { error: false as const, result: data.result };
}

async function sendMessages(
  fields: Record<string, unknown>,
  env: Env,
  stats: RequestStats,
  formatted?: FormattedMessage,
) {
  if (fields.chat_id !== undefined && String(fields.chat_id) !== env.CHAT_ID) {
    throw new HttpError(400, 'chat_id differs from the configured recipient');
  }
  const text = getText(
    formatted ? { ...fields, title: undefined, text: formatted.text } : fields,
  );
  const thread = fields.message_thread_id;
  if (
    thread !== undefined &&
    (!Number.isSafeInteger(Number(thread)) || Number(thread) < 1)
  ) {
    throw new HttpError(400, 'message_thread_id must be a positive integer');
  }
  const silent = fields.disable_notification;
  if (
    silent !== undefined &&
    ![true, false, 'true', 'false'].includes(silent as boolean | string)
  ) {
    throw new HttpError(400, 'disable_notification must be a boolean');
  }
  let sent = 0;
  let offset = 0;
  for (const part of splitText(text)) {
    const { success } = await env.SEND_LIMITER.limit({ key: 'messages' });
    if (!success) {
      return json(
        { ok: false, error: 'Message rate limit exceeded', sent },
        429,
        { 'Retry-After': '60' },
      );
    }
    let result: Awaited<ReturnType<typeof callTelegram>>;
    try {
      result = await callTelegram(
        'sendMessage',
        {
          chat_id: env.CHAT_ID,
          text: part,
          ...(formatted
            ? {
                entities: sliceEntities(
                  formatted.entities,
                  offset,
                  part.length,
                ),
                link_preview_options: { is_disabled: true },
              }
            : {}),
          disable_notification: silent === true || silent === 'true',
          ...(thread !== undefined
            ? { message_thread_id: Number(thread) }
            : {}),
        },
        env,
      );
    } catch (error) {
      if (error instanceof HttpError)
        return json({ ok: false, error: error.message, sent }, error.status);
      throw error;
    }
    if (result.error) {
      return json(
        { ok: false, error: 'Telegram rejected the message', sent },
        result.status,
        result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {},
      );
    }
    sent++;
    stats.sent = sent;
    offset += part.length;
  }
  return json({ ok: true, sent });
}

async function handleRequest(request: Request, env: Env, stats: RequestStats) {
  const url = new URL(request.url);
  let bark = false;
  try {
    if (url.pathname === '/health' && request.method === 'GET') {
      stats.route = 'health';
      return json({ ok: true, service: 'telegram-notify-worker' });
    }
    const barkRoute = matchBarkRoute(url.pathname);
    if (barkRoute) {
      bark = true;
      stats.route = 'bark';
      if (!barkRoute.methods.includes(request.method)) {
        return barkResponse(
          json({ ok: false, error: 'Method not allowed' }, 405, {
            Allow: barkRoute.methods.join(', '),
          }),
        );
      }
      validateConfig(env);
      const fields = await readBarkFields(request, url, barkRoute.parts);
      await authenticate(request, url, env, fields.device_key);
      const limited = await checkRequestLimit(env);
      return await barkResponse(
        limited ??
          (await sendMessages(fields, env, stats, formatBarkMessage(fields))),
      );
    }
    if (
      !['/sendMessage', '/api/sendMessage', '/api/getMe'].includes(url.pathname)
    ) {
      throw new HttpError(404, 'Route not found');
    }
    stats.route = url.pathname === '/api/getMe' ? 'get_me' : 'send_message';
    const methods =
      url.pathname === '/api/sendMessage' ? ['POST'] : ['GET', 'POST'];
    if (!methods.includes(request.method)) {
      return json({ ok: false, error: 'Method not allowed' }, 405, {
        Allow: methods.join(', '),
      });
    }
    validateConfig(env);
    await authenticate(request, url, env);
    const limited = await checkRequestLimit(env);
    if (limited) return limited;
    if (url.pathname === '/api/getMe') {
      const result = await callTelegram('getMe', {}, env);
      if (result.error)
        return json(
          { ok: false, error: 'Telegram request rejected' },
          result.status,
          result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {},
        );
      return json({ ok: true, result: result.result });
    }
    return await sendMessages(await readFields(request, url), env, stats);
  } catch (error) {
    if (error instanceof HttpError) {
      const response = json({ ok: false, error: error.message }, error.status);
      return bark ? barkResponse(response) : response;
    }
    const response = json({ ok: false, error: 'Internal server error' }, 500);
    return bark ? barkResponse(response) : response;
  }
}

export default {
  async fetch(request, env) {
    const started = performance.now();
    const stats: RequestStats = { route: 'unknown', sent: 0 };
    const response = await handleRequest(request, env, stats);
    console.log({
      event: 'request_completed',
      route: stats.route,
      method: [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
      ].includes(request.method)
        ? request.method
        : 'OTHER',
      status: response.status,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      sent: stats.sent,
    });
    return response;
  },
} satisfies ExportedHandler<Env>;
