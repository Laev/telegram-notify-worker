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

function barkPost(mf, path, fields, form = false, headers = {}) {
  return mf.dispatchFetch(`https://notify.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': form
        ? 'application/x-www-form-urlencoded'
        : 'application/json',
      ...headers,
    },
    body: form
      ? new URLSearchParams(fields).toString()
      : JSON.stringify(fields),
  });
}

test('Bark GET paths support body, title and subtitle with encoded characters', async () => {
  const body = '中文 / + ? % %2F 😀';
  for (const parts of [[body], ['标题', body], ['标题', '副标题', body]]) {
    const { mf, upstream, mock } = setup();
    success(upstream, (data, options) => {
      assert.equal(data.text, parts.join('\n'));
      assert.equal(data.chat_id, chat);
      assert.equal(options.body.includes(key), false);
    });
    const path = [key, ...parts].map(encodeURIComponent).join('/');
    const response = await mf.dispatchFetch(`https://notify.example/${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const result = await response.json();
    assert.equal(result.code, 200);
    assert.equal(result.message, 'success');
    assert.equal(result.sent, 1);
    assert.ok(Number.isInteger(result.timestamp));
    mock.assertNoPendingInterceptors();
  }
});

test('Bark path text wins over query fields and preserves Bark plus decoding', async () => {
  const { mf, upstream } = setup();
  success(upstream, (data) => assert.equal(data.text, 'A B+C\nURL body'));
  assert.equal(
    (
      await mf.dispatchFetch(
        `https://notify.example/${key}/A+B%2BC/URL%20body?title=wrong&body=wrong`,
      )
    ).status,
    200,
  );
});

test('Bark key-only URLs accept GET fields and bodyless POST paths', async () => {
  for (const method of ['GET', 'POST']) {
    const { mf, upstream } = setup();
    success(upstream, (data) => assert.equal(data.text, '标题\n内容 + 中文'));
    const params = new URLSearchParams({ title: '标题', body: '内容 + 中文' });
    const response = await mf.dispatchFetch(
      `https://notify.example/${key}?${params}`,
      { method },
    );
    assert.equal(response.status, 200);
  }
});

test('Bark POST supports JSON and forms on key paths and push', async () => {
  for (const path of [`/${key}`, '/push']) {
    for (const form of [false, true]) {
      const { mf, upstream, mock } = setup();
      success(upstream, (data, options) => {
        assert.equal(
          data.text,
          '🖼 Title\nSubtitle\nText\n\n🏷 tasks\n🔗 https://example.com/task',
        );
        assert.equal(data.chat_id, chat);
        assert.equal(options.body.includes(key), false);
        assert.equal(data.sound, undefined);
      });
      const response = await barkPost(
        mf,
        path,
        {
          device_key: key,
          title: 'Title',
          subtitle: 'Subtitle',
          body: 'Text',
          url: 'https://example.com/task',
          sound: 'minuet',
          icon: 'https://example.com/icon',
          group: 'tasks',
          badge: 1,
          automaticallyCopy: 1,
          copy: 'copied text',
        },
        form,
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).code, 200);
      mock.assertNoPendingInterceptors();
    }
  }
});

test('Bark POST path fields take precedence over the request body', async () => {
  const { mf, upstream } = setup();
  success(upstream, (data) => assert.equal(data.text, 'Path title\nPath body'));
  assert.equal(
    (
      await barkPost(mf, `/${key}/Path%20title/Path%20body`, {
        device_key: 'wrong',
        title: 'wrong',
        body: 'wrong',
      })
    ).status,
    200,
  );
});

test('Bark rejects invalid credentials and never falls back from an invalid header', async () => {
  const { mf } = setup();
  for (const [path, fields, headers] of [
    ['/push', { body: 'hello' }, {}],
    ['/push', { body: 'hello', device_key: 'wrong' }, {}],
    [`/${key}/hello`, {}, { authorization: 'Bearer wrong' }],
    [
      '/push',
      { body: 'hello', device_key: key },
      { authorization: 'Basic wrong' },
    ],
  ]) {
    const response = await barkPost(mf, path, fields, false, headers);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 401);
  }
});

test('header-only mode disables both Bark URL and body keys', async () => {
  const { mf, upstream } = setup({ ALLOW_QUERY_AUTH: 'false' });
  assert.equal(
    (await mf.dispatchFetch(`https://notify.example/${key}/hello`)).status,
    401,
  );
  assert.equal(
    (await barkPost(mf, '/push', { device_key: key, body: 'hello' })).status,
    401,
  );
  success(upstream);
  assert.equal(
    (
      await barkPost(mf, '/push', { body: 'hello' }, false, {
        authorization: `Bearer ${key}`,
      })
    ).status,
    200,
  );
});

