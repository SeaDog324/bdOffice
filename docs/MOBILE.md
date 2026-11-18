# Android client

The mobile application is a uni-app Vue interface hosted by a native Android container. It provides conversations, task decisions and reading; the desktop owns models, engines and file execution.

## Build

Install JDK 17, Android SDK 35/build-tools 35.0.0 and Gradle 8.11.1. Set `JAVA_HOME`, `ANDROID_HOME` and `BIGDOG_GRADLE_HOME` to your installations.

```sh
npm ci
npm run mobile:android
```

The builder creates the H5 assets, third-party notices and independent APK under `.build/mobile-release/`. It uses AndroidKeyStore, native libwebrtc, HTTP/WSS, PDF rendering and UnifiedPush bridges. No DCloud cloud-packaging account is needed for this container.

Local signing material is created under ignored `.build/android-signing/`, or your explicitly selected `BIGDOG_ANDROID_SIGNING_DIR`. No maintainer key or legacy private configuration is imported. Keep your key private if you need future upgrades. A self-signed build cannot update an APK signed by a different publisher; use a separate application ID for your own distribution.

## Pairing and reading

Run your [Remote coordinator](REMOTE.md), connect the desktop, then generate an invitation in **Settings → Mobile collaboration**. Scan the QR code, choose its image or paste the complete invitation. Confirm the target desktop. Short invitations expire and are single-use; previously paired clients reconnect using persistent identity.

Text, images and PDFs can be read in-app. The desktop renders Office artifacts to PDF for mobile viewing. Uncached documents require the host online. Drafts and durable outbox entries are separated by host/session; retries retain request identity.

File-specific editor chats are read-only on mobile. A global AI BigDog conversation can submit file work to the desktop. Android background delivery depends on a configured UnifiedPush distributor and OS permissions; a notification is a synchronization hint, not an execution receipt.
