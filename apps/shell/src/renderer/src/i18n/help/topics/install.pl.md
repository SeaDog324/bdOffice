# Instalacja BigDogOffice

Pobierz BigDogOffice ze [strony wydań](https://github.com/whdite/bdOffice/releases). Dostępne platformy, architektury i informacje o podpisie podano dla każdego wydania; użyj dołączonych do niego plików.

## Wybierz plik dla swojego komputera

| Platforma                            | Wymagania                                             | Plik                          |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)                |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                  |
| **Windows** — większość komputerów   | Windows 10+, Intel/AMD                                | instalator `-x64-Setup.exe`   |
| **Windows** na Arm                   | Windows 11 on Arm (Snapdragon X i podobne)            | instalator `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 lub nowsze)         | `.deb`                        |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                        |
| **Linux** — wszystko inne            | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                   |

Starsze wersje pozostają na stronie Releases.

## W systemie macOS

Otwórz plik `.dmg` i przeciągnij **BigDogOffice** do katalogu Aplikacje. W kompilacji Intel przy pierwszym uruchomieniu trzeba potwierdzić otwarcie: kliknij prawym przyciskiem aplikację w Aplikacjach ▸ Otwórz. To Gatekeeper reaguje na obraz dysku wyglądający na niepodpisany, a nie uszkodzone pobranie.

## W systemie Windows

Uruchom instalator `.exe`. Umieszcza BigDogOffice w menu Start i rejestruje `.docx`, `.xlsx`, `.pptx`, `.pdf` i podobne, więc dwuklik na plik go otwiera.

## W systemie Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — działa tam, gdzie leży, bez żadnego etapu instalacji:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Wymaga środowiska uruchomieniowego FUSE 2. Jeśli wolisz go nie instalować, uruchom go z `--appimage-extract-and-run`, a sandbox zadziała z katalogu wypakowanego.

## Kompilacja, którą uruchamiasz

**Ustawienia ▸ O aplikacji** to miejsce, w którym aplikacja zgłasza posiadaną kompilację, kanał, za którym podąża, i to, gdzie mieszka projekt. Gdy na tym kanale pojawi się nowsza kompilacja, to samo okno zaproponuje aktualizację; instalacja przez Flatpak, Nix albo Docker tego nie robi, bo zastępuje je narzędzie, które je tam umieściło.

## Wiersz poleceń jest w zestawie

Każda instalacja zawiera polecenie `bigdogoffice`, które komunikuje się z tymi samymi silnikami co okno, więc nigdy nie rozbieżą się w ocenie pliku. W systemach macOS i Windows znajduje się w pakiecie aplikacji; `bigdogoffice install-cli` umieszcza je w `PATH`. Co potrafi, dowiesz się w rozdziale **Wiersz poleceń i agenci**.
