# HQ engine protocol

This crate owns the Tauri-free, versioned NDJSON contract between the native
macOS application and the Rust engine sidecar.

## Transport

- UTF-8, one compact JSON object per line.
- The Swift client writes requests to the sidecar's stdin.
- The sidecar writes protocol envelopes only to stdout.
- Diagnostics go to stderr and are never mixed into stdout.
- Protocol version `1` is rejected explicitly when a different version arrives.
- Every request has a non-empty string `id`; results and errors echo it.

The sidecar emits one startup `handshake` envelope before reading requests. Its
result declares the engine version, the launching application version, and only
the methods implemented by that engine build. The handshake reserves sequence
`0`; emitted runtime events are ordered from sequence `1`.

## Version-one methods

| Method | Initial behavior |
| --- | --- |
| `health` | Heartbeat and process health snapshot; responds with `kind: "pong"`. |
| `cancel` | Requests cancellation of an in-flight request by `requestId`. |
| `shutdown` | Cancels outstanding work, flushes an `end` acknowledgement, and exits. |
| `config.get` | Reads the local HQ configuration, if present. |
| `auth.state` | Reads local stored-token state without network refresh. |
| `workspaces.list` | Discovers company workspaces under the resolved local HQ root. |
| `sync.status` | Reads the local sync journal or returns the no-journal default. |
| `projects.list` | Scans local board and PRD files. |
| `sessions.list` | Scans local Claude and Codex session stores. |

The initial engine deliberately does not claim cloud workspace merging, token
refresh, sync mutation, project mutation, or live-process-perfect session
status.

## Contract fixtures

Golden Swift-consumable frames live in
[`tests/fixtures`](tests/fixtures/README.md). Rust tests round-trip every
response fixture byte-for-byte and decode every request fixture.
