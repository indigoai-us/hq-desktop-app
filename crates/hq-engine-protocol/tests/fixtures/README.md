# Engine protocol golden fixtures

These newline-terminated files are the byte-stable version-one contract shared
with the native Swift client. Copy or load them directly in Swift codec tests.
Each `.jsonl` file contains exactly one compact JSON object and one terminating
newline.

Requests contain `protocolVersion`, `id`, `method`, and `params`. Responses
always contain `protocolVersion`, `id`, `kind`, `sequence`, `result`, `error`,
`event`, and `data`; absent optional response fields are explicit `null` values.

The startup handshake reserves sequence `0`. Ordered runtime events begin at
sequence `1`.
