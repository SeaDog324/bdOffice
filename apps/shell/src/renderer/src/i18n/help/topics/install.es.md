# Instalar BigDogOffice

Descarga BigDogOffice desde la [página de versiones](https://github.com/whdite/bdOffice/releases). Consulta en cada versión las plataformas, arquitecturas y firmas disponibles y utiliza los archivos adjuntos a esa versión.

## Elija el archivo para su equipo

| Plataforma                           | Requisitos                                            | Archivo                       |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)                |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                  |
| **Windows** — la mayoría de los PC   | Windows 10+, Intel/AMD                                | instalador `-x64-Setup.exe`   |
| **Windows** en Arm                   | Windows 11 en Arm (Snapdragon X y similares)          | instalador `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 o posterior)        | `.deb`                        |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                        |
| **Linux** — cualquier otro           | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                   |

Las versiones anteriores siguen en la página de versiones.

## En macOS

Abra el `.dmg` y arrastre **BigDogOffice** a Aplicaciones. En una compilación para Intel, el primer arranque le pide confirmar la apertura: haga clic derecho en la aplicación dentro de Aplicaciones ▸ Abrir. Es Gatekeeper:topándose con una imagen de disco que parece no estar firmada, no una descarga dañada.

## En Windows

Ejecute el instalador `.exe`. Coloca BigDogOffice en el menú Inicio y registra `.docx`, `.xlsx`, `.pptx`, `.pdf` y formatos similares como aplicaciones predeterminadas, de modo que al hacer doble clic en un archivo este se abra en BigDogOffice.

## En Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — se ejecuta donde esté, sin ningún paso de instalación:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Necesita el entorno de ejecución de FUSE 2. Si prefiere no instalarlo, ejecútelo con `--appimage-extract-and-run` y el sandbox funcionará desde el directorio extraído.

## La compilación que está ejecutando

**Configuración ▸ Acerca de** es donde la aplicación informa de la compilación que tiene, del canal que sigue y de dónde vive el proyecto. Cuando se publica una compilación más reciente en ese canal, el mismo panel ofrece la actualización; una instalación de Flatpak, Nix o Docker no lo hace, porque la reemplaza la herramienta que la puso ahí.

## La línea de comandos viene incluida

Cada instalación trae un comando `bigdogoffice` que habla con los mismos motores que la ventana, de modo que ambos nunca discrepan sobre un archivo. En macOS y Windows está dentro del paquete de la aplicación; `bigdogoffice install-cli` lo pone en su `PATH`. Vea **Línea de comandos y agentes** para saber qué puede hacer.
