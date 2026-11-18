# 安装 大狗Office

请从[发行页面](https://github.com/whdite/bdOffice/releases)下载大狗Office。可用平台、架构及签名信息以各版本说明为准，请选择该版本实际附带的安装文件。

## 选择适合你机器的文件

| 平台                                 | 需求                                                   | 文件                      |
| ------------------------------------ | ------------------------------------------------------ | ------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                              | `.dmg` (arm64)            |
| **macOS** — Intel                    | macOS 11+                                              | `.dmg` (x64)              |
| **Windows** — 大多数 PC              | Windows 10+、Intel/AMD                                 | `-x64-Setup.exe` 安装包   |
| **Windows** on Arm                   | Arm 版 Windows 11（Snapdragon X 等）                   | `-arm64-Setup.exe` 安装包 |
| **Linux** — Debian / Ubuntu          | x86_64、glibc 2.34+（Ubuntu 22.04 或更新）             | `.deb`                    |
| **Linux** — Fedora / RHEL / openSUSE | x86_64、glibc 2.34+（Fedora 35+、RHEL 9+、Leap 15.6+） | `.rpm`                    |
| **Linux** — 其他                     | x86_64、glibc 2.34+、FUSE 2                            | `.AppImage`               |

旧版本仍保留在 Releases 页面上。

## 在 macOS 上

打开 `.dmg`，把 **大狗Office** 拖进「应用程序」文件夹。Intel 版首次启动时会请你确认打开：在「应用程序」里右键点这个应用 ▸ 打开。这只是 Gatekeeper 遇到一个看起来未签名的磁盘映像，并不是下载损坏。

## 在 Windows 上

运行 `.exe` 安装程序。它会把 大狗Office 放进开始菜单，并注册 `.docx`、`.xlsx`、`.pptx`、`.pdf` 等格式，双击文件就会用 大狗Office 打开。

## 在 Linux 上

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — 免安装，放在哪儿就在哪儿运行：

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

它需要 FUSE 2 运行时。如果不想安装它，可以用 `--appimage-extract-and-run` 来运行，沙箱会从解压出来的目录工作。

## 你正在运行的构建

**设置 ▸ 关于** 是应用报告你所用的构建、它跟随的更新渠道以及项目所在地的地方。当该渠道上发布了更新的构建时，同一个面板会提示更新；Flatpak、Nix 或 Docker 安装则不会，因为这些安装会被当初装上它们的工具替换掉。

## 命令行随包附带

每个安装版本都带一个 `bigdogoffice` 命令，它和窗口调用的是同一套引擎，因此两者对同一个文件不会给出不同的结果。在 macOS 和 Windows 上它位于应用包内；`bigdogoffice install-cli` 会把它放进你的 `PATH`。它能做什么，见**命令行与代理**。
