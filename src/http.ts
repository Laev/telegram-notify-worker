export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export async function readBody(request: Request, limit = 64 * 1024) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Request body is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid request body');
  } finally {
    reader.releaseLock();
  }
}

export function readParameters(
  params: URLSearchParams,
  uniqueFields: string[] = [],
) {
  for (const field of uniqueFields) {
    if (params.getAll(field).length > 1) {
      throw new HttpError(400, 'Duplicate credential field');
    }
  }
  return Object.fromEntries(params) as Record<string, unknown>;
}

export async function readFields(
  request: Request,
  url: URL,
  options: {
    uniqueFields?: string[];
    allowEmpty?: boolean;
    multipart?: boolean;
  } = {},
) {
  const uniqueFields = options.uniqueFields ?? [];
  if (request.method === 'GET') {
    return readParameters(url.searchParams, uniqueFields);
  }
  const contentType = request.headers.get('content-type') ?? '';
  const type = contentType.split(';')[0].trim();
  const supported =
    type === 'application/json' ||
    type === 'application/x-www-form-urlencoded' ||
    (options.multipart && type === 'multipart/form-data');
  const formatError = options.multipart
    ? 'Use JSON, form-urlencoded or multipart fields'
    : 'Use JSON or form-urlencoded';
  if (!supported && !options.allowEmpty) {
    throw new HttpError(415, formatError);
  }
  const body = await readBody(request);
  if (!body && options.allowEmpty) return {};
  if (!supported) throw new HttpError(415, formatError);
  if (type === 'application/x-www-form-urlencoded') {
    return readParameters(new URLSearchParams(body), uniqueFields);
  }
  if (type === 'multipart/form-data') {
    let form: FormData;
    try {
      form = await new Response(body, {
        headers: { 'Content-Type': contentType },
      }).formData();
    } catch {
      throw new HttpError(400, 'Invalid multipart form');
    }
    const params = new URLSearchParams();
    for (const [name, value] of form) {
      if (typeof value !== 'string')
        throw new HttpError(400, 'File uploads are not supported');
      params.append(name, value);
    }
    return readParameters(params, uniqueFields);
  }
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected an object');
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON object');
  }
}