test('Bark rejects duplicate credentials, batch recipients and invalid fields', async () => {
  const { mf } = setup();
  for (const fields of [
    { device_key: key, device_keys: [key], body: 'hello' },
    { device_key: key, chat_id: '999', body: 'hello' },
    { device_key: key, body: 'hello', subtitle: 123 },
    { device_key: key, body: 'hello', url: 'javascript:alert(1)' },
    { device_key: key, body: '', url: 'https://example.com' },
  ])
    assert.equal((await barkPost(mf, '/push', fields)).status, 400);
  const response = await mf.dispatchFetch('https://notify.example/push', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `device_key=${key}&device_key=${key}&body=hello`,
  });
  assert.equal(response.status, 400);
});

test('Bark keeps parsing and message limits bounded', async () => {
  const { mf } = setup();
  assert.equal(
    (await mf.dispatchFetch(`https://notify.example/${key}/bad%ZZ`)).status,
    400,
  );
  assert.equal(
    (await barkPost(mf, '/push', { device_key: key, body: 'x'.repeat(16001) }))
      .status,
    413,
  );
  assert.equal(
    (await barkPost(mf, '/push', { device_key: key, body: 'x'.repeat(70000) }))
      .status,
    413,
  );
  const response = await mf.dispatchFetch('https://notify.example/push');
  assert.equal(
    (
      await barkPost(mf, '/push', {
        device_key: key,
        title: 'x'.repeat(8000),
        subtitle: 'x'.repeat(4000),
        body: 'x'.repeat(3999),
        url: 'https://example.com',
      })
    ).status,
    413,
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal((await response.json()).code, 405);
});

test('Bark errors retain retry delay and partial delivery without exposing secrets', async () => {
  const { mf, upstream } = setup();
  success(upstream);
  upstream
    .intercept({ path: `/bot${token}/sendMessage`, method: 'POST' })
    .reply(429, {
      ok: false,
      description: token + key,
      parameters: { retry_after: 17 },
    });
  const response = await barkPost(mf, '/push', {
    device_key: key,
    body: 'x'.repeat(5000),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '17');
  const result = await response.json();
  assert.equal(result.code, 429);
  assert.equal(result.sent, 1);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('Bark multipart fields work with bounded parsing; native routes stay unchanged', async () => {
  const { mf, upstream } = setup();
  async function submit(path, body, headers = {}) {
    const request = new Request(`https://notify.example${path}`, {
      method: 'POST',
      body,
    });
    return mf.dispatchFetch(request.url, {
      method: request.method,
      headers: { ...Object.fromEntries(request.headers), ...headers },
      body: await request.text(),
    });
  }
  success(upstream, (data) => assert.equal(data.text, '标题\n内容'));
  const fields = new FormData();
  fields.set('device_key', key);
  fields.set('title', '标题');
  fields.set('body', '内容');
  assert.equal((await submit('/push', fields)).status, 200);
  fields.append('device_key', key);
  assert.equal((await submit('/push', fields)).status, 400);
  assert.equal(
    (await submit('/sendMessage', fields, { authorization: `Bearer ${key}` }))
      .status,
    415,
  );
  fields.delete('device_key');
  fields.set('device_key', key);
  fields.set('file', new Blob(['file contents']), 'upload.txt');
  assert.equal((await submit('/push', fields)).status, 400);
  const malformed = await mf.dispatchFetch('https://notify.example/push', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=missing' },
    body: 'not a multipart body',
  });
  assert.equal(malformed.status, 400);
});

test('Bark and native routes share the authenticated request rate limit', async () => {
  const { mf, upstream } = setup();
  for (let i = 0; i < 20; i++) {
    success(upstream);
    const response =
      i % 2 === 0
        ? await mf.dispatchFetch(`https://notify.example/${key}/hello`)
        : await notify(mf, { text: 'hello' });
    assert.equal(response.status, 200);
  }
  const response = await mf.dispatchFetch(
    `https://notify.example/${key}/hello`,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal((await response.json()).message, 'Request rate limit exceeded');
});

test('Bark layout styles headers and group while keeping Markdown-like body literal', async () => {
  const { mf, upstream, mock } = setup();
  const fields = {
    device_key: key,
    title: '部署 <成功>',
    subtitle: '状态 _正常_',
    body: '**literal** _name_ [text](url) <b>tag</b> & 😀',
    icon: '🚀',
    group: '服务_监控',
    url: 'https://example.com/a?x=1&y=2',
  };
  success(upstream, (data) => {
    assert.equal(
      data.text,
      `🚀 ${fields.title}\n${fields.subtitle}\n${fields.body}\n\n🏷 ${fields.group}\n🔗 ${fields.url}`,
    );
    assert.deepEqual(data.entities, [
      { type: 'bold', offset: 3, length: fields.title.length },
      {
        type: 'italic',
        offset: data.text.indexOf(fields.subtitle),
        length: fields.subtitle.length,
      },
      {
        type: 'code',
        offset: data.text.indexOf(fields.group),
        length: fields.group.length,
      },
      {
        type: 'text_link',
        offset: data.text.indexOf(fields.url),
        length: fields.url.length,
        url: fields.url,
      },
    ]);
    assert.equal(data.parse_mode, undefined);
    assert.deepEqual(data.link_preview_options, { is_disabled: true });
    assert.equal(data.icon, undefined);
    assert.equal(data.group, undefined);
  });
  assert.equal((await barkPost(mf, '/push', fields)).status, 200);
  mock.assertNoPendingInterceptors();
});

test('Bark layout turns an image icon into a link without fetching it', async () => {
  const { mf, upstream, mock } = setup();
  const icon = 'https://example.com/icon.png';
  success(upstream, (data) => {
    assert.equal(data.text, '🖼 标题\n内容');
    assert.deepEqual(data.entities, [
      { type: 'text_link', offset: 0, length: '🖼'.length, url: icon },
      { type: 'bold', offset: '🖼 '.length, length: 2 },
    ]);
    assert.equal(data.chat_id, chat);
    assert.equal(JSON.stringify(data).includes(key), false);
  });
  const params = new URLSearchParams({ icon });
  assert.equal(
    (
      await mf.dispatchFetch(
        `https://notify.example/${key}/标题/内容?${params}`,
      )
    ).status,
    200,
  );
  mock.assertNoPendingInterceptors();
});

test('Bark layout preserves entity offsets and compound emoji across title splits', async () => {
  const { mf, upstream, mock } = setup();
  const fields = {
    device_key: key,
    title: 'T'.repeat(4100),
    subtitle: '👨‍👩‍👧‍👦',
    body: 'body _literal_',
    icon: '🧪',
  };
  const messages = [];
  for (let i = 0; i < 2; i++) success(upstream, (data) => messages.push(data));
  const response = await barkPost(mf, '/push', fields);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sent, 2);
  assert.equal(
    messages.map((m) => m.text).join(''),
    `🧪 ${fields.title}\n${fields.subtitle}\n${fields.body}`,
  );
  assert.deepEqual(messages[0].entities, [
    { type: 'bold', offset: 3, length: 4093 },
  ]);
  assert.deepEqual(messages[1].entities, [
    { type: 'bold', offset: 0, length: 7 },
    { type: 'italic', offset: 8, length: fields.subtitle.length },
  ]);
  assert.ok(messages.every((m) => m.text.length <= 4096));
  mock.assertNoPendingInterceptors();
});

test('Bark layout clips group and link entities to their own message segment', async () => {
  for (const metadata of [
    { group: 'g'.repeat(128) },
    { url: 'https://example.com/path' },
  ]) {
    const { mf, upstream, mock } = setup();
    const messages = [];
    for (let i = 0; i < 2; i++)
      success(upstream, (data) => messages.push(data));
    assert.equal(
      (
        await barkPost(mf, '/push', {
          device_key: key,
          body: 'x'.repeat(4084),
          ...metadata,
        })
      ).status,
      200,
    );
    const entities = messages.flatMap((m) => m.entities);
    assert.equal(entities.length, 2);
    assert.ok(entities.every((e) => e.length > 0));
    for (const message of messages) {
      assert.ok(message.text.length <= 4096);
      for (const entity of message.entities)
        assert.ok(entity.offset + entity.length <= message.text.length);
    }
    const rendered = messages
      .map((m) =>
        m.entities
          .map((e) => m.text.slice(e.offset, e.offset + e.length))
          .join(''),
      )
      .join('');
    assert.equal(rendered, metadata.group ?? metadata.url);
    if (metadata.url) assert.ok(entities.every((e) => e.url === metadata.url));
    mock.assertNoPendingInterceptors();
  }
});

test('Bark layout validates metadata and rejects raw caller formatting', async () => {
  const { mf } = setup();
  for (const extra of [
    { group: 1 },
    { group: 'x'.repeat(129) },
    { icon: [] },
    { icon: 'x'.repeat(33) },
    { icon: 'javascript:alert(1)' },
    { icon: 'https://%' },
    { title: 1 },
    { parse_mode: 'MarkdownV2' },
    { entities: [{ type: 'bold', offset: 0, length: 1 }] },
  ])
    assert.equal(
      (
        await barkPost(mf, '/push', {
          device_key: key,
          body: 'hello',
          ...extra,
        })
      ).status,
      400,
    );
});
