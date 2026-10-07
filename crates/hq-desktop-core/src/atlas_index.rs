//! Company Atlas listing from the locally synced company folder (QA-016).
//!
//! The Atlas map used to page the whole company vault through hq-pro
//! `/v1/files/list` and read every project PRD over the network: about 42 s
//! cold for Indigo, longer than the UI's refresh timeout. The synced folder
//! under `companies/{slug}/` already holds the same ACL-filtered objects, so
//! the map is built from it in two steps:
//!
//! 1. [`atlas_first_page`] reads only the district roots and their direct
//!    children (no recursive walk). It returns folders and loose files in the
//!    `/v1/files/list` object shape plus a revision stamp, well under 2 s even
//!    on a large company.
//! 2. [`atlas_full_listing`] walks the districts once and caches the listing
//!    on disk keyed by that revision, so a second open with an unchanged
//!    folder reads one cache file instead of walking.
//!
//! The revision covers the names and mtimes of every entry at depth one and
//! two under each district plus the caller's sync stamp, so adding, removing
//! or syncing a project, knowledge folder or policy produces a new revision.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// District prefixes the Atlas map shows, plus the registry it seeds repos from.
pub const ATLAS_PREFIXES: [&str; 7] = [
    "projects/",
    "knowledge/",
    "policies/",
    "repos/",
    "workers/",
    "skills/",
    "registry/resources/",
];

/// Most objects listed per prefix; matches the TS builder's district cap.
pub const ATLAS_MAX_PER_PREFIX: usize = 100_000;

const CACHE_VERSION: u32 = 1;

/// One object in the `/v1/files/list` shape the TS builder parses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasObject {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasListing {
    pub revision: String,
    /// False for the first page: folders are placeholders without counts.
    pub complete: bool,
    /// True when a prefix hit [`ATLAS_MAX_PER_PREFIX`].
    pub truncated: bool,
    pub objects: Vec<AtlasObject>,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    listing: AtlasListing,
}

fn skip_name(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name == "Thumbs.db"
}

fn iso(time: Option<SystemTime>) -> Option<String> {
    let time = time?;
    let dt: chrono::DateTime<chrono::Utc> = time.into();
    Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn mtime_nanos(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn sorted_entries(dir: &Path) -> Vec<(String, fs::Metadata)> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, fs::Metadata)> = read
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_str()?.to_string();
            if skip_name(&name) {
                return None;
            }
            // symlink_metadata: a link never pulls in objects outside the company.
            let meta = fs::symlink_metadata(entry.path()).ok()?;
            if meta.file_type().is_symlink() {
                return None;
            }
            Some((name, meta))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Revision stamp for the company folder: depth one and two entries under
/// every prefix, with mtimes, plus `sync_stamp` (the last sync time).
pub fn atlas_revision(company_dir: &Path, sync_stamp: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(CACHE_VERSION.to_le_bytes());
    hash.update(sync_stamp.as_bytes());
    for prefix in ATLAS_PREFIXES {
        let root = company_dir.join(prefix.trim_end_matches('/'));
        hash.update(prefix.as_bytes());
        for (name, meta) in sorted_entries(&root) {
            hash.update(name.as_bytes());
            hash.update(mtime_nanos(&meta).to_le_bytes());
            hash.update(meta.len().to_le_bytes());
            if meta.is_dir() {
                for (child, child_meta) in sorted_entries(&root.join(&name)) {
                    hash.update(child.as_bytes());
                    hash.update(mtime_nanos(&child_meta).to_le_bytes());
                    hash.update(child_meta.len().to_le_bytes());
                }
            }
        }
    }
    let digest = hash.finalize();
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// District roots and their direct children only. Folders come back as
/// `prefix/name/` keys, which the TS builder turns into one folder node each.
pub fn atlas_first_page(company_dir: &Path, sync_stamp: &str) -> AtlasListing {
    let mut objects = Vec::new();
    for prefix in ATLAS_PREFIXES {
        let root = company_dir.join(prefix.trim_end_matches('/'));
        for (name, meta) in sorted_entries(&root) {
            let key = if meta.is_dir() {
                format!("{prefix}{name}/")
            } else {
                format!("{prefix}{name}")
            };
            objects.push(AtlasObject {
                key,
                last_modified: iso(meta.modified().ok()),
                size: if meta.is_dir() { 0 } else { meta.len() },
            });
        }
    }
    AtlasListing {
        revision: atlas_revision(company_dir, sync_stamp),
        complete: false,
        truncated: false,
        objects,
    }
}

fn walk_prefix(company_dir: &Path, prefix: &str, cap: usize, out: &mut Vec<AtlasObject>) -> bool {
    let root = company_dir.join(prefix.trim_end_matches('/'));
    if !root.is_dir() {
        return false;
    }
    let mut count = 0usize;
    let walker = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || e.file_name().to_str().map_or(false, |n| !skip_name(n)));
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                eprintln!("[atlas_index] walk entry skipped under {prefix}: {err}");
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(company_dir) else {
            continue;
        };
        let Some(rel) = rel.to_str() else { continue };
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(err) => {
                eprintln!("[atlas_index] stat failed for {rel}: {err}");
                continue;
            }
        };
        out.push(AtlasObject {
            key: rel.replace('\\', "/"),
            last_modified: iso(meta.modified().ok()),
            size: meta.len(),
        });
        count += 1;
        if count >= cap {
            return true;
        }
    }
    false
}

