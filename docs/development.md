# 开发与维护

[简体中文](development.md) | [English](development.en.md) · [返回首页](../README.md)

## 命令行部署

需要 Node.js 22 或更新版本。

```sh
git clone https://github.com/Laev/telegram-notify-worker.git
cd telegram-notify-worker
npm ci
npx wrangler login
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填写 BOT_TOKEN、CHAT_ID 和 NOTIFY_KEY
npm run deploy -- --secrets-file .dev.vars
```

首次部署会同时创建 Worker 和上传三个 Secret。`.dev.vars` 已加入 Git 忽略列表，请勿提交或分享。后续轮换单个密钥时使用 `npx wrangler secret put NOTIFY_KEY`，按交互提示输入新值。

账户内若已有其他项目使用 Rate Limiting namespace `22022`，请在 `wrangler.jsonc` 中选择独立的正整数编号。

## 本地开发和验证

```sh
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填写开发用配置
npm run dev
```

`.dev.vars` 已加入 Git 忽略列表。测试使用虚构凭据和模拟上游，在 workerd 运行时中执行，不发送真实消息。

```sh
npm run types
npm run verify
```

检查包括类型、格式、鉴权、固定接收人、GET 编码、分段、限流、上游错误和部署打包。实际部署后再用 `/health`、缺失鉴权请求、`/api/getMe` 和一条真实通知验证。

## 回滚

更新线上 Worker 前记录 `npx wrangler versions list` 中的版本 ID。需要恢复时：

```sh
npx wrangler rollback VERSION_ID
```

版本回滚前核对 Cloudflare 当前显示的绑定和 Secret 兼容性。通知密钥轮换是单独的操作；不要为恢复旧代码重新启用已泄漏的密钥。
