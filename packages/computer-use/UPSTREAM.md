# Cua SDK provenance

The desktop driver is the unmodified MIT-licensed `@trycua/cua-driver` npm adapter,
pinned to **0.52.7**, together with its matching platform package and UniFFI runtime.
The Node bridge has MPL-2.0 components; see `THIRD_PARTY.md`, `MPL-2.0.txt` and
the platform package's `node-runtime-NOTICE.md` for notices and corresponding source.
Source: https://github.com/trycua/cua/tree/main/libs/cua-driver

BigDog owns the tool definitions, authorization, task lifecycle and auxiliary
process protocol. The driver performs local observation and input. No Cua Spaces,
model account, hosted inference, or optional perception extension is required.
The SDK and platform packages must be upgraded together after compatibility tests.

This directory contains BigDog adapter code, not a fork of the native driver.
Retain the SDK's MIT notices and the dependency notices in desktop distributions.
