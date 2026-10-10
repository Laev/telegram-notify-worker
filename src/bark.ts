import { HttpError, readFields, readParameters } from './http';
import type { FormattedMessage, MessageEntity } from './message';

export function matchBarkRoute(pathname: string) {
  if (pathname === '/push') return { parts: [] as string[], methods: ['POST'] };
  const parts = pathname.replace(/\/$/, '').split('/').slice(1);
  if (!parts.length || parts.length > 4 || parts.some((part) => !part))
    return null;
  let first = parts[0];
  try {
    first = decodeURIComponent(first);
  } catch {
    // Report malformed encoding while reading the request, using the Bark response format.
  }
  if (
    ['api', 'file', 'health', 'sendMessage', 'push'].includes(first) ||
    /^bot\d+:/.test(first)
  ) {
    return null;
  }
  return { parts, methods: ['GET', 'POST'] };
}

export async function readBarkFields(
  request: Request,
  url: URL,
  parts: string[],
) {
  const query = readParameters(url.searchParams, ['device_key']);
  const body =
    request.method === 'POST'
      ? await readFields(request, url, {
          uniqueFields: ['device_key'],
          allowEmpty: true,
          multipart: true,
        })
      : {};
  const isJson =
    request.headers.get('content-type')?.split(';')[0].trim() ===
    'application/json';
  const fields = isJson ? { ...body, ...query } : { ...query, ...body };
  if (parts.length) {
    let decoded: string[];
    try {
      decoded = parts.map((part, index) =>
        decodeURIComponent(index === 0 ? part : part.replace(/\+/g, ' ')),
      );
    } catch {
      throw new HttpError(400, 'Invalid URL encoding');
    }
    fields.device_key = decoded[0];
    if (parts.length > 1) fields.body = decoded.at(-1);
    if (parts.length > 2) fields.title = decoded[1];
    if (parts.length > 3) fields.subtitle = decoded[2];
  }
  return fields;
}

function httpUrl(value: unknown, field: string) {
  if (typeof value === 'string' && value.length <= 2048) {
    try {
      if (['https:', 'http:'].includes(new URL(value).protocol)) return value;
    } catch {
      // Use a stable field error rather than exposing URL parser details.
    }
  }
  throw new HttpError(
    400,
    `${field} must be an HTTP or HTTPS URL of at most 2048 characters`,
  );
}

export function formatBarkMessage(
  fields: Record<string, unknown>,
): FormattedMessage {
  if (fields.device_keys !== undefined)
    throw new HttpError(400, 'Batch recipients are not supported');
  if (typeof fields.body !== 'string' || !fields.body.trim()) {
    throw new HttpError(400, 'body must be a non-empty string');
  }
  if (fields.title !== undefined && typeof fields.title !== 'string') {
    throw new HttpError(400, 'title must be a string');
  }
  if (fields.subtitle !== undefined && typeof fields.subtitle !== 'string') {
    throw new HttpError(400, 'subtitle must be a string');
  }
  if (
    fields.group !== undefined &&
    (typeof fields.group !== 'string' || fields.group.length > 128)
  ) {
    throw new HttpError(
      400,
      'group must be a string of at most 128 UTF-16 units',
    );
  }
  const url = fields.url !== undefined ? httpUrl(fields.url, 'url') : undefined;
  let icon = '';
  let iconUrl: string | undefined;
  if (fields.icon !== undefined) {
    if (typeof fields.icon !== 'string')
      throw new HttpError(400, 'icon must be a string');
    if (/^[a-z][a-z0-9+.-]*:/i.test(fields.icon)) {
      iconUrl = httpUrl(fields.icon, 'icon');
      icon = '🖼';
    } else {
      if (fields.icon.length > 32 || /[\r\n]/.test(fields.icon)) {
        throw new HttpError(
          400,
          'icon must be an emoji or a short label of at most 32 UTF-16 units',
        );
      }
      icon = fields.icon.trim();
    }
  }
  const message: FormattedMessage = { text: '', entities: [] };
  function append(text: string, type?: MessageEntity['type'], link?: string) {
    if (type && text.length)
      message.entities.push({
        type,
        offset: message.text.length,
        length: text.length,
        ...(link ? { url: link } : {}),
      });
    message.text += text;
  }
  if (icon) {
    append(icon, iconUrl ? 'text_link' : undefined, iconUrl);
    append(' ');
  }
  if (fields.title) {
    append(fields.title, 'bold');
    if (fields.subtitle) append('\n');
  }
  if (fields.subtitle) {
    append(fields.subtitle);
  }
  if (fields.title || fields.subtitle) append('\n\n');
  append(fields.body);
  if (fields.group || url) append('\n\n');
  if (fields.group) {
    append('🏷 ');
    append(fields.group, 'code');
    if (url) append('\n');
  }
  if (url) {
    append('🔗 ');
    append(new URL(url).host, 'text_link', url);
  }
  return message;
}

export async function barkResponse(response: Response) {
  const result: { ok: boolean; error?: string; sent?: number } =
    await response.json();
  return Response.json(
    {
      code: response.status,
      message: result.ok ? 'success' : (result.error ?? 'Request failed'),
      timestamp: Math.floor(Date.now() / 1000),
      ...(result.sent !== undefined ? { sent: result.sent } : {}),
    },
    { status: response.status, headers: response.headers },
  );
}
