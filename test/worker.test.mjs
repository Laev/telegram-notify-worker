import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MockAgent, fetch as upstreamFetch } from 'undici';

const token = '123456:fixture_token';
const key = 'test-key-with-at-least-thirty-two-characters';
const chat = '-100123456';
const script = await readFile(
  new URL('../dist/worker.js', import.meta.url),
  'utf8',
);
const instances = [];

function setup(overrides = {}) {
  const mock = new MockAgent();
  mock.disableNetConnect();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: '2026-10-10',
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        BOT_TOKEN: token,
        CHAT_ID: chat,
        NOTIFY_KEY: key,
        ALLOW_QUERY_AUTH: 'true',
        ...overrides,
      },
      ratelimits: {
        SEND_LIMITER: {
          namespace_id: '22022',
          simple: { limit: 20, period: 60 },
        },
      },
      outboundService: async (request) =>
        upstreamFetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
          duplex: 'half',
          dispatcher: mock,
        }),
    }),
  );
  instances.push(mf);
  const upstream = mock.get('https://api.telegram.org');
  return { mf, mock, upstream };
}

function success(upstream, inspect = () => {}, method = 'sendMessage') {
  upstream
    .intercept({ path: `/bot${token}/${method}`, method: 'POST' })
    .reply((options) => {
      const body = JSON.parse(options.body);
      inspect(body, options);
      return {
        statusCode: 200,
        data: JSON.stringify({ ok: true, result: { message_id: 1 } }),
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
}

function notify(mf, body, headers = {}) {
  return mf.dispatchFetch('https://notify.example/sendMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((mf) => mf.dispose()));
});

test('health works without secrets; sending fails closed', async () => {
  const { mf } = setup({ NOTIFY_KEY: '' });
  assert.equal(
    (await mf.dispatchFetch('https://notify.example/health')).status,
    200,
  );
  assert.equal((await notify(mf, { text: 'hello' })).status, 503);
});

test('missing and wrong credentials never reach Telegram', async () => {
  const { mf } = setup();
  for (const suffix of ['', '?key=wrong']) {
    const response = await mf.dispatchFetch(
      `https://notify.example/sendMessage${suffix}`,
    );
    assert.equal(response.status, 401);
  }
  assert.equal(
    (await notify(mf, { text: 'hello' }, { authorization: 'Bearer wrong' }))
      .status,
    401,
  );
});

test('GET notifications preserve Unicode and punctuation; credentials stay local', async () => {
  const { mf, upstream, mock } = setup();
  const text = 'Notification\n中文 & + ? 😀';
  success(upstream, (body, options) => {
    assert.equal(body.chat_id, chat);
    assert.equal(body.text, text);
    assert.equal(options.body.includes(key), false);
    assert.equal(JSON.stringify(options.headers).includes(key), false);
  });
  const params = new URLSearchParams({ key, text });
  const response = await mf.dispatchFetch(
    `https://notify.example/sendMessage?${params}`,
  );
  assert.deepEqual(await response.json(), { ok: true, sent: 1 });
  mock.assertNoPendingInterceptors();
});

test('query authentication can be disabled', async () => {
  const { mf } = setup({ ALLOW_QUERY_AUTH: 'false' });
  assert.equal(
    (
      await mf.dispatchFetch(
        `https://notify.example/sendMessage?key=${key}&text=hello`,
      )
    ).status,
    401,
  );
});

test('invalid header cannot fall back to a valid query key', async () => {
  const { mf } = setup();
  assert.equal(
    (
      await mf.dispatchFetch(
        `https://notify.example/sendMessage?key=${key}&text=hello`,
        {
          headers: { authorization: 'Bearer wrong' },
        },
      )
    ).status,
    401,
  );
});

test('duplicate query keys are rejected', async () => {
  const { mf } = setup();
  assert.equal(
    (
      await mf.dispatchFetch(
        `https://notify.example/sendMessage?key=${key}&key=${key}&text=hello`,
      )
    ).status,
    401,
  );
});

test('Bearer POST supports title, topic and silent notifications', async () => {
  const { mf, upstream } = setup();
  success(upstream, (body) => {
    assert.equal(body.text, 'Title\nMessage');
    assert.equal(body.message_thread_id, 42);
    assert.equal(body.disable_notification, true);
  });
  assert.equal(
    (
      await notify(mf, {
        title: 'Title',
        content: 'Message',
        message_thread_id: 42,
        disable_notification: true,
      })
    ).status,
    200,
  );
});

test('form-urlencoded POST is supported', async () => {
  const { mf, upstream } = setup();
  success(upstream, (body) => assert.equal(body.text, 'form + 中文'));
  const response = await mf.dispatchFetch(
    'https://notify.example/sendMessage',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ text: 'form + 中文' }).toString(),
    },
  );
  assert.equal(response.status, 200);
});

test('a caller cannot select a different recipient', async () => {
  const { mf } = setup();
  assert.equal(
    (await notify(mf, { text: 'hello', chat_id: '999' })).status,
    400,
  );
});

