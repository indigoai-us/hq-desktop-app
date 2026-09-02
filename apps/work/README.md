# HQ Work

`apps/work` is the one HQ Work frontend. It owns the shared SvelteKit shell
for desktop, web, and a future mobile target; the UI and platform contracts
remain in `packages/{ui,platform,core,auth}`.

## Targets

| Target | Command | Output | Purpose |
| --- | --- | --- | --- |
| Web | `pnpm --dir apps/work build` | `apps/work/.vercel/output` | Vercel serverless auth and S3 byte-hop routes, plus the web shell. |
| Desktop | `TAURI=1 pnpm --dir apps/work build` | `apps/work/build/index.html` | Static SPA fallback for Tauri's `frontendDist`. No server routes are published. |
| Mobile (later) | `TAURI=1 pnpm --dir apps/work build` | `apps/work/build` | Reuses the same static target and shared shell. |

The adapter decision is intentionally one line in `svelte.config.js`: static
when `TAURI` is set and Vercel otherwise. The static target selects the empty
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
