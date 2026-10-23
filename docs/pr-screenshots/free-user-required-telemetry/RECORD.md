# US-004 build and render record

Story: free-user-required-telemetry US-004, the desktop usage-data disclosure for free users.

## Render check (design harness)

- Server: `npm run dev:preview` run from `apps/sync` (Vite preview config, port 5391 for this lane).
- Pages: `/dev-harness/index.html?view=onboarding&mode=consent&step=6&notice=pending` (consent run) and `/dev-harness/index.html?view=onboarding&step=8&notice=pending` (ready screen).
- Driver: Playwright 1.62.1 with system Chrome (`channel: 'chrome'`), headless, `reducedMotion: 'reduce'`, viewports 1280x800 and 390x844.
- The live server flag is off, so every state is mocked through the harness `notice` query parameter.
- BEFORE images come from origin/main (af35beb1f). The BEFORE consent image needs this branch's `mode=consent` harness patch, because origin/main's harness cannot open the consent run directly.
- AFTER results: the disclosure shows in every image, and the consent run has no checkbox. The harness mock carries the locked server text (TELEMETRY_DISCLOSURE, version 2026-10-22) word for word, and none of the images contains the word "anonymous". Both lists end above the fold in every image. Consent 1280: collects list ends at 490px, never-collects at 450px, actions at 645px of 800. Consent 390: 522px and 628px, actions at 802px of 844. Ready 1280: 605px and 571px, actions at 717px of 800. Ready 390: 665px and 756px of 844; the upgrade line and the actions sit below the fold at 884px, so that screen needs a scroll to reach Continue. No page errors were logged.
- The single checkbox left on the ready screen is "Enable HQ Anywhere", which is also on origin/main.

## Native build

- One debug bundle was built and copied to `/tmp/fut-scratch/HQ US004 Scratch.app` under its own product name. It was never launched.
- `tauri build --debug` compiled and bundled the .app. The DMG step then failed in `bundle_dmg.sh`, and ad hoc signing failed because the `HQ Installer Dev` identity is not on this machine. Neither affects the .app compile check.
- The bundle and every `src-tauri/target` directory are deleted after this record and the screenshots are committed.

## Gates

- `pnpm typecheck`, `pnpm lint`, `pnpm test`: all exit 0 (@hq/platform 747, @hq/work 458, @hq/ui 12357, hq-sync 2967 tests).
- `cargo test -p hq-desktop-core`: 3151 passed with `--test-threads=4`. The first fully parallel run had 6 timing failures in `hq_cli_update` and `runtime_diagnosis`, modules this branch does not touch. All of them passed on the rerun.
- `cargo test -p hq-sync-menubar`: 2324 passed, 0 failed.
