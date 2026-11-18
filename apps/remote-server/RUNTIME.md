# AI 大狗 Remote 0.1.1 自部署运行包

需要 Node.js 24。解压后进入本目录，执行 `npm ci --omit=dev --ignore-scripts`。
在本机环境设置 `DSH_SERVER_ACCOUNT`、`DSH_SERVER_PASSWORD`、`DSH_SERVER_PUBLIC_URL`（生产用 HTTPS 公网 origin）、`DSH_SERVER_DATA_FILE`（持久化绝对路径），然后执行 `node main.mjs`。默认监听 127.0.0.1:8080，健康检查 `/healthz`。

生产 TLS/WSS 请使用 Caddy/nginx 反向代理。TURN 可配置 `DSH_SERVER_TURN_URLS`、`DSH_SERVER_TURN_SECRET`，推送允许的域名配置 `BIGDOG_PUSH_ORIGIN`。默认不向其他服务器发送推送。
支持桌面生成的二维码和完整邀请配对，手机无需单独填写服务器或账号。
完整部署、配对与原生Android构建步骤见源码的 docs/REMOTE.md 和 docs/MOBILE.md。
单账号自有设备使用；不包含任何账号、密码、设备身份、模型凭证或测试资料。
