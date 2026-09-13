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

Native welcome visual acceptance passed: hand tile, no wallpaper, and four
resource cards fit without clipping. VM welcome is selected but its final
visual inspection remains obstructed by an OS permission dialog; no permission
settings were changed. VM setup DM visual acceptance is complete.

Gateway restart on the same disk is verified; instance replacement/disaster
recovery, cancellation/rollback, and old queued-message migration are not
certified. This is not a production deployment or a notarized release.
