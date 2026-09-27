# Windows install: antivirus warnings

## Norton may block the installer

Norton Antivirus can flag the HQ Desktop Windows installer (`.msi` or
`-setup.exe`) as untrusted and block it from running, even though it is
digitally signed. This is expected right now, not a sign the download is
unsafe.

Why it happens: Norton's file-reputation check weighs how many Norton users
have already run a given binary. A binary signed with a newer or lower-volume
code-signing certificate, downloaded from a GitHub release rather than a large
app store, starts with a low reputation score until enough people have
installed it. Reputation rises automatically over time as more people run it;
there is nothing a user needs to fix on their end beyond allowing the file
once.

### How to allow the installer

1. If Norton shows a block/quarantine notification right after download,
   open **Norton** → **Security History** (or **My Norton** → **Security** →
   **History**).
2. Find the HQ installer entry (it will be named after the downloaded file,
   e.g. `HQ_x.y.z_x64-setup.exe`).
3. Select it and choose **Restore** (or **Restore & Exclude** if offered) to
   remove it from quarantine.
4. If Norton offers to add an exclusion, allow it so Norton does not
   re-block the same file on the next run.
5. Re-run the installer.

If Norton's SmartFirewall or Download Insight dialog appears instead of a
quarantine, choose **"Yes, I trust this file"** / **"Allow"** rather than
"Remove threat" — Norton is naming the file's low reputation, not a detected
threat signature.

This same low-reputation block can happen with other antivirus products for
the same reason (new certificate, GitHub-hosted download); the fix above
generalizes: allow/restore the file, don't quarantine it.

## For maintainers: code-signing options considered

The installer is already signed (see [`RELEASE.md`](RELEASE.md#windows-signing)
for the current Azure Trusted Signing setup). Signing alone does not exempt a
binary from reputation-based blocking — reputation is a separate, download-volume-driven
signal every code-signing identity has to earn. Options evaluated to reduce
how often this fires:

| Option | Cost | Effect on Norton/SmartScreen |
|---|---|---|
| EV (Extended Validation) code-signing certificate | Ongoing annual cost, hardware-token/HSM issuance step | Historically granted instant SmartScreen reputation; Norton still applies its own separate reputation curve, so it helps SmartScreen more than Norton specifically |
| Azure Trusted Signing (current setup) | Low ongoing cost, already wired into CI via OIDC | Standard reputation-building signing; reputation still accrues over time by download volume, same as any non-EV cert |
| Submit the binary to Microsoft for SmartScreen reputation review | Free | Can accelerate SmartScreen trust for this specific binary/version; does not affect Norton, which runs its own independent reputation system |

Recommendation: stay on Azure Trusted Signing (already in place, low
maintenance) and let reputation accrue with release volume; treat the Norton
note above as the interim mitigation. An EV certificate is worth reconsidering
only if SmartScreen (not Norton) blocking becomes a frequent support load,
since EV's main benefit is instant SmartScreen trust rather than faster Norton
trust.
