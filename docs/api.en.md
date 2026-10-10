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

Native notification endpoints send plain text; Bark endpoints use the automatic layout below. The title and text together may contain up to 16000 UTF-16 code units. Longer text is sent in order as messages of up to 4096 code units, preserving content and compound emoji. POST bodies are limited to 64 KiB. Upstream requests time out after 10 seconds.

The `/api/*` routes provide a limited notification interface. They expose `getMe` and `sendMessage`, use a fixed recipient, and return a segment count for successful sends. File uploads, arbitrary bot token paths, webhook management, and formatted text are not implemented.

When Telegram returns a rate limit response, the Worker preserves `Retry-After` if provided. Sending is not retried automatically because a message may have arrived before the connection failed. Do not resend an entire long message after a partial delivery.

## Bark compatibility

Common Bark sender HTTP formats are supported, with delivery to this instance's fixed Telegram chat. Replace the original Bark key with `NOTIFY_KEY`.

| Route                              | Methods   | Content source                        |
| ---------------------------------- | --------- | ------------------------------------- |
| `/{key}/{body}`                    | GET, POST | Message path segment                  |
| `/{key}/{title}/{body}`            | GET, POST | Title and message path segments       |
| `/{key}/{title}/{subtitle}/{body}` | GET, POST | Title, subtitle, and message segments |
| `/{key}`                           | GET, POST | Query parameters or request body      |
| `/push`                            | POST      | `device_key` field or Bearer header   |

POST accepts JSON, `application/x-www-form-urlencoded`, and `multipart/form-data` text fields. Bodies remain limited to 64 KiB. File uploads and the batch `device_keys` field return 400.

```sh
curl 'https://notify.example.com/YOUR_NOTIFY_KEY/Hello%20world'

curl https://notify.example.com/YOUR_NOTIFY_KEY \
  --data-urlencode 'title=Task notification' \
  --data-urlencode 'body=Task completed'

curl https://notify.example.com/push \
  -H 'Content-Type: application/json' \
  --data '{"device_key":"YOUR_NOTIFY_KEY","title":"Task notification","subtitle":"Result","body":"Task completed","icon":"🚀","group":"Tasks","url":"https://example.com/task"}'
```

`title` is bold, `subtitle` uses regular text, and a blank line separates the header from the body. `body` stays literal. Markdown and HTML characters in the body remain text. Caller-supplied `parse_mode` and `entities` are still rejected.

| Field   | Telegram display                                                                 | Limit                                                           |
| ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `group` | A `🏷 Group name` label below the body, with a monospace name for searching       | 128 UTF-16 code units                                           |
| `icon`  | Emoji or a short label before the title; an image URL becomes a clickable 🖼 icon | Single-line labels: 32 UTF-16 code units; URLs: 2048 characters |
| `url`   | A `🔗 Target hostname` link below the body                                       | HTTP/HTTPS, 2048 characters                                     |

A subtitle is followed by a blank line before the body. With only a title, that title is followed by a blank line. With neither header, the body starts on the first line; if an icon is supplied, it occupies its own line immediately above the body. Messages contain only the supplied content, with no fixed links or promotional text.

Image icons are links to view the image. The Worker does not download images or send photos; link previews are disabled. `group` is a visual label in the message. Use `message_thread_id` for Telegram topics.

All visible text after layout, including icons, labels, links, and newlines, shares the 16000 UTF-16 code unit limit. Long messages retain styles and links with entity offsets recalculated for each segment. Existing rate limits apply; `chat_id`, topic, and silent delivery fields follow the validation above.

Path fields take precedence over other fields. For JSON requests, query parameters take precedence over body fields. For URL-encoded and multipart forms, body fields take precedence over query parameters. A bare `+` in a message path segment becomes a space, as in Bark; encode a literal plus as `%2B` and a slash as `%2F`. Each field is decoded once.

The Bearer header takes precedence. An invalid header never falls back to a path or body key. When `ALLOW_QUERY_AUTH=false`, path keys and `device_key` are disabled; use Bearer authentication. Path and query keys may appear in client or proxy logs, so keep them private.

Success uses the Bark response format: `{"code":200,"message":"success","timestamp":...,"sent":1}`. Failures retain their HTTP status, with a matching `code`; `sent` and `Retry-After` preserve partial delivery counts and retry delays.

iOS display fields such as `sound`, `badge`, `level`, `volume`, `automaticallyCopy`, `copy`, and `isArchive` are ignored. Bark App device registration, APNs delivery, and encrypted message decryption are not implemented.
