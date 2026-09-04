# HQ Work

`apps/work` is the one HQ Work frontend. It owns the shared SvelteKit shell
for web, desktop and mobile; the UI and platform contracts remain in
`packages/{ui,platform,core,auth}`.

**There is exactly one copy of this app.** All three targets render the same
Svelte source. Where behaviour has to differ per platform, branch inline on the
resolved host platform — or better, on a capability flag derived from it — and
never fork a component into per-platform files. `single-svelte-source.test.ts`
enforces this: it fails on `*.mobile.svelte`-style variants, on a second
SvelteKit app under `apps/`, on application source inside a native shell
directory, and on any two byte-identical `.svelte` files across app trees.

## Targets

| Target | Command | Output | Purpose |
| --- | --- | --- | --- |
| Web | `pnpm --dir apps/work build` | `apps/work/.vercel/output` | Vercel serverless auth and S3 byte-hop routes, plus the web shell. |
| Desktop | `TAURI=1 pnpm --dir apps/work build` | `apps/work/build/index.html` | Static SPA fallback for Tauri's `frontendDist`. No server routes are published. |
| Mobile | `pnpm --dir apps/work build:mobile` | `apps/work/build` | Same static target as desktop, rendered by the `apps/work/src-tauri` shell on iOS and Android. |

The adapter decision is intentionally one line in `svelte.config.js`: static
when `TAURI` is set and Vercel otherwise. Mobile takes the same static branch
as desktop — `build:mobile` is just `TAURI=1 vite build`. The static target selects the empty
Tauri hook entry and adapter-static emits only the fallback document and
assets; the hosted server-only routes are not copied to `build/`.

At runtime, `+page.svelte` selects `TauriPlatformAdapter` when
`window.__TAURI__` (or the `TAURI` build flag) is present. It otherwise uses a
direct `WebPlatformAdapter` for hq-pro. Full desktop window wiring is deferred;
the injected Tauri adapter is safe to construct without importing a Tauri npm
module.

## Environment

| Variable | Where needed | Notes |
| --- | --- | --- |
| `PUBLIC_HQ_PRO_API_URL` | Web deployments | Required outside development. The development default is `https://hqapi.hq.computer`. |
| `PUBLIC_APP_ORIGIN` | Web deployments | Public URL used for the Cognito callback. |
| `AWS_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_ISSUER`, `COGNITO_CLIENT_ID`, `COGNITO_HOSTED_UI_DOMAIN` | Hosted auth routes | Cognito configuration for the web deployment. |
| `HQ_LOCAL_MESH=1` | `vite dev` only | Explicit local-development session/token bridge opt-in; compiled out of production behavior. |
| `COGNITO_TEST_JWKS` | E2E only | Test public JWKS; ignored for Vercel production. |

hq-pro must be deployed with `HQ_WEB_ALLOWED_ORIGINS` containing each Work web
origin and must allow `Authorization` plus OPTIONS preflight. This is a hard
deployment dependency: the browser calls hq-pro directly for REST and realtime
credentials. `/api/chat-attachment-upload` and `/api/chat-attachment-bytes`
remain serverless functions because vault S3 buckets do not permit browser
cross-origin byte PUT/GET. The Cognito signin, callback, signout, and token
bridge routes also remain web-only serverless functions; Tauri uses the static
build and native adapter path instead.

For web, the verified session keeps the Cognito id token in an httpOnly cookie.
An authenticated, no-store same-origin `GET /api/auth/token` moves that token
into JavaScript memory only; all hq-pro requests attach it as `Authorization:
Bearer …`. It is never added to page data, localStorage, or a URL. An hq-pro
401 clears the in-memory token and returns the user through the existing
sign-in flow. This browser-held-token posture is deliberate and depends on the
hq-pro CORS allowlist above.

## Checks

```sh
pnpm --dir apps/work typecheck
pnpm --dir apps/work test
pnpm --dir apps/work lint
pnpm --dir apps/work build
TAURI=1 pnpm --dir apps/work build
pnpm --dir apps/work test:e2e
```

## Platform resolution

`resolveHostPlatform()` in `packages/platform` is the single place the app
decides which of `web | desktop | ios | android` it is. Nothing else should
inspect `window.__TAURI__` to work that out.

It reads two facts. First, whether a native shell is present at all — checked
*before* the OS, so a browser on an iPhone stays the `web` target and does not
inherit mobile-native capabilities. Second, which OS that shell is running on,
taken from `window.__HQ_HOST_OS__`, which `apps/work/src-tauri` injects as a
non-writable global from Rust's compile-time target before any page script
runs. That value cannot disagree with the binary that is executing; the Tauri
os-plugin global is kept only as a fallback.

