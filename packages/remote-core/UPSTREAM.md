# Remote transport provenance

Pinned MIT source: https://github.com/liguobao/ds-harness-remote/tree/1c8687d3b7bb8167dd23eede1b291cef01736db8 . Full attribution is retained in `LICENSE-ds-harness-remote` and each copied workspace license. No Flutter/Dart app, AGPL phone automation, PRoot runtime or DSH agent executor is copied.

| Local source                    | Upstream source                                                       | Adaptation                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/remote-protocol/src`  | `packages/protocol/src`                                               | Runtime source copied at the pinned revision.                                                                                                     |
| `packages/remote-crypto/src`    | `packages/crypto/src`                                                 | Noise IK and standard authenticated frame encryption; runtime unchanged.                                                                          |
| `packages/remote-transport/src` | `packages/webrtc/src`                                                 | Adaptive transport, route budgets, fallback, framing, backpressure; runtime unchanged.                                                            |
| `src/vendor/dsh-remote/rtc-*`   | `packages/webrtc/src/rtc-*`                                           | Original R1 primitive extraction retained for compatibility.                                                                                      |
| `src/vendor/dsh-host`           | `packages/plugin/src`                                                 | Host connection/RTC wrappers with local imports/ports, ICE policy propagation and werift nominated-pair stats correction; not an unmodified copy. |
| `apps/remote-server/src`        | `apps/server/src`                                                     | Original Control/Relay/identity store retained; BigDog courier/ownership/push routes, static landing path and close lifecycle added.              |

`transport-upstream-lock.json` records copied runtime SHA-256 values. Keep those files unchanged unless deliberately updating the pinned source; local adaptations live outside this list. Tests and package exports are adapted for this monorepo. The upstream source is MIT; new BigDog modules remain under their workspace license.

BigDog additions are `server-api.ts`, `secure-client.ts`, `host.ts`, `host-ports.ts`, `offline.ts`, Session RPC/client integration and Android native bridges. The online channel verifies Noise identity and pins first-trusted Host keys. Offline AEAD keys are domain-separated by server origin, with sender, receiver, Session, request ID, epoch and expiry authenticated. Static offline keys do not promise forward secrecy for stored envelopes if the endpoint identity is later compromised. Mobile/Host key material is protected by each device OS vault.

Connection and deployment instructions are in [Remote configuration](../../docs/REMOTE.md). Runtime provenance and source hashes remain independent from deployment-specific credentials and environments.