fn cache_path(cache_dir: &Path, cache_key: &str) -> PathBuf {
    let safe: String = cache_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    cache_dir.join(format!("{safe}.json"))
}

/// Cached listing for `cache_key` when its revision still matches.
pub fn atlas_cached_listing(cache_dir: &Path, cache_key: &str, revision: &str) -> Option<AtlasListing> {
    let raw = fs::read(cache_path(cache_dir, cache_key)).ok()?;
    let file: CacheFile = match serde_json::from_slice(&raw) {
        Ok(file) => file,
        Err(err) => {
            eprintln!("[atlas_index] cache unreadable for {cache_key}: {err}");
            return None;
        }
    };
    (file.version == CACHE_VERSION && file.listing.revision == revision).then_some(file.listing)
}

/// Every object under the Atlas prefixes. Served from the on-disk cache when
/// the folder revision is unchanged; otherwise walked once and cached.
pub fn atlas_full_listing(
    company_dir: &Path,
    sync_stamp: &str,
    cache_dir: &Path,
    cache_key: &str,
    cap: usize,
) -> AtlasListing {
    let revision = atlas_revision(company_dir, sync_stamp);
    if let Some(hit) = atlas_cached_listing(cache_dir, cache_key, &revision) {
        return hit;
    }
    let mut objects = Vec::new();
    let mut truncated = false;
    for prefix in ATLAS_PREFIXES {
        truncated |= walk_prefix(company_dir, prefix, cap, &mut objects);
    }
    let listing = AtlasListing {
        revision,
        complete: true,
        truncated,
        objects,
    };
    if let Err(err) = write_cache(cache_dir, cache_key, &listing) {
        // A missing cache only costs the next open a walk.
        eprintln!("[atlas_index] cache write failed for {cache_key}: {err}");
    }
    listing
}

