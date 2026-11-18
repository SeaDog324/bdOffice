# Computer-use component notices and source availability

BigDog's computer tools use the published, unmodified Cua SDK 0.52.7.
The SDK adapter is MIT; its native packages include an MPL-2.0 Node bridge.
This is a component-level license record, not a change to BigDog's own license.

## Cua Driver 0.52.7

Copyright (c) 2025 Cua AI, Inc. MIT text: `CUA-LICENSE.txt`.

Source and native build inputs for the published SDK:
https://github.com/trycua/cua/tree/1cce41e40f58182bb4c09186c15634a6c8436d35/libs/cua-driver

This is the `cua-driver-rs-v0.52.7` release tag. BigDog does not ship Cua Spaces
or the optional perception models, and does not modify the SDK/native libraries.

## UniFFI Node bridge 0.31.0-3 — MPL-2.0

`@ubjs/core`, `@ubjs/node` and their platform packages are copyright James Hugman
and the uniffi-bindgen-react-native contributors. Their corresponding source,
available under MPL-2.0, is:
https://github.com/jhugman/uniffi-bindgen-react-native/tree/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449

Cua's `cua_driver_node_runtime.node` is an upstream compatibility build of this
runtime. Its source transformations and the trampoline-cache source are:
https://github.com/trycua/cua/blob/1cce41e40f58182bb4c09186c15634a6c8436d35/libs/cua-driver/scripts/build-node-runtime.mjs
https://github.com/trycua/cua/blob/1cce41e40f58182bb4c09186c15634a6c8436d35/libs/cua-driver/scripts/node-runtime-trampoline-cache.rs

The cache originates from uniffi-bindgen-react-native commit `5d24b38`, as
recorded in the platform package's `node-runtime-NOTICE.md`. BigDog preserves
that notice and ships `MPL-2.0.txt`. These MPL-covered components and their source
remain available under MPL-2.0; recipients retain the rights granted by that license.

## Existing media dependency

The existing `mediabunny` 1.65.2 dependency is copyright Vanilagy and contributors,
licensed MPL-2.0. The published archive includes its source and LICENSE:
https://registry.npmjs.org/mediabunny/-/mediabunny-1.65.2.tgz
Repository: https://github.com/Vanilagy/mediabunny

## Release checks

The npm license gate permits only the exact reviewed package names, versions and
license expressions listed in `tools/reviewed-license-exceptions.json`, with this
notice present. This does not add MPL, GPL, AGPL or source-available licenses to
the general allowlist. Upgrades require rechecking the corresponding source and notices.
