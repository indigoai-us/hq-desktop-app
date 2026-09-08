# Native Meet validation (US-012)

This harness creates a reusable probe transport before the final Meet UI exists.
It does **not** certify the existing application or claim that native calls passed.
There are three deliberately separate outputs:

- `hq-meet-native-diagnostic/v1`: actual WebRTC probe observations from attached
  WebDriver sessions; **unattested**, even if the session is a native application.
- Synthetic Vitest validator results: regression coverage of evidence rejection,
  never media, permission, packaging or performance proof.
- `hq-meet-native-receipt/v1`: signature-verified collector evidence and hashed
  artifacts meeting the strict metric checks. The trusted collector must be an
  operator-trusted native evidence collector, not a key supplied by the candidate
  evidence package. Ed25519 is this verifier’s design choice, not a PRD prerequisite;
  an existing authorized host runner can hold the collector key. Its signature authenticates its assertions; cryptography
  alone cannot establish that assertions about a device are true.

## Run the probe

Use existing authorized isolated test devices, including headed Tart clean rooms
for Mac permission work. Do not touch another running VM. Reserve the native build
slot before installing sidecars, building, running tests, or committing through
hooks. Prepare the repo-defined sidecar command for HQ native QA; use `tauri dev
--no-watch` for development. Keep test bundles outside the synced tree. Never
modify an installed signed bundle, disable CSP, use fake media-device flags, or
bypass OS permission prompts. Activate the native window and grant actual camera,
microphone and audio-playback permissions with the operator present. Click the probe’s public
fixture audio button when the native runtime requires a user gesture.

Attach native WebDriver sessions to the intended executables and tunnel each
session endpoint to loopback. The adapter does not create a Chrome/Edge browser
session and has no scripted fallback. Windows's existing `e2e-automation` Tauri
WebView2 binary can exercise the probe, but its bytes differ from the signed
release. Without separately verified release equivalence it cannot pass the
native receipt gate. A Mac WKWebView WebDriver attachment/bridge is still required;
no working Mac driver or signed Mac/Windows run is claimed by this change.

Create public speech audio from `SPEECH_SCRIPT` in `fixtures.ts` using an installed
native TTS engine (macOS `say`/`afconvert`, Windows `System.Speech`), recording the
engine, voice, OS version and resulting WAV SHA-256. The runner requires a 5–120
second audio file and records its actual digest. Do not use real call audio.
The probe requests microphone permission, immediately stops that track, and sends
only the generated public speech plus sequence-coded tones. Camera permission is requested and its track immediately stopped; transmitted
video comes from a generated public canvas. A full-viewport opaque fixture surface
hides the existing HQ UI during collection and is removed on cleanup. Screenshots
still need review before sharing. Only participant zero sends
the generated 1280×720 screen (14pt text, sequence pixels). This exercises WebRTC
screen-track transmission, **not native screen-picker capture permission**.

Example `collect.json` (use actual existing session IDs):

```json
{
  "endpoints": [
    { "id": "mac01", "webdriverUrl": "http://127.0.0.1:4444", "sessionId": "actual-session" },
    { "id": "win01", "webdriverUrl": "http://127.0.0.1:4445", "sessionId": "actual-session" }
  ],
  "profile": "direct",
  "durationMs": 60000,
  "speechWavPath": "/absolute/test-artifacts/public-speech.wav"
}
```

From the repository root:

```sh
pnpm exec tsx apps/sync/e2e/meet/run-native.ts collect /absolute/collect.json /absolute/artifacts/diagnostic.json
```

Run each entry of `scenarios` (2, 4, 8 participants × four profiles). TURN credentials
come only through `HQ_MEET_TEST_ICE_SERVERS` injected by `hq secrets exec`, using the
existing authorized test allocation; never put them in the config or logs. The
probe uses real `RTCPeerConnection`, receive-track audio FFT marker detection,
rendered-video sequence pixel detection, selected candidate types and per-direction
`getStats()` counters. SDP, candidate addresses and credentials remain in memory;
driver errors are redacted. Collection, ICE gathering, driver commands, fixture
sizes and teardown have explicit bounds. In-memory diagnostic output is capped at
32 MiB; an hour-long run that reaches this cap fails and needs a streaming collector. Cancellation attempts track/peer cleanup
on all endpoints. Failure never writes a passing receipt.

