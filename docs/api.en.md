# API reference

[简体中文](api.md) | [English](api.en.md) · [Home](../README.en.md)

## Recipient configuration

The `CHAT_ID` Worker secret is required and fixes the recipient chat for this instance. The `chat_id` request field is optional; if present, it must match the configured value. Clients holding the notification key can therefore send messages only to the configured recipient.

A missing or non-numeric `CHAT_ID` causes application endpoints, including `/api/getMe`, to return HTTP 503. A request specifying a different `chat_id` returns HTTP 400. `/health` still checks service liveness only.

## Authentication

Use the `Authorization: Bearer YOUR_NOTIFY_KEY` header whenever possible.

Clients that only support GET notification URLs can also use a query parameter:

```text
https://notify.example.com/sendMessage?key=YOUR_NOTIFY_KEY&text=Hello%20world
```

URL-encode the message text. Query keys may be recorded in client or proxy logs, so restrict log access. Worker invocation logs are disabled; other logging systems should also avoid saving query strings. Rotate `NOTIFY_KEY` if it leaks.

Set `ALLOW_QUERY_AUTH` to `"false"` to accept header authentication only.

## Endpoints

| Route              | Methods   | Authentication              | Purpose                                 |
| ------------------ | --------- | --------------------------- | --------------------------------------- |
| `/health`          | GET       | None                        | Liveness, without checking Telegram     |
| `/sendMessage`     | GET       | Bearer or `key` query value | Send notifications                      |
| `/sendMessage`     | POST      | Bearer                      | Send JSON or form-urlencoded requests   |
| `/api/sendMessage` | POST      | Bearer                      | Limited Bot API text sending endpoint   |
| `/api/getMe`       | GET, POST | Bearer                      | Check the bot token and upstream access |

```sh
curl https://notify.example.com/sendMessage \
  -H 'Authorization: Bearer YOUR_NOTIFY_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"title":"Service notification","text":"Scheduled task completed"}'
```

Successful sends return `{"ok":true,"sent":1}`. Failures return `ok: false`, an error description, and an HTTP status code. On a send failure, `sent` counts the segments confirmed as delivered; if the connection was interrupted, delivery of the failed segment may remain uncertain.

Supported fields:

| Field                  | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `text`                 | Required message text; `content` is also accepted       |
| `title`                | Optional title, joined to the text with a newline       |
| `chat_id`              | Optional; must match the Worker's `CHAT_ID` if provided |
| `message_thread_id`    | Optional positive integer ID of a group topic           |
| `disable_notification` | Optional boolean for silent delivery                    |

Only plain text is supported. The title and text together may contain up to 16000 UTF-16 code units. Longer text is sent in order as messages of up to 4096 code units, preserving content and compound emoji. POST bodies are limited to 64 KiB. Upstream requests time out after 10 seconds.

The `/api/*` routes provide a limited notification interface. They expose `getMe` and `sendMessage`, use a fixed recipient, and return a segment count for successful sends. File uploads, arbitrary bot token paths, webhook management, and formatted text are not implemented.

When Telegram returns a rate limit response, the Worker preserves `Retry-After` if provided. Sending is not retried automatically because a message may have arrived before the connection failed. Do not resend an entire long message after a partial delivery.
