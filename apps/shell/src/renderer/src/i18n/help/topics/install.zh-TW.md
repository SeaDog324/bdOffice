# 安裝 大狗Office

請從[發行頁面](https://github.com/whdite/bdOffice/releases)下載大狗Office。可用平台、架構及簽章資訊以各版本說明為準，請選擇該版本實際附帶的安裝檔案。

## 選擇適合你電腦的檔案

| 平台                                 | 需求                                                   | 檔案                        |
| ------------------------------------ | ------------------------------------------------------ | --------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                              | `.dmg` (arm64)              |
| **macOS** — Intel                    | macOS 11+                                              | `.dmg` (x64)                |
| **Windows** — 大多數 PC              | Windows 10+、Intel/AMD                                 | `-x64-Setup.exe` 安裝程式   |
| **Windows** on Arm                   | Arm 版 Windows 11（Snapdragon X 之類）                 | `-arm64-Setup.exe` 安裝程式 |
| **Linux** — Debian / Ubuntu          | x86_64、glibc 2.34+（Ubuntu 22.04 或更新）             | `.deb`                      |
| **Linux** — Fedora / RHEL / openSUSE | x86_64、glibc 2.34+（Fedora 35+、RHEL 9+、Leap 15.6+） | `.rpm`                      |
| **Linux** — 其他                     | x86_64、glibc 2.34+、FUSE 2                            | `.AppImage`                 |

舊版本仍保留在 Releases 頁面上。

## 在 macOS 上

開啟 `.dmg`，把 **大狗Office** 拖進「應用程式」資料夾。Intel 版首次啟動時會請你確認開啟：在「應用程式」裡按右鍵點這個應用程式 ▸ 打開。這只是 Gatekeeper 遇到一個看起來未簽署的磁碟映像，並不是下載損毀。

## 在 Windows 上

執行 `.exe` 安裝程式。它會把 大狗Office 放進開始功能表，並註冊 `.docx`、`.xlsx`、`.pptx`、`.pdf` 等格式，按兩下檔案就會用 大狗Office 開啟。

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

**AppImage** — 免安裝，放在哪裡就在哪裡執行：

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

它需要 FUSE 2 執行環境。如果不想安裝它，可以用 `--appimage-extract-and-run` 來執行，沙箱會從解壓出來的目錄運作。

## 你正在執行的建置

**設定 ▸ 關於** 是應用程式回報你正在使用的建置版本、它跟隨的更新頻道，以及專案所在位置的地方。當該頻道發布了更新的建置版本時，同一個面板會提供更新；Flatpak、Nix 或 Docker 安裝則不會，因為這些安裝會被當初把它們裝上去的工具取代。

## 命令列隨著一起安裝

每次安裝都會附帶一個 `bigdogoffice` 命令，它與視窗呼叫的是同一套引擎，因此兩者對同一個檔案不會有分歧。在 macOS 與 Windows 上它位於應用程式套件內；`bigdogoffice install-cli` 會把它放進你的 `PATH`。它能做什麼，見**命令列與代理**。
