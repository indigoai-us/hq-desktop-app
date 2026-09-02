# Native parity ledger

This directory is the cutover gate for the macOS native rewrite.

- `commands.json` is generated from the Tauri command registry and annotated
  with its native, engine, Windows-only, or retired disposition.
- `events.json` is generated from frontend listeners and records whether the
  native platform layer or Rust engine owns each stream.
- `routes.json` enumerates every desktop route that requires a native rendering.
- `windows.json` enumerates every standalone surface and its verification size.

Regenerate command and event ledgers from the repository root:

```sh
node scripts/generate-native-parity.mjs
```

Cutover is blocked when a frontend command appears only in
`frontendOnlyCommands`, when a route or window has no XCUITest, or when any
`visualRequired` surface lacks a full-window macOS screenshot in any of the
four required variants: light, dark, light reduced-transparency, and dark
reduced-transparency.

Run the complete visual gate from the repository root:

```sh
pnpm visual-tour:native
```
