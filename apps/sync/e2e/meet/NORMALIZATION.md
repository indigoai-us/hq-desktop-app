# Raw diagnostic normalization

This path produces `normalized-unattested-diagnostic`, never a passing native receipt.

1. Run `run-native.ts collect` with an optional absolute `bindingDirectory`. After each probe starts, the collector exclusively writes `<deviceId>.json` there with session URL, session ID and a fresh random nonce. These are correlation values, not app credentials.
2. While collection remains active, run `run-native.ts host` on each actual native host. Set `sessionBinding` to the corresponding `{webdriverUrl, sessionId, probeNonce}` and supply the actual app PID, executable and bundle paths. Use the local app WebDriver listener: a proxy or tunnel process is rejected as proof of app ownership. The collector verifies listener PID and nonce before and after sampling, hashes the executable before/after, and hashes the OS hardware UUID. Identical physical host UUIDs are rejected even with different device labels.
3. Assemble the host observations into a JSON array. Independently obtain the expected signed executable SHA-256 for each hashed host ID; do not derive the expected mapping from the observations being verified.
4. Run `run-native.ts normalize config.json output.json`. Configuration fields are `diagnosticPath`, `hostObservationsPath`, and `expectedBinaries` (host ID to expected binary hash).

The receiver/source clock offsets come from intersecting repeated WebDriver request/response intervals. Inconsistent clocks, uncertainty above 50 ms per host, collection holes over 1 second, unobserved emissions, and ambiguous audio marker cycles are rejected. Marker transition delays are conservative observation-age measurements, not precision acoustic mouth-to-ear measurements. Repeated markers contribute gap duration but no new latency sample. Recovery retains the completed gap, including the interval before the first recovered marker.

Remote WebDriver tunnels must use a matching URL/port mapping for the separately collected local binding; differing mappings currently fail closed. A normalization failure preserves the raw diagnostics for investigation.

This does not yet attest host-observation JSON, verify screenshot legibility, certify actual microphone/speaker or display capture paths, or implement OS network fault injection. The existing signed-evidence verifier is separate and does not gain native certification merely from this diagnostic normalization.
