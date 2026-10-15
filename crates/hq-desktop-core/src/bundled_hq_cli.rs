//! Bundled hq-cli baseline (US-006).
//!
//! The macOS app ships a pinned hq-cli package and a pinned Node runtime per
//! arch under `Contents/Resources/hq-cli/darwin-<arch>/`, built by
//! `apps/sync/scripts/build-bundled-hq-cli.sh`. Each arch directory holds:
//!
//! ```text
//! manifest.json      schema, versions, bins, per-file sha256 + executable bit, tree digest
//! package/           the hq-cli package root with its own node_modules
//! node/bin/node      the pinned Node runtime
//! ```
//!
//! On first run, before the decision screen, the app verifies the bundle
//! against its manifest and copies it into the managed toolchain:
//!
//! ```text
//! <npm prefix>/lib/node_modules/@indigoai-us/hq-cli   the package (where npm and the updater expect it)
//! <toolchain>/bundled-hq-cli/node/                     the bundled Node runtime
//! <toolchain>/bundled-hq-cli/bin/<bin>                 shell shims: exec <node> <package>/<target> "$@"
//! <npm prefix>/bin/<bin>                               symlinks to the shims
//! <toolchain>/bundled-hq-cli/installed.json            marker, written last
//! ```
//!
//! The shims run the bundled Node directly, so `hq --version` works with no
//! network and no other Node on the machine. The bin entries are live
//! symlinks, which the npm-bin cleanup in install_deps keeps.
//!
//! The tree digest formula must stay identical to
//! `apps/sync/scripts/bundled-hq-cli-manifest.mjs`:
//! `sha256( for each file sorted by path: path + "\0" + sha256 + "\n" )`.
//! The parity test below verifies a fixture written by that script.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::hq_cli_staged_swap::{exchange_paths, hq_cli_package_dir, npm_global_bin_dir};

pub const MANIFEST_SCHEMA: &str = "hq-bundled-cli.v1";
pub const MANIFEST_NAME: &str = "manifest.json";
/// Directory under the managed toolchain that holds the bundled Node, the
/// shims and the install marker.
pub const INSTALL_DIR_NAME: &str = "bundled-hq-cli";
pub const MARKER_NAME: &str = "installed.json";
const MARKER_SCHEMA: &str = "hq-bundled-cli-installed.v1";
const NODE_BIN: &str = "node/bin/node";
const PACKAGE_DIR: &str = "package";

/// The bundle arch name for the running process, as used in
/// `darwin-<arch>` resource directories.
pub fn host_arch() -> Option<&'static str> {
    if cfg!(target_arch = "aarch64") {
        Some("arm64")
    } else if cfg!(target_arch = "x86_64") {
        Some("x64")
    } else {
        None
    }
}

pub fn arch_dir_name(arch: &str) -> String {
    format!("darwin-{arch}")
}

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("bundled hq-cli is missing at {0}")]
    MissingBundle(PathBuf),
    #[error("bundled hq-cli manifest is invalid: {0}")]
    BadManifest(String),
    #[error("bundled hq-cli failed verification: {0}")]
    BadChecksum(String),
    #[error("bundled hq-cli io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl BundleError {
    /// Short stable code for diagnostics and logs.
    pub fn code(&self) -> &'static str {
        match self {
            BundleError::MissingBundle(_) => "missing_bundle",
            BundleError::BadManifest(_) => "bad_manifest",
            BundleError::BadChecksum(_) => "bad_checksum",
            BundleError::Io { .. } => "io",
        }
    }
}

