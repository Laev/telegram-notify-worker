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

export async function readFields(request: Request, url: URL) {
  if (request.method === 'GET') {
    return Object.fromEntries(url.searchParams) as Record<string, unknown>;
  }
  const type = request.headers.get('content-type')?.split(';')[0].trim();
  if (
    type !== 'application/json' &&
    type !== 'application/x-www-form-urlencoded'
  ) {
    throw new HttpError(415, 'Use JSON or form-urlencoded');
  }
  const body = await readBody(request);
  if (type === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(body));
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
