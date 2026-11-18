# Configuration and local data

The repository contains no user provider configuration, accounts, databases, device identities, private signing keys or deployment credentials. `apps/remote-server/.env.example` contains empty fields and a loopback development URL.

## Model connection

Configure the provider, model and API key in the desktop onboarding or settings. Skipping model setup still allows ordinary document editing. Credentials belong in the application's local profile or OS storage, not source files.

The bundled Cua driver does not require a separate hosted model account. AI calls and optional search/image services use their configured providers. OS and application permissions continue to apply.

## Environment variables

| Variable | Purpose |
|---|---|
| `GENOFFICE_USER_DATA` | Select a separate local desktop profile |
| `BIGDOG_REMOTE_CONFIG` | Path to a local, ignored Remote host configuration |
| `JAVA_HOME`, `ANDROID_HOME`, `BIGDOG_GRADLE_HOME` | Android build tool locations |
| `BIGDOG_ANDROID_SIGNING_DIR` | Your own Android signing directory |
| `BUILD_DIR` | Desktop packaging output directory |
| `BIGDOG_UPDATE_URL` | Optional HTTPS update feed for your distribution |

The desktop build can optionally inject analytics/font-mirror settings. These values are not supplied by this source distribution; without analytics metadata the tracker is a no-op. See [privacy details](../PRIVACY.md). Do not place secrets in package metadata, logs or screenshots.

## Data separation

Profiles contain Session summaries and conversation JSON, task ledgers, local caches and device state. Exporting a Session is separate from granting another host permission to act on files. Back up profiles and signing keys through your own private storage; do not add them to this repository.
