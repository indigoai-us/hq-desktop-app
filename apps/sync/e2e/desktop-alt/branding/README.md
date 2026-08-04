# Desktop-alt branding chrome harness (US-007)

Test harness for V4 desktop UI chrome tokens and (later) white-label branding.
Lives under `e2e/desktop-alt/branding/` and runs with the rest of the desktop-alt
E2E suite.

## Why Vitest + happy-dom (not tauri-driver)

The desktop-alt suite already has a dual harness: source-contract specs in Node,
and real component-mount specs under happy-dom (see `mission-control.test.ts`).

For **CSS custom properties and color-scheme chrome**, we need a DOM + CSSOM
with `getComputedStyle` and `prefers-color-scheme` media queries. Options:

| Approach | Why not / why |
|----------|----------------|
| **tauri-driver + WebDriver** | No macOS WKWebView WebDriver support — cannot drive the real Tauri window's style tree on this platform. |
| **Vitest + happy-dom (this harness)** | Injects the real `src/desktop-alt/v4/tokens.css`, resolves `@media (prefers-color-scheme: …)`, and mounts real Svelte V4 chrome with mocked Tauri bridges. Fast, CI-friendly, no app binary. |

Brand product wiring (US-005) is still out of scope; this story freezes the
token contract and the fixture injection path so branded cases can fill in later.

## How `prefers-color-scheme` emulation works

happy-dom exposes device media settings on the window:

```ts
(window as any).happyDOM.settings.device.prefersColorScheme = 'light' | 'dark';
```

Default in happy-dom is `'light'`. Set the scheme **before** injecting the CSS
(or re-inject the `<style>` after flipping) so media-query rules re-resolve.
Then read tokens with:

```ts
getComputedStyle(document.documentElement).getPropertyValue('--v4-ground').trim();
```

Dark defaults and light overrides are asserted against the values in
`src/desktop-alt/v4/tokens.css` (e.g. dark `--v4-ground` `#161618`, light
`#f6f6f8`).

## Brand fixture mechanism

| Export | Role |
|--------|------|
| `CompanyBrandSettings` | Frozen interface: `logoUrlLight`, `logoUrlDark`, `accentColor` (hq-pro shape). |
| `TEST_BRAND` | Built-in fixture (`https://fixtures.test/logo-*.svg`, `#6633cc`). |
| `BrandEntitlement` / `TEST_ENTITLEMENT` | `'entitled' \| 'not_entitled'`; default `not_entitled`. |
| `loadBrandFixture()` | Reads optional `HQ_SYNC_BRAND_FIXTURE` (path to JSON); falls back to `TEST_BRAND`. |

Inject a custom brand without a live hq-pro backend:

```bash
HQ_SYNC_BRAND_FIXTURE=./path/to/brand.json pnpm test:e2e:desktop-alt
```

JSON must include the three string fields of `CompanyBrandSettings`.

## How to run locally

From the repo root (same command as CI):

```bash
pnpm test:e2e:desktop-alt
```

That runs `vitest run --config e2e/desktop-alt/vitest.config.ts`, which includes
`e2e/desktop-alt/**/*.spec.ts` (and `**/*.test.ts`), so `branding/chrome-tokens.spec.ts`
is picked up automatically.

Typecheck (also run in `.github/workflows/desktop-alt-e2e.yml`):

```bash
pnpm typecheck
```

## Adding branded cases (US-005+)

1. Open `chrome-tokens.spec.ts` and replace the
   `describe.todo('branded chrome (US-005)')` block with a real `describe`.
2. Load brand via `loadBrandFixture()` or `TEST_BRAND`; set entitlement to
   `'entitled'`.
3. Mount the product chrome that applies logo / accent overrides.
4. Assert DOM (logo `src`s) and any CSS variables product introduces.
5. Keep the default-token and “app shell mounts with HQ defaults” cases green —
   branded paths must not break unbranded chrome.

## CI

`.github/workflows/desktop-alt-e2e.yml` runs on `macos-latest` when
`e2e/desktop-alt/**` or `src/desktop-alt/**` (including `v4/tokens.css`) change.
No separate workflow step is required for this subdirectory.
