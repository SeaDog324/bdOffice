# BigDogOffice'i yükleme

BigDogOffice uygulamasını [sürüm sayfasından](https://github.com/whdite/bdOffice/releases) indirin. Mevcut platformlar, mimariler ve imza bilgileri her sürümde belirtilir; o sürüme eklenen dosyaları kullanın.

## Makineniz için doğru dosyayı seçin

| Platform                             | Gereksinimler                                         | Dosya                          |
| ------------------------------------ | ----------------------------------------------------- | ------------------------------ |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)                 |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                   |
| **Windows** — çoğu PC                | Windows 10+, Intel/AMD                                | `-x64-Setup.exe` yükleyicisi   |
| Arm üzerinde **Windows**             | Arm üzerinde Windows 11 (Snapdragon X ve benzerleri)  | `-arm64-Setup.exe` yükleyicisi |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 veya daha yeni)     | `.deb`                         |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                         |
| **Linux** — diğerleri                | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                    |

Eski sürümler Sürümler sayfasında kalmaya devam eder.

## macOS'te

`.dmg` dosyasını açın ve **BigDogOffice**'i Uygulamalar klasörüne sürükleyin. Intel derlemesinde ilk açılışta uygulamayı açmayı onaylamanız istenir: Uygulamalar'da uygulamaya sağ tıklayın ▸ Aç. Bu, Gatekeeper'ın imzasız görünen bir disk görüntüsüyle karşılaşmasıdır; bozuk bir indirme değildir.

## Windows'ta

`.exe` yükleyicisini çalıştırın. BigDogOffice'i Başlat menüsüne ekler ve `.docx`, `.xlsx`, `.pptx`, `.pdf` ve benzeri uzantıları kaydeder; böylece bir dosyaya çift tıklamak onu açar.

## Linux'ta

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — bulunduğu yerden, yükleme adımı olmadan çalışır:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

FUSE 2 çalışma zamanına ihtiyaç duyar. Onu yüklemek istemiyorsanız `--appimage-extract-and-run` ile çalıştırın; korumalı alan, çıkarılan dizinden çalışır.

## Çalıştırdığınız derleme

**Ayarlar ▸ Hakkında**, uygulamanın sahip olduğunuz derlemeyi, izlediği kanalı ve projenin nerede bulunduğunu bildirdiği yerdir. O kanalda daha yeni bir derleme yayımlandığında aynı bölme güncellemeyi sunar; Flatpak, Nix veya Docker kurulumu sunmaz, çünkü bunlar onları yerleştiren araç tarafından değiştirilir.

## Komut satırı da birlikte gelir

Her kurulum, pencerenin konuştuğu motorlarla aynı motorlarla konuşan bir `bigdogoffice` komutuyla gelir; böylece ikisi bir dosya hakkında asla anlaşmazlığa düşmez. macOS ve Windows'ta uygulama paketinin içindedir; `bigdogoffice install-cli` onu `PATH` değişkeninize ekler. Neler yapabildiği için **Komut satırı ve aracılar** bölümüne bakın.
