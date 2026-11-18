# Android third-party notices

Native WebRTC SDK: `io.github.webrtc-sdk:android:150.7871.01`. `WEBRTC.md` and `WEBRTC-SDK.txt` are copied from https://github.com/webrtc-sdk/android at `1d6a68a74162d3f218f9681d49c6b5eef8f02800`, whose README names that Maven version. They retain the upstream WebRTC and bundled third-party notices.

UnifiedPush connector 3.3.5, OkHttp 4.12.0, Okio, Kotlin and AndroidX use Apache-2.0; a copy is included. The build generates `src/static/THIRD-PARTY-NOTICES.txt` from the actual Vite JavaScript module graph, appends native notices and includes it in the APK. The Android app exposes the file through “开源致谢”. Fixed MIT transport provenance is documented in `packages/remote-core/UPSTREAM.md`.
