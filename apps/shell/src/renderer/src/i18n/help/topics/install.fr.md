# Installer BigDogOffice

Téléchargez BigDogOffice depuis la [page des versions](https://github.com/whdite/bdOffice/releases). Les plateformes, architectures et informations de signature disponibles sont précisées pour chaque version ; utilisez les fichiers qui lui sont joints.

## Choisir le fichier pour votre machine

| Plateforme                           | Prérequis                                             | Fichier                         |
| ------------------------------------ | ----------------------------------------------------- | ------------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)                  |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                    |
| **Windows** — la plupart des PC      | Windows 10+, Intel/AMD                                | installateur `-x64-Setup.exe`   |
| **Windows** sur Arm                  | Windows 11 sur Arm (Snapdragon X et similaires)       | installateur `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 ou plus récent)     | `.deb`                          |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                          |
| **Linux** — tout le reste            | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                     |

Les versions antérieures restent sur la page Releases.

## Sous macOS

Ouvrez le `.dmg` et faites glisser **BigDogOffice** dans Applications. Sur une version Intel, le premier lancement demande de confirmer l’ouverture : clic droit sur l’application dans Applications ▸ Ouvrir. C’est Gatekeeper qui rencontre une image disque sans signature, pas un téléchargement endommagé.

## Sous Windows

Lancez l’installeur `.exe`. Il place BigDogOffice dans le menu Démarrer et enregistre `.docx`, `.xlsx`, `.pptx`, `.pdf` et formats voisins, si bien qu’un double-clic sur un fichier l’ouvre.

## Sous Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — s’exécute sur place, sans étape d’installation :

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Il lui faut l’environnement d’exécution FUSE 2. Si vous préférez ne pas l’installer, lancez-le avec `--appimage-extract-and-run` : le bac à sable fonctionne alors depuis le répertoire extrait.

## Le build que vous exécutez

**Paramètres ▸ À propos** est l'endroit où l'application indique le build que vous avez, le canal qu'elle suit et où se trouve le projet. Lorsqu'un build plus récent est publié sur ce canal, le même volet propose la mise à jour ; une installation Flatpak, Nix ou Docker ne le fait pas, car elle est remplacée par l'outil qui l'a mise là.

## La ligne de commande est incluse

Chaque installation livre une commande `bigdogoffice` qui parle aux mêmes moteurs que la fenêtre : les deux ne peuvent donc pas se contredire sur un fichier. Sous macOS et Windows, elle se trouve dans le bundle de l’application ; `bigdogoffice install-cli` la met sur votre `PATH`. Pour ce qu’elle sait faire, voir **Ligne de commande et agents**.
