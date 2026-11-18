# تثبيت BigDogOffice

نزّل BigDogOffice من [صفحة الإصدارات](https://github.com/whdite/bdOffice/releases). تُذكر المنصات والمعماريات ومعلومات التوقيع المتاحة لكل إصدار؛ استخدم الملفات المرفقة بذلك الإصدار.

## اختر الملف المناسب لجهازك

| النظام                               | المتطلبات                                             | الملف                   |
| ------------------------------------ | ----------------------------------------------------- | ----------------------- |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)          |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)            |
| **Windows** — معظم أجهزة PC          | Windows 10+، Intel/AMD                                | حزمة `-x64-Setup.exe`   |
| **Windows** على Arm                  | Windows 11 على Arm (Snapdragon X وما شابه)            | حزمة `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64، glibc 2.34+ (Ubuntu 22.04 أو أحدث)            | `.deb`                  |
| **Linux** — Fedora / RHEL / openSUSE | x86_64، glibc 2.34+ (Fedora 35+، RHEL 9+، Leap 15.6+) | `.rpm`                  |
| **Linux** — أي شيء آخر               | x86_64، glibc 2.34+، FUSE 2                           | `.AppImage`             |

تبقى الإصدارات الأقدم على صفحة الإصدارات.

## على macOS

افتح ملف `.dmg` واسحب **BigDogOffice** إلى مجلد التطبيقات. وفي نسخة Intel يطلب منك أول تشغيل تأكيد الفتح: انقر نقرًا يمينًا على التطبيق داخل التطبيقات ▸ فتح. هذا Gatekeeper أمام صورة قرص تبدو غير موقّعة، لا تنزيلًا تالفًا.

## على Windows

شغّل حزمة التثبيت `.exe`. فهي تضع BigDogOffice في قائمة ابدأ وتسجّل `.docx` و`.xlsx` و`.pptx` و`.pdf` وما شابهها، بحيث يفتح الملف بالنقر المزدوج.

## على Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — يعمل من مكانه، بلا خطوة تثبيت:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

يحتاج إلى بيئة تشغيل FUSE 2. وإن لم تكن ترغب في تثبيتها فشغّله مع `--appimage-extract-and-run`، وتعمل البيئة المعزولة من المجلد المستخرج.

## النسخة التي تشغّلها

**الإعدادات ▸ حول** هو المكان الذي يبلّغ فيه التطبيق عن نسختك، والقناة التي يتبعها، وموقع المشروع. فحين تُنشر نسخة أحدث على تلك القناة، تعرض اللوحة نفسها التحديث؛ أما تثبيت Flatpak أو Nix أو Docker فلا يفعل، لأن الأداة التي وضعته هناك تستبدله.

## سطر الأوامر يأتي معه

كل تثبيت يشحن أمر `bigdogoffice` يتحدث إلى المحركات نفسها التي تستخدمها النافذة، فلا يتناقض الطرفان حول أي ملف. وعلى macOS وWindows يوجد داخل حزمة التطبيق؛ و`bigdogoffice install-cli` يضعه في `PATH` لديك. انظر **سطر الأوامر والوكلاء** لمعرفة ما يمكنه فعله.