## Profiles and evidence

`direct`: verify a non-relay selected path. `forced-turn`: set relay policy and
verify the selected path includes relay. `constrained`: externally enforce 2 Mbps
upload / 10 Mbps download, 150ms RTT, 2% loss, 30ms injected jitter on at least one
endpoint. Other endpoints meet the normal baseline (10/30 Mbps, ≤80ms RTT, ≤1%
loss). `sleep-reconnect`: a host controller records precise sleep/network-loss and
network-return times. The runner does not silently claim to apply OS network
shaping or sleep; these require the host controller's auditable artifacts and
cleanup. Unsupported profiles remain diagnostic-only until verified externally.

Before a receipt, the independently trusted collector must correlate run/device
IDs, the exact running binary hash and full commit, native OS/hardware inventory,
platform signing verification, packaging, permission actions and release-byte
identity/equivalence. Record CPU percent and resident bytes from the actual native
process at least every two seconds. No CPU/memory ceiling is invented in US-012;
raw samples support the subsequent feasibility/soak decision. Supported-baseline
artifacts must cite release requirements, not just the machine that happened to
be available. macOS floor is 13.0 (`minimumSystemVersion` in Tauri config).
Windows minimum OS and minimum hardware remain to be established from the release
policy; Windows CI existence alone does not establish either floor.

`NativeEvidence` in `native-harness.ts` is the collector contract. Each directed
pair needs monotonic audio/video and sent/received counters plus ≥30 samples with
no sampling hole over one second. Collect calibrated source-emission/receiver
observation times and clock uncertainty; transport RTT is **not** mouth-to-ear
latency. Audio FFT detections by themselves are not calibrated latency. Preserve
source/receiver marker artifacts and calibration, then derive the normalized
samples. Only the screen sender's outgoing directions require screen latency and
14pt normal-fit screenshot review. A reviewer identifies the decoded reference
text and viewport; a bare screenshot or programmatic `true` is not a review.

The evaluator enforces audio p95 ≤300ms normal / ≤500ms constrained, screen p95
≤1500ms / ≤3000ms, and no unexplained audio gap >2000ms. Clock uncertainty is added
to measured latency (and must be ≤50ms). Only the exact overlap with an evidenced
induced disconnect is subtracted from a gap; a long surrounding dropout still
fails. Recovery resolves within 20 seconds of verified network return into audio
or an explicit user retry state. Missing devices, directions, platforms, artifacts,
finite values, duration coverage, or counters fail closed.

The CLI does not manufacture normalized evidence from arbitrary summaries. The
remaining host collector integration must independently derive the measurements,
perform signing/process checks and attest screenshot review. This work provides
the probe, bounded collector transport, schema and receipt verifier; it does not
claim that this external collector, Mac attachment, calibrated audio latency or
network-fault controller has already been deployed or exercised.

## Verify an evidence package

The trusted collector signs the exact UTF-8 evidence JSON bytes using its registered
Ed25519 key. Keep the trusted public key outside the submitted evidence package;
never accept a public key supplied by the candidate run. Artifacts are relative
paths with SHA-256 hashes. Symlink escapes, missing/oversized files, invalid
signatures and changed bytes are rejected. Receipt output contains only correlation,
evidence digest, artifact count and failures; no media/signaling contents.

```json
{
  "evidenceRoot": "/absolute/artifacts/run-001",
  "evidencePath": "evidence.json",
  "signaturePath": "/absolute/artifacts/run-001/evidence.ed25519",
  "trustedCollectorPublicKeyPath": "/absolute/registered-collectors/test-host.pem"
}
```

```sh
pnpm exec tsx apps/sync/e2e/meet/run-native.ts verify /absolute/verify.json /absolute/artifacts/receipt.json
pnpm --dir apps/sync exec vitest run --config e2e/meet/vitest.config.ts
```

The second command runs **synthetic validator regressions only**. It does not replace
signed native Mac/Windows 2→4→8 receipts or US-031's 60-minute mixed-platform gate.
No signed native receipts were generated as part of authoring this harness.
