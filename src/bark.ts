import { HttpError, readFields, readParameters } from './http';

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

export function normalizeBarkFields(fields: Record<string, unknown>) {
  if (fields.device_keys !== undefined)
    throw new HttpError(400, 'Batch recipients are not supported');
  if (typeof fields.body !== 'string' || !fields.body.trim()) {
    throw new HttpError(400, 'body must be a non-empty string');
  }
  if (fields.subtitle !== undefined && typeof fields.subtitle !== 'string') {
    throw new HttpError(400, 'subtitle must be a string');
  }
  if (fields.url !== undefined) {
    try {
      if (
        typeof fields.url !== 'string' ||
        !['https:', 'http:'].includes(new URL(fields.url).protocol)
      ) {
        throw new Error('Invalid URL');
      }
    } catch {
      throw new HttpError(400, 'url must be an HTTP or HTTPS URL');
    }
  }
  return {
    ...fields,
    text: [fields.subtitle, fields.body, fields.url]
      .filter((part) => part !== undefined && part !== '')
      .join('\n'),
  };
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
