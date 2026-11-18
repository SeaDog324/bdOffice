# BigDogOffice installeren

Download BigDogOffice van de [releasepagina](https://github.com/whdite/bdOffice/releases). Beschikbare platforms, architecturen en ondertekeningsinformatie staan bij elke release; gebruik de bestanden die bij die release zijn gevoegd.

## Kies het bestand voor je computer

| Platform                             | Vereisten                                             | Bestand                         |
| ------------------------------------ | ----------------------------------------------------- | ------------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)                  |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                    |
| **Windows** — de meeste pc's         | Windows 10+, Intel/AMD                                | installateur `-x64-Setup.exe`   |
| **Windows** op Arm                   | Windows 11 on Arm (Snapdragon X en vergelijkbaar)     | installateur `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 of nieuwer)         | `.deb`                          |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                          |
| **Linux** — al het andere            | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                     |

Oudere versies blijven op de Releases-pagina staan.

## Op macOS

Open het `.dmg` en sleep **BigDogOffice** naar Programma's. Bij een Intel-build vraagt de eerste keer starten om bevestiging: klik met de rechtermuis op de app in Programma's ▸ Open. Dat is Gatekeeper die een schijfkopie tegenkomt die niet-ondertekend lijkt, geen beschadigde download.

## Op Windows

Voer de installateur `.exe` uit. Die zet BigDogOffice in het Startmenu en registreert `.docx`, `.xlsx`, `.pptx`, `.pdf` en soortgelijke, zodat een dubbelklik op een bestand het opent.

## Op Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — draait waar het staat, zonder installatiestap:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Het heeft de FUSE 2-runtime nodig. Wil je die niet installeren, start het dan met `--appimage-extract-and-run`; de sandbox werkt vanuit de uitgepakte map.

## De build die je draait

**Instellingen ▸ Over** is waar de app meldt welke build je hebt, welk kanaal hij volgt en waar het project woont. Zodra er een nieuwere build op dat kanaal verschijnt, biedt hetzelfde paneel die update aan; een Flatpak-, Nix- of Docker-installatie doet dat niet, omdat ze door het gereedschap dat ze daar heeft geplaatst worden vervangen.

## De opdrachtregel zit erbij

Elke installatie bevat een `bigdogoffice`-commando dat met dezelfde engines praat als het venster, zodat de twee nooit over een bestand het oneens zijn. Op macOS en Windows zit het in de app-bundel; `bigdogoffice install-cli` zet het in je `PATH`. Wat het kan doen, lees je in **Opdrachtregel en agents**.
