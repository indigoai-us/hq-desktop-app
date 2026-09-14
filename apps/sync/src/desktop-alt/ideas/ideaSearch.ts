/**
 * Re-export shim. The board's pure search/derivation logic now lives in
 * `@hq/ui/ideas/search` so the shell's Ideas tab and this legacy desktop-alt
 * board share ONE implementation instead of drifting copies.
 *
 * The types differ only in import path — `@hq/platform`'s `IdeaCapture` and
 * the local store's are the same structural shape (both mirror the Rust
 * `CaptureRecord`), so existing callers here need no change.
 */
export * from '@hq/ui/ideas/search';
