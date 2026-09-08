# Raw diagnostic normalization

This path produces `normalized-unattested-diagnostic`, never a passing native receipt.

1. Run `run-native.ts collect` with an optional absolute `bindingDirectory`. After each probe starts, the collector exclusively writes `<deviceId>.json` there with session URL, session ID and a fresh random nonce. These are correlation values, not app credentials.
2. While collection remains active, run `run-native.ts host` on each actual native host. Set `sessionBinding` to the corresponding `{webdriverUrl, sessionId, probeNonce}` and supply the actual app PID, executable and bundle paths. Use the local app WebDriver listener: a proxy or tunnel process is rejected as proof of app ownership. The collector verifies listener PID and nonce before and after sampling, hashes the executable before/after, and hashes the OS hardware UUID. Identical physical host UUIDs are rejected even with different device labels.
3. Assemble the host observations into a JSON array. Independently obtain the expected signed executable SHA-256 for each hashed host ID; do not derive the expected mapping from the observations being verified.
4. Run `run-native.ts normalize config.json output.json`. Configuration fields are `diagnosticPath`, `hostObservationsPath`, and `expectedBinaries` (host ID to expected binary hash).

The receiver/source clock offsets come from intersecting repeated WebDriver request/response intervals. Inconsistent clocks, uncertainty above 50 ms per host, collection holes over 1 second, unobserved emissions, and ambiguous audio marker cycles are rejected. Marker transition delays are conservative observation-age measurements, not precision acoustic mouth-to-ear measurements. Repeated markers contribute gap duration but no new latency sample. Recovery retains the completed gap, including the interval before the first recovered marker.

Remote WebDriver tunnels must use a matching URL/port mapping for the separately collected local binding; differing mappings currently fail closed. A normalization failure preserves the raw diagnostics for investigation.

This does not yet attest host-observation JSON, verify screenshot legibility, certify actual microphone/speaker or display capture paths, or implement OS network fault injection. The existing signed-evidence verifier is separate and does not gain native certification merely from this diagnostic normalization.

## Scoped network controller

`collect` and `ladder` accept `networkScope`: `{namespace, runId, deviceId, auditPath}`. `runId` is exactly 16 lowercase hexadecimal characters; namespace must equal `hq-meet-<runId>`. This controller runs only on a disposable Linux router host with `ip` and `tc` already installed. It does not provision namespaces, guests, routes, privileges, or paid resources.

The existing namespace must contain only `lo`, `uplink`, and `guest`. Both data interfaces must be veth links with aliases `hq-meet:<runId>:<deviceId>:<interface>`. They must have no existing shaping. The target test guest's traffic must already route exclusively through this namespace; application and final traffic counters are checked, but independent topology/throughput verification remains necessary.

Rules use `ip netns exec <namespace> tc ...` exclusively. Constrained settings are 2/10 Mbit egress, 75 ms delay each direction, 30 ms jitter, and 2% per-direction loss. Sleep/reconnect is a network interruption, not OS suspension: after collection starts it waits 10 seconds, verifies 100% loss on both links, waits 3 seconds, then restores and verifies normal settings. WebDriver control must remain on an independent management path.

An exclusive JSONL audit records command execution, applied settings, actual byte-counter progress, fault boundaries and cleanup. Failed application/capture cancels the fault task and removes owned handle `712:` from both interfaces. Cleanup failure rejects the run. `ladder` stores separate audits alongside each scenario. Constrained and reconnect collection now reject missing controllers; no profile name alone claims an applied impairment.

Only command-boundary regression tests have run on the development Mac. Linux namespace execution and real guest traversal are still unverified. Command syntax follows the upstream iproute2 [netem](https://man7.org/linux/man-pages/man8/tc-netem.8.html) and [network namespace](https://man7.org/linux/man-pages/man8/ip-netns.8.html) manuals.
