<p align="center"><img src="assets/bigdog-office.png" width="112" alt="大狗Office"></p>

# 大狗Office · BigDogOffice

大狗Office 是一款开源的本地 AI 办公应用。桌面端支持编辑 DOCX、XLSX、PPTX、PDF、Markdown 和 HTML，并在同一处处理对话、任务和文件成果。Android 客户端连接桌面后，可以继续会话、确认任务和查看文件。

[官方网站](https://bdoffice.deepthink-x.com/) · [下载安装包](https://bdoffice.deepthink-x.com/updates) · [GitHub Releases](https://github.com/whdite/bdOffice/releases) · [Apache-2.0 许可证](LICENSE)

## 安装与使用

- 从官网或 GitHub Releases 选择适合系统和架构的安装包。[下载与签名说明](DOWNLOADS.md) · [更新日志](CHANGELOG.md)
- 在「设置 → 模型」连接所选 AI 服务。打开文件便可交代编辑任务，或在 AI 大狗中处理跨文件工作。[模型与本地数据配置](docs/CONFIGURATION.md)
- 在电脑的「设置 → 手机协作」打开配置说明，连接自部署服务，再用 Android 客户端扫码配对。[Android 使用说明](docs/MOBILE.md) · [Remote 自部署](docs/REMOTE.md)

## 从源码构建

准备 Node.js 24、npm 10 或更新版本、支持 2024 Edition 的 Rust stable 和对应平台的原生构建工具。

```sh
git clone https://github.com/whdite/bdOffice.git
cd bdOffice
npm ci
npm run typecheck
npm run build:all
npm exec -- electron apps/shell
```

首次构建完成后，可用 `npm run dev` 启动开发环境。[桌面、Android 与 Remote 构建说明](docs/BUILD.md)

## 工程结构

| 目录 | 内容 |
| --- | --- |
| `apps/shell` | Electron 桌面端、AI 大狗、设置和任务调度 |
| `apps/docs`、`sheets`、`slides`、`pdf`、`markdown`、`html` | 桌面编辑器 |
| `apps/mobile` | uni-app 界面与 Android 原生容器 |
| `apps/remote-server` | 自部署认证、连接中继和离线消息服务 |
| `packages` | 文件引擎、模型适配、会话存储、远程传输、电脑操作工具和 CLI |
| `skills` | 随项目提供的办公自动化指引 |

[架构说明](docs/ARCHITECTURE.md) · [命令行工具](packages/cli/README.md) · [隐私说明](PRIVACY.md) · [贡献指南](CONTRIBUTING.md) · [安全问题报告](SECURITY.md)

## 许可证与致谢

大狗Office 项目源码采用 Apache License 2.0。第三方组件按各自的许可证分发，并保留原有版权和归属说明。[LICENSE](LICENSE) · [NOTICE](NOTICE) · [上游与第三方致谢](ACKNOWLEDGEMENTS.md)
