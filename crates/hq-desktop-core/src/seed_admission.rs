//! Read-only first-seed checks. No ownership is inferred from existing bytes.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedEntry {
    Directory,
    File(String),
    Symlink(PathBuf),
}
pub fn require_empty(root: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("The prepared folder is missing or replaced.".into());
    }
    if std::fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err("The prepared folder is not empty; its files require recovery review.".into());
    }
    Ok(())
}
/// Compare every actual entry, without following links, with the exact template.
/// A partial or changed tree cannot become a completed seed.
pub fn verify_inventory(
    root: &Path,
    expected: &BTreeMap<PathBuf, SeedEntry>,
    hash_file: &dyn Fn(&Path) -> Result<String, String>,
) -> Result<(), String> {
    fn visit(
        root: &Path,
        dir: &Path,
        found: &mut BTreeMap<PathBuf, SeedEntry>,
        hash: &dyn Fn(&Path) -> Result<String, String>,
        expected: &BTreeMap<PathBuf, SeedEntry>,
    ) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_path_buf();
            if !expected.contains_key(&relative) {
                return Err("Unknown file in prepared folder; recovery review required. Files were preserved.".into());
            }
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            let kind = if meta.file_type().is_symlink() {
                SeedEntry::Symlink(std::fs::read_link(&path).map_err(|e| e.to_string())?)
            } else if meta.is_dir() {
                SeedEntry::Directory
            } else if meta.is_file() {
                SeedEntry::File(hash(&path)?)
            } else {
                return Err(
                    "Unsupported entry in prepared folder; recovery review required.".into(),
                );
            };
            let recurse = kind == SeedEntry::Directory;
            found.insert(relative, kind);
            if recurse {
                visit(root, &path, found, hash, expected)?;
            }
        }
        Ok(())
    }
    let meta = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("Prepared folder is missing or replaced.".into());
    }
    let mut actual = BTreeMap::new();
    visit(root, root, &mut actual, hash_file, expected)?;
    if &actual != expected {
        return Err("Prepared files differ from the template; recovery review required. Files were preserved.".into());
    }
    Ok(())
}
/// Persist created directory entries before the app commits Seeded. Windows
/// directory durability still requires paired platform acceptance.
pub fn sync_directories(root: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if std::fs::symlink_metadata(&path)
                .map_err(|e| e.to_string())?
                .is_dir()
            {
                sync_directories(&path)?;
            }
        }
        std::fs::File::open(root)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = root;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "hq-seed-module-{}-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&p).unwrap();
        p
    }
    fn hash(p: &Path) -> Result<String, String> {
        std::fs::read_to_string(p).map_err(|e| e.to_string())
    }
    #[test]
    fn empty_and_unchanged_tree_pass() {
        let r = fixture();
        require_empty(&r).unwrap();
        std::fs::create_dir(r.join("core")).unwrap();
        std::fs::write(r.join("core/a"), "owned").unwrap();
        let e = BTreeMap::from([
            (PathBuf::from("core"), SeedEntry::Directory),
            (PathBuf::from("core/a"), SeedEntry::File("owned".into())),
        ]);
        verify_inventory(&r, &e, &hash).unwrap();
        sync_directories(&r).unwrap();
        std::fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn initialize_done_nonempty_and_arrival_before_seed_hold() {
        let r = fixture();
        require_empty(&r).unwrap();
        std::fs::write(r.join("notes"), "unknown").unwrap();
        assert!(require_empty(&r).is_err());
        assert_eq!(std::fs::read_to_string(r.join("notes")).unwrap(), "unknown");
        std::fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn partial_missing_entry_cannot_complete() {
        let r = fixture();
        let e = BTreeMap::from([(PathBuf::from("missing"), SeedEntry::File("needed".into()))]);
        assert!(verify_inventory(&r, &e, &hash).is_err());
        std::fs::remove_dir_all(r).unwrap();
    }
    #[test]
    fn unknown_extra_and_changed_bytes_hold_without_cleanup() {
        let r = fixture();
        std::fs::write(r.join("a"), "changed").unwrap();
        let e = BTreeMap::from([(PathBuf::from("a"), SeedEntry::File("approved".into()))]);
        assert!(verify_inventory(&r, &e, &hash).is_err());
        std::fs::write(r.join("a"), "approved").unwrap();
        std::fs::write(r.join("extra"), "keep").unwrap();
        assert!(verify_inventory(&r, &e, &hash).is_err());
        assert_eq!(std::fs::read_to_string(r.join("extra")).unwrap(), "keep");
        std::fs::remove_dir_all(r).unwrap();
    }
}