fn io_err(path: &Path) -> impl FnOnce(io::Error) -> BundleError + '_ {
    move |source| BundleError::Io {
        path: path.to_path_buf(),
        source,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleManifest {
    pub schema: String,
    pub version: String,
    pub node_version: String,
    pub arch: String,
    pub bins: BTreeMap<String, String>,
    pub tree_sha256: String,
    pub files: Vec<ManifestFile>,
}

/// A bundle whose every file matched its manifest when it was checked.
#[derive(Debug, Clone)]
pub struct VerifiedBundle {
    pub root: PathBuf,
    pub manifest: BundleManifest,
}

/// Where the bundle is installed.
#[derive(Debug, Clone)]
pub struct InstallPaths {
    /// The managed toolchain root (`.../Indigo HQ/toolchain`).
    pub toolchain_dir: PathBuf,
    /// The managed npm prefix (`<toolchain>/npm-global`).
    pub npm_prefix: PathBuf,
}

impl InstallPaths {
    pub fn install_dir(&self) -> PathBuf {
        self.toolchain_dir.join(INSTALL_DIR_NAME)
    }
    pub fn node_dir(&self) -> PathBuf {
        self.install_dir().join("node")
    }
    pub fn node_bin(&self) -> PathBuf {
        self.node_dir().join("bin").join("node")
    }
    pub fn shim_dir(&self) -> PathBuf {
        self.install_dir().join("bin")
    }
    pub fn marker(&self) -> PathBuf {
        self.install_dir().join(MARKER_NAME)
    }
    pub fn package_dir(&self) -> PathBuf {
        hq_cli_package_dir(&self.npm_prefix, false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    /// The bundle was copied into the toolchain.
    Installed { version: String },
    /// The same bundle was already installed; bin links were re-checked.
    AlreadyInstalled { version: String },
    /// A newer hq-cli (from the updater) is already installed and was left alone.
    KeptExisting { existing_version: String },
}

impl InstallOutcome {
    /// True when hq-cli is usable without a registry install.
    pub fn satisfies_hq_cli(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct InstallMarker {
    schema: String,
    version: String,
    node_version: String,
    arch: String,
    tree_sha256: String,
}

/// Check that a manifest path is a plain relative path with no `..`, no
/// absolute prefix and no empty segments.
fn checked_relative(path: &str) -> Result<PathBuf, BundleError> {
    if path.is_empty() || path.contains('\\') || path.contains('\0') {
        return Err(BundleError::BadManifest(format!("invalid path {path:?}")));
    }
    let candidate = Path::new(path);
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => {
                return Err(BundleError::BadManifest(format!(
                    "path escapes the bundle: {path:?}"
                )))
            }
        }
    }
    if out.as_os_str().is_empty() || out.to_string_lossy() != path {
        return Err(BundleError::BadManifest(format!("non-canonical path {path:?}")));
    }
    Ok(out)
}

fn sha256_file(path: &Path) -> Result<String, BundleError> {
    let mut file = fs::File::open(path).map_err(io_err(path))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf).map_err(io_err(path))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The tree digest over a sorted file list. Same formula as the build script.
pub fn tree_digest(files: &[ManifestFile]) -> String {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(file.sha256.as_bytes());
        hasher.update(b"\n");
    }
    hex(&hasher.finalize())
}

fn read_manifest(root: &Path) -> Result<BundleManifest, BundleError> {
    let path = root.join(MANIFEST_NAME);
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(BundleError::MissingBundle(path))
        }
        Err(error) => return Err(io_err(&path)(error)),
    };
    serde_json::from_slice(&raw)
        .map_err(|error| BundleError::BadManifest(format!("parse {}: {error}", path.display())))
}

/// Static checks on the manifest itself: schema, arch, sorted unique safe
/// paths, required entries, bins and the recorded tree digest.
fn check_manifest(manifest: &BundleManifest, expected_arch: &str) -> Result<(), BundleError> {
    if manifest.schema != MANIFEST_SCHEMA {
        return Err(BundleError::BadManifest(format!(
            "unexpected schema {:?}",
            manifest.schema
        )));
    }
    if manifest.arch != expected_arch {
        return Err(BundleError::BadManifest(format!(
            "arch {} does not match {expected_arch}",
            manifest.arch
        )));
    }
    if semver::Version::parse(&manifest.version).is_err() {
        return Err(BundleError::BadManifest(format!(
            "version {:?} is not semver",
            manifest.version
        )));
    }
    let mut previous: Option<&str> = None;
    for file in &manifest.files {
        checked_relative(&file.path)?;
        if file.path == MANIFEST_NAME {
            return Err(BundleError::BadManifest("manifest lists itself".into()));
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BundleError::BadManifest(format!("bad sha256 for {}", file.path)));
        }
        if let Some(prev) = previous {
            if prev >= file.path.as_str() {
                return Err(BundleError::BadManifest(format!(
                    "files are not sorted and unique at {}",
                    file.path
                )));
            }
        }
        previous = Some(&file.path);
    }
    let listed = |path: &str| manifest.files.iter().find(|file| file.path == path);
    match listed(NODE_BIN) {
        Some(file) if file.executable => {}
        _ => {
            return Err(BundleError::BadManifest(
                "node/bin/node is missing or not executable".into(),
            ))
        }
    }
    if !manifest.bins.contains_key("hq") {
        return Err(BundleError::BadManifest("bins has no hq entry".into()));
    }
    for (name, target) in &manifest.bins {
        if name.is_empty() || name.contains('/') || name.starts_with('.') {
            return Err(BundleError::BadManifest(format!("invalid bin name {name:?}")));
        }
        checked_relative(target)?;
        if listed(&format!("{PACKAGE_DIR}/{target}")).is_none() {
            return Err(BundleError::BadManifest(format!(
                "bin {name} target {target} is not in the bundle"
            )));
        }
    }
    if tree_digest(&manifest.files) != manifest.tree_sha256 {
        return Err(BundleError::BadChecksum("tree digest mismatch".into()));
    }
    Ok(())
}

