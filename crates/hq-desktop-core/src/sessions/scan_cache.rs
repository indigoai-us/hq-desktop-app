//! Content-keyed memos for the per-file parses the local session scanners do.
//!
//! ## Why this exists
//!
//! The Mission Control poller (`commands/sessions.rs::setup_sessions_poller`)
//! re-runs a full local scan every [`super::SESSIONS_POLL_INTERVAL_SECS`]
//! seconds. Each scan used to re-open and re-parse **every** transcript on disk:
//! a 64 KiB tail read + `serde_json` parse per Claude transcript, plus a head
//! read per Codex rollout. On a working machine that is thousands of files —
//! measured at ~4,400 files and up to ~165 MB read and parsed *every 5 seconds*,
//! which cost ~7 % of a CPU continuously and dominated the app's Activity
//! Monitor energy impact.
//!
//! Almost none of those files change between two ticks. `stat` is already done
//! (mtime is the liveness signal), so the parse result can be memoised against
//! the stat and reused. A tick then costs `read_dir` + `stat` per file, and a
//! real read only for the handful of transcripts that actually grew — which is
//! exactly the set of live sessions.
//!
//! ## Correctness
//!
//! [`StampCache`] keys on `(mtime, len)`. Appending to a transcript changes
//! both, so a live session's tail is re-read on the very next tick: freshness is
//! unchanged relative to reading unconditionally.
//!
//! [`StableCache`] is for parses whose result cannot change for a given path:
//! the *head* of an append-only rollout file, and an HQ `meta.yaml` that is
//! written once at session start. Only successful parses are stored, so a file
//! that appears later is still picked up on the next tick.
//!
//! Callers prune a cache with [`StampCache::retain_paths`] /
//! [`StableCache::retain_paths`], passing the set of paths the current scan saw,
//! so a deleted or rotated transcript does not leak an entry forever. Memos whose
//! key set is already bounded by the number of real sessions (the HQ `meta.yaml`
//! lookup) are left unpruned deliberately — the entries are tiny and one per
//! session.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// The stat fields that identify a version of a file's contents.
///
/// Both are required: mtime alone has coarse granularity on some filesystems, and
/// length alone misses an in-place rewrite.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileStamp {
    pub mtime: SystemTime,
    pub len: u64,
}

impl FileStamp {
    pub fn new(mtime: SystemTime, len: u64) -> Self {
        Self { mtime, len }
    }
}

/// A memo keyed by path **and** [`FileStamp`]: the entry is reused only while the
/// file's mtime and length are unchanged.
pub struct StampCache<T> {
    entries: Mutex<Option<HashMap<PathBuf, (FileStamp, T)>>>,
}

impl<T: Clone> StampCache<T> {
    /// Const-constructible so callers can hold one in a `static`.
    pub const fn new() -> Self {
        Self {
            entries: Mutex::new(None),
        }
    }

    /// Return the memoised value for `path` at `stamp`, computing and storing it
    /// when absent or stale.
    ///
    /// A poisoned lock is not fatal: we fall back to computing without caching,
    /// so a panic elsewhere degrades performance rather than breaking the scan.
    pub fn get_or_compute(&self, path: &Path, stamp: FileStamp, compute: impl FnOnce() -> T) -> T {
        let Ok(mut guard) = self.entries.lock() else {
            return compute();
        };
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some((cached_stamp, value)) = map.get(path) {
            if *cached_stamp == stamp {
                return value.clone();
            }
        }
        let value = compute();
        map.insert(path.to_path_buf(), (stamp, value.clone()));
        value
    }

    /// Drop every entry whose path is not in `keep`. Called once per scan with
    /// the paths the scan actually saw, bounding the cache to live files.
    pub fn retain_paths(&self, keep: &HashSet<PathBuf>) {
        if let Ok(mut guard) = self.entries.lock() {
            if let Some(map) = guard.as_mut() {
                map.retain(|path, _| keep.contains(path));
            }
        }
    }

    /// Number of live entries. Test/diagnostic accessor.
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|map| map.len()))
            .unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Forget everything. Test/diagnostic helper.
    pub fn clear(&self) {
        if let Ok(mut guard) = self.entries.lock() {
            *guard = None;
        }
    }
}

impl<T: Clone> Default for StampCache<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// A memo keyed by path only, for parses whose result cannot change for a given
/// path (see the module docs). Only successful values are stored — the caller
/// passes `None` for "nothing to remember yet" and we retry next scan.
pub struct StableCache<T> {
    entries: Mutex<Option<HashMap<PathBuf, T>>>,
}

impl<T: Clone> StableCache<T> {
    pub const fn new() -> Self {
        Self {
            entries: Mutex::new(None),
        }
    }

    /// Return the memoised value for `path`, computing it when absent. `compute`
    /// returning `None` is **not** cached, so a file that shows up later is
    /// still picked up.
    pub fn get_or_compute(&self, path: &Path, compute: impl FnOnce() -> Option<T>) -> Option<T> {
        let Ok(mut guard) = self.entries.lock() else {
            return compute();
        };
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(value) = map.get(path) {
            return Some(value.clone());
        }
        let value = compute()?;
        map.insert(path.to_path_buf(), value.clone());
        Some(value)
    }

