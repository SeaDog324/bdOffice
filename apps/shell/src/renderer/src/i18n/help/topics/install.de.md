# BigDogOffice installieren

Laden Sie BigDogOffice von der [Releases-Seite](https://github.com/whdite/bdOffice/releases) herunter. Verfügbare Plattformen, Architekturen und Signaturinformationen stehen bei der jeweiligen Version; verwenden Sie deren angehängte Dateien.

## Die Datei für Ihren Rechner wählen

| Plattform                            | Voraussetzungen                                       | Datei                                    |
| ------------------------------------ | ----------------------------------------------------- | ---------------------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)                           |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                             |
| **Windows** — die meisten PCs        | Windows 10+, Intel/AMD                                | `-x64-Setup.exe` Installationsprogramm   |
| **Windows** auf Arm                  | Windows 11 auf Arm (Snapdragon X und Ähnliches)       | `-arm64-Setup.exe` Installationsprogramm |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 oder neuer)         | `.deb`                                   |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                                   |
| **Linux** — alles andere             | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                              |

Ältere Versionen bleiben auf der Releases-Seite.

## Unter macOS

Öffnen Sie die `.dmg` und ziehen Sie **BigDogOffice** in Applications. Bei einem Intel-Build fragt der erste Start das Öffnen ab: Rechtsklick auf die App in Applications ▸ Öffnen. Das ist Gatekeeper bei einem scheinbar nicht signierten Datenträgerabbild und keine beschädigte Datei.

## Unter Windows

Führen Sie das Installationsprogramm `.exe` aus. Es legt BigDogOffice im Startmenü ab und registriert `.docx`, `.xlsx`, `.pptx`, `.pdf` und Verwandte, sodass ein Doppelklick auf eine Datei sie öffnet.

## Unter Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — läuft ohne Installationsschritt direkt von dort:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Er benötigt die FUSE-2-Laufzeit. Wenn Sie sie lieber nicht installieren, starten Sie ihn mit `--appimage-extract-and-run`; die Sandbox arbeitet dann aus dem entpackten Verzeichnis.

## Der Build, den Sie ausführen

**Einstellungen ▸ Über** ist der Ort, an dem die App meldet, welchen Build Sie haben, welchem Kanal sie folgt und wo das Projekt zu Hause ist. Sobald ein neuerer Build auf diesem Kanal erscheint, bietet derselbe Bereich die Aktualisierung an; eine Flatpak-, Nix- oder Docker-Installation tut das nicht, denn sie wird vom Werkzeug ersetzt, das sie dorthin gebracht hat.

## Die Kommandozeile ist dabei

Jede Installation bringt den Befehl `bigdogoffice` mit, der mit denselben Engines spricht wie das Fenster: Die beiden können sich bei einer Datei also nicht widersprechen. Unter macOS und Windows liegt er im App-Bundle; `bigdogoffice install-cli` legt ihn in Ihren `PATH`. Was er kann, steht in **Kommandozeile und Agenten**.
