# 致谢与第三方许可

大狗Office 基于 [genspark-ai/genoffice](https://github.com/genspark-ai/genoffice) 构建，感谢 GenOffice 上游团队在编辑引擎、文件格式处理与桌面集成方面的工作。

大狗Office 在此基础上进行了品牌、全局 Agent、工具调用与审批、模型设置和发布通道等适配。本仓库仅用于公开介绍和分发安装包，不发布应用源码或内部构建流程。

GenOffice 的 Apache-2.0 许可及其他第三方组件的版权、许可和声明继续适用于对应组件。安装包内包含第三方许可说明（`THIRD-PARTY-NOTICES.txt`、`LICENSES.chromium.html` 等）；本说明不改变第三方组件的许可，也不代表上游对本产品提供背书。

移动端界面结构和视觉方式参照 [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go)，以 uni-app 独立实现并接入大狗能力；未分发其 Flutter 应用、手机自动化或 PRoot 引擎。远程传输复用独立的 MIT [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)。电脑操作复用 [Cua SDK](https://github.com/trycua/cua) 驱动，原生 RTC、扫码、PDF 等组件的许可证与对应来源随安装包提供。上述组件分别适用各自许可，不改变其原有版权和源码获取权利。
