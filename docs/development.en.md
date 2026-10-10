# Development and maintenance

[简体中文](development.md) | [English](development.en.md) · [Home](../README.en.md)

## CLI deployment

Requires Node.js 22 or later.

```sh
git clone https://github.com/Laev/telegram-notify-worker.git
cd telegram-notify-worker
npm ci
npx wrangler login
cp .dev.vars.example .dev.vars
# Fill in BOT_TOKEN, CHAT_ID, and NOTIFY_KEY in .dev.vars
npm run deploy -- --secrets-file .dev.vars
```

The first deployment creates the Worker and uploads the three secrets together. `.dev.vars` is ignored by Git; keep it private and out of commits. To rotate an individual secret later, run `npx wrangler secret put NOTIFY_KEY` and enter the new value at the prompt.

If another project in your account already uses rate limiting namespace `22022`, choose a separate positive integer in `wrangler.jsonc`.

## Local development and verification

```sh
cp .dev.vars.example .dev.vars
# Fill in your development configuration in .dev.vars
npm run dev
```

`.dev.vars` is ignored by Git. Tests use fictional credentials and a mocked upstream in the workerd runtime; no real messages are sent.

```sh
npm run types
npm run verify
```

Checks cover types, formatting, authentication, the fixed recipient, GET encoding, message splitting, rate limits, upstream errors, and deployment packaging. After an actual deployment, verify `/health`, a request without authentication, `/api/getMe`, and one real notification.

## Rollback

Before updating a live Worker, record its version ID from `npx wrangler versions list`. To restore that version:

```sh
npx wrangler rollback VERSION_ID
```

Before rolling back, check the bindings and secret compatibility shown by Cloudflare. Notification key rotation is a separate operation; keep leaked keys revoked when restoring older code.
