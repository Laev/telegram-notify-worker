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

原生通知接口发送纯文本；Bark 兼容接口使用下文的自动排版。标题和正文合计上限 16000 个 UTF-16 单元，单条最多 4096 个单元，超过时顺序拆分，保持内容与 emoji 完整。POST 请求体上限 64 KiB。上游请求超时为 10 秒。

`/api/*` 是适用于通知的受限接口，并非完整 Bot API 的透明替代：只开放 `getMe` 和 `sendMessage`，固定接收人，成功发送只返回分段计数。文件上传、任意 Bot Token 路径、Webhook 管理和格式化文本均未实现。

Telegram 返回 429 时，会保留 `Retry-After`。服务不会自动重试发送，因为断线前消息可能已经送达。长消息部分成功后，不应直接重发整条。

## Bark 兼容

兼容 Bark 发送端的常用 HTTP 推送格式，消息仍发送到本实例固定的 Telegram 聊天。原 Bark key 需要替换为 `NOTIFY_KEY`。

| 路由                               | 方法      | 内容来源                          |
| ---------------------------------- | --------- | --------------------------------- |
| `/{key}/{body}`                    | GET、POST | 路径正文                          |
| `/{key}/{title}/{body}`            | GET、POST | 路径标题、正文                    |
| `/{key}/{title}/{subtitle}/{body}` | GET、POST | 路径标题、副标题、正文            |
| `/{key}`                           | GET、POST | 查询参数或请求体                  |
| `/push`                            | POST      | `device_key` 字段或 Bearer 请求头 |

POST 支持 JSON、`application/x-www-form-urlencoded` 和 `multipart/form-data` 文本字段。请求体仍限制为 64 KiB，文件上传和 `device_keys` 批量设备字段返回 400。

```sh
curl 'https://notify.example.com/YOUR_NOTIFY_KEY/Hello%20world'

curl https://notify.example.com/YOUR_NOTIFY_KEY \
  --data-urlencode 'title=任务通知' \
  --data-urlencode 'body=任务已完成'

curl https://notify.example.com/push \
  -H 'Content-Type: application/json' \
  --data '{"device_key":"YOUR_NOTIFY_KEY","title":"任务通知","subtitle":"执行结果","body":"任务已完成","icon":"🚀","group":"任务监控","url":"https://example.com/task"}'
```

`title` 加粗、`subtitle` 使用常规字体；标题区与正文之间空一行，`body` 保持原文。正文里的 Markdown 或 HTML 符号不会被当作排版指令，调用方仍不传 `parse_mode` 或 `entities`。

| 字段    | Telegram 展示                                            | 限制                                                 |
| ------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `group` | 正文下方的 `🏷 分组名称`，名称使用等宽字体，方便搜索      | 最多 128 个 UTF-16 单元                              |
| `icon`  | emoji 或短标签放在标题前；图片 URL 显示为可点击的 🖼 图标 | 标签最多 32 个 UTF-16 单元、单行；URL 最多 2048 字符 |
| `url`   | 正文下方的 `🔗 目标域名`                                 | HTTP/HTTPS，最多 2048 字符                           |

有副标题时，副标题下方空一行再显示正文；仅有正标题时，正标题下方空一行。没有正标题和副标题时，正文从首行开始；若传入图标，则图标单独一行，下一行直接显示正文。消息只展示请求中的内容，不附加固定链接或推广文案。

图片图标链接仅供点击查看，Worker 不下载图片、不发送照片；链接预览关闭。`group` 是消息里的视觉标签；群组话题仍使用 `message_thread_id`。

排版后的全部可见文本（包括图标、标签、链接和换行）合计最多 16000 个 UTF-16 单元。长消息分段时保留粗体和链接，并重新计算每段的文本实体位置。复用既有限流逻辑；`chat_id`、话题和静默通知扩展字段遵守上文的校验。

路径字段优先于其他字段。JSON 请求中查询参数优先于请求体；URL 编码表单与 multipart 请求中请求体优先于查询参数。路径正文中的裸 `+` 按 Bark 约定解析为空格，字面加号应写为 `%2B`，斜杠应写为 `%2F`；每个字段只解码一次。

Bearer 请求头优先，错误的请求头不会回退到路径或正文密钥。`ALLOW_QUERY_AUTH=false` 时，路径 key 和 `device_key` 均停用，只接受 Bearer。路径和查询参数密钥可能进入客户端或代理日志，请妥善保护。

成功返回 Bark 风格的 `{"code":200,"message":"success","timestamp":...,"sent":1}`。失败保留真实 HTTP 状态码，`code` 与其一致；`sent` 和 `Retry-After` 保留已发送分段数与重试等待时间。

`sound`、`badge`、`level`、`volume`、`automaticallyCopy`、`copy`、`isArchive` 等 iOS 展示参数会被忽略。Bark App 的设备注册、APNs 推送及加密消息解密未实现。
