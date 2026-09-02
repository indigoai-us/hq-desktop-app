# HQ native engine

`hq-engine` is the Tauri-free request core used by the native macOS app. The
process boundary is versioned NDJSON from `hq-engine-protocol`; the executable
stdio host lives in `hq-engine-sidecar`.

## Capability truth

The startup handshake advertises only methods present in `capabilities()`.
Every legacy command assigned to the engine has an explicit registration:

- `Implemented` means the method has executable dispatch and contract coverage.
- `Blocked` records the missing runtime boundary: local orchestration, cloud,
  packaged Node.js/HQ runner, Recall SDK resources, GStreamer frameworks, or
  native AppKit ownership.

`parity-engine-commands.txt` must exactly match the generated native parity
ledger. The parity tests fail if a generated command is missing or a blocked
command leaks into the handshake.

## Event delivery strategy

The generated ledger assigns 65 legacy events to the engine. None is currently
claimed as delivered. The Swift transport can decode event envelopes, but that
alone is not a domain subscription, and the sidecar has no source adapters for
those 65 streams.

An event may move to `Delivered` only after all of these exist:

1. A real producer adapter feeds a bounded engine event channel.
2. The sidecar multiplexes that channel through its single stdout writer.
3. `EventSequencer` assigns a strictly increasing sequence number.
4. The native app has a named consumer that applies the event payload.
5. An end-to-end contract test proves producer → NDJSON → native subscription.

The stdio lifecycle event `engine:shutting_down` is intentionally separate from
the legacy parity ledger. `parity-engine-events.txt`,
`emitted_parity_event_names()`, and `subscribed_parity_event_names()` form the
cutover gate: a delivery claim fails tests unless both sides are registered.

## Packaging blockers

- Sync, package, and content-progress streams need the managed Node.js
  toolchain and HQ runner plus a process-event bridge.
- Messaging, marketplace, share, and some workspace flows need authenticated
  cloud clients and refresh semantics.
- Meeting detection needs the Recall SDK sidecar and packaged model/resources.
- Recording needs the GStreamer frameworks and runtime plugin search paths.

Those domains remain blocked rather than silently degrading or advertising
capabilities that the signed native bundle cannot execute.
