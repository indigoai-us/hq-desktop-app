# HQ Native for macOS

This target is the fully native macOS edition of HQ. Its UI is SwiftUI/AppKit,
uses the macOS 26 Liquid Glass system material when available, keeps a native
material fallback for macOS 13–15, and contains no web view or Tauri
dependency.

This is the shipping macOS target. The existing `apps/sync` target remains the
Windows Tauri application and a retained compatibility reference; both targets
read the same local HQ folder and service contracts. Native cutover is guarded
by generated command/event ledgers, exhaustive unit and UI tests, and 188
full-window screenshots.

## Local build

```sh
pnpm install --frozen-lockfile
xcodegen generate --spec apps/native-macos/project.yml \
  --project apps/native-macos
xcodebuild -project apps/native-macos/HQNative.xcodeproj -scheme HQNative \
  -destination 'platform=macOS' build
```

Local builds require macOS 26/Xcode 26, Rust with the
`aarch64-apple-darwin` target, XcodeGen, and the Recall SDK dependencies
installed by the workspace package install.

## Tests

```sh
xcodebuild -project apps/native-macos/HQNative.xcodeproj -scheme HQNative \
  -destination 'platform=macOS' test
pnpm visual-tour:native
```

The visual tour captures 30 routes and 17 standalone windows in light, dark,
light reduced-transparency, and dark reduced-transparency variants. It rejects
missing, blank, transparent, undersized, or incomplete captures.
