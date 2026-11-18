# Installare BigDogOffice

Scarica BigDogOffice dalla [pagina delle versioni](https://github.com/whdite/bdOffice/releases). Piattaforme, architetture e informazioni sulla firma disponibili sono indicate per ogni versione; usa i file allegati a quella versione.

## Scegli il file giusto per il tuo computer

| Piattaforma                           | Requisiti                                             | File                                          |
| ------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| **macOS** — Apple Silicon             | macOS 11+                                             | `.dmg` (arm64)                                |
| **macOS** — Intel                     | macOS 11+                                             | `.dmg` (x64)                                  |
| **Windows** — la maggior parte dei PC | Windows 10+, Intel/AMD                                | programma di installazione `-x64-Setup.exe`   |
| **Windows** su Arm                    | Windows 11 on Arm (Snapdragon X e simili)             | programma di installazione `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu           | x86_64, glibc 2.34+ (Ubuntu 22.04 o successivo)       | `.deb`                                        |
| **Linux** — Fedora / RHEL / openSUSE  | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                                        |
| **Linux** — qualsiasi altra cosa      | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                                   |

Le versioni più vecchie restano sulla pagina Releases.

## Su macOS

Apri il file `.dmg` e trascina **BigDogOffice** in Applicazioni. Su una build Intel il primo avvio ti chiede di confermare l'apertura: fai clic con il tasto destro sull'app in Applicazioni ▸ Apri. Non è un download danneggiato: è Gatekeeper che incontra un'immagine disco che sembra non firmata.

## Su Windows

Esegui il programma di installazione `.exe`. Inserisce BigDogOffice nel menu Start e registra `.docx`, `.xlsx`, `.pptx`, `.pdf` e simili, così un doppio clic su un file lo apre.

## Su Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — funziona da dove si trova, senza alcuna fase di installazione:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Richiede il runtime FUSE 2. Se preferisci non installarlo, avvialo con `--appimage-extract-and-run`: la sandbox funziona dalla directory estratta.

## La build che stai eseguendo

**Impostazioni ▸ Informazioni** è dove l'app riporta la build che hai, il canale che segue e dove vive il progetto. Quando una build più recente viene pubblicata su quel canale, lo stesso pannello offre l'aggiornamento; un'installazione Flatpak, Nix o Docker non lo fa, perché è quella che l'ha messa lì a sostituirla.

## La riga di comando è inclusa

Ogni installazione include il comando `bigdogoffice`, che comunica con gli stessi motori della finestra, così i due non si contraddicono mai su un file. Su macOS e Windows si trova dentro il bundle dell'app; `bigdogoffice install-cli` lo mette sul tuo `PATH`. Vedi **Riga di comando e agenti** per scoprire cosa può fare.
