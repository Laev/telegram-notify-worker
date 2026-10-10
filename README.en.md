# Telegram Notify Worker — Lightweight Telegram notifications

[简体中文](README.md) | [English](README.en.md)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue)](LICENSE)
[![Check](https://github.com/Laev/telegram-notify-worker/actions/workflows/check.yml/badge.svg)](https://github.com/Laev/telegram-notify-worker/actions/workflows/check.yml)

Deploy your own Telegram notification endpoint on Cloudflare Workers. Configure your bot and access key, then send messages through HTTP requests.

- **Quick deployment**: Use the official Cloudflare deploy button without a local development environment.
- **Key authentication**: Use a Bearer header, or a separate access key for GET notification URLs.
- **Bark compatibility**: Reuse common push paths and JSON or form requests, with delivery through Telegram.
- **Fixed recipient**: Store the bot token and chat ID as Worker secrets.
- **Long messages**: Split text automatically while keeping compound emoji intact.
- **Lightweight**: No server, database, or runtime npm dependencies.

## Quick start

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Laev/telegram-notify-worker)

### 1. Prepare your bot and configuration

Contact [@BotFather](https://t.me/BotFather) on Telegram and use `/newbot` to create a bot. Send `/start` to your new bot so it can message you.

All three secrets are required. `CHAT_ID` fixes the recipient for this instance. You can omit `chat_id` from notification requests; if included, it must match the configured value.

| Secret       | Value                                                        |
| ------------ | ------------------------------------------------------------ |
| `BOT_TOKEN`  | The bot token provided by BotFather                          |
| `CHAT_ID`    | The numeric recipient chat ID; group IDs may be negative     |
| `NOTIFY_KEY` | Your own random access key, 32–512 characters, no whitespace |

Find `message.chat.id` in your bot's [getUpdates](https://core.telegram.org/bots/api#getupdates) response to obtain `CHAT_ID`. For group notifications, add the bot to the group and allow it to send messages.

A missing or malformed `CHAT_ID` causes notification endpoints to return HTTP 503. A request specifying a different `chat_id` returns HTTP 400.

### 2. Deploy

Click the button above, sign in to Cloudflare, and follow the setup to connect GitHub, create your project, and provide the three secrets. Generate a notification key with:

```sh
openssl rand -hex 32
```

If the setup does not show secret input fields, add them under your Worker's **Settings → Variables and Secrets**, choose the **Secret** type, then save and deploy.

After deployment, note your Worker URL, such as `https://telegram-notify-worker.example.workers.dev`. `ALLOW_QUERY_AUTH` defaults to `true`; set it to `false` if you only use header authentication. A custom domain reachable from your notification clients is recommended.

### 3. Send your first message

Replace the domain and access key below:

```sh
curl https://notify.example.com/sendMessage \
  -H 'Authorization: Bearer YOUR_NOTIFY_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"text":"Your first notification"}'
```

A response of `{"ok":true,"sent":1}` together with a received Telegram message confirms that your configuration works.

Clients that only support GET notification URLs can use this format. URL-encode the message text:

```text
https://notify.example.com/sendMessage?key=YOUR_NOTIFY_KEY&text=Hello%20world
```

## Bark compatibility

Existing Bark push scripts can use the following URLs. Replace the domain with your Worker address and the original Bark key with `NOTIFY_KEY`. URL-encode each title and message segment separately.

```text
https://notify.example.com/YOUR_NOTIFY_KEY/body
https://notify.example.com/YOUR_NOTIFY_KEY/title/body
https://notify.example.com/YOUR_NOTIFY_KEY/title/subtitle/body
```

`POST /YOUR_NOTIFY_KEY` and `POST /push` also accept JSON, URL-encoded forms, and multipart text fields. See [parameters and examples](docs/api.en.md#bark-compatibility).

When `ALLOW_QUERY_AUTH=false`, path keys and `device_key` are disabled; supply a Bearer header. Titles are bold, subtitles use regular text, and a blank line separates the header from the body. `group` appears as a label. `icon` accepts emoji; an image URL becomes a clickable 🖼 icon. `url` appears as a short hostname link. Sound, badges, and automatic copying are ignored.

## Documentation

[API and parameters](docs/api.en.md) · [Local development, CLI deployment, and rollback](docs/development.en.md)

<details>
<summary>Features and limits</summary>

- Supports titles, message text, group topics, and silent notifications.
- Native endpoints send plain text; Bark endpoints add automatic layout. Each request accepts up to 16000 UTF-16 code units; each message accepts up to 4096.
- Defaults to roughly 20 authenticated requests and 20 outgoing messages per minute per Cloudflare location. Rate limits use approximate counters.
- Exposes only `getMe` and `sendMessage` for notifications. See the API documentation for the supported routes.
- Request bodies are limited to 64 KiB. Upstream requests time out after 10 seconds. Failed sends are not retried automatically to avoid duplicate notifications.
- Query keys may appear in client or proxy logs. Prefer Bearer authentication and keep your key private.
- `/health` checks service liveness only. Confirm delivery by checking the Telegram message.

</details>

## License

Copyright 2026 Laev. Licensed under [Apache-2.0](LICENSE), allowing modification and commercial use. When redistributing, retain the license, [NOTICE](NOTICE), and applicable copyright notices.