/// Walk `root` and check every file against the manifest: each listed file
/// exists as a regular file with the listed sha256 and executable bit, and no
/// unlisted file or symlink is present. `skip_root_names` lists top-level
/// entries to ignore (the manifest itself in a bundle).
fn check_tree(
    root: &Path,
    files: &[ManifestFile],
    skip_root_names: &[&str],
) -> Result<(), BundleError> {
    let listed: BTreeMap<&str, &ManifestFile> =
        files.iter().map(|file| (file.path.as_str(), file)).collect();
    let mut seen = BTreeSet::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|error| {
            let path = error.path().unwrap_or(root).to_path_buf();
            BundleError::Io {
                path,
                source: error
                    .into_io_error()
                    .unwrap_or_else(|| io::Error::other("walk error")),
            }
        })?;
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| BundleError::BadManifest("walk left the bundle root".into()))?;
        if entry.depth() == 1
            && skip_root_names
                .iter()
                .any(|name| rel.as_os_str() == std::ffi::OsStr::new(name))
        {
            continue;
        }
        let rel_str = rel
            .to_str()
            .ok_or_else(|| BundleError::BadChecksum(format!("non-UTF-8 path {}", rel.display())))?;
        let file_type = entry.file_type();
        if file_type.is_dir() {
            continue;
        }
        if file_type.is_symlink() {
            return Err(BundleError::BadChecksum(format!("unexpected symlink {rel_str}")));
        }
        if !file_type.is_file() {
            return Err(BundleError::BadChecksum(format!("unexpected file type {rel_str}")));
        }
        let Some(expected) = listed.get(rel_str) else {
            return Err(BundleError::BadChecksum(format!("unlisted file {rel_str}")));
        };
        let metadata = entry.metadata().map_err(|error| BundleError::Io {
            path: entry.path().to_path_buf(),
            source: error
                .into_io_error()
                .unwrap_or_else(|| io::Error::other("metadata error")),
        })?;
        let executable = metadata.permissions().mode() & 0o111 != 0;
        if executable != expected.executable {
            return Err(BundleError::BadChecksum(format!("executable bit mismatch {rel_str}")));
        }
        if sha256_file(entry.path())? != expected.sha256 {
            return Err(BundleError::BadChecksum(format!("checksum mismatch {rel_str}")));
        }
        seen.insert(rel_str.to_string());
    }
    if let Some(missing) = files.iter().find(|file| !seen.contains(&file.path)) {
        return Err(BundleError::BadChecksum(format!("listed file is missing {}", missing.path)));
    }
    Ok(())
}

/// Verify the bundle at `bundle_dir` (one `darwin-<arch>` directory).
pub fn verify_bundle(bundle_dir: &Path, expected_arch: &str) -> Result<VerifiedBundle, BundleError> {
    match fs::symlink_metadata(bundle_dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return Err(BundleError::BadManifest(format!(
                "{} is not a directory",
                bundle_dir.display()
            )))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(BundleError::MissingBundle(bundle_dir.to_path_buf()))
        }
        Err(error) => return Err(io_err(bundle_dir)(error)),
    }
    let manifest = read_manifest(bundle_dir)?;
    check_manifest(&manifest, expected_arch)?;
    check_tree(bundle_dir, &manifest.files, &[MANIFEST_NAME])?;
    Ok(VerifiedBundle {
        root: bundle_dir.to_path_buf(),
        manifest,
    })
}

fn installed_package_version(package_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(package_dir.join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn read_marker(path: &Path) -> Option<InstallMarker> {
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Removes a staging directory when dropped, so a failed install leaves no
/// partial copy behind.
struct StagingGuard(PathBuf);

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "[bundled-hq-cli] could not remove staging {}: {error}",
                    self.0.display()
                );
            }
        }
    }
}

