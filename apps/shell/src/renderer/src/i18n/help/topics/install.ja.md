# BigDogOffice のインストール

[リリースページ](https://github.com/whdite/bdOffice/releases)から BigDogOffice をダウンロードしてください。対応するプラットフォーム、アーキテクチャ、署名情報は各リリースの説明を確認し、そのリリースに添付されたファイルを使用してください。

## 自分のマシンに合わせてファイルを選ぶ

| プラットフォーム                     | 必要なもの                                             | ファイル                          |
| ------------------------------------ | ------------------------------------------------------ | --------------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                              | `.dmg` (arm64)                    |
| **macOS** — Intel                    | macOS 11+                                              | `.dmg` (x64)                      |
| **Windows** — ほとんどの PC          | Windows 10+、Intel/AMD                                 | `-x64-Setup.exe` インストーラー   |
| **Windows** on Arm                   | Arm 版の Windows 11（Snapdragon X など）               | `-arm64-Setup.exe` インストーラー |
| **Linux** — Debian / Ubuntu          | x86_64、glibc 2.34+（Ubuntu 22.04 以降）               | `.deb`                            |
| **Linux** — Fedora / RHEL / openSUSE | x86_64、glibc 2.34+（Fedora 35+、RHEL 9+、Leap 15.6+） | `.rpm`                            |
| **Linux** — それ以外                 | x86_64、glibc 2.34+、FUSE 2                            | `.AppImage`                       |

古いバージョンは Releases ページにそのまま残っています。

## macOS で

`.dmg` を開いて **BigDogOffice** を Applications にドラッグします。Intel 版では初回起動時に開いてよいか確認されます。Applications でアプリを右クリック ▸ 開く の順です。これは未署名に見えるディスクイメージに対する Gatekeeper の動作で、ダウンロードの破損ではありません。

## Windows で

`.exe` インストーラーを実行します。BigDogOffice がスタートメニューに追加され、`.docx`、`.xlsx`、`.pptx`、`.pdf` などが登録されるので、ファイルをダブルクリックすれば開きます。

## Linux で

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — インストールはなしで、そのまま動きます：

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

FUSE 2 ランタイムが必要です。インストールしたくない場合は `--appimage-extract-and-run` を付けて実行してください。展開されたディレクトリーからサンドボックスが動作します。

## いま動かしているビルド

**設定 ▸ 情報** は、アプリが使っているビルド、追随しているチャンネル、プロジェクトが置かれている場所をアプリが示す場所です。そのチャンネルに新しいビルドが公開されると、同じペインが更新を提案します。Flatpak、Nix、Docker でインストールした場合には提案しません。それらを設置したツールが置き換えるものだからです。

## コマンドラインも同梱されています

どのインストールにも `bigdogoffice` コマンドが含まれ、ウィンドウと同じエンジンを動かします。同じファイルをどちらがどう扱うかが変わることがないので、意见が分かれることはありません。macOS と Windows ではアプリバンドルの中にあり、`bigdogoffice install-cli` で `PATH` に追加できます。何ができるかは **コマンドラインとエージェント** を参照してください。
