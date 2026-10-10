# Telegram Notify Worker — 轻量 Telegram 通知服务

[简体中文](README.md) | [English](README.en.md)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue)](LICENSE)
[![Check](https://github.com/Laev/telegram-notify-worker/actions/workflows/check.yml/badge.svg)](https://github.com/Laev/telegram-notify-worker/actions/workflows/check.yml)

在 Cloudflare Workers 上部署自己的 Telegram 通知入口。填入机器人信息和访问密钥，即可通过 HTTP 请求发送消息。

- **快速部署**：使用 Cloudflare 官方部署按钮，无需本地开发环境。
- **密钥鉴权**：支持 Bearer 请求头，或用于 GET 推送的独立访问密钥。
- **Bark 兼容**：沿用常用推送路径和 JSON、表单格式，消息发送到 Telegram。
- **固定接收人**：Bot Token 与 Chat ID 保存在 Worker Secret 中。
- **长消息分段**：自动拆分文本，保持复合 emoji 完整。
- **轻量运行**：无需服务器或数据库，没有运行时 npm 依赖。

## 快速开始

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Laev/telegram-notify-worker)

### 1. 准备机器人与配置

在 Telegram 中联系 [@BotFather](https://t.me/BotFather)，使用 `/newbot` 创建机器人。向新机器人发送 `/start`，让它可以向你发送消息。

三个 Secret 均为必填。`CHAT_ID` 用来固定本实例的接收人，发送请求时可以省略 `chat_id`；如果传入，则必须与配置值相同。

| Secret       | 填写内容                                      |
| ------------ | --------------------------------------------- |
| `BOT_TOKEN`  | BotFather 提供的机器人 Token                  |
| `CHAT_ID`    | 接收消息的数字聊天 ID，群组 ID 可以为负数     |
| `NOTIFY_KEY` | 自己生成的随机访问密钥，32–512 字符，不含空白 |

`CHAT_ID` 可以从机器人的 [getUpdates](https://core.telegram.org/bots/api#getupdates) 响应中找到 `message.chat.id`。向群组推送时，先将机器人加入群组并允许它发送消息。

`CHAT_ID` 缺失或格式错误时，通知接口返回 HTTP 503；请求指定其他 `chat_id` 时返回 HTTP 400。

### 2. 点击部署

点击上方按钮，登录 Cloudflare，按引导关联 GitHub、创建项目，填写三个 Secret 后部署。可用以下命令生成通知密钥：

```sh
openssl rand -hex 32
```

如果部署引导没有显示 Secret 输入项，可在 Worker 的 **Settings → Variables and Secrets** 中添加，类型选择 **Secret**，保存并部署。

部署完成后记下 Worker 地址，例如 `https://telegram-notify-worker.example.workers.dev`。默认 `ALLOW_QUERY_AUTH=true`；只使用请求头鉴权时可设为 `false`。建议绑定从发送端可访问的自定义域名。

默认 `ENABLE_LOGS=false`，不输出应用调用日志；设为 `true` 后记录路由类别、方法、状态码、耗时和发送数量，不记录密钥或消息内容。持久化日志还需在 Cloudflare 启用 Workers Logs（仓库配置已启用采集能力）。此开关不控制 Cloudflare 平台自身的请求元数据。

### 3. 发送第一条消息

替换下面的域名和访问密钥：

```sh
curl https://notify.example.com/sendMessage \
  -H 'Authorization: Bearer YOUR_NOTIFY_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"text":"第一条通知已发送"}'
```

返回 `{"ok":true,"sent":1}` 并收到 Telegram 消息，即表示配置成功。

只支持 GET 推送地址的客户端可以使用以下格式，正文需要 URL 编码：

```text
https://notify.example.com/sendMessage?key=YOUR_NOTIFY_KEY&text=Hello%20world
```

## Bark 兼容

原有 Bark 推送脚本可使用以下地址，将域名换成 Worker 地址，原 Bark key 换成 `NOTIFY_KEY`。标题和正文分别进行 URL 编码。

```text
https://notify.example.com/YOUR_NOTIFY_KEY/正文
https://notify.example.com/YOUR_NOTIFY_KEY/标题/正文
https://notify.example.com/YOUR_NOTIFY_KEY/标题/副标题/正文
```

也支持 `POST /YOUR_NOTIFY_KEY` 和 `POST /push` 的 JSON、URL 编码表单及 multipart 文本字段。[参数与示例](docs/api.md#bark-兼容)。

`ALLOW_QUERY_AUTH=false` 时，路径密钥和 `device_key` 均停用，需要提供 Bearer 请求头。标题加粗、副标题使用常规字体，标题区与正文之间空一行，`group` 显示为分组标签。`icon` 可使用 emoji；图片 URL 显示为可点击的 🖼 图标。只有图标时，图标单独一行，下一行直接显示正文；没有标题、副标题和图标时，正文从首行开始。`url` 显示为简短域名链接。音效、角标和自动复制等 iOS 参数被忽略。

## 文档

[接口与参数](docs/api.md) · [本地开发、命令行部署与回滚](docs/development.md)

<details>
<summary>功能与使用限制</summary>

- 支持标题、正文、群组话题和静默通知。
- 原生接口发送纯文本，Bark 接口自动排版；每次最多 16000 个 UTF-16 单元，单条最多 4096 个。
- 默认每个 Cloudflare 节点每分钟约 20 次已鉴权请求、20 条发送消息。限额为近似计数。
- 仅开放通知所需的 `getMe` 与 `sendMessage`，接口范围详见接口文档。
- 请求体上限 64 KiB，上游请求超时 10 秒。失败后不自动重试，以避免重复通知。
- 查询参数密钥可能被客户端或代理日志记录；优先使用 Bearer，请妥善保护密钥。
- `/health` 只检查服务存活；实际收信以 Telegram 消息为准。

</details>

## 许可证

Copyright 2026 Laev。采用 [Apache-2.0](LICENSE) 许可证，允许二次开发和商业使用。再分发时须保留许可证、[NOTICE](NOTICE) 及适用的版权声明。