    pub fn retain_paths(&self, keep: &HashSet<PathBuf>) {
        if let Ok(mut guard) = self.entries.lock() {
            if let Some(map) = guard.as_mut() {
                map.retain(|path, _| keep.contains(path));
            }
        }
    }

    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|map| map.len()))
            .unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        if let Ok(mut guard) = self.entries.lock() {
            *guard = None;
        }
    }
}

impl<T: Clone> Default for StableCache<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::time::Duration;

    fn stamp(secs: u64, len: u64) -> FileStamp {
        FileStamp::new(SystemTime::UNIX_EPOCH + Duration::from_secs(secs), len)
    }

    #[test]
    fn stamp_cache_computes_once_for_an_unchanged_file() {
        let cache: StampCache<u32> = StampCache::new();
        let calls = Cell::new(0);
        let path = Path::new("/tmp/a.jsonl");

        for _ in 0..10 {
            let value = cache.get_or_compute(path, stamp(100, 4096), || {
                calls.set(calls.get() + 1);
                7
            });
            assert_eq!(value, 7);
        }

        // Ten polls, one parse — this is the whole point of the cache.
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn stamp_cache_recomputes_when_mtime_changes() {
        let cache: StampCache<u32> = StampCache::new();
        let calls = Cell::new(0);
        let path = Path::new("/tmp/a.jsonl");

        cache.get_or_compute(path, stamp(100, 4096), || {
            calls.set(calls.get() + 1);
            1
        });
        let value = cache.get_or_compute(path, stamp(101, 4096), || {
            calls.set(calls.get() + 1);
            2
        });

        assert_eq!(value, 2, "a touched file must be re-read, not served stale");
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn stamp_cache_recomputes_when_length_changes() {
        let cache: StampCache<u32> = StampCache::new();
        let calls = Cell::new(0);
        let path = Path::new("/tmp/a.jsonl");

        cache.get_or_compute(path, stamp(100, 4096), || {
            calls.set(calls.get() + 1);
            1
        });
        // An append inside the same mtime granularity still changes length.
        let value = cache.get_or_compute(path, stamp(100, 9000), || {
            calls.set(calls.get() + 1);
            2
        });

        assert_eq!(value, 2);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn stamp_cache_keys_are_per_path() {
        let cache: StampCache<u32> = StampCache::new();
        cache.get_or_compute(Path::new("/tmp/a"), stamp(1, 1), || 1);
        cache.get_or_compute(Path::new("/tmp/b"), stamp(1, 1), || 2);

        assert_eq!(
            cache.get_or_compute(Path::new("/tmp/a"), stamp(1, 1), || 99),
            1
        );
        assert_eq!(
            cache.get_or_compute(Path::new("/tmp/b"), stamp(1, 1), || 99),
            2
        );
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn stamp_cache_retain_drops_vanished_paths() {
        let cache: StampCache<u32> = StampCache::new();
        cache.get_or_compute(Path::new("/tmp/a"), stamp(1, 1), || 1);
        cache.get_or_compute(Path::new("/tmp/b"), stamp(1, 1), || 2);
        assert_eq!(cache.len(), 2);

        let keep: HashSet<PathBuf> = [PathBuf::from("/tmp/a")].into_iter().collect();
        cache.retain_paths(&keep);

        assert_eq!(cache.len(), 1, "deleted transcripts must not leak entries");
        assert_eq!(
            cache.get_or_compute(Path::new("/tmp/a"), stamp(1, 1), || 99),
            1
        );
    }

    #[test]
    fn stable_cache_computes_once_and_ignores_stamp() {
        let cache: StableCache<u32> = StableCache::new();
        let calls = Cell::new(0);
        let path = Path::new("/tmp/rollout.jsonl");

        for _ in 0..5 {
            let value = cache.get_or_compute(path, || {
                calls.set(calls.get() + 1);
                Some(3)
            });
            assert_eq!(value, Some(3));
        }

        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn stable_cache_does_not_memoise_absence() {
        let cache: StableCache<u32> = StableCache::new();
        let calls = Cell::new(0);
        let path = Path::new("/tmp/meta.yaml");

        // File not there yet.
        assert_eq!(
            cache.get_or_compute(path, || {
                calls.set(calls.get() + 1);
                None
            }),
            None
        );
        // ...and now it is. A cached "missing" would hide it forever.
        assert_eq!(
            cache.get_or_compute(path, || {
                calls.set(calls.get() + 1);
                Some(5)
            }),
            Some(5)
        );
        assert_eq!(calls.get(), 2);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn stable_cache_retain_drops_vanished_paths() {
        let cache: StableCache<u32> = StableCache::new();
        cache.get_or_compute(Path::new("/tmp/a"), || Some(1));
        cache.get_or_compute(Path::new("/tmp/b"), || Some(2));

        let keep: HashSet<PathBuf> = [PathBuf::from("/tmp/b")].into_iter().collect();
        cache.retain_paths(&keep);

        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn clear_forgets_everything() {
        let cache: StampCache<u32> = StampCache::new();
        cache.get_or_compute(Path::new("/tmp/a"), stamp(1, 1), || 1);
        assert!(!cache.is_empty());
        cache.clear();
        assert!(cache.is_empty());
    }
}
