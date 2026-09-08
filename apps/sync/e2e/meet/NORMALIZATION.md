# Raw diagnostic normalization

The generated transport probe does not request physical microphone/camera access. It can run in guests without capture devices and explicitly reports `physicalCaptureTested: false`. This is not capture-device or TCC permission evidence.

This path produces `normalized-unattested-diagnostic`, never a passing native receipt.

1. Run `run-native.ts collect` with an optional absolute `bindingDirectory`. After each probe starts, the collector exclusively writes `<deviceId>.json` there with session URL, session ID and a fresh random nonce. These are correlation values, not app credentials.
2. While collection remains active, run `run-native.ts host` on each actual native host. Set `sessionBinding` to `{webdriverUrl, sessionId, probeNonce}`, using the actual host-local listener URL (normally `http://127.0.0.1:4445`) and the session ID/nonce from the controller binding file and supply the actual app PID, executable and bundle paths. Use the local app WebDriver listener: a proxy or tunnel process is rejected as proof of app ownership. The collector verifies listener PID and nonce before and after sampling, hashes the executable before/after, and hashes the OS hardware UUID. Identical physical host UUIDs are rejected even with different device labels.
3. Assemble the host observations into a JSON array. Independently obtain the expected signed executable SHA-256 for each hashed host ID; do not derive the expected mapping from the observations being verified.
4. Run `run-native.ts normalize config.json output.json`. Configuration fields are `diagnosticPath`, `hostObservationsPath`, `expectedBinaries` (host ID to expected binary hash), and optional `tunnelMappings`. Each mapping contains `hostId`, `hostLocalWebdriverUrl`, `controllerWebdriverUrl`, `sessionId`, and `probeNonce`. Supply mappings whenever the controller uses forwarded ports; all eight host-local listeners may be port 4445 while their controller ports are distinct.

The receiver/source clock offsets come from intersecting repeated WebDriver request/response intervals. Inconsistent clocks, uncertainty above 50 ms per host, collection holes over 1 second, unobserved emissions, and invalid or unmatched audio sequence markers are rejected. Audio now encodes the full 16-bit sequence in four independent frequency banks, so setup lasting multiple eight-second periods does not create cycle ambiguity. The receiver requires all four banks; audio sample rates below 32 kHz fail closed. Old modulo-16 diagnostic records are rejected and must be recollected. Marker transition delays are conservative observation-age measurements, not precision acoustic mouth-to-ear measurements. Repeated markers contribute gap duration but no new latency sample. Recovery retains the completed gap, including the interval before the first recovered marker.

Remote tunnel mappings bind controller and host-local addresses through the independently observed host UUID digest, expected binary hash, session ID, and nonce. Local PID ownership remains verified only against the real host-local listener. Mapping changes, reused controller sessions, missing hosts, or mismatched nonces fail closed. A normalization failure preserves the raw diagnostics for investigation.

This does not yet attest host-observation JSON, verify screenshot legibility, certify actual microphone/speaker or display capture paths, or implement OS network fault injection. The existing signed-evidence verifier is separate and does not gain native certification merely from this diagnostic normalization.

## Scoped network controller

`collect` and `ladder` accept `networkScope`: `{namespace, runId, deviceId, auditPath}`. `runId` is exactly 16 lowercase hexadecimal characters; namespace must equal `hq-meet-<runId>`. This controller runs only on a disposable Linux router host with `ip` and `tc` already installed. It does not provision namespaces, guests, routes, privileges, or paid resources.

The existing namespace must contain only `lo`, `uplink`, and `guest`. Both data interfaces must be veth links with aliases `hq-meet:<runId>:<deviceId>:<interface>`. They must have no existing shaping. The target test guest's traffic must already route exclusively through this namespace; application and final traffic counters are checked, but independent topology/throughput verification remains necessary.

Rules use `ip netns exec <namespace> tc ...` exclusively. Constrained settings are 2/10 Mbit egress, 75 ms delay each direction, 30 ms jitter, and 2% per-direction loss. Sleep/reconnect is a network interruption, not OS suspension: after collection starts it waits 10 seconds, verifies 100% loss on both links, waits 3 seconds, then restores and verifies normal settings. WebDriver control must remain on an independent management path.

An exclusive JSONL audit records command execution, applied settings, actual byte-counter progress, fault boundaries and cleanup. Failed application/capture cancels the fault task and removes owned handle `712:` from both interfaces. Cleanup failure rejects the run. `ladder` stores separate audits alongside each scenario. Constrained and reconnect collection now reject missing controllers; no profile name alone claims an applied impairment.

Only command-boundary regression tests have run on the development Mac. Linux namespace execution and real guest traversal are still unverified. Command syntax follows the upstream iproute2 [netem](https://man7.org/linux/man-pages/man8/tc-netem.8.html) and [network namespace](https://man7.org/linux/man-pages/man8/ip-netns.8.html) manuals.

## Startup and ICE exchange

A suspended AudioContext keeps startup pending for up to 10 seconds while the operator activates the visible audio button. The harness does not change autoplay policy. Timeout or cancellation rejects startup; cleanup is safe before startup and during an outstanding gesture wait.

Offers and answers are exchanged immediately after local descriptions exist. The controller drains and forwards actual ICE candidates in memory, including candidates arriving while gathering remains active. It requires every peer connection to report connected and its data channel open within a bounded 20-second negotiation window. Candidate exchange continues during sampling. Queue budgets and per-command deadlines remain enforced; SDP/candidate bodies are never included in diagnostic artifacts or errors.