fn write_cache(cache_dir: &Path, cache_key: &str, listing: &AtlasListing) -> Result<(), String> {
    fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let body = serde_json::to_vec(&CacheFile {
        version: CACHE_VERSION,
        listing: listing.clone(),
    })
    .map_err(|e| e.to_string())?;
    let target = cache_path(cache_dir, cache_key);
    let tmp = target.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

/// Validate a company-relative object key for a text read under the Atlas
/// prefixes: no absolute paths, no `..`, no hidden segments.
pub fn atlas_object_path(company_dir: &Path, key: &str) -> Result<PathBuf, String> {
    let key = key.trim();
    if key.is_empty() || key.starts_with('/') || key.contains('\\') {
        return Err(format!("invalid atlas key: {key:?}"));
    }
    if !ATLAS_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return Err(format!("atlas key outside the map: {key:?}"));
    }
    if key.split('/').any(|seg| seg.is_empty() || seg == ".." || seg.starts_with('.')) {
        return Err(format!("invalid atlas key: {key:?}"));
    }
    Ok(company_dir.join(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn synthetic_vault(root: &Path, files: usize) {
        // ~20k files spread like a real company: many projects with nested
        // story folders, knowledge, policies, workers and skills.
        let districts = [("projects", 6), ("knowledge", 2), ("policies", 1), ("workers", 1)];
        let total_weight: usize = districts.iter().map(|d| d.1).sum();
        for (district, weight) in districts {
            let n = files * weight / total_weight;
            for i in 0..n {
                let dir = root.join(format!("{district}/item-{:03}/sub-{}", i / 25, i % 5));
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join(format!("file-{i}.md")), b"x").unwrap();
            }
        }
        fs::create_dir_all(root.join("skills/one")).unwrap();
        fs::write(root.join("skills/one/SKILL.md"), b"x").unwrap();
        fs::write(root.join("policies/loose-policy.md"), b"x").unwrap();
        fs::create_dir_all(root.join("knowledge/.git")).unwrap();
        fs::write(root.join("knowledge/.git/HEAD"), b"x").unwrap();
    }

    #[test]
    fn first_page_on_a_20k_file_vault_returns_under_two_seconds() {
        let tmp = tempfile::tempdir().unwrap();
        synthetic_vault(tmp.path(), 20_000);
        let started = Instant::now();
        let page = atlas_first_page(tmp.path(), "sync-1");
        let elapsed = started.elapsed();
        assert!(elapsed.as_secs_f64() < 2.0, "first page took {elapsed:?}");
        assert!(!page.complete);
        // Folders only at depth one: 20k files collapse to a few hundred keys.
        assert!(page.objects.len() < 1_000, "{} keys", page.objects.len());
        assert!(page.objects.iter().any(|o| o.key == "projects/item-000/"));
        assert!(page.objects.iter().any(|o| o.key == "skills/one/"));
        assert!(page.objects.iter().any(|o| o.key == "policies/loose-policy.md"));
        assert!(!page.objects.iter().any(|o| o.key.contains(".git")));
    }

    #[test]
    fn full_listing_walks_once_then_serves_the_revision_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let company = tmp.path().join("company");
        let cache = tmp.path().join("cache");
        synthetic_vault(&company, 20_000);
        let cold = atlas_full_listing(&company, "sync-1", &cache, "co", ATLAS_MAX_PER_PREFIX);
        assert!(cold.complete);
        assert!(!cold.truncated);
        assert!(cold.objects.len() >= 19_990, "{} objects", cold.objects.len());
        assert!(cold.objects.iter().all(|o| !o.key.contains("/.git/")));
        assert_eq!(cold.revision, atlas_first_page(&company, "sync-1").revision);

        let started = Instant::now();
        let warm = atlas_full_listing(&company, "sync-1", &cache, "co", ATLAS_MAX_PER_PREFIX);
        assert_eq!(warm, cold);
        assert!(started.elapsed().as_secs_f64() < 2.0);

        // A new sync stamp or a new project folder invalidates the cache.
        assert_ne!(atlas_revision(&company, "sync-2"), cold.revision);
        fs::create_dir_all(company.join("projects/brand-new")).unwrap();
        fs::write(company.join("projects/brand-new/prd.json"), b"{}").unwrap();
        let after = atlas_full_listing(&company, "sync-1", &cache, "co", ATLAS_MAX_PER_PREFIX);
        assert_ne!(after.revision, cold.revision);
        assert!(after.objects.iter().any(|o| o.key == "projects/brand-new/prd.json"));
    }

    #[test]
    fn full_listing_caps_each_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        synthetic_vault(tmp.path(), 2_000);
        let listing = atlas_full_listing(tmp.path(), "", &tmp.path().join(".cache"), "co", 50);
        assert!(listing.truncated);
        let projects = listing.objects.iter().filter(|o| o.key.starts_with("projects/")).count();
        assert_eq!(projects, 50);
    }

    #[test]
    fn object_paths_stay_inside_the_map() {
        let root = Path::new("/hq/companies/co");
        assert!(atlas_object_path(root, "projects/a/prd.json").is_ok());
        for bad in ["../x", "projects/../../etc/passwd", "/etc/passwd", "settings/.env", "projects/.hidden/x", ""] {
            assert!(atlas_object_path(root, bad).is_err(), "{bad}");
        }
    }

    /// Manual timing on a real synced company folder:
    /// `ATLAS_MEASURE_DIR=<hq>/companies/<slug> cargo test --lib atlas_index -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn measure_real_company_folder() {
        let Ok(dir) = std::env::var("ATLAS_MEASURE_DIR") else { return };
        let dir = PathBuf::from(dir);
        let cache = tempfile::tempdir().unwrap();
        let t = Instant::now();
        let page = atlas_first_page(&dir, "measure");
        println!("first page: {} keys in {:?}", page.objects.len(), t.elapsed());
        let t = Instant::now();
        let cold = atlas_full_listing(&dir, "measure", cache.path(), "m", ATLAS_MAX_PER_PREFIX);
        println!("full cold: {} objects in {:?}", cold.objects.len(), t.elapsed());
        let t = Instant::now();
        let warm = atlas_full_listing(&dir, "measure", cache.path(), "m", ATLAS_MAX_PER_PREFIX);
        println!("full warm: {} objects in {:?}", warm.objects.len(), t.elapsed());
    }
}
