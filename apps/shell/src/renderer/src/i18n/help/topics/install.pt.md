# Instalar o BigDogOffice

Baixe o BigDogOffice na [página de versões](https://github.com/whdite/bdOffice/releases). As plataformas, arquiteturas e informações de assinatura disponíveis são indicadas em cada versão; use os arquivos anexados a ela.

## Escolher o ficheiro para a sua máquina

| Plataforma                           | Requisitos                                            | Ficheiro                      |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)                |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                  |
| **Windows** — a maioria dos PC       | Windows 10+, Intel/AMD                                | instalador `-x64-Setup.exe`   |
| **Windows** em Arm                   | Windows 11 em Arm (Snapdragon X e semelhantes)        | instalador `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 ou mais recente)    | `.deb`                        |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                        |
| **Linux** — qualquer outra           | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                   |

As versões mais antigas permanecem na página de lançamentos.

## No macOS

Abra o `.dmg` e arraste o **BigDogOffice** para Aplicações. Numa compilação Intel, o primeiro arranque pede-lhe que confirme a abertura: clique com o botão direito na aplicação em Aplicações ▸ Abrir. Isso é o Gatekeeper a encontrar uma imagem de disco sem assinatura aparente, não uma transferência danificada.

## No Windows

Execute o instalador `.exe`. Ele coloca o BigDogOffice no menu Iniciar e regista `.docx`, `.xlsx`, `.pptx`, `.pdf` e afins, para que um clique duplo num ficheiro o abra.

## No Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — corre de onde está, sem passo de instalação:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Precisa do runtime FUSE 2. Se preferir não o instalar, execute-o com `--appimage-extract-and-run` e a sandbox funciona a partir do diretório extraído.

## A versão que está a executar

**Configurações ▸ Sobre** é onde a aplicação comunica a versão que tem, o canal que segue e onde vive o projeto. Quando é publicada uma versão mais recente nesse canal, o mesmo painel oferece a atualização; uma instalação por Flatpak, Nix ou Docker não o faz, porque essas são substituídas pela ferramenta que as lá colocou.

## A linha de comandos vem de brinde

Todas as instalações incluem um comando `bigdogoffice` que fala com os mesmos motores que a janela usa, por isso os dois nunca discordam sobre um ficheiro. Em macOS e Windows está dentro do pacote da aplicação; e `bigdogoffice install-cli` coloca-o no seu `PATH`. Consulte **Linha de comandos e agentes** para saber o que ele sabe fazer.
