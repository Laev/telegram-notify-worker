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

## Call logs

Open the Worker in the Cloudflare dashboard → Observability → Logs and filter by `event = request_completed`. Each request writes one summary with `route`, `method`, `status`, `duration_ms`, and `sent` (message parts accepted by Telegram). If a split message fails partway through, `sent` retains the successful count; it does not indicate that the recipient has read the message.

Custom logs exclude credentials, notification content, chat IDs, request URLs, and raw errors. Automatic invocation logs stay disabled, and query-string redaction is enabled. Cloudflare stores the logs; no database or external logging service is added.

These exclusions apply to the application summary. Cloudflare real-time debugging still includes request metadata; query-string redaction does not cover paths. Bark paths containing keys or notification text appear in real-time debugging. For sensitive notifications, use `POST /push` with content and `device_key` in the body, or use a Bearer header.

The [Workers Logs Free plan](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing) includes 200,000 logs per day with 3-day retention, shared across the account. This project writes one log per request with 100% sampling.

## Rollback

Before updating a live Worker, record its version ID from `npx wrangler versions list`. To restore that version:

```sh
npx wrangler rollback VERSION_ID
```

Before rolling back, check the bindings and secret compatibility shown by Cloudflare. Notification key rotation is a separate operation; keep leaked keys revoked when restoring older code.
