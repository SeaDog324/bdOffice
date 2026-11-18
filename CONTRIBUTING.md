# Contributing

Use the build instructions in [docs/BUILD.md](docs/BUILD.md). Keep changes scoped to the relevant editor, shared engine or host adapter. Describe behavior, verification and any compatibility impact when proposing a change.

UI chrome uses semantic tokens from `packages/ui/src/tokens.css`; document colors and export content remain document data. New UI tokens need light, dark and system-dark values. When adding localized keys, update every sibling locale shard.

Main-process and preload changes require rebuilding the Shell. Workspace packages used at runtime must be bundled or explicitly packaged; a successful TypeScript check alone does not establish packaged dependency availability.

Preserve Session/storage/protocol compatibility, third-party attribution and license boundaries. Do not add credentials, local profiles, customer files, generated installers or signing keys. Use ignored local configuration and placeholder-only examples.