test('only two upstream methods are exposed, and API routes require Bearer', async () => {
  const { mf, upstream } = setup();
  for (const path of [
    '/api/setWebhook',
    `/bot${token}/sendMessage`,
    '/file/bot123/file',
    '/api/sendMessage?key=' + key,
  ]) {
    assert.equal(
      (await mf.dispatchFetch(`https://notify.example${path}`)).status,
      path.startsWith('/api/sendMessage') ? 405 : 404,
    );
  }
  assert.equal(
    (await mf.dispatchFetch(`https://notify.example/api/getMe?key=${key}`))
      .status,
    401,
  );
  success(upstream, (body) => assert.deepEqual(body, {}), 'getMe');
  assert.equal(
    (
      await mf.dispatchFetch('https://notify.example/api/getMe', {
        headers: { authorization: `Bearer ${key}` },
      })
    ).status,
    200,
  );
  success(upstream);
  assert.equal(
    (
      await mf.dispatchFetch('https://notify.example/api/sendMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: '{"text":"hello"}',
      })
    ).status,
    200,
  );
});

test('malformed JSON, unsupported bodies and invalid fields are rejected', async () => {
  const { mf } = setup();
  for (const body of ['{', 'null', '[]']) {
    assert.equal(
      (
        await mf.dispatchFetch('https://notify.example/sendMessage', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await notify(mf, { text: 'hello' }, { 'content-type': 'text/plain' }))
      .status,
    415,
  );
  for (const body of [
    { text: '' },
    { text: 1 },
    { text: 'hello', parse_mode: 'HTML' },
    { text: 'hi', title: {} },
    { text: 'hi', message_thread_id: 0 },
    { text: 'hi', disable_notification: 'yes' },
  ]) {
    assert.equal((await notify(mf, body)).status, 400);
  }
});

test('text and body limits are enforced', async () => {
  const { mf } = setup();
  assert.equal((await notify(mf, { text: 'a'.repeat(16001) })).status, 413);
  assert.equal((await notify(mf, { text: 'a'.repeat(70000) })).status, 413);
});

test('long text splits without changing content or breaking emoji', async () => {
  const { mf, upstream } = setup();
  const text = 'a'.repeat(4095) + '😀' + '中文'.repeat(3000);
  const sent = [];
  for (let i = 0; i < 3; i++) success(upstream, (body) => sent.push(body.text));
  const response = await notify(mf, { text });
  assert.deepEqual(await response.json(), { ok: true, sent: 3 });
  assert.equal(sent.join(''), text);
  assert.ok(sent.every((part) => part.length <= 4096 && part.isWellFormed()));
});

test('compound emoji stays together at a message boundary', async () => {
  for (const emoji of ['👨‍👩‍👧‍👦', '👍🏽', '🇨🇳']) {
    const { mf, upstream } = setup();
    const text = 'a'.repeat(4094) + emoji;
    const sent = [];
    for (let i = 0; i < 2; i++)
      success(upstream, (body) => sent.push(body.text));
    assert.equal((await notify(mf, { text })).status, 200);
    assert.deepEqual(sent, ['a'.repeat(4094), emoji]);
  }
});

test('an oversized grapheme is rejected before any part is sent', async () => {
  const { mf } = setup();
  const text = 'first message\n' + 'a' + '\u0301'.repeat(4096);
  const response = await notify(mf, { text });
  assert.equal(response.status, 413);
});

test('upstream redirects are rejected instead of forwarding secrets', async () => {
  const { mf, upstream, mock } = setup();
  upstream
    .intercept({ path: `/bot${token}/sendMessage`, method: 'POST' })
    .reply(302, '', { headers: { location: 'https://another.example/' } });
  const response = await notify(mf, { text: 'hello' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).sent, 0);
  mock.assertNoPendingInterceptors();
});

test('Telegram throttling preserves retry delay and partial delivery count', async () => {
  const { mf, upstream } = setup();
  success(upstream);
  upstream
    .intercept({ path: `/bot${token}/sendMessage`, method: 'POST' })
    .reply(429, {
      ok: false,
      error_code: 429,
      parameters: { retry_after: 17 },
    });
  const response = await notify(mf, { text: 'a'.repeat(5000) });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '17');
  assert.equal((await response.json()).sent, 1);
});

test('upstream errors are sanitized; messages are not retried', async () => {
  const { mf, upstream, mock } = setup();
  upstream
    .intercept({ path: `/bot${token}/sendMessage`, method: 'POST' })
    .reply(403, { ok: false, description: token + key });
  const response = await notify(mf, { text: 'hello' });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body.includes(token), false);
  assert.equal(body.includes(key), false);
  mock.assertNoPendingInterceptors();
});

test('non-JSON upstream response becomes a gateway error', async () => {
  const { mf, upstream } = setup();
  upstream
    .intercept({ path: `/bot${token}/sendMessage`, method: 'POST' })
    .reply(200, '<html>bad gateway</html>');
  assert.equal((await notify(mf, { text: 'hello' })).status, 502);
});

test('network failure reports uncertainty instead of retrying', async () => {
  const { mf, upstream } = setup();
  upstream
    .intercept({ path: `/bot${token}/sendMessage`, method: 'POST' })
    .replyWithError(new Error(token));
  const response = await notify(mf, { text: 'hello' });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.sent, 0);
  assert.match(body.error, /unknown/);
  assert.equal(body.error.includes(token), false);
});

test('rate limiter caps outgoing messages', async () => {
  const { mf, upstream } = setup();
  for (let i = 0; i < 20; i++) success(upstream);
  for (let i = 0; i < 5; i++)
    assert.equal((await notify(mf, { text: 'a'.repeat(15000) })).status, 200);
  const response = await notify(mf, { text: 'hello' });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Message rate limit exceeded',
    sent: 0,
  });
});
