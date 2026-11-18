# BigDogOffice 설치

[릴리스 페이지](https://github.com/whdite/bdOffice/releases)에서 BigDogOffice를 다운로드하세요. 지원 플랫폼, 아키텍처 및 서명 정보는 각 릴리스 설명을 확인하고 해당 릴리스에 첨부된 파일을 사용하세요.

## 내 컴퓨터에 맞는 파일 고르기

| 플랫폼                               | 필요한 것                                            | 파일                             |
| ------------------------------------ | ---------------------------------------------------- | -------------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                            | `.dmg` (arm64)                   |
| **macOS** — Intel                    | macOS 11+                                            | `.dmg` (x64)                     |
| **Windows** — 대부분의 PC            | Windows 10+, Intel/AMD                               | `-x64-Setup.exe` 설치 프로그램   |
| **Windows** on Arm                   | Arm 버전 Windows 11(Snapdragon X 등)                 | `-arm64-Setup.exe` 설치 프로그램 |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+(Ubuntu 22.04 이상)               | `.deb`                           |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+(Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                           |
| **Linux** — 그 외                    | x86_64, glibc 2.34+, FUSE 2                          | `.AppImage`                      |

이전 버전은 Releases 페이지에 그대로 남아 있습니다.

## macOS에서

`.dmg`을 열고 **BigDogOffice**를 Applications로 끌어다 놓습니다. Intel 빌드에서는 첫 실행 때 열기 확인을 요구합니다. Applications에서 앱을 오른쪽 클릭하고 ▸ 열기 하세요. 이건 손상된 다운로드가 아니라, 서명되지 않은 것처럼 보이는 디스크 이미지를 만난 Gatekeeper의 동작입니다.

## Windows에서

`.exe` 설치 프로그램을 실행합니다. BigDogOffice를 시작 메뉴에 넣고 `.docx`, `.xlsx`, `.pptx`, `.pdf` 등을 등록해서, 파일을 두 번 클릭하면 열립니다.

## Linux에서

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — 설치 단계 없이, 그 자리에서 실행됩니다:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

FUSE 2 런타임이 필요합니다. 설치하기를 꺼리면 `--appimage-extract-and-run`으로 실행하세요. 풀린 디렉터리에서 샌드박스가 동작합니다.

## 지금 실행 중인 빌드

**설정 ▸ 정보**는 앱이 지금 가진 빌드, 따르는 업데이트 채널, 프로젝트가 있는 곳을 보고하는 곳입니다. 그 채널에 더 새 빌드가 올라오면 같은 패널이 그 업데이트를 제안합니다. Flatpak, Nix, Docker로 설치한 경우에는 제안하지 않습니다. 그 설치들을 놓아 준 도구가 대신 교체하기 때문입니다.

## 명령줄도 함께 옵니다

모든 설치본에는 `bigdogoffice` 명령이 들어 있고, 창이 쓰는 바로 그 엔진을 구동합니다. 같은 파일에 대한 둘의 판단이 어긋날 일은 없습니다. macOS와 Windows에서는 앱 번들 안에 있으며, `bigdogoffice install-cli`로 `PATH`에 넣습니다. 무엇을 할 수 있는지는 **명령줄과 에이전트**를 보세요.
