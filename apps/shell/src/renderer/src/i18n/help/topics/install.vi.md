# Cài đặt BigDogOffice

Tải BigDogOffice từ [trang phát hành](https://github.com/whdite/bdOffice/releases). Nền tảng, kiến trúc và thông tin chữ ký có sẵn được nêu trong từng bản phát hành; hãy dùng các tệp đính kèm của bản đó.

## Chọn tệp cho máy của bạn

| Nền tảng                             | Yêu cầu                                               | Tệp                              |
| ------------------------------------ | ----------------------------------------------------- | -------------------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)                   |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)                     |
| **Windows** — hầu hết PC             | Windows 10+, Intel/AMD                                | trình cài đặt `-x64-Setup.exe`   |
| **Windows** trên Arm                 | Windows 11 trên Arm (Snapdragon X và tương tự)        | trình cài đặt `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 hoặc mới hơn)       | `.deb`                           |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                           |
| **Linux** — thứ khác                 | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`                      |

Các bản cũ hơn vẫn nằm trên trang phát hành.

## Trên macOS

Mở tệp `.dmg` rồi kéo **BigDogOffice** vào Applications. Với bản dựng Intel, lần chạy đầu tiên sẽ yêu cầu bạn xác nhận việc mở: nhấp phải vào ứng dụng trong Applications ▸ Mở. Đó là Gatekeeper gặp một đĩa ảnh trông như không có chữ ký, chứ không phải tệp tải về bị hỏng.

## Trên Windows

Chạy trình cài đặt `.exe`. Nó đưa BigDogOffice vào menu Start và đăng ký `.docx`, `.xlsx`, `.pptx`, `.pdf` cùng các định dạng tương tự, để nhấp đúp vào một tệp là mở được tệp đó.

## Trên Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — chạy ngay tại chỗ, không cần bước cài đặt:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

Nó cần môi trường chạy FUSE 2. Nếu bạn không muốn cài đặt, hãy chạy với `--appimage-extract-and-run`, và hộp cát sẽ hoạt động từ thư mục đã giải nén.

## Bản dựng bạn đang chạy

**Cài đặt ▸ Giới thiệu** là nơi ứng dụng báo bạn đang có bản dựng nào, đang theo kênh nào và dự án nằm ở đâu. Khi bản dựng mới hơn được phát hành trên kênh đó, chính bảng đó sẽ đề nghị cập nhật; bản cài đặt qua Flatpak, Nix hoặc Docker thì không, vì bị công cụ đã cài chúng thay thế.

## Dòng lệnh đi kèm luôn

Mọi bản cài đặt đều kèm lệnh `bigdogoffice` nói chuyện với đúng những engine mà cửa sổ dùng, nên cả hai không bao giờ bất đồng về một tệp. Trên macOS và Windows nó nằm trong gói ứng dụng; và `bigdogoffice install-cli` đưa nó vào `PATH` của bạn. Xem **Dòng lệnh và tác nhân** để biết nó làm được gì.
