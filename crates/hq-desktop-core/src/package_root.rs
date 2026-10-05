use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Take};
use std::path::{Path, PathBuf};

pub const PACKAGE_VERSION_STORE_POINTER_MAX_BYTES: usize = 512;
pub const PACKAGE_ROOT_MANIFEST_MAX_BYTES: usize = 1024;

pub const LEGACY_ROOT_ID: &str = "legacy";
const STORE_DIR: &str = "hq-cli";
const VERSIONS_DIR: &str = "versions";
const POINTER_FILE: &str = "active-root.json";
const MANIFEST_FILE: &str = "hq-root.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivePackageRoot {
    pub root_id: String,
    pub version: Option<String>,
    pub root_path: PathBuf,
}

/// Resolve the versioned CLI root selected by the pointer. Any invalid or
/// unavailable store state falls back to the existing npm-installed tree.
pub fn resolve_active_package_root(prefix: &Path, legacy_root: &Path) -> ActivePackageRoot {
    resolve_versioned_root(prefix).unwrap_or_else(|| ActivePackageRoot {
        root_id: LEGACY_ROOT_ID.to_owned(),
        version: None,
        root_path: legacy_root.to_path_buf(),
    })
}

fn resolve_versioned_root(prefix: &Path) -> Option<ActivePackageRoot> {
    let store = prefix.join(STORE_DIR);
    let versions = store.join(VERSIONS_DIR);
    if !is_real_directory(&store) || !is_real_directory(&versions) {
        return None;
    }

    let pointer = read_bounded_json(
        &store.join(POINTER_FILE),
        PACKAGE_VERSION_STORE_POINTER_MAX_BYTES,
    )?;
    if !schema_is_one(pointer.get("schema")?) {
        return None;
    }
    let root_id = pointer.get("root_id")?.as_str()?;
    let version = pointer.get("version")?.as_str()?;
    if !is_valid_root_id(root_id) || !is_strict_semver(version) {
        return None;
    }

    let root_path = versions.join(format!("{version}-{root_id}"));
    if !is_real_directory(&root_path) {
        return None;
    }
    let manifest = read_bounded_json(
        &root_path.join(MANIFEST_FILE),
        PACKAGE_ROOT_MANIFEST_MAX_BYTES,
    )?;
    if !schema_is_one(manifest.get("schema")?)
        || manifest.get("root_id")?.as_str()? != root_id
        || manifest.get("version")?.as_str()? != version
    {
        return None;
    }

    Some(ActivePackageRoot {
        root_id: root_id.to_owned(),
        version: Some(version.to_owned()),
        root_path,
    })
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

fn read_bounded_json(path: &Path, max_bytes: usize) -> Option<Value> {
    let path_metadata = fs::symlink_metadata(path).ok()?;
    if !path_metadata.file_type().is_file()
        || path_metadata.file_type().is_symlink()
        || path_metadata.len() > max_bytes as u64
    {
        return None;
    }
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > max_bytes as u64 {
        return None;
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut limited: Take<File> = file.take(max_bytes as u64 + 1);
    limited.read_to_end(&mut bytes).ok()?;
    if bytes.len() > max_bytes {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn schema_is_one(value: &Value) -> bool {
    value.as_u64() == Some(1) || value.as_i64() == Some(1) || value.as_f64() == Some(1.0)
}

fn is_valid_root_id(root_id: &str) -> bool {
    let bytes = root_id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && is_root_id_char(bytes[0], true)
        && bytes[1..].iter().all(|byte| is_root_id_char(*byte, false))
}

fn is_root_id_char(byte: u8, first: bool) -> bool {
    byte.is_ascii_lowercase()
        || byte.is_ascii_digit()
        || (!first && matches!(byte, b'.' | b'_' | b'-'))
}

fn is_strict_semver(version: &str) -> bool {
    semver::Version::parse(version).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use tempfile::{tempdir, TempDir};

    const ROOT_ID: &str = "root-a1";
    const VERSION: &str = "5.344.1";

    fn fixture() -> (TempDir, PathBuf, PathBuf) {
        let temp = tempdir().unwrap();
        let prefix = temp.path().join("prefix");
        let legacy = prefix.join("lib/node_modules/@indigoai-us/hq-cli");
        fs::create_dir_all(&legacy).unwrap();
        (temp, prefix, legacy)
    }

    fn store_paths(prefix: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let store = prefix.join("hq-cli");
        let versions = store.join("versions");
        let root = versions.join(format!("{VERSION}-{ROOT_ID}"));
        (store, versions, root)
    }

    fn create_versioned_root(prefix: &Path, manifest: &str) -> PathBuf {
        let (store, versions, root) = store_paths(prefix);
        fs::create_dir_all(&root).unwrap();
        fs::write(store.join("active-root.json"), pointer(VERSION, ROOT_ID)).unwrap();
        fs::write(root.join("hq-root.json"), manifest).unwrap();
        assert!(versions.is_dir());
        root
    }

    fn pointer(version: &str, root_id: &str) -> String {
        format!(r#"{{"schema":1,"root_id":"{root_id}","version":"{version}"}}"#)
    }

    fn assert_legacy(root: ActivePackageRoot, legacy: &Path) {
        assert_eq!(root.root_id, "legacy");
        assert_eq!(root.version, None);
        assert_eq!(root.root_path, legacy);
    }

    #[test]
    fn valid_pointer_resolves_the_versioned_root() {
        let (_temp, prefix, legacy) = fixture();
        let root_path = create_versioned_root(
            &prefix,
            &format!(r#"{{"schema":1,"root_id":"{ROOT_ID}","version":"{VERSION}"}}"#),
        );

        let active = resolve_active_package_root(&prefix, &legacy);

        assert_eq!(active.root_id, ROOT_ID);
        assert_eq!(active.version.as_deref(), Some(VERSION));
        assert_eq!(active.root_path, root_path);
    }

    #[test]
    fn invalid_pointer_classes_fall_back_to_legacy() {
        let (_temp, prefix, legacy) = fixture();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);

        for raw_pointer in [
            "{",
            r#"{"schema":2,"root_id":"root-a1","version":"5.344.1"}"#,
            r#"{"schema":1,"root_id":"Root/A","version":"5.344.1"}"#,
            r#"{"schema":1,"root_id":"root-a1","version":"05.344.1"}"#,
        ] {
            let (_temp, prefix, legacy) = fixture();
            let (store, versions, _root) = store_paths(&prefix);
            fs::create_dir_all(&versions).unwrap();
            fs::write(store.join("active-root.json"), raw_pointer).unwrap();
            assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
        }

        for invalid_root_id in ["Upper", "has/slash", ""] {
            let (_temp, prefix, legacy) = fixture();
            let (store, versions, _root) = store_paths(&prefix);
            fs::create_dir_all(&versions).unwrap();
            fs::write(
                store.join("active-root.json"),
                pointer(VERSION, invalid_root_id),
            )
            .unwrap();
            assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
        }

        let (_temp, prefix, legacy) = fixture();
        let (store, versions, _root) = store_paths(&prefix);
        fs::create_dir_all(&versions).unwrap();
        fs::write(
            store.join("active-root.json"),
            pointer(VERSION, &"a".repeat(65)),
        )
        .unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);

        let (_temp, prefix, legacy) = fixture();
        let (store, _versions, _root) = store_paths(&prefix);
        fs::create_dir_all(&store).unwrap();
        fs::write(
            store.join("active-root.json"),
            vec![b'x'; PACKAGE_VERSION_STORE_POINTER_MAX_BYTES + 1],
        )
        .unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);

        let (_temp, prefix, legacy) = fixture();
        let (store, versions, _root) = store_paths(&prefix);
        fs::create_dir_all(&versions).unwrap();
        fs::write(
            store.join("active-root.json"),
            pointer(VERSION, ROOT_ID),
        )
        .unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
    }

    #[test]
    fn invalid_manifest_classes_fall_back_to_legacy() {
        for manifest in [
            "{",
            r#"{"schema":2,"root_id":"root-a1","version":"5.344.1"}"#,
            r#"{"schema":1,"root_id":"Root/A","version":"5.344.1"}"#,
            r#"{"schema":1,"root_id":"root-a1","version":"05.344.1"}"#,
            r#"{"schema":1,"root_id":"root-a1","version":"5.344.0"}"#,
        ] {
            let (_temp, prefix, legacy) = fixture();
            create_versioned_root(&prefix, manifest);
            assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
        }

        let (_temp, prefix, legacy) = fixture();
        let (store, _versions, root) = store_paths(&prefix);
        fs::create_dir_all(&root).unwrap();
        fs::write(store.join("active-root.json"), pointer(VERSION, ROOT_ID)).unwrap();
        fs::write(
            root.join("hq-root.json"),
            vec![b'x'; PACKAGE_ROOT_MANIFEST_MAX_BYTES + 1],
        )
        .unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
    }

    #[test]
    fn manifest_root_id_mismatch_falls_back_to_legacy() {
        let (_temp, prefix, legacy) = fixture();
        create_versioned_root(
            &prefix,
            &format!(r#"{{"schema":1,"root_id":"root-b2","version":"{VERSION}"}}"#),
        );

        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_store_directories_and_roots_fall_back_to_legacy() {
        use std::os::unix::fs::symlink;

        let (_temp, prefix, legacy) = fixture();
        let external = prefix.join("external");
        fs::create_dir_all(&external).unwrap();
        symlink(&external, prefix.join("hq-cli")).unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);

        let (_temp, prefix, legacy) = fixture();
        let (store, versions, root) = store_paths(&prefix);
        fs::create_dir_all(&store).unwrap();
        let external_versions = prefix.join("external-versions");
        fs::create_dir_all(&external_versions).unwrap();
        symlink(&external_versions, &versions).unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
        assert!(!root.exists());

        let (_temp, prefix, legacy) = fixture();
        let (_store, versions, root) = store_paths(&prefix);
        fs::create_dir_all(&versions).unwrap();
        let external_root = prefix.join("external-root");
        fs::create_dir_all(&external_root).unwrap();
        fs::write(prefix.join("hq-cli/active-root.json"), pointer(VERSION, ROOT_ID)).unwrap();
        symlink(external_root, root).unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_pointer_and_manifest_files_fall_back_to_legacy() {
        use std::os::unix::fs::symlink;

        let (_temp, prefix, legacy) = fixture();
        let (store, versions, _root) = store_paths(&prefix);
        fs::create_dir_all(&versions).unwrap();
        let external_pointer = prefix.join("external-pointer.json");
        fs::write(&external_pointer, pointer(VERSION, ROOT_ID)).unwrap();
        symlink(&external_pointer, store.join("active-root.json")).unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);

        let (_temp, prefix, legacy) = fixture();
        let (store, _versions, root) = store_paths(&prefix);
        fs::create_dir_all(&root).unwrap();
        fs::write(store.join("active-root.json"), pointer(VERSION, ROOT_ID)).unwrap();
        let external_manifest = prefix.join("external-manifest.json");
        fs::write(
            &external_manifest,
            format!(r#"{{"schema":1,"root_id":"{ROOT_ID}","version":"{VERSION}"}}"#),
        )
        .unwrap();
        symlink(external_manifest, root.join("hq-root.json")).unwrap();
        assert_legacy(resolve_active_package_root(&prefix, &legacy), &legacy);
    }

    #[test]
    fn pointer_and_manifest_bounds_match_hq_cli_constants() {
        // Must match PACKAGE_VERSION_STORE_POINTER_MAX_BYTES and
        // PACKAGE_ROOT_MANIFEST_MAX_BYTES in hq-cli's TS store readers.
        assert_eq!(PACKAGE_VERSION_STORE_POINTER_MAX_BYTES, 512);
        assert_eq!(PACKAGE_ROOT_MANIFEST_MAX_BYTES, 1024);
    }
}
