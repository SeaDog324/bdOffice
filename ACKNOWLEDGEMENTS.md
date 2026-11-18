# 致谢与第三方许可

大狗Office 基于 [genspark-ai/genoffice](https://github.com/genspark-ai/genoffice) 构建，感谢 GenOffice 上游团队在编辑引擎、文件格式处理与桌面集成方面的工作。

大狗Office 在此基础上实现了 AI 大狗工作区、工具调用与审批、模型设置和发布通道等功能。项目源码采用 Apache License 2.0，构建说明随源码提供。[LICENSE](LICENSE) · [构建说明](docs/BUILD.md)

项目保留上游的 Apache-2.0 许可和归属声明。安装包内附第三方许可文件，包括 `THIRD-PARTY-NOTICES.txt` 和 `LICENSES.chromium.html`。各组件适用各自的许可。[NOTICE](NOTICE)

移动端使用 uni-app 实现，界面设计参考 dsh-Go。远程传输复用 MIT 许可的 ds-harness-remote。电脑操作复用 Cua SDK，原生 RTC、扫码和 PDF 组件的许可随安装包提供。[移动端设计溯源](apps/mobile/UI-PROVENANCE.md) · [远程传输溯源](packages/remote-core/UPSTREAM.md) · [Cua 组件声明](packages/computer-use/THIRD_PARTY.md)
