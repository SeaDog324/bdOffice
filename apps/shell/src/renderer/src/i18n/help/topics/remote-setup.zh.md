# 手机协作配置

## 启动协调服务

使用 Node.js 24 和 Docker，在开源工程根目录生成运行包。

```sh
npm ci
npm run remote:package
cp apps/remote-server/.env.example apps/remote-server/.env
```

在本地 `.env` 中设置 `REMOTE_ACCOUNT` 和随机的 `REMOTE_PASSWORD`。启动服务并保留持久化数据卷。

```sh
docker compose --env-file apps/remote-server/.env -f apps/remote-server/compose.yaml up -d --build
```

本机监听 `127.0.0.1:48300`。供其他设备连接时，请配置能从对应设备访问的服务地址。公网部署使用 TLS，按 `compose.yaml` 的公开部署配置启用 Caddy 和 TURN。

## 连接桌面和手机

在源码目录外新建配置 JSON，填写部署地址与自己设置的账号、密码和初始配对码。把环境变量 `BIGDOG_REMOTE_CONFIG` 指向该文件，再启动桌面应用。

```json
{
  "serverUrl": "http://127.0.0.1:48300",
  "account": "your-account@example.com",
  "password": "YOUR_OWN_PASSWORD",
  "name": "My desktop",
  "pairingCode": "YOUR_RANDOM_INITIAL_INVITATION"
}
```

在「设置 → 手机协作」确认桌面连接状态，生成二维码。用手机端扫码或粘贴完整配对码，核对电脑名称后确认连接。执行任务时保持桌面应用可用。
