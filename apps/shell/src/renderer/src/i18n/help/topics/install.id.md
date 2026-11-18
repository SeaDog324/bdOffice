# Memasang BigDogOffice

Unduh BigDogOffice dari [halaman rilis](https://github.com/whdite/bdOffice/releases). Platform, arsitektur, dan informasi tanda tangan tersedia dalam catatan setiap rilis; gunakan berkas yang dilampirkan pada rilis tersebut.

## Pilih berkas untuk komputer Anda

| Platform                             | Kebutuhan                                             | Berkas                       |
| ------------------------------------ | ----------------------------------------------------- | ---------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)               |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                 |
| **Windows** — kebanyakan PC          | Windows 10+, Intel/AMD                                | installer `-x64-Setup.exe`   |
| **Windows** di Arm                   | Windows 11 di Arm (Snapdragon X dan sejenisnya)       | installer `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 atau lebih baru)    | `.deb`                       |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                       |
| **Linux** — lainnya                  | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                  |

Versi lama tetap ada di halaman Rilis.

## Di macOS

Buka `.dmg` lalu seret **BigDogOffice** ke Applications. Pada build Intel, peluncuran pertama meminta Anda mengonfirmasi pembukaan: klik kanan aplikasinya di Applications ▸ Buka. Itu Gatekeeper bertemu citra disk yang tampak tidak ditandatangani, bukan unduhan yang rusak.

## Di Windows

Jalankan installer `.exe`. Ia menaruh BigDogOffice di menu Start dan mendaftarkan `.docx`, `.xlsx`, `.pptx`, `.pdf` dan sejenisnya sehingga klik ganda pada berkas langsung membukanya.

## Di Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — berjalan di mana pun diletakkan, tanpa langkah pemasangan:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Ia membutuhkan runtime FUSE 2. Jika Anda lebih suka tidak memasangnya, jalankan dengan `--appimage-extract-and-run` dan sandbox tetap berjalan dari direktori hasil ekstrak.

## Build yang sedang Anda jalankan

**Pengaturan ▸ Tentang** adalah tempat aplikasi melaporkan build yang Anda pakai, kanal yang diikutinya, dan letak proyeknya. Ketika build yang lebih baru diterbitkan di kanal itu, panel yang sama menawarkan pembaruan; instalasi Flatpak, Nix, atau Docker tidak, karena semuanya digantikan oleh alat yang memasang mereka di sana.

## Baris perintahnya sudah ikut

Setiap pemasangan membawa perintah `bigdogoffice` yang berbicara dengan mesin yang sama dengan jendela, sehingga keduanya tidak pernah berbeda pendapat tentang sebuah berkas. Di macOS dan Windows perintahnya berada di dalam bundel aplikasi; `bigdogoffice install-cli` menaruhnya di `PATH` Anda. Lihat **Perintah baris perintah dan agen** untuk mengetahui apa saja yang dapat dilaukannya.
