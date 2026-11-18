# Installing BigDogOffice

Download BigDogOffice from the [Releases page](https://github.com/whdite/bdOffice/releases). Available platforms, architectures and signing information are listed for each release; use the files attached to that release.

## Pick the file for your machine

| Platform                             | Requirements                                          | File                         |
| ------------------------------------ | ----------------------------------------------------- | ---------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)               |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                 |
| **Windows** — most PCs               | Windows 10+, Intel/AMD                                | `-x64-Setup.exe` installer   |
| **Windows** on Arm                   | Windows 11 on Arm (Snapdragon X and similar)          | `-arm64-Setup.exe` installer |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 or newer)           | `.deb`                       |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                       |
| **Linux** — anything else            | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                  |

Older versions stay on the Releases page.

## On macOS

Open the `.dmg` and drag **BigDogOffice** into Applications. On an Intel build the first launch asks you to confirm opening it: right-click the app in Applications ▸ Open. That is Gatekeeper meeting an unsigned-seeming disk image, not a damaged download.

## On Windows

Run the `.exe` installer. It puts BigDogOffice in the Start menu and registers `.docx`, `.xlsx`, `.pptx`, `.pdf` and friends so double-clicking a file opens it.

## On Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — runs where it is, with no install step:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

It needs the FUSE 2 runtime. If you would rather not install it, run it with `--appimage-extract-and-run` and the sandbox works from the extracted directory.

## The build you are running

**Settings ▸ About** is where the app reports the build you have, the channel it follows and where the project lives. When a newer build is published on that channel, the same pane offers the update; a Flatpak, Nix or Docker install does not, because those are replaced by the tool that put them there.

## The command line comes with it

Every install ships a `bigdogoffice` command that talks to the same engines the window does, so the two never disagree about a file. On macOS and Windows it is inside the app bundle; `bigdogoffice install-cli` puts it on your `PATH`. See **Command line and agents** for what it can do.