/// Install a verified bundle into the managed toolchain. See the module docs
/// for the layout. A newer existing hq-cli is kept.
pub fn install_verified_bundle(
    bundle: &VerifiedBundle,
    paths: &InstallPaths,
) -> Result<InstallOutcome, BundleError> {
    let manifest = &bundle.manifest;
    let bundled_version = semver::Version::parse(&manifest.version)
        .map_err(|error| BundleError::BadManifest(format!("version: {error}")))?;
    let package_dir = paths.package_dir();
    let marker = read_marker(&paths.marker());
    let marker_matches = marker.as_ref().is_some_and(|m| {
        m.schema == MARKER_SCHEMA
            && m.tree_sha256 == manifest.tree_sha256
            && m.version == manifest.version
    });

    if let Some(existing) = installed_package_version(&package_dir) {
        let existing_semver = semver::Version::parse(&existing).ok();
        if existing_semver.as_ref().is_some_and(|v| *v > bundled_version) {
            return Ok(InstallOutcome::KeptExisting {
                existing_version: existing,
            });
        }
        if existing == manifest.version && marker_matches && paths.node_bin().is_file() {
            write_bin_links(manifest, paths)?;
            return Ok(InstallOutcome::AlreadyInstalled { version: existing });
        }
    }

    let install_dir = paths.install_dir();
    fs::create_dir_all(&install_dir).map_err(io_err(&install_dir))?;
    let staging = install_dir.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&staging).map_err(io_err(&staging))?;
    let _guard = StagingGuard(staging.clone());

    copy_listed_files(&bundle.root, &staging, &manifest.files)?;
    // Re-verify the copy so a disk error or a bundle changed mid-copy cannot
    // land an unverified tree.
    check_tree(&staging, &manifest.files, &[])?;

    // The marker goes away first: a crash between here and the final marker
    // write leaves no marker, so the next launch reinstalls.
    remove_if_exists(&paths.marker())?;
    place_dir(&staging.join(PACKAGE_DIR), &package_dir, &staging.join("old-package"))?;
    place_dir(&staging.join("node"), &paths.node_dir(), &staging.join("old-node"))?;
    write_bin_links(manifest, paths)?;
    write_marker(
        &paths.marker(),
        &InstallMarker {
            schema: MARKER_SCHEMA.into(),
            version: manifest.version.clone(),
            node_version: manifest.node_version.clone(),
            arch: manifest.arch.clone(),
            tree_sha256: manifest.tree_sha256.clone(),
        },
    )?;
    Ok(InstallOutcome::Installed {
        version: manifest.version.clone(),
    })
}

/// Read-only check used by the queue and dependency probes: the marker matches
/// an installed package and the bundled node and `hq` entry are present.
pub fn bundled_install_present(paths: &InstallPaths) -> Option<String> {
    let marker = read_marker(&paths.marker())?;
    if marker.schema != MARKER_SCHEMA {
        return None;
    }
    let version = installed_package_version(&paths.package_dir())?;
    if !paths.node_bin().is_file() {
        return None;
    }
    let hq = npm_global_bin_dir(&paths.npm_prefix, false).join("hq");
    if fs::metadata(&hq).is_err() {
        return None;
    }
    Some(version)
}

/// Launch fast path that skips hashing the whole bundle. It reads only the
/// bundle manifest and the installed state, and answers when no copy is
/// needed: the same bundle is installed and its `hq` entry is live, or a newer
/// hq-cli from the updater is installed. `None` means run
/// [`ensure_bundled_install`].
pub fn bundled_install_current(
    resource_root: &Path,
    arch: &str,
    paths: &InstallPaths,
) -> Option<InstallOutcome> {
    let manifest = read_manifest(&resource_root.join(arch_dir_name(arch))).ok()?;
    check_manifest(&manifest, arch).ok()?;
    let bundled = semver::Version::parse(&manifest.version).ok()?;
    let existing = installed_package_version(&paths.package_dir())?;
    if semver::Version::parse(&existing).is_ok_and(|v| v > bundled) {
        return Some(InstallOutcome::KeptExisting {
            existing_version: existing,
        });
    }
    let marker = read_marker(&paths.marker())?;
    let current = marker.schema == MARKER_SCHEMA
        && marker.tree_sha256 == manifest.tree_sha256
        && marker.version == manifest.version
        && existing == manifest.version
        && paths.node_bin().is_file()
        && manifest.bins.keys().all(|name| {
            let link = npm_global_bin_dir(&paths.npm_prefix, false).join(name);
            fs::read_link(&link).ok() == Some(paths.shim_dir().join(name))
                && paths.shim_dir().join(name).is_file()
        });
    current.then_some(InstallOutcome::AlreadyInstalled { version: existing })
}

