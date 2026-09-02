# Native macOS update and release bridge

The native product ships for Apple Silicon as `HQ.app` with bundle identifier
`ai.indigo.hq-sync-menubar`. Its HQ host, Rust engine sidecar, and complete
Recall/GStreamer runtime are arm64-only. Sparkle 2.9.2 owns native update UI and
update installation. `.github/workflows/release.yml` is the authoritative
publisher: it accepts only a Developer ID signed, hardened-runtime, notarized
bundle that passes the native release verifier.

## Version identity

`versions.toml` contains two independent values:

- `product.version` becomes `CFBundleShortVersionString` and the version shown
  to people.
- `product.build` becomes `CFBundleVersion` / `CURRENT_PROJECT_VERSION` and the
  appcast's `sparkle:version`.

Increment `product.build` for every release, including alpha and beta releases.
Run `pnpm version:app` after changing either value. Release preparation refuses
a tag whose version differs from the built bundle and takes the Sparkle build
version from the verified bundle, not from the tag.

## Channels and scheduling

The native client preserves the existing channel policy:

- stable releases update stable, beta, and alpha appcasts;
- beta releases update beta and alpha appcasts;
- alpha releases update only the alpha appcast;
- non-Indigo users are forced to stable;
- Indigo users without a preference default to beta.

Sparkle checks ten seconds after launch and schedules later checks every six
hours. Automatic download and installation are disabled; installation always
uses Sparkle's user-facing native flow.

Each channel is a mutable `appcast.xml` asset on a fixed public GitHub Release
tag, which makes the client URL durable without relying on external DNS:

- stable:
  `https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-stable/appcast.xml`
- beta:
  `https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-beta/appcast.xml`
- alpha:
  `https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-alpha/appcast.xml`

The appcast enclosure always points to the immutable archive on its versioned
product release. A release updates only the channel tags allowed by the policy
above, leaving the other channel feeds untouched.

## CI validation build

CI may compile a discarded, unsigned Release bundle with the deterministic
validation key:

```sh
xcodebuild build \
  -project apps/native-macos/HQNative.xcodeproj \
  -scheme HQNative \
  -configuration Release \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO \
  HQ_NATIVE_VALIDATION_BUILD=1 \
  SPARKLE_PUBLIC_ED_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
```

That path stamps `HQValidationOnlyBuild=1`. It requires code signing to be off.
The build gate rejects the validation key from a normal Release, and the
release verifier rejects both the marker and validation key. A validation build
can never enter release preparation or public publishing.

## Production preparation

Start with a Developer ID signed, Apple-notarized, stapled `HQ.app`. Resolve
Sparkle's `sign_update` from the pinned 2.9.2 Swift package artifact. Supply
secrets through the environment without printing them:

```sh
HQ_NATIVE_APP_PATH=/absolute/path/HQ.app \
HQ_RELEASE_OUTPUT_DIR=/absolute/path/native-release \
HQ_RELEASE_TAG=v0.11.0 \
HQ_RELEASE_REPOSITORY=indigoai-us/hq-desktop-app \
SPARKLE_SIGN_UPDATE_BIN=/absolute/path/Sparkle-2.9.2/bin/sign_update \
SPARKLE_ED_PRIVATE_KEY=... \
TAURI_SIGNING_PRIVATE_KEY=... \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... \
pnpm exec tsx scripts/prepare-native-macos-release.ts
```

The Sparkle private key must use Sparkle's current exported format: canonical
base64 encoding of a 32-byte Ed25519 seed. The bridge derives its public key in
memory and requires an exact match with `SUPublicEDKey` in the built app before
it creates any artifact.

The bridge:

1. verifies identity, versions, exact arm64 host and sidecar architecture,
   Developer ID signatures, hardened runtime, host/helper entitlement
   separation, notarization, Sparkle 2.9.2, and the absence of HQ
   web/Tauri/Node runtime;
2. creates one `HQ_<version>_aarch64.app.tar.gz` archive;
3. signs that same archive with the legacy Tauri minisign key;
4. passes the matching Sparkle Ed25519 private key to `sign_update` on standard
   input;
5. emits a legacy `latest.json` containing only `darwin-aarch64`;
6. emits appcasts only for channels allowed to receive the release; and
7. writes `native-release-plan.json` with `publishingEnabled: false`.

There is no `darwin-x86_64` entry and no artifact labeled `universal`. Existing
Intel clients remain on the prior Tauri release until an explicit Intel
migration is designed.

`publishingEnabled: false` means the preparation script itself never mutates
GitHub. The release workflow publishes its outputs only after the app and DMG
pass signing, notarization, stapling, architecture, and runtime checks. It then:

1. merges the native `darwin-aarch64` entry with whichever Windows Tauri
   artifacts completed successfully;
2. uploads the versioned arm64 archive and DMG plus versionless download
   aliases;
3. replaces `appcast.xml` only on the selected fixed channel releases; and
4. downloads the public product assets and channel feeds to verify that the
   published URLs are readable and the appcasts match byte-for-byte.

Before replacing a channel feed, the workflow reads its current public appcast.
It rejects a lower build number and rejects reusing one build number for a
different display version. Re-running the same version/build remains
idempotent.

## Native/WebKit boundary

HQ product surfaces, the `HQ` executable, and `hq-engine-sidecar` contain no
Tauri, Node.js, web view, bundled web runtime, or WebKit linkage. The pinned
third-party `Sparkle.framework` links Apple's system WebKit solely for Sparkle's
isolated release-notes panel. Verification allows that one documented
system-framework link and rejects WebKit from the HQ host or sidecar, bundled
web assets outside Sparkle, and any Tauri/Wry or Node.js runtime.

Sparkle 2.9.2's upstream framework contains signed universal arm64/x86_64
helper slices. After Xcode archives the app, the release workflow
deterministically thins the framework binary, Autoupdate, Updater app, and both
XPC services to arm64. It then re-signs nested code from the inside out,
preserving Sparkle's identifiers, requirements, and component-specific
entitlements before re-signing the framework and host. Verification requires
exact arm64 architecture and a Developer ID hardened-runtime signature on every
Sparkle Mach-O.

## External production gaps

No production secrets were generated or embedded. A real public release still
requires:

- the production Sparkle Ed25519 public key as `SPARKLE_PUBLIC_ED_KEY`;
- the matching private key in the release secret store as
  `SPARKLE_ED_PRIVATE_KEY`;
- the existing legacy Tauri signing key and password;
- an available Developer ID Application identity;
- Apple notarization credentials and a successful stapled ticket;
- the pinned Sparkle 2.9.2 `sign_update` binary;
- GitHub Actions `contents: write` permission to upload the product assets and
  replace assets on the fixed `sparkle-*` channel releases.

The release workflow resolves `sign_update` from the Xcode package artifact for
the exact Sparkle 2.9.2 pin. It does not download a second release toolchain.
Production private keys are supplied only through GitHub Actions secrets and
are never written to source or printed.
