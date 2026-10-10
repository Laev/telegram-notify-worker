# 接口文档

[简体中文](api.md) | [English](api.en.md) · [返回首页](../README.md)

## 接收人配置

Worker Secret 中的 `CHAT_ID` 必填，固定本实例的接收聊天。请求中的 `chat_id` 可省略；传入时必须与配置值相同。这样，持有通知密钥的客户端只能向配置的接收人发送消息。

`CHAT_ID` 缺失或不是数字聊天 ID 时，业务接口（含 `/api/getMe`）返回 HTTP 503。请求指定其他 `chat_id` 时返回 HTTP 400。`/health` 仍只检查服务存活。

## 请求鉴权

推荐在请求头中携带 `Authorization: Bearer YOUR_NOTIFY_KEY`。

对于只支持 GET 推送地址的客户端，也可以使用查询参数：

```text
https://notify.example.com/sendMessage?key=YOUR_NOTIFY_KEY&text=Hello%20world
```

正文需要进行 URL 编码。查询参数中的密钥可能被客户端或代理日志记录，应限制日志访问。Worker 已关闭 invocation logs，其他日志系统也应避免保存查询字符串。密钥泄漏后更换 `NOTIFY_KEY`。

如果只使用请求头鉴权，把 `ALLOW_QUERY_AUTH` 改为 `"false"`。

## 接口

| 路由               | 请求方法  | 鉴权                     | 用途                                 |
| ------------------ | --------- | ------------------------ | ------------------------------------ |
| `/health`          | GET       | 无                       | 进程存活检查，不检查 Telegram 连通性 |
| `/sendMessage`     | GET       | Bearer 或 `key` 查询参数 | 通知推送                             |
| `/sendMessage`     | POST      | Bearer                   | JSON 或 form-urlencoded 推送         |
| `/api/sendMessage` | POST      | Bearer                   | 受限的 Bot API 文本发送入口          |
| `/api/getMe`       | GET、POST | Bearer                   | 检查 Bot Token 和上游连通性          |

```sh
curl https://notify.example.com/sendMessage \
  -H 'Authorization: Bearer YOUR_NOTIFY_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"title":"服务通知","text":"定时任务已完成"}'
```

成功返回 `{"ok":true,"sent":1}`。失败返回 `ok: false`、错误说明和 HTTP 状态码。发送失败时的 `sent` 表示已经确认成功的分段数量；网络中断后，失败分段是否送达仍可能未知。

支持的字段：

| 字段                   | 说明                                                |
| ---------------------- | --------------------------------------------------- |
| `text`                 | 必填正文；也可以使用 `content`                      |
| `title`                | 可选标题，与正文以换行连接                          |
| `chat_id`              | 可省略；如果传入，必须与 Worker 中的 `CHAT_ID` 相同 |
| `message_thread_id`    | 可选，群组话题的正整数 ID                           |
| `disable_notification` | 可选布尔值，静默发送                                |

仅支持纯文本。标题和正文合计上限 16000 个 UTF-16 单元，单条最多 4096 个单元，超过时顺序拆分，保持内容与 emoji 完整。POST 请求体上限 64 KiB。上游请求超时为 10 秒。

`/api/*` 是适用于通知的受限接口，并非完整 Bot API 的透明替代：只开放 `getMe` 和 `sendMessage`，固定接收人，成功发送只返回分段计数。文件上传、任意 Bot Token 路径、Webhook 管理和格式化文本均未实现。

Telegram 返回 429 时，会保留 `Retry-After`。服务不会自动重试发送，因为断线前消息可能已经送达。长消息部分成功后，不应直接重发整条。