fn copy_listed_files(src_root: &Path, dst_root: &Path, files: &[ManifestFile]) -> Result<(), BundleError> {
    for file in files {
        let rel = checked_relative(&file.path)?;
        let src = src_root.join(&rel);
        let dst = dst_root.join(&rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(io_err(parent))?;
        }
        fs::copy(&src, &dst).map_err(io_err(&src))?;
        let mode = if file.executable { 0o755 } else { 0o644 };
        fs::set_permissions(&dst, fs::Permissions::from_mode(mode)).map_err(io_err(&dst))?;
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), BundleError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_err(path)(error)),
    }
}

/// Move `staged` to `live`. An existing `live` directory is exchanged
/// atomically where the filesystem supports it, otherwise moved to `old`
/// first. The previous tree ends up inside staging and is removed with it.
fn place_dir(staged: &Path, live: &Path, old: &Path) -> Result<(), BundleError> {
    match fs::symlink_metadata(live) {
        Ok(_) => {
            if exchange_paths(live, staged).map_err(io_err(live))? {
                return Ok(());
            }
            fs::rename(live, old).map_err(io_err(live))?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if let Some(parent) = live.parent() {
                fs::create_dir_all(parent).map_err(io_err(parent))?;
            }
        }
        Err(error) => return Err(io_err(live)(error)),
    }
    fs::rename(staged, live).map_err(io_err(live))
}

/// Single-quote a path for /bin/sh.
fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn write_atomic(path: &Path, contents: &[u8], mode: u32) -> Result<(), BundleError> {
    let tmp = path.with_file_name(format!(
        ".{}.tmp",
        path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()
    ));
    fs::write(&tmp, contents).map_err(io_err(&tmp))?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(mode)).map_err(io_err(&tmp))?;
    fs::rename(&tmp, path).map_err(io_err(path))
}

/// Write one shim per bin and point `<prefix>/bin/<bin>` at it.
fn write_bin_links(manifest: &BundleManifest, paths: &InstallPaths) -> Result<(), BundleError> {
    let shim_dir = paths.shim_dir();
    fs::create_dir_all(&shim_dir).map_err(io_err(&shim_dir))?;
    let bin_dir = npm_global_bin_dir(&paths.npm_prefix, false);
    fs::create_dir_all(&bin_dir).map_err(io_err(&bin_dir))?;
    let node = paths.node_bin();
    let package_dir = paths.package_dir();
    for (name, target) in &manifest.bins {
        let shim = shim_dir.join(name);
        let script = format!(
            "#!/bin/sh\nexec {} {} \"$@\"\n",
            sh_quote(&node),
            sh_quote(&package_dir.join(checked_relative(target)?))
        );
        write_atomic(&shim, script.as_bytes(), 0o755)?;

        let link = bin_dir.join(name);
        if fs::read_link(&link).ok().as_deref() == Some(shim.as_path()) {
            continue;
        }
        let tmp_link = bin_dir.join(format!(".{name}.bundled-link"));
        remove_if_exists(&tmp_link)?;
        std::os::unix::fs::symlink(&shim, &tmp_link).map_err(io_err(&tmp_link))?;
        fs::rename(&tmp_link, &link).map_err(io_err(&link))?;
    }
    Ok(())
}

fn write_marker(path: &Path, marker: &InstallMarker) -> Result<(), BundleError> {
    let mut raw = serde_json::to_vec_pretty(marker)
        .map_err(|error| BundleError::BadManifest(format!("marker: {error}")))?;
    raw.push(b'\n');
    write_atomic(path, &raw, 0o644)
}

