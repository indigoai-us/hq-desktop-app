# Local bot promotion and desktop refresh acceptance

This is coordinated, unreleased work. Desktop PR807 depends on CLI PR575,
backend PR275, and the private-context adapter in runtime PR94.

## Promotion

On September 13, 2026, the built macOS app created and promoted disposable
Juniper (`bridge-promotion-0913b`, `agt_01M2DHP0HZQ9MC5HVA6NKDW9QG`). The native
profile drove the actual backend through an isolated endpoint restricted to
that agent. A fresh ChatGPT subscription login completed cloud authentication.
No local OAuth credentials were copied and no API key was required.

The same DM and agent UID continued after promotion. Juniper identified itself
as a specimen librarian, executed its authored specimen-label skill, recalled
private local facts, saved a new private shelf label, and recalled both old and
new context after a Fleet gateway restart. On-box tool receipts corroborated
actual skill execution. The backend PR includes the detailed operation and
SSM receipts. Existing live agents and the global runtime pin were untouched.

After the aesthetic refresh, a new native DM at 17:04 EDT received a visible
reply confirming Juniper's role, CedarKite / CK-7392 / amber skill result, and
the saved cobalt-9046 shelf label.

## Design provenance and native acceptance

The visual source is desktop PR772 and the owner's rendered reference image.
Shared surface tokens, message spacing, rounded controls, and thread sizing
follow that PR. Native dark window colors match unobstructed canvas samples
from the rendered reference. The welcome hand tile and resource icon tiles
follow the screenshot. Navigation, sidebar width, setup actions, and message
behavior remain intact. Removing duplicate WebKit blur prevents the native
sidebar from washing out white over AppKit material.

Local build `HQ Promotion 20260913m` and the macOS 15.7.7 Tart VM were inspected.
Native checks covered sending and opening a cloud reply, opening/closing the
bot profile, settings, switching Light then Dark, local bot labels, and
project disclosure rows. At 960x600 both conversation panes, composers, send
controls, and thread Close fit without horizontal overflow. Long messages
scroll inside the conversation. VM screenshots confirmed blue-violet surfaces,
readable messages, and visible composer controls.

The workspace lookup fix bounds local discovery, accepts valid late results,
retains the last successful roster, and offers a compact retry status. Normal
native roster loading passed without the former amber banner. A loopback proxy then delayed only the real membership response beyond the
15-second UI deadline. The built app showed its compact status row without
covering Send. Clicking Retry acknowledged immediately; releasing the delay
forwarded HTTP 200 responses and restored the real roster. A separate late
response also cleared the warning automatically. The proxy was stopped and
the app relaunched against its normal endpoint after verification.

## Automated validation

- Core: 2,367 unit tests and one integration test passed serially.
- Menubar: 1,233 passed, two existing ignored tests.
- Promotion UI: 29 passed; platform adapter: nine passed.
- Refresh: 20 setup tests, 45 settings/sidebar/bot interaction tests,
  12 appearance tests, and one reply-layout test passed.
- UI typecheck: zero errors, 70 warnings. Native host typecheck: zero errors,
  76 warnings. Six workspace-roster regression tests pass. Frontend and native
  debug builds pass.

## Remaining limits

Native and VM welcome visual acceptance passed: hand tile, no wallpaper, and
four resource cards fit without clipping. Restarting the disposable VM cleared
an OS permission dialog without changing permission settings. VM setup DM
visual acceptance also passed. Final host/VM executable SHA-256:
`a3303b314e8d0ed6d3556c9b8d196e8f4ee70e9d7e79186b09ef89942a1ef4f7`.

Gateway restart on the same disk is verified; instance replacement/disaster
recovery, cancellation/rollback, and old queued-message migration are not
certified. This is not a production deployment or a notarized release.

## Fresh onboarding follow-up — September 14

The earlier Juniper results and executable hash above describe the original
acceptance run. A separate fresh-local-state VM run now verifies automatic setup
registration and its first real Claude reply without retry messages or repairs.
The setup conversation creates Cedar QA, which recalls its saved marker and
uses its authored checklist before and after Stop → Start through desktop controls.

This required fixing the connected-provider setup gate, installing missing
provider runtimes before connecting, exposing automatic setup failures, and
opening the desktop directly from the menu bar and Dock. Companion CLI PR575
packages the setup template and both skills and includes managed runtime bins
in the launchd PATH. The successful attempt uses the complete installed package,
without an externally staged setup worker.

The run reuses test-account, company, provider authorizations, and dependencies;
it does not re-certify fresh signup or dependency installation. Cedar's cloud
promotion reaches subscription pairing automatically and renews expired codes
without clicks. Cloud continuity and restart are still pending provider
authorization. Its first cloud candidate was replaced by the ordinary updater;
the isolated test fixture now invokes an immutable importer outside that global
installation. This repaired cloud attempt is not a clean end-to-end pass.
Release the companion CLI importer before enabling promotion in production.

Latest native checks: 1,233 menubar tests pass (two existing ignored tests), and
2,367 core tests plus the runner integration pass with four test threads. The
initial core run and a focused rerun during concurrent native testing failed a
one-second version probe; a subsequent focused test and full four-thread run
passed. Assertions and production timeouts are unchanged; diagnostic assertion
output was added. Native UI typecheck remains zero errors and 76 warnings.