`capabilitiesFor(platform)` turns that into the capability table the UI reads.
The switch is exhaustive, so adding a platform without a table is a compile
error rather than a silently degraded UI.

## Mobile

The native shell lives in `apps/work/src-tauri`. It is a wrapper with exactly
two jobs — host the shared build in a webview, and report the OS. It carries no
product behaviour, and no `tray-icon`, `window-vibrancy`, `global-shortcut`,
`single-instance` or `macos-private-api` dependency, none of which build for
iOS or Android.

| Command | What it does |
| --- | --- |
| `pnpm --dir apps/work icons` | Regenerate every icon set from the source image. |
| `pnpm --dir apps/work ios:init` | Generate the Xcode project (`src-tauri/gen/apple`). |
| `pnpm --dir apps/work ios:dev` | Run on a simulator or device. |
| `pnpm --dir apps/work ios:build` | Build the iOS app. |
| `pnpm --dir apps/work android:init` | Generate the Gradle project (`src-tauri/gen/android`). |
| `pnpm --dir apps/work android:dev` | Run on an emulator or device. |
| `pnpm --dir apps/work android:build` | Build the Android app. |

Rust targets:

```sh
# iOS
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
# Android
rustup target add aarch64-linux-android armv7-linux-androideabi \
  i686-linux-android x86_64-linux-android
```

### Icons

Icon sets are generated, not committed. `pnpm icons` renders every desktop,
Android and iOS size from the single source image
(`apps/sync/src-tauri/icons/app-icon.png`) into `src-tauri/icons` and
`src-tauri/gen/apple/Assets.xcassets`, both of which are gitignored. Every
`ios:*` and `android:*` script runs it first, so the normal build path needs no
extra step.

They are generated because `tauri ios init` seeds the icon set with Tauri's own
placeholder logo, and a committed placeholder is indistinguishable from a real
icon in review — this repo shipped one that way once. Regenerating makes the
source image the only thing that can be wrong.

The cost: a fresh checkout has no `AppIcon-*.png` until `pnpm icons` runs, so
**opening `src-tauri/gen/apple` in Xcode directly fails asset-catalog
compilation** until you run it. `pnpm --dir apps/work icons` fixes that.

**Android additionally needs a JDK, the Android SDK and the NDK**, with
`ANDROID_HOME` and `NDK_HOME` exported. Neither is installed on every dev
machine. A working macOS setup:

```sh
brew install openjdk@21
brew install --cask android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
# accepts Google's SDK licences — a legal agreement, so read it first
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install \
  platform-tools "platforms;android-36" "build-tools;36.0.0" \
  "ndk;27.3.13750724"
export NDK_HOME="$ANDROID_HOME/ndk/27.3.13750724"
```

The generated project pins `compileSdk`/`targetSdk` 36 and `minSdk` 24, so the
platform and build-tools majors must match 36. `pnpm --dir apps/work
android:build --debug --target aarch64` is a verified path on that setup.

`gen/android`'s Gradle `rustBuild*` task shells out to
`npm run -- tauri android android-studio-script`, which is why `package.json`
carries a bare `"tauri": "tauri"` passthrough. Nothing invokes that script by
hand; deleting it fails the APK assembly with only `Process 'command 'npm''
finished with non-zero exit value 1`, so `mobile-shell-config.test.ts` pins it.

### Known gap: the shell runs, the app does not render

Both mobile targets build, install and launch, but the root route does not
paint. `+layout.server.ts` and `+page.server.ts` are **server** loads, so the
client router requests `/__data.json` at startup, and a static bundle with no
server answers 404 — SvelteKit then renders its own 404 page. Reproducible off
-device by serving `apps/work/build` over plain HTTP.

Making mobile functional therefore means moving the root route's session data
off a server load (universal load + a native-auth branch), not fixing anything
in the native shell. Treat "it built" and "it works" as separate claims here.

Mobile capabilities are deliberately narrow (`MOBILE_CAPABILITIES` in
`packages/platform/src/capabilities.ts`): notifications and HTTP only. Every
local-machine capability — file browsing, sync daemon, launching apps, package
management, session spawning, the on-disk work-mesh cache — is false, because a
phone has no HQ checkout. `canSelfUpdate` is false because the app stores own
the update path.