/// Verify and install in one step. A missing or bad bundle returns the error
/// so the caller can fall back to the registry install.
pub fn ensure_bundled_install(
    resource_root: &Path,
    arch: &str,
    paths: &InstallPaths,
) -> Result<InstallOutcome, BundleError> {
    let bundle = verify_bundle(&resource_root.join(arch_dir_name(arch)), arch)?;
    install_verified_bundle(&bundle, paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const VERSION: &str = "5.125.0";

    /// Write a small bundle with a fake node that prints the script it was
    /// given, so running the shim proves the bundled node and package path.
    fn write_bundle(root: &Path, version: &str, arch: &str) -> PathBuf {
        let dir = root.join(arch_dir_name(arch));
        let pkg = dir.join("package");
        fs::create_dir_all(pkg.join("dist/bin")).unwrap();
        fs::create_dir_all(dir.join("node/bin")).unwrap();
        fs::write(
            pkg.join("package.json"),
            format!(
                r#"{{"name":"@indigoai-us/hq-cli","version":"{version}","bin":{{"hq":"./dist/index.js","hq-auth-refresh":"dist/bin/hq-auth-refresh.js"}}}}"#
            ),
        )
        .unwrap();
        fs::write(pkg.join("dist/index.js"), format!("{version}\n")).unwrap();
        fs::write(pkg.join("dist/bin/hq-auth-refresh.js"), "refresh\n").unwrap();
        // The fake node answers `<script> --version` by printing the script file.
        let node = dir.join("node/bin/node");
        fs::write(&node, "#!/bin/sh\n[ \"$2\" = \"--version\" ] && exec cat \"$1\"\nexit 3\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        write_manifest(&dir, version, arch);
        dir
    }

    fn write_manifest(dir: &Path, version: &str, arch: &str) {
        let mut files = Vec::new();
        for entry in walkdir::WalkDir::new(dir).min_depth(1) {
            let entry = entry.unwrap();
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry.path().strip_prefix(dir).unwrap().to_str().unwrap().to_string();
            if rel == MANIFEST_NAME {
                continue;
            }
            let mode = entry.metadata().unwrap().permissions().mode();
            files.push(ManifestFile {
                sha256: sha256_file(entry.path()).unwrap(),
                executable: mode & 0o111 != 0,
                path: rel,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let manifest = BundleManifest {
            schema: MANIFEST_SCHEMA.into(),
            version: version.into(),
            node_version: "v22.17.0".into(),
            arch: arch.into(),
            bins: BTreeMap::from([
                ("hq".into(), "dist/index.js".into()),
                ("hq-auth-refresh".into(), "dist/bin/hq-auth-refresh.js".into()),
            ]),
            tree_sha256: tree_digest(&files),
            files,
        };
        fs::write(dir.join(MANIFEST_NAME), serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    }

    fn install_paths(root: &Path) -> InstallPaths {
        let toolchain_dir = root.join("Application Support/Indigo HQ/toolchain");
        InstallPaths {
            npm_prefix: toolchain_dir.join("npm-global"),
            toolchain_dir,
        }
    }

    fn run_hq_version(paths: &InstallPaths) -> std::process::Output {
        // No PATH, no HOME: only the shim, the bundled node and the copied
        // package take part, which is the offline first-run case.
        Command::new(npm_global_bin_dir(&paths.npm_prefix, false).join("hq"))
            .arg("--version")
            .env_clear()
            .output()
            .unwrap()
    }

    #[test]
    fn good_bundle_installs_and_hq_version_runs_offline() {
        let temp = tempfile::tempdir().unwrap();
        let resources = temp.path().join("Resources/hq-cli");
        write_bundle(&resources, VERSION, "arm64");
        let paths = install_paths(temp.path());

        let outcome = ensure_bundled_install(&resources, "arm64", &paths).unwrap();
        assert_eq!(outcome, InstallOutcome::Installed { version: VERSION.into() });

        let output = run_hq_version(&paths);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), VERSION);

        // Bin entries are live symlinks to shims outside prefix/bin, so the
        // npm-bin cleanup keeps them.
        for name in ["hq", "hq-auth-refresh"] {
            let link = npm_global_bin_dir(&paths.npm_prefix, false).join(name);
            assert_eq!(fs::read_link(&link).unwrap(), paths.shim_dir().join(name));
            assert!(fs::metadata(&link).is_ok());
        }
        assert_eq!(installed_package_version(&paths.package_dir()).as_deref(), Some(VERSION));
        assert_eq!(bundled_install_present(&paths).as_deref(), Some(VERSION));
        // No staging directory is left behind.
        let leftovers: Vec<_> = fs::read_dir(paths.install_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".staging-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn bad_checksum_is_rejected_and_nothing_is_copied() {
        let temp = tempfile::tempdir().unwrap();
        let resources = temp.path().join("Resources/hq-cli");
        let dir = write_bundle(&resources, VERSION, "arm64");
        fs::write(dir.join("package/dist/index.js"), "tampered\n").unwrap();
        let paths = install_paths(temp.path());

        let error = ensure_bundled_install(&resources, "arm64", &paths).unwrap_err();
        assert!(matches!(error, BundleError::BadChecksum(ref m) if m.contains("package/dist/index.js")), "{error}");
        assert!(!paths.toolchain_dir.exists());
        assert_eq!(bundled_install_present(&paths), None);
    }

    #[test]
    fn unlisted_or_missing_files_fail_verification() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_bundle(temp.path(), VERSION, "arm64");
        fs::write(dir.join("package/extra.js"), "x").unwrap();
        assert!(matches!(verify_bundle(&dir, "arm64"), Err(BundleError::BadChecksum(m)) if m.contains("unlisted")));
        fs::remove_file(dir.join("package/extra.js")).unwrap();
        fs::remove_file(dir.join("package/dist/bin/hq-auth-refresh.js")).unwrap();
        assert!(matches!(verify_bundle(&dir, "arm64"), Err(BundleError::BadChecksum(m)) if m.contains("missing")));
    }

    #[test]
    fn executable_bit_change_fails_verification() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_bundle(temp.path(), VERSION, "arm64");
        fs::set_permissions(dir.join("node/bin/node"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(verify_bundle(&dir, "arm64"), Err(BundleError::BadChecksum(m)) if m.contains("executable")));
    }

    #[test]
    fn missing_bundle_reports_missing_for_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let paths = install_paths(temp.path());
        let error = ensure_bundled_install(&temp.path().join("nope"), "arm64", &paths).unwrap_err();
        assert!(matches!(error, BundleError::MissingBundle(_)));
        assert_eq!(error.code(), "missing_bundle");

        // A directory without a manifest is also a missing bundle.
        let dir = temp.path().join("res").join(arch_dir_name("arm64"));
        fs::create_dir_all(&dir).unwrap();
        assert!(matches!(verify_bundle(&dir, "arm64"), Err(BundleError::MissingBundle(_))));
        assert!(!paths.toolchain_dir.exists());
    }

    #[test]
    fn symlink_in_bundle_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_bundle(temp.path(), VERSION, "arm64");
        std::os::unix::fs::symlink("/etc/hosts", dir.join("package/link")).unwrap();
        assert!(matches!(verify_bundle(&dir, "arm64"), Err(BundleError::BadChecksum(m)) if m.contains("symlink")));
    }

    #[test]
    fn escaping_manifest_path_is_rejected() {
        for bad in ["../outside", "/etc/hosts", "package/../../x", "./package/a", "package//a"] {
            assert!(matches!(checked_relative(bad), Err(BundleError::BadManifest(_))), "{bad}");
        }
        let temp = tempfile::tempdir().unwrap();
        let dir = write_bundle(temp.path(), VERSION, "arm64");
        let mut manifest = read_manifest(&dir).unwrap();
        manifest.files.insert(
            0,
            ManifestFile {
                path: "../escape".into(),
                sha256: "0".repeat(64),
                executable: false,
            },
        );
        manifest.tree_sha256 = tree_digest(&manifest.files);
        fs::write(dir.join(MANIFEST_NAME), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(matches!(verify_bundle(&dir, "arm64"), Err(BundleError::BadManifest(m)) if m.contains("escapes")));
    }

    #[test]
    fn wrong_arch_or_tree_digest_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let dir = write_bundle(temp.path(), VERSION, "arm64");
        assert!(matches!(verify_bundle(&dir, "x64"), Err(BundleError::BadManifest(_))));
        let mut manifest = read_manifest(&dir).unwrap();
        manifest.tree_sha256 = "0".repeat(64);
        fs::write(dir.join(MANIFEST_NAME), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(matches!(verify_bundle(&dir, "arm64"), Err(BundleError::BadChecksum(m)) if m.contains("tree")));
    }

    #[test]
    fn newer_existing_install_is_kept() {
        let temp = tempfile::tempdir().unwrap();
        let paths = install_paths(temp.path());
        let live = paths.package_dir();
        fs::create_dir_all(&live).unwrap();
        fs::write(live.join("package.json"), r#"{"name":"@indigoai-us/hq-cli","version":"5.130.0"}"#).unwrap();
        let resources = temp.path().join("Resources/hq-cli");
        write_bundle(&resources, VERSION, "arm64");

        let outcome = ensure_bundled_install(&resources, "arm64", &paths).unwrap();
        assert_eq!(outcome, InstallOutcome::KeptExisting { existing_version: "5.130.0".into() });
        assert_eq!(installed_package_version(&live).as_deref(), Some("5.130.0"));
        assert!(!paths.node_dir().exists());
    }

    #[test]
    fn older_existing_install_is_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let paths = install_paths(temp.path());
        let live = paths.package_dir();
        fs::create_dir_all(&live).unwrap();
        fs::write(live.join("package.json"), r#"{"name":"@indigoai-us/hq-cli","version":"5.100.0"}"#).unwrap();
        fs::write(live.join("stale.js"), "old").unwrap();
        let resources = temp.path().join("Resources/hq-cli");
        write_bundle(&resources, VERSION, "arm64");

        let outcome = ensure_bundled_install(&resources, "arm64", &paths).unwrap();
        assert_eq!(outcome, InstallOutcome::Installed { version: VERSION.into() });
        assert!(!live.join("stale.js").exists());
        assert_eq!(String::from_utf8_lossy(&run_hq_version(&paths).stdout).trim(), VERSION);
    }

    #[test]
    fn second_run_is_already_installed_and_repairs_links() {
        let temp = tempfile::tempdir().unwrap();
        let resources = temp.path().join("Resources/hq-cli");
        write_bundle(&resources, VERSION, "arm64");
        let paths = install_paths(temp.path());
        ensure_bundled_install(&resources, "arm64", &paths).unwrap();

        let hq = npm_global_bin_dir(&paths.npm_prefix, false).join("hq");
        fs::remove_file(&hq).unwrap();
        let outcome = ensure_bundled_install(&resources, "arm64", &paths).unwrap();
        assert_eq!(outcome, InstallOutcome::AlreadyInstalled { version: VERSION.into() });
        assert_eq!(String::from_utf8_lossy(&run_hq_version(&paths).stdout).trim(), VERSION);
    }

    #[test]
    fn fast_path_answers_only_for_a_complete_matching_install() {
        let temp = tempfile::tempdir().unwrap();
        let resources = temp.path().join("Resources/hq-cli");
        let dir = write_bundle(&resources, VERSION, "arm64");
        let paths = install_paths(temp.path());
        assert_eq!(bundled_install_current(&resources, "arm64", &paths), None);

        ensure_bundled_install(&resources, "arm64", &paths).unwrap();
        assert_eq!(
            bundled_install_current(&resources, "arm64", &paths),
            Some(InstallOutcome::AlreadyInstalled { version: VERSION.into() })
        );

        // A missing bin link sends the launch back through the full install.
        let hq = npm_global_bin_dir(&paths.npm_prefix, false).join("hq");
        fs::remove_file(&hq).unwrap();
        assert_eq!(bundled_install_current(&resources, "arm64", &paths), None);
        ensure_bundled_install(&resources, "arm64", &paths).unwrap();

        // A different bundle (new app version) is not current.
        fs::write(dir.join("package/dist/index.js"), "changed\n").unwrap();
        write_manifest(&dir, VERSION, "arm64");
        assert_eq!(bundled_install_current(&resources, "arm64", &paths), None);
    }

    #[test]
    fn fast_path_keeps_a_newer_updater_install() {
        let temp = tempfile::tempdir().unwrap();
        let paths = install_paths(temp.path());
        let live = paths.package_dir();
        fs::create_dir_all(&live).unwrap();
        fs::write(live.join("package.json"), r#"{"version":"5.130.0"}"#).unwrap();
        let resources = temp.path().join("Resources/hq-cli");
        write_bundle(&resources, VERSION, "arm64");
        assert_eq!(
            bundled_install_current(&resources, "arm64", &paths),
            Some(InstallOutcome::KeptExisting { existing_version: "5.130.0".into() })
        );
    }

    #[test]
    fn shim_quotes_paths_with_spaces_and_quotes() {
        assert_eq!(sh_quote(Path::new("/a b/c'd")), r"'/a b/c'\''d'");
    }

    /// Parity with apps/sync/scripts/bundled-hq-cli-manifest.mjs: the fixture
    /// manifest was written by that script, and Rust must accept it with the
    /// same tree digest. Regenerate with
    /// `node apps/sync/scripts/bundled-hq-cli-manifest.mjs write <fixture>/darwin-arm64 --version 0.0.1 --node-version v22.17.0 --arch arm64`.
    #[test]
    fn manifest_written_by_build_script_verifies() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/bundled-hq-cli/darwin-arm64");
        let bundle = verify_bundle(&fixture, "arm64").unwrap();
        assert_eq!(bundle.manifest.version, "0.0.1");
        assert_eq!(bundle.manifest.bins.get("hq").map(String::as_str), Some("dist/index.js"));
    }
}
