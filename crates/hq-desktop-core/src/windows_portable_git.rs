//! HQ-managed PortableGit for Windows.
//!
//! When a Windows machine has no usable Git, HQ installs its own copy into the
//! per-user managed toolchain (`%LOCALAPPDATA%\IndigoHQ\toolchain\git`). It
//! never runs the Git for Windows setup program, never asks for administrator
//! rights and never touches a Git the person installed themselves.
//!
//! The bundle is the official full PortableGit release, not MinGit: MinGit has
//! no `bash.exe`, so Git hooks with a Bash shebang and HQ's Bash-based shims
//! (qmd) cannot run on it. See
//! `companies/indigo/projects/install-flow-rethink/research/windows-portable-git-assessment-2026-10-20.md`
//! in HQ for the probe results behind that choice.
//!
//! Install flow ([`install_portable_git`]):
//!
//! 1. Check the downloaded `.7z.exe` against the pinned SHA-256. A mismatch
//!    stops here; nothing is written.
//! 2. Find the 7z payload inside the self-extracting file and extract it in
//!    process into a fresh `.git-install-<uuid>` staging folder. The
//!    self-extractor stub is never executed.
//! 3. Check the staged tree has Git and Bash, run the bundle's own
//!    `post-install.bat` (the step the self-extractor would have run), then run
//!    `git --version` and a `bash -c` probe from the staged copy.
//! 4. Activate with renames: the live bundle moves to `git.previous` (the
//!    rollback copy) and the staged tree becomes `git`. A failed rename puts the
//!    old bundle back.
//! 5. Run `git --version` from the live path. If it fails, the new bundle is
//!    removed and the previous one restored.
//!
//! Everything that touches processes goes through [`PortableGitHost`], so the
//! whole flow is tested off Windows with a fake host.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Git for Windows release HQ pins. `git --version` prints
/// `git version <PORTABLE_GIT_VERSION>`.
pub const PORTABLE_GIT_VERSION: &str = "2.54.0.windows.1";

/// Folder name of the live managed bundle under the toolchain root.
pub const MANAGED_GIT_DIR_NAME: &str = "git";
/// Folder name of the rollback copy of the previous managed bundle.
pub const PREVIOUS_GIT_DIR_NAME: &str = "git.previous";

const STAGING_PREFIX: &str = ".git-install-";
const FAILED_PREFIX: &str = ".git-failed-";
const ROLLBACK_PREFIX: &str = ".git-rollback-";

/// The 7z signature that starts the archive inside a 7-Zip self-extractor.
const SEVEN_ZIP_SIGNATURE: [u8; 6] = [b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C];
/// The self-extractor stub is about 240 KB; never search further than this.
const SFX_STUB_SEARCH_LIMIT: usize = 4 * 1024 * 1024;

/// Processor architecture of a PortableGit build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortableGitArch {
    X64,
    Arm64,
}

/// One pinned PortableGit release asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortableGitAsset {
    pub arch: PortableGitArch,
    pub file_name: &'static str,
    pub url: &'static str,
    /// SHA-256 of the whole `.7z.exe`, from the release's asset digest and the
    /// checksum table in the release notes (they match).
    pub sha256: &'static str,
    pub size: u64,
    /// The MSYS2 environment folder holding the native Git build: `mingw64`
    /// on x64, `clangarm64` on ARM64.
    pub native_prefix: &'static str,
}

/// PortableGit 2.54.0.windows.1 for x64.
pub static PORTABLE_GIT_X64: PortableGitAsset = PortableGitAsset {
    arch: PortableGitArch::X64,
    file_name: "PortableGit-2.54.0-64-bit.7z.exe",
    url: "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/PortableGit-2.54.0-64-bit.7z.exe",
    sha256: "bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311",
    size: 58_995_352,
    native_prefix: "mingw64",
};

/// PortableGit 2.54.0.windows.1 for ARM64 (native ARM64 Git and Bash).
pub static PORTABLE_GIT_ARM64: PortableGitAsset = PortableGitAsset {
    arch: PortableGitArch::Arm64,
    file_name: "PortableGit-2.54.0-arm64.7z.exe",
    url: "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/PortableGit-2.54.0-arm64.7z.exe",
    sha256: "f8e92cd3359fcbb96998cfd606a536ccc6dbfb23c04e12b29042f9ba45b6b0c7",
    size: 59_757_336,
    native_prefix: "clangarm64",
};

/// The asset for a Rust `std::env::consts::ARCH` value. HQ ships separate x64
/// and ARM64 Windows builds, so the build's own architecture is the machine's
/// (the same rule the managed Node download uses). Any other architecture has
/// no PortableGit build and gets `None`.
pub fn portable_git_asset_for_arch(rust_arch: &str) -> Option<&'static PortableGitAsset> {
    match rust_arch {
        "x86_64" => Some(&PORTABLE_GIT_X64),
        "aarch64" => Some(&PORTABLE_GIT_ARM64),
        _ => None,
    }
}

/// Where the managed bundle and its rollback copy live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedGitLayout {
    toolchain: PathBuf,
}

impl ManagedGitLayout {
    pub fn new(toolchain: impl Into<PathBuf>) -> Self {
        Self {
            toolchain: toolchain.into(),
        }
    }

    pub fn toolchain(&self) -> &Path {
        &self.toolchain
    }

    /// The live bundle: `<toolchain>\git`.
    pub fn git_dir(&self) -> PathBuf {
        self.toolchain.join(MANAGED_GIT_DIR_NAME)
    }

    /// The rollback copy: `<toolchain>\git.previous`.
    pub fn previous_dir(&self) -> PathBuf {
        self.toolchain.join(PREVIOUS_GIT_DIR_NAME)
    }

    fn unique_sibling(&self, prefix: &str) -> PathBuf {
        self.toolchain
            .join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()))
    }
}

/// `<bundle>\cmd\git.exe`, the Git entry point that goes on PATH.
pub fn git_exe_in(bundle: &Path) -> PathBuf {
    bundle.join("cmd").join("git.exe")
}

/// `<bundle>\bin\bash.exe`, the Git Bash launcher HQ's qmd shim and Claude
/// Code expect next to Git.
pub fn bash_exe_in(bundle: &Path) -> PathBuf {
    bundle.join("bin").join("bash.exe")
}

/// The folders HQ puts on a child process PATH for a managed bundle, in order:
/// the Git entry point, then Git Bash (so a bare `bash` resolves here and not
/// to the WSL launcher in System32). The bundle's native-prefix and `usr\bin`
/// helpers are found by `git.exe` and `bash.exe` themselves.
pub fn managed_git_path_dirs(bundle: &Path) -> Vec<PathBuf> {
    vec![bundle.join("cmd"), bundle.join("bin")]
}

/// Git folders for a Windows child-process search PATH, in two groups the
/// caller places around its other entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsGitSearchDirs {
    /// HQ's managed bundle: `cmd` (git.exe), `bin` (Git Bash) and the native
    /// helper folder. These go early, ahead of System32, so a bare `bash`
    /// never resolves to the WSL launcher `System32\bash.exe`.
    pub managed: Vec<PathBuf>,
    /// An installed Git for Windows under Program Files. Empty while HQ's
    /// PortableGit is live, so git, bash and their helpers come from one
    /// bundle and a system Git cannot mix in.
    pub system: Vec<PathBuf>,
}

pub fn windows_git_search_dirs(
    managed_git_dir: &Path,
    native_prefix: &str,
    program_files: &Path,
    managed_portable_git_active: bool,
) -> WindowsGitSearchDirs {
    let mut managed = managed_git_path_dirs(managed_git_dir);
    managed.push(managed_git_dir.join(native_prefix).join("bin"));
    let system = if managed_portable_git_active {
        Vec::new()
    } else {
        let git = program_files.join("Git");
        vec![
            git.join("bin"),
            git.join("usr").join("bin"),
            git.join("cmd"),
        ]
    };
    WindowsGitSearchDirs { managed, system }
}

/// What occupies a managed Git folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedGitBundle {
    Absent,
    /// HQ's older MinGit fallback: Git without Bash.
    MinGit,
    /// Full PortableGit: Git and Bash.
    PortableGit,
    /// Something is there, but it is neither layout.
    Incomplete,
}

/// Classify the bundle in `dir` from its files. Does not run anything.
pub fn classify_managed_git_bundle(dir: &Path) -> ManagedGitBundle {
    if std::fs::symlink_metadata(dir).is_err() {
        return ManagedGitBundle::Absent;
    }
    let git = git_exe_in(dir).is_file();
    let bin_bash = bash_exe_in(dir).is_file();
    let usr_bash = dir.join("usr").join("bin").join("bash.exe").is_file();
    match (git, bin_bash, usr_bash) {
        (true, true, true) => ManagedGitBundle::PortableGit,
        (true, false, false) => ManagedGitBundle::MinGit,
        _ => ManagedGitBundle::Incomplete,
    }
}

/// Windows paths compare case-insensitively; this compares component by
/// component on the lowercased text, with either separator.
fn windows_path_is_within(path: &Path, root: &Path) -> bool {
    fn parts(path: &Path) -> Vec<String> {
        path.to_string_lossy()
            .replace('/', "\\")
            .split('\\')
            .filter(|part| !part.is_empty() && *part != ".")
            .map(|part| part.to_lowercase())
            .collect()
    }
    let path = parts(path);
    let root = parts(root);
    !root.is_empty() && path.len() > root.len() && path[..root.len()] == root[..]
}

/// True when the Git HQ resolved (`resolved_git`, reporting `version`) is HQ's
/// own managed copy and it is not the pinned PortableGit: an older MinGit, a
/// damaged bundle, or a different version. A Git outside the managed folder is
/// the person's own and is never replaced.
pub fn managed_git_needs_reprovision(
    resolved_git: &Path,
    version: Option<&str>,
    managed_git_dir: &Path,
) -> bool {
    if !windows_path_is_within(resolved_git, managed_git_dir) {
        return false;
    }
    if classify_managed_git_bundle(managed_git_dir) != ManagedGitBundle::PortableGit {
        return true;
    }
    !version.is_some_and(|version| version.contains(PORTABLE_GIT_VERSION))
}

/// Which stage of the install failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortableGitStage {
    /// The download did not match the pinned SHA-256.
    Checksum,
    /// The download is not a 7z self-extractor.
    Payload,
    /// Extraction or the staged layout check failed.
    Extract,
    /// `post-install.bat`, `git --version` or the Bash probe failed on the
    /// staged copy.
    Prepare,
    /// The rename into place failed (the previous bundle is back in place).
    Activate,
    /// The activated bundle did not run; the previous bundle was restored.
    Verify,
    /// No rollback copy exists to roll back to.
    Rollback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableGitError {
    pub stage: PortableGitStage,
    pub detail: String,
}

impl PortableGitError {
    fn new(stage: PortableGitStage, detail: impl Into<String>) -> Self {
        Self {
            stage,
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for PortableGitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PortableGit {:?} failed: {}", self.stage, self.detail)
    }
}

impl std::error::Error for PortableGitError {}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// Check `bytes` against the asset's pinned digest.
pub fn verify_portable_git_sha256(
    bytes: &[u8],
    asset: &PortableGitAsset,
) -> Result<(), PortableGitError> {
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(asset.sha256) {
        Ok(())
    } else {
        Err(PortableGitError::new(
            PortableGitStage::Checksum,
            format!(
                "{} checksum mismatch: expected {}, got {actual} ({} bytes)",
                asset.file_name,
                asset.sha256,
                bytes.len()
            ),
        ))
    }
}

/// The 7z archive inside a 7-Zip self-extracting `.exe`: everything from the
/// first 7z signature within the stub search limit.
pub fn sfx_7z_payload(bytes: &[u8]) -> Result<&[u8], PortableGitError> {
    let window = &bytes[..bytes.len().min(SFX_STUB_SEARCH_LIMIT)];
    window
        .windows(SEVEN_ZIP_SIGNATURE.len())
        .position(|candidate| candidate == SEVEN_ZIP_SIGNATURE)
        .map(|offset| &bytes[offset..])
        .ok_or_else(|| {
            PortableGitError::new(
                PortableGitStage::Payload,
                "no 7z archive found in the PortableGit download",
            )
        })
}

/// Extract a 7z archive into `dest` in process. Entry names that would leave
/// `dest` are rejected by the extractor, and each file's CRC is checked.
/// `progress` gets the running count of extracted entries every few hundred.
pub fn extract_portable_git_payload(
    payload: &[u8],
    dest: &Path,
    progress: &mut dyn FnMut(u64),
) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
    let mut extracted: u64 = 0;
    sevenz_rust2::decompress_with_extract_fn(
        io::Cursor::new(payload),
        dest,
        |entry, reader, path| {
            if entry.is_anti_item() {
                return Ok(true);
            }
            let keep_going = sevenz_rust2::default_entry_extract_fn(entry, reader, path)?;
            extracted += 1;
            if extracted % 250 == 0 {
                progress(extracted);
            }
            Ok(keep_going)
        },
    )
    .map_err(|e| format!("PortableGit archive could not be extracted: {e}"))?;
    progress(extracted);
    Ok(())
}

/// Files a freshly extracted PortableGit must have before it is prepared.
pub fn required_portable_git_files(bundle: &Path, asset: &PortableGitAsset) -> Vec<PathBuf> {
    vec![
        git_exe_in(bundle),
        bundle.join("bin").join("git.exe"),
        bash_exe_in(bundle),
        bundle.join("usr").join("bin").join("bash.exe"),
        bundle.join(asset.native_prefix).join("bin").join("git.exe"),
        bundle.join("post-install.bat"),
    ]
}

/// Check the staged tree has Git, Bash and the post-install script.
pub fn validate_staged_portable_git(bundle: &Path, asset: &PortableGitAsset) -> Result<(), String> {
    for path in required_portable_git_files(bundle, asset) {
        if !path.is_file() {
            return Err(format!("PortableGit is missing {}", path.display()));
        }
    }
    Ok(())
}

/// The side effects the install flow needs. [`SystemPortableGitHost`] is the
/// real one; tests use a fake.
pub trait PortableGitHost {
    /// Extract the 7z `payload` into `dest`.
    fn extract(&mut self, payload: &[u8], dest: &Path) -> Result<(), String>;
    /// Run the staged bundle's post-install step, then prove `git --version`
    /// and `bash -c` work from `staged`.
    fn prepare_and_probe(&mut self, staged: &Path, asset: &PortableGitAsset) -> Result<(), String>;
    /// Rename a folder. Implementations may retry transient Windows locks.
    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()>;
    /// Prove the bundle activated at `git_dir` runs.
    fn verify_live(&mut self, git_dir: &Path) -> Result<(), String>;
    /// A progress line for the setup screen's inactivity timer.
    fn progress(&mut self, _line: &str) {}
}

/// Result of a successful install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableGitInstall {
    /// What the live folder held before (for migration telemetry and logs).
    pub replaced: ManagedGitBundle,
    /// Where the previous bundle was kept, when there was one.
    pub rollback_copy: Option<PathBuf>,
}

/// Download-independent install: verify, stage, prove, activate, verify live.
/// See the module docs. Leaves the live bundle untouched on every failure
/// before activation, and restores it on a failure after.
pub fn install_portable_git(
    layout: &ManagedGitLayout,
    asset: &PortableGitAsset,
    archive: &[u8],
    host: &mut dyn PortableGitHost,
) -> Result<PortableGitInstall, PortableGitError> {
    // A crash between the two activation renames leaves only git.previous.
    let _ = recover_interrupted_activation(layout, host);

    verify_portable_git_sha256(archive, asset)?;
    let payload = sfx_7z_payload(archive)?;

    std::fs::create_dir_all(layout.toolchain()).map_err(|e| {
        PortableGitError::new(
            PortableGitStage::Extract,
            format!("mkdir {}: {e}", layout.toolchain().display()),
        )
    })?;
    sweep_stale_portable_git_siblings(layout, Duration::from_secs(60 * 60));

    let staged = layout.unique_sibling(STAGING_PREFIX);
    let discard_staged = |staged: &Path| {
        let _ = std::fs::remove_dir_all(staged);
    };

    host.progress("Extracting Git");
    if let Err(detail) = host
        .extract(payload, &staged)
        .and_then(|()| validate_staged_portable_git(&staged, asset))
    {
        discard_staged(&staged);
        return Err(PortableGitError::new(PortableGitStage::Extract, detail));
    }

    host.progress("Checking Git and Bash");
    if let Err(detail) = host.prepare_and_probe(&staged, asset) {
        discard_staged(&staged);
        return Err(PortableGitError::new(PortableGitStage::Prepare, detail));
    }

    let activation = match activate_staged_bundle(layout, &staged, host) {
        Ok(activation) => activation,
        Err(detail) => {
            discard_staged(&staged);
            return Err(PortableGitError::new(PortableGitStage::Activate, detail));
        }
    };

    if let Err(detail) = host.verify_live(&layout.git_dir()) {
        let restored = undo_activation(layout, activation.rollback_copy.is_some(), host);
        let detail = match restored {
            Ok(()) => detail,
            Err(undo) => format!("{detail}; restoring the previous Git failed: {undo}"),
        };
        return Err(PortableGitError::new(PortableGitStage::Verify, detail));
    }

    host.progress("Git is ready");
    Ok(activation)
}

fn activate_staged_bundle(
    layout: &ManagedGitLayout,
    staged: &Path,
    host: &mut dyn PortableGitHost,
) -> Result<PortableGitInstall, String> {
    let git_dir = layout.git_dir();
    let previous = layout.previous_dir();
    let replaced = classify_managed_git_bundle(&git_dir);
    let had_live = replaced != ManagedGitBundle::Absent;

    if had_live {
        // One rollback generation: the bundle being replaced now. An older
        // rollback copy goes first so the rename below has a free name.
        if std::fs::symlink_metadata(&previous).is_ok() {
            remove_path(&previous).map_err(|e| {
                format!(
                    "could not remove the old rollback copy {}: {e}",
                    previous.display()
                )
            })?;
        }
        host.rename(&git_dir, &previous).map_err(|e| {
            format!(
                "could not move {} aside to {}: {e}",
                git_dir.display(),
                previous.display()
            )
        })?;
    }

    if let Err(activate) = host.rename(staged, &git_dir) {
        let mut detail = format!(
            "could not move {} into place at {}: {activate}",
            staged.display(),
            git_dir.display()
        );
        if had_live {
            if let Err(restore) = host.rename(&previous, &git_dir) {
                detail.push_str(&format!("; restoring the previous Git failed: {restore}"));
            }
        }
        return Err(detail);
    }

    Ok(PortableGitInstall {
        replaced,
        rollback_copy: had_live.then_some(previous),
    })
}

/// Take a just-activated bundle back out and put the rollback copy (if any)
/// back in place.
fn undo_activation(
    layout: &ManagedGitLayout,
    had_previous: bool,
    host: &mut dyn PortableGitHost,
) -> Result<(), String> {
    let git_dir = layout.git_dir();
    let failed = layout.unique_sibling(FAILED_PREFIX);
    host.rename(&git_dir, &failed)
        .map_err(|e| format!("could not move the new Git aside: {e}"))?;
    if had_previous {
        host.rename(&layout.previous_dir(), &git_dir)
            .map_err(|e| format!("could not restore the previous Git: {e}"))?;
    }
    let _ = std::fs::remove_dir_all(&failed);
    Ok(())
}

/// If the live folder is missing but a usable rollback copy exists (a crash
/// between the two activation renames), put the rollback copy back. Returns
/// whether it restored anything.
pub fn recover_interrupted_activation(
    layout: &ManagedGitLayout,
    host: &mut dyn PortableGitHost,
) -> io::Result<bool> {
    if classify_managed_git_bundle(&layout.git_dir()) != ManagedGitBundle::Absent {
        return Ok(false);
    }
    match classify_managed_git_bundle(&layout.previous_dir()) {
        ManagedGitBundle::PortableGit | ManagedGitBundle::MinGit => {
            host.rename(&layout.previous_dir(), &layout.git_dir())?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Swap the live bundle with its rollback copy, so the previous Git is live
/// again and the replaced one becomes the rollback copy. Running it twice
/// returns to where it started.
pub fn rollback_managed_git(
    layout: &ManagedGitLayout,
    host: &mut dyn PortableGitHost,
) -> Result<(), PortableGitError> {
    let git_dir = layout.git_dir();
    let previous = layout.previous_dir();
    match classify_managed_git_bundle(&previous) {
        ManagedGitBundle::PortableGit | ManagedGitBundle::MinGit => {}
        other => {
            return Err(PortableGitError::new(
                PortableGitStage::Rollback,
                format!(
                    "no usable rollback copy at {} ({other:?})",
                    previous.display()
                ),
            ))
        }
    }
    let had_live = classify_managed_git_bundle(&git_dir) != ManagedGitBundle::Absent;
    let parked = layout.unique_sibling(ROLLBACK_PREFIX);
    if had_live {
        host.rename(&git_dir, &parked).map_err(|e| {
            PortableGitError::new(
                PortableGitStage::Rollback,
                format!("move live Git aside: {e}"),
            )
        })?;
    }
    if let Err(e) = host.rename(&previous, &git_dir) {
        if had_live {
            let _ = host.rename(&parked, &git_dir);
        }
        return Err(PortableGitError::new(
            PortableGitStage::Rollback,
            format!("restore rollback copy: {e}"),
        ));
    }
    if had_live {
        host.rename(&parked, &previous).map_err(|e| {
            PortableGitError::new(
                PortableGitStage::Rollback,
                format!("keep the replaced Git as the rollback copy: {e}"),
            )
        })?;
    }
    Ok(())
}

/// True for a staging or failed-activation folder name that is old enough to
/// belong to a finished or crashed run. A concurrent install's fresh staging
/// folder is younger than `min_age` and is left alone.
fn is_stale_portable_git_sibling(name: &str, age: Option<Duration>, min_age: Duration) -> bool {
    let ours = name.starts_with(STAGING_PREFIX)
        || name.starts_with(FAILED_PREFIX)
        || name.starts_with(ROLLBACK_PREFIX);
    ours && matches!(age, Some(age) if age >= min_age)
}

/// Best-effort removal of staging and failed-activation folders left by an
/// interrupted run. Never touches `git` or `git.previous`.
pub fn sweep_stale_portable_git_siblings(layout: &ManagedGitLayout, min_age: Duration) {
    let Ok(entries) = std::fs::read_dir(layout.toolchain()) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let age = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok());
        if is_stale_portable_git_sibling(&name.to_string_lossy(), age, min_age) {
            let _ = remove_path(&entry.path());
        }
    }
}

fn remove_path(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// The child PATH for probing a bundle: the bundle's own folders, then
/// Windows. Any installed Git is left out so the probe proves this bundle.
pub fn bundle_probe_path(bundle: &Path, asset: &PortableGitAsset, system_root: &Path) -> String {
    [
        bundle.join("cmd"),
        bundle.join("bin"),
        bundle.join(asset.native_prefix).join("bin"),
        bundle.join("usr").join("bin"),
        system_root.join("System32"),
        system_root.to_path_buf(),
    ]
    .iter()
    .map(|dir| dir.to_string_lossy().into_owned())
    .collect::<Vec<_>>()
    .join(";")
}

/// The Bash probe: strict mode, arrays and `[[ ]]`, and the helpers HQ hooks
/// use, all resolved by the bundle's own Bash.
pub const BASH_PROBE_SCRIPT: &str = "set -euo pipefail; a=(one two); [[ ${#a[@]} == 2 ]]; \
for t in git sed awk ssh; do command -v \"$t\" >/dev/null; done; printf HQ_BASH_OK";
pub const BASH_PROBE_MARKER: &str = "HQ_BASH_OK";

/// Output of a probe process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run a command with a deadline, without a console window on Windows. The
/// child is killed when the deadline passes.
pub fn run_probe(
    mut command: std::process::Command,
    timeout: Duration,
) -> Result<ProbeOutput, String> {
    use std::io::Read;
    use std::process::Stdio;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let program = format!("{:?}", command.get_program());
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {program}: {e}"))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = stream.read_to_string(&mut text);
        }
        text
    });
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_string(&mut text);
        }
        text
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{program} did not finish within {}s",
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("waiting for {program} failed: {e}")),
        }
    };
    Ok(ProbeOutput {
        success: status.success(),
        code: status.code(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// The real host: in-process 7z extraction, the bundle's post-install step and
/// probes as child processes, and renames retried through transient Windows
/// locks (antivirus or the search indexer holding a just-written file).
pub struct SystemPortableGitHost {
    system_root: PathBuf,
    progress: Box<dyn FnMut(&str) + Send>,
}

impl SystemPortableGitHost {
    pub fn new(system_root: PathBuf, progress: Box<dyn FnMut(&str) + Send>) -> Self {
        Self {
            system_root,
            progress,
        }
    }

    fn probe_command(
        &self,
        program: &Path,
        bundle: &Path,
        asset: &PortableGitAsset,
    ) -> std::process::Command {
        let mut command = std::process::Command::new(program);
        command
            .current_dir(bundle)
            .env("PATH", bundle_probe_path(bundle, asset, &self.system_root))
            // A Git or Bash setting from another install must not steer the
            // probe of this bundle.
            .env_remove("GIT_EXEC_PATH")
            .env_remove("BASH_ENV")
            .env_remove("ENV");
        command
    }

    /// The step the self-extractor runs after extracting: the bundle's own
    /// `post-install.bat` (device folders, `/etc` files, DLL links). It deletes
    /// itself and `etc\post-install` when done, which is how completion is
    /// checked; `cmd.exe` reports a missing batch file after that self-delete,
    /// so its exit code is not used.
    fn run_post_install(&mut self, bundle: &Path, asset: &PortableGitAsset) -> Result<(), String> {
        let cmd = self.system_root.join("System32").join("cmd.exe");
        let mut command = self.probe_command(&cmd, bundle, asset);
        command.args(["/d", "/c", "post-install.bat"]);
        let output = run_probe(command, Duration::from_secs(300))?;
        let script_left = bundle.join("post-install.bat").exists();
        let scripts_left = bundle.join("etc").join("post-install").exists();
        if script_left || scripts_left {
            return Err(format!(
                "post-install.bat did not finish (exit {:?}): {} {}",
                output.code,
                output.stdout.trim(),
                output.stderr.trim()
            ));
        }
        Ok(())
    }
}

/// Check `git --version` output from `git_exe`.
fn probe_git_version(output: &ProbeOutput, git_exe: &Path) -> Result<(), String> {
    let version = output.stdout.trim();
    if output.success && version.contains(PORTABLE_GIT_VERSION) {
        Ok(())
    } else {
        Err(format!(
            "{} --version: expected {PORTABLE_GIT_VERSION}, got '{version}' (exit {:?}) {}",
            git_exe.display(),
            output.code,
            output.stderr.trim()
        ))
    }
}

fn probe_bash(output: &ProbeOutput, bash_exe: &Path) -> Result<(), String> {
    if output.success && output.stdout.contains(BASH_PROBE_MARKER) {
        Ok(())
    } else {
        Err(format!(
            "{} probe failed (exit {:?}): {} {}",
            bash_exe.display(),
            output.code,
            output.stdout.trim(),
            output.stderr.trim()
        ))
    }
}

impl PortableGitHost for SystemPortableGitHost {
    fn extract(&mut self, payload: &[u8], dest: &Path) -> Result<(), String> {
        let progress = &mut self.progress;
        extract_portable_git_payload(payload, dest, &mut |count| {
            progress(&format!("Extracting Git ({count} files)"));
        })
    }

    fn prepare_and_probe(&mut self, staged: &Path, asset: &PortableGitAsset) -> Result<(), String> {
        self.run_post_install(staged, asset)?;

        let git = git_exe_in(staged);
        let mut command = self.probe_command(&git, staged, asset);
        command.arg("--version");
        probe_git_version(&run_probe(command, Duration::from_secs(60))?, &git)?;

        let bash = bash_exe_in(staged);
        let mut command = self.probe_command(&bash, staged, asset);
        command.args(["--noprofile", "--norc", "-c", BASH_PROBE_SCRIPT]);
        probe_bash(&run_probe(command, Duration::from_secs(60))?, &bash)
    }

    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        rename_with_retry(from, to, 20, Duration::from_millis(250))
    }

    fn verify_live(&mut self, git_dir: &Path) -> Result<(), String> {
        let git = git_exe_in(git_dir);
        let mut command = std::process::Command::new(&git);
        command.arg("--version").env_remove("GIT_EXEC_PATH");
        probe_git_version(&run_probe(command, Duration::from_secs(60))?, &git)?;
        if !bash_exe_in(git_dir).is_file() {
            return Err(format!("{} is missing", bash_exe_in(git_dir).display()));
        }
        Ok(())
    }

    fn progress(&mut self, line: &str) {
        (self.progress)(line);
    }
}

/// True for errors a short wait can clear on Windows: access denied (5) and
/// sharing violation (32), the codes antivirus and indexer handles produce.
fn rename_error_is_transient(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied || matches!(error.raw_os_error(), Some(5 | 32))
}

/// `std::fs::rename`, retried `attempts` times on transient lock errors.
pub fn rename_with_retry(from: &Path, to: &Path, attempts: u32, delay: Duration) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < attempts && rename_error_is_transient(&e) => {
                attempt += 1;
                std::thread::sleep(delay);
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    /// A fake bundle tree for `asset` under `dir`.
    fn write_portable_tree(dir: &Path, asset: &PortableGitAsset, marker: &str) {
        for file in required_portable_git_files(dir, asset) {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, marker).unwrap();
        }
    }

    fn write_mingit_tree(dir: &Path) {
        for file in [
            dir.join("cmd").join("git.exe"),
            dir.join("mingw64").join("bin").join("git.exe"),
        ] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "mingit").unwrap();
        }
    }

    fn marker_of(bundle: &Path) -> String {
        std::fs::read_to_string(git_exe_in(bundle)).unwrap()
    }

    /// The bytes of a minimal "self-extractor": a stub, then a 7z signature.
    /// Its digest becomes the test asset's pin.
    fn fake_archive() -> Vec<u8> {
        let mut bytes = b"MZ fake sfx stub".to_vec();
        bytes.extend_from_slice(&SEVEN_ZIP_SIGNATURE);
        bytes.extend_from_slice(b"payload");
        bytes
    }

    fn leak_str(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    fn asset_for(archive: &[u8], base: &'static PortableGitAsset) -> PortableGitAsset {
        PortableGitAsset {
            sha256: leak_str(sha256_hex(archive)),
            ..*base
        }
    }

    #[derive(Default)]
    struct FakeHost {
        asset_prefix: &'static str,
        extract_error: Option<String>,
        /// Extract writes part of the tree, then fails, like a disk-full or a
        /// killed extraction would.
        partial_extract: bool,
        prepare_error: Option<String>,
        verify_errors: VecDeque<String>,
        /// Fail the rename whose 1-based call number is listed.
        fail_rename_calls: Vec<usize>,
        rename_calls: RefCell<usize>,
        calls: Vec<String>,
        marker: String,
    }

    impl FakeHost {
        fn new(asset: &PortableGitAsset) -> Self {
            Self {
                asset_prefix: asset.native_prefix,
                marker: "new".to_string(),
                ..Default::default()
            }
        }
    }

    impl PortableGitHost for FakeHost {
        fn extract(&mut self, payload: &[u8], dest: &Path) -> Result<(), String> {
            self.calls.push("extract".into());
            assert!(
                payload.starts_with(&SEVEN_ZIP_SIGNATURE),
                "extract gets the 7z payload"
            );
            if self.partial_extract {
                std::fs::create_dir_all(dest.join("cmd")).unwrap();
                std::fs::write(dest.join("cmd").join("git.exe"), "half").unwrap();
                return Err("extraction interrupted".into());
            }
            if let Some(error) = &self.extract_error {
                return Err(error.clone());
            }
            let asset = PortableGitAsset {
                native_prefix: self.asset_prefix,
                ..PORTABLE_GIT_X64
            };
            write_portable_tree(dest, &asset, &self.marker);
            Ok(())
        }

        fn prepare_and_probe(
            &mut self,
            staged: &Path,
            _asset: &PortableGitAsset,
        ) -> Result<(), String> {
            self.calls.push(format!(
                "prepare:{}",
                staged.file_name().unwrap().to_string_lossy()
            ));
            match &self.prepare_error {
                Some(error) => Err(error.clone()),
                None => Ok(()),
            }
        }

        fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
            let call = {
                let mut calls = self.rename_calls.borrow_mut();
                *calls += 1;
                *calls
            };
            self.calls.push(format!(
                "rename:{}->{}",
                from.file_name().unwrap().to_string_lossy(),
                to.file_name().unwrap().to_string_lossy()
            ));
            if self.fail_rename_calls.contains(&call) {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"));
            }
            std::fs::rename(from, to)
        }

        fn verify_live(&mut self, git_dir: &Path) -> Result<(), String> {
            self.calls.push("verify".into());
            assert!(git_exe_in(git_dir).is_file());
            match self.verify_errors.pop_front() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    }

    fn toolchain_entries(layout: &ManagedGitLayout) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(layout.toolchain())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn pins_are_the_official_2_54_0_release_assets() {
        for asset in [&PORTABLE_GIT_X64, &PORTABLE_GIT_ARM64] {
            assert!(asset.url.starts_with(
                "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/"
            ));
            assert!(asset.url.ends_with(asset.file_name));
            assert_eq!(asset.sha256.len(), 64);
            assert!(asset
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(
                asset.file_name.starts_with("PortableGit-") && asset.file_name.ends_with(".7z.exe")
            );
        }
        assert_eq!(
            PORTABLE_GIT_X64.sha256,
            "bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311"
        );
        assert_eq!(
            PORTABLE_GIT_ARM64.sha256,
            "f8e92cd3359fcbb96998cfd606a536ccc6dbfb23c04e12b29042f9ba45b6b0c7"
        );
        // Never MinGit (no Bash) and never the Git setup program.
        for asset in [&PORTABLE_GIT_X64, &PORTABLE_GIT_ARM64] {
            assert!(!asset.file_name.contains("MinGit"));
            assert!(!asset.file_name.to_ascii_lowercase().contains("setup"));
        }
    }

    #[test]
    fn x64_and_arm64_select_their_own_build() {
        let x64 = portable_git_asset_for_arch("x86_64").unwrap();
        assert_eq!(x64.arch, PortableGitArch::X64);
        assert_eq!(x64.native_prefix, "mingw64");
        assert!(x64.file_name.contains("64-bit"));

        let arm64 = portable_git_asset_for_arch("aarch64").unwrap();
        assert_eq!(arm64.arch, PortableGitArch::Arm64);
        assert_eq!(arm64.native_prefix, "clangarm64");
        assert!(arm64.file_name.contains("arm64"));

        assert_eq!(portable_git_asset_for_arch("x86"), None);
        assert_eq!(portable_git_asset_for_arch("arm"), None);
    }

    #[test]
    fn arm64_layout_check_wants_clangarm64_not_mingw64() {
        let tmp = tempfile::TempDir::new().unwrap();
        let x64_tree = tmp.path().join("x64");
        write_portable_tree(&x64_tree, &PORTABLE_GIT_X64, "x");
        assert!(validate_staged_portable_git(&x64_tree, &PORTABLE_GIT_X64).is_ok());
        let error = validate_staged_portable_git(&x64_tree, &PORTABLE_GIT_ARM64).unwrap_err();
        assert!(error.contains("clangarm64"), "{error}");
    }

    #[test]
    fn classifies_mingit_portablegit_and_partial_trees() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert_eq!(
            classify_managed_git_bundle(&tmp.path().join("none")),
            ManagedGitBundle::Absent
        );
        let mingit = tmp.path().join("mingit");
        write_mingit_tree(&mingit);
        assert_eq!(
            classify_managed_git_bundle(&mingit),
            ManagedGitBundle::MinGit
        );
        let portable = tmp.path().join("portable");
        write_portable_tree(&portable, &PORTABLE_GIT_X64, "p");
        assert_eq!(
            classify_managed_git_bundle(&portable),
            ManagedGitBundle::PortableGit
        );
        let partial = tmp.path().join("partial");
        std::fs::create_dir_all(partial.join("bin")).unwrap();
        std::fs::write(bash_exe_in(&partial), "").unwrap();
        assert_eq!(
            classify_managed_git_bundle(&partial),
            ManagedGitBundle::Incomplete
        );
    }

    #[test]
    fn only_hqs_own_non_pinned_git_needs_reprovisioning() {
        let tmp = tempfile::TempDir::new().unwrap();
        let managed = tmp.path().join("toolchain").join("git");
        write_mingit_tree(&managed);
        let pinned = format!("git version {PORTABLE_GIT_VERSION}");

        // HQ's MinGit is migrated, whatever its version says.
        assert!(managed_git_needs_reprovision(
            &git_exe_in(&managed),
            Some(&pinned),
            &managed
        ));

        // The person's own Git is never touched, Bash or not.
        let user_git = tmp
            .path()
            .join("Program Files")
            .join("Git")
            .join("cmd")
            .join("git.exe");
        assert!(!managed_git_needs_reprovision(
            &user_git,
            Some("git version 2.40.0.windows.1"),
            &managed
        ));
        // A sibling folder that only shares the name prefix is not managed.
        let sibling = tmp
            .path()
            .join("toolchain")
            .join("git.previous")
            .join("cmd")
            .join("git.exe");
        assert!(!managed_git_needs_reprovision(
            &sibling,
            Some(&pinned),
            &managed
        ));

        // The pinned PortableGit is left alone; another version is upgraded.
        std::fs::remove_dir_all(&managed).unwrap();
        write_portable_tree(&managed, &PORTABLE_GIT_X64, "p");
        assert!(!managed_git_needs_reprovision(
            &git_exe_in(&managed),
            Some(&pinned),
            &managed
        ));
        assert!(managed_git_needs_reprovision(
            &git_exe_in(&managed),
            Some("git version 2.53.0.windows.1"),
            &managed
        ));
        assert!(managed_git_needs_reprovision(
            &git_exe_in(&managed),
            None,
            &managed
        ));
    }

    #[test]
    fn managed_path_match_ignores_case_and_separator_style() {
        let root = Path::new(r"C:\Users\A\AppData\Local\IndigoHQ\toolchain\git");
        assert!(windows_path_is_within(
            Path::new(r"c:/users/a/appdata/local/indigohq/TOOLCHAIN/GIT/cmd/git.exe"),
            root
        ));
        assert!(!windows_path_is_within(root, root));
        assert!(!windows_path_is_within(
            Path::new(r"C:\Users\A\AppData\Local\IndigoHQ\toolchain\git.previous\cmd\git.exe"),
            root
        ));
    }

    #[test]
    fn finds_the_7z_payload_after_the_sfx_stub() {
        let archive = fake_archive();
        let payload = sfx_7z_payload(&archive).unwrap();
        assert!(payload.starts_with(&SEVEN_ZIP_SIGNATURE));
        assert_eq!(payload.len(), SEVEN_ZIP_SIGNATURE.len() + b"payload".len());
        let error = sfx_7z_payload(b"MZ not an archive").unwrap_err();
        assert_eq!(error.stage, PortableGitStage::Payload);
    }

    #[test]
    fn fresh_install_activates_after_probing_the_staged_copy() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        let archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        let mut host = FakeHost::new(&asset);

        let installed = install_portable_git(&layout, &asset, &archive, &mut host).unwrap();
        assert_eq!(installed.replaced, ManagedGitBundle::Absent);
        assert_eq!(installed.rollback_copy, None);
        assert_eq!(
            classify_managed_git_bundle(&layout.git_dir()),
            ManagedGitBundle::PortableGit
        );
        // Probe ran on the staged copy, before the activation rename.
        let prepare = host
            .calls
            .iter()
            .position(|c| c.starts_with("prepare:.git-install-"))
            .unwrap();
        let activate = host
            .calls
            .iter()
            .position(|c| c.starts_with("rename:.git-install-"))
            .unwrap();
        assert!(prepare < activate);
        assert_eq!(host.calls.last().unwrap(), "verify");
        assert_eq!(toolchain_entries(&layout), vec!["git".to_string()]);
    }

    #[test]
    fn checksum_failure_writes_nothing_and_keeps_the_live_bundle() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        write_mingit_tree(&layout.git_dir());
        let mut archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        archive.push(0); // tampered after pinning
        let mut host = FakeHost::new(&asset);

        let error = install_portable_git(&layout, &asset, &archive, &mut host).unwrap_err();
        assert_eq!(error.stage, PortableGitStage::Checksum);
        assert!(error.detail.contains("checksum mismatch"));
        assert!(
            host.calls.is_empty(),
            "nothing extracted, probed or renamed: {:?}",
            host.calls
        );
        assert_eq!(
            classify_managed_git_bundle(&layout.git_dir()),
            ManagedGitBundle::MinGit
        );
        assert_eq!(toolchain_entries(&layout), vec!["git".to_string()]);
    }

    #[test]
    fn interrupted_extraction_rolls_back_to_the_untouched_live_bundle() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        write_mingit_tree(&layout.git_dir());
        let archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        let mut host = FakeHost::new(&asset);
        host.partial_extract = true;

        let error = install_portable_git(&layout, &asset, &archive, &mut host).unwrap_err();
        assert_eq!(error.stage, PortableGitStage::Extract);
        assert!(!host
            .calls
            .iter()
            .any(|c| c.starts_with("rename") || c.starts_with("prepare")));
        assert_eq!(
            classify_managed_git_bundle(&layout.git_dir()),
            ManagedGitBundle::MinGit
        );
        // The half-written staging folder is gone.
        assert_eq!(toolchain_entries(&layout), vec!["git".to_string()]);
    }

    #[test]
    fn a_staged_copy_that_fails_its_probe_is_never_activated() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        let archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        let mut host = FakeHost::new(&asset);
        host.prepare_error = Some("bash probe failed".into());

        let error = install_portable_git(&layout, &asset, &archive, &mut host).unwrap_err();
        assert_eq!(error.stage, PortableGitStage::Prepare);
        assert_eq!(
            classify_managed_git_bundle(&layout.git_dir()),
            ManagedGitBundle::Absent
        );
        assert!(toolchain_entries(&layout).is_empty());
    }

    #[test]
    fn migrates_managed_mingit_and_keeps_it_as_the_rollback_copy() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        write_mingit_tree(&layout.git_dir());
        let archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        let mut host = FakeHost::new(&asset);

        let installed = install_portable_git(&layout, &asset, &archive, &mut host).unwrap();
        assert_eq!(installed.replaced, ManagedGitBundle::MinGit);
        assert_eq!(installed.rollback_copy, Some(layout.previous_dir()));
        assert_eq!(
            classify_managed_git_bundle(&layout.git_dir()),
            ManagedGitBundle::PortableGit
        );
        assert_eq!(
            classify_managed_git_bundle(&layout.previous_dir()),
            ManagedGitBundle::MinGit
        );
        assert_eq!(
            toolchain_entries(&layout),
            vec!["git".to_string(), "git.previous".to_string()]
        );
    }

    #[test]
    fn upgrade_keeps_one_rollback_generation_and_rollback_swaps_back() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        write_mingit_tree(&layout.previous_dir());
        write_portable_tree(&layout.git_dir(), &PORTABLE_GIT_X64, "v1");
        let archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        let mut host = FakeHost::new(&asset);
        host.marker = "v2".into();

        install_portable_git(&layout, &asset, &archive, &mut host).unwrap();
        assert_eq!(marker_of(&layout.git_dir()), "v2");
        assert_eq!(
            marker_of(&layout.previous_dir()),
            "v1",
            "the MinGit generation is dropped"
        );

        rollback_managed_git(&layout, &mut host).unwrap();
        assert_eq!(marker_of(&layout.git_dir()), "v1");
        assert_eq!(marker_of(&layout.previous_dir()), "v2");
        rollback_managed_git(&layout, &mut host).unwrap();
        assert_eq!(marker_of(&layout.git_dir()), "v2");
        assert_eq!(
            toolchain_entries(&layout),
            vec!["git".to_string(), "git.previous".to_string()]
        );
    }

    #[test]
    fn rollback_without_a_rollback_copy_changes_nothing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        write_portable_tree(&layout.git_dir(), &PORTABLE_GIT_X64, "only");
        let asset = PORTABLE_GIT_X64;
        let mut host = FakeHost::new(&asset);
        let error = rollback_managed_git(&layout, &mut host).unwrap_err();
        assert_eq!(error.stage, PortableGitStage::Rollback);
        assert_eq!(marker_of(&layout.git_dir()), "only");
    }

    #[test]
    fn a_failed_activation_rename_puts_the_previous_bundle_back() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        write_portable_tree(&layout.git_dir(), &PORTABLE_GIT_X64, "old");
        let archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        let mut host = FakeHost::new(&asset);
        // Rename 1 moves the live bundle aside; rename 2 (staged -> git) fails.
        host.fail_rename_calls = vec![2];

        let error = install_portable_git(&layout, &asset, &archive, &mut host).unwrap_err();
        assert_eq!(error.stage, PortableGitStage::Activate);
        assert_eq!(marker_of(&layout.git_dir()), "old");
        assert_eq!(toolchain_entries(&layout), vec!["git".to_string()]);
    }

    #[test]
    fn a_live_bundle_that_does_not_run_is_replaced_by_the_previous_one() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        write_mingit_tree(&layout.git_dir());
        let archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        let mut host = FakeHost::new(&asset);
        host.verify_errors.push_back("git.exe did not start".into());

        let error = install_portable_git(&layout, &asset, &archive, &mut host).unwrap_err();
        assert_eq!(error.stage, PortableGitStage::Verify);
        assert_eq!(
            classify_managed_git_bundle(&layout.git_dir()),
            ManagedGitBundle::MinGit
        );
        assert_eq!(toolchain_entries(&layout), vec!["git".to_string()]);
    }

    #[test]
    fn a_fresh_install_that_does_not_run_leaves_no_git_behind() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        let archive = fake_archive();
        let asset = asset_for(&archive, &PORTABLE_GIT_X64);
        let mut host = FakeHost::new(&asset);
        host.verify_errors.push_back("git.exe did not start".into());

        let error = install_portable_git(&layout, &asset, &archive, &mut host).unwrap_err();
        assert_eq!(error.stage, PortableGitStage::Verify);
        assert!(toolchain_entries(&layout).is_empty());
    }

    #[test]
    fn a_crash_between_the_activation_renames_is_recovered_next_time() {
        let tmp = tempfile::TempDir::new().unwrap();
        let layout = ManagedGitLayout::new(tmp.path().join("toolchain"));
        // The live bundle was moved aside, then the process died.
        write_portable_tree(&layout.previous_dir(), &PORTABLE_GIT_X64, "kept");
        let asset = PORTABLE_GIT_X64;
        let mut host = FakeHost::new(&asset);
        assert!(recover_interrupted_activation(&layout, &mut host).unwrap());
        assert_eq!(marker_of(&layout.git_dir()), "kept");
        assert!(!layout.previous_dir().exists());
        // Nothing to do once the live bundle is there.
        assert!(!recover_interrupted_activation(&layout, &mut host).unwrap());
    }

    #[test]
    fn stale_sweep_only_takes_old_staging_folders() {
        let hour = Duration::from_secs(3600);
        assert!(is_stale_portable_git_sibling(
            ".git-install-abc",
            Some(hour),
            hour
        ));
        assert!(is_stale_portable_git_sibling(
            ".git-failed-abc",
            Some(hour * 2),
            hour
        ));
        assert!(!is_stale_portable_git_sibling(
            ".git-install-abc",
            Some(Duration::from_secs(5)),
            hour
        ));
        assert!(!is_stale_portable_git_sibling(
            ".git-install-abc",
            None,
            hour
        ));
        assert!(!is_stale_portable_git_sibling("git", Some(hour * 10), hour));
        assert!(!is_stale_portable_git_sibling(
            "git.previous",
            Some(hour * 10),
            hour
        ));
        assert!(!is_stale_portable_git_sibling(
            ".node-install-abc",
            Some(hour * 10),
            hour
        ));
    }

    #[test]
    fn probe_path_holds_only_the_bundle_and_windows() {
        let bundle = Path::new(r"C:\t\git");
        let path = bundle_probe_path(bundle, &PORTABLE_GIT_ARM64, Path::new(r"C:\Windows"));
        let entries: Vec<&str> = path.split(';').collect();
        assert_eq!(entries.len(), 6);
        assert!(entries[..4]
            .iter()
            .all(|entry| entry.starts_with(r"C:\t\git")));
        assert!(entries[2].contains("clangarm64"));
        assert!(!path.to_ascii_lowercase().contains("program files"));
    }

    #[test]
    fn managed_git_path_dirs_put_git_bash_on_path() {
        let dirs = managed_git_path_dirs(Path::new("/t/git"));
        assert_eq!(
            dirs,
            vec![PathBuf::from("/t/git/cmd"), PathBuf::from("/t/git/bin")]
        );
    }

    /// A child PATH laid out the way the desktop composes it on Windows:
    /// managed toolchain, managed Git, Node, system Git, then Windows.
    fn composed_child_path(git: &WindowsGitSearchDirs, system_root: &Path) -> Vec<PathBuf> {
        let mut path = vec![PathBuf::from(r"C:\t\node")];
        path.extend(git.managed.iter().cloned());
        path.push(PathBuf::from(r"C:\Program Files\nodejs"));
        path.extend(git.system.iter().cloned());
        path.push(system_root.join("System32"));
        path.push(system_root.to_path_buf());
        path
    }

    #[test]
    fn child_path_resolves_bash_to_the_managed_bundle_not_wsl_or_system_git() {
        let managed = Path::new(r"C:\t\git");
        let program_files = Path::new(r"C:\Program Files");
        let system_root = Path::new(r"C:\Windows");
        // Folders that hold a bash.exe on a machine with WSL and an installed
        // Git for Windows, plus HQ's PortableGit.
        let has_bash = |dir: &Path| {
            [
                managed.join("bin"),
                program_files.join("Git").join("bin"),
                program_files.join("Git").join("usr").join("bin"),
                system_root.join("System32"),
            ]
            .contains(&dir.to_path_buf())
        };

        let active = windows_git_search_dirs(managed, "mingw64", program_files, true);
        let path = composed_child_path(&active, system_root);
        let bash = path.iter().find(|dir| has_bash(dir)).unwrap();
        assert_eq!(bash, &managed.join("bin"));
        assert!(
            !path
                .iter()
                .any(|dir| dir.starts_with(program_files.join("Git"))),
            "no system Git folder while PortableGit is live: {path:?}"
        );
        let git_cmd = path
            .iter()
            .position(|dir| dir == &managed.join("cmd"))
            .unwrap();
        let system32 = path
            .iter()
            .position(|dir| dir == &system_root.join("System32"))
            .unwrap();
        assert!(git_cmd < system32);

        // Without HQ's PortableGit, an installed Git's Bash still wins over WSL.
        let inactive = windows_git_search_dirs(managed, "mingw64", program_files, false);
        let path = composed_child_path(&inactive, system_root);
        let bash = path
            .iter()
            .filter(|dir| !dir.starts_with(managed))
            .find(|dir| has_bash(dir))
            .unwrap();
        assert_eq!(bash, &program_files.join("Git").join("bin"));
    }

    #[test]
    fn arm64_search_dirs_use_the_clangarm64_helper_folder() {
        let dirs =
            windows_git_search_dirs(Path::new("/t/git"), "clangarm64", Path::new("/pf"), true);
        assert_eq!(
            dirs.managed.last().unwrap(),
            &PathBuf::from("/t/git/clangarm64/bin")
        );
        assert!(dirs.system.is_empty());
    }

    #[test]
    fn version_and_bash_probes_require_the_pin_and_the_marker() {
        let ok = |stdout: &str| ProbeOutput {
            success: true,
            code: Some(0),
            stdout: stdout.into(),
            stderr: String::new(),
        };
        let git = Path::new("git.exe");
        assert!(probe_git_version(&ok("git version 2.54.0.windows.1\n"), git).is_ok());
        assert!(probe_git_version(&ok("git version 2.53.0.windows.1\n"), git).is_err());
        let failed = ProbeOutput {
            success: false,
            ..ok("git version 2.54.0.windows.1")
        };
        assert!(probe_git_version(&failed, git).is_err());
        assert!(probe_bash(&ok("HQ_BASH_OK"), Path::new("bash.exe")).is_ok());
        assert!(probe_bash(&ok(""), Path::new("bash.exe")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn run_probe_captures_output_and_enforces_its_deadline() {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "printf out; printf err >&2; exit 3"]);
        let output = run_probe(command, Duration::from_secs(10)).unwrap();
        assert_eq!(output.stdout, "out");
        assert_eq!(output.stderr, "err");
        assert_eq!(output.code, Some(3));
        assert!(!output.success);

        let mut slow = std::process::Command::new("/bin/sh");
        slow.args(["-c", "sleep 5"]);
        let error = run_probe(slow, Duration::from_millis(200)).unwrap_err();
        assert!(error.contains("did not finish"), "{error}");
    }

    /// Real-asset check, run by hand or on a Windows runner:
    /// `HQ_PORTABLE_GIT_ASSET=<path to the .7z.exe> cargo test -p hq-desktop-core
    /// windows_portable_git::tests::real_asset -- --ignored --nocapture`.
    /// Off Windows it verifies the digest and in-process extraction of the
    /// layout. On Windows it runs the whole install against a temp toolchain,
    /// including post-install, the probes, a Bash-shebang hook, upgrade and
    /// rollback.
    #[test]
    #[ignore = "needs a downloaded PortableGit asset in HQ_PORTABLE_GIT_ASSET"]
    fn real_asset_install_end_to_end() {
        let path = std::env::var("HQ_PORTABLE_GIT_ASSET").expect("HQ_PORTABLE_GIT_ASSET");
        let bytes = std::fs::read(&path).unwrap();
        let asset = if path.contains("arm64") {
            &PORTABLE_GIT_ARM64
        } else {
            &PORTABLE_GIT_X64
        };
        verify_portable_git_sha256(&bytes, asset).unwrap();
        let payload = sfx_7z_payload(&bytes).unwrap();
        let tmp = tempfile::TempDir::new().unwrap();

        #[cfg(not(windows))]
        {
            let dest = tmp.path().join("staged");
            let mut last = 0;
            extract_portable_git_payload(payload, &dest, &mut |count| last = count).unwrap();
            validate_staged_portable_git(&dest, asset).unwrap();
            assert!(last > 1000, "extracted {last} entries");
            eprintln!("extracted {last} entries for {}", asset.file_name);
        }

        #[cfg(windows)]
        {
            let _ = payload;
            let layout = ManagedGitLayout::new(tmp.path().join("tool chain with spaces"));
            let system_root =
                PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()));
            let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let sink = lines.clone();
            let mut host = SystemPortableGitHost::new(
                system_root.clone(),
                Box::new(move |line| sink.lock().unwrap().push(line.to_string())),
            );

            // Migration from a MinGit-shaped managed folder.
            write_mingit_tree(&layout.git_dir());
            let started = std::time::Instant::now();
            let installed = install_portable_git(&layout, asset, &bytes, &mut host).unwrap();
            eprintln!(
                "install took {:?}; {} progress lines",
                started.elapsed(),
                lines.lock().unwrap().len()
            );
            assert_eq!(installed.replaced, ManagedGitBundle::MinGit);
            assert_eq!(
                classify_managed_git_bundle(&layout.git_dir()),
                ManagedGitBundle::PortableGit
            );
            assert!(!layout.git_dir().join("post-install.bat").exists());

            // Git and a Bash-shebang hook from the live bundle only.
            let git = git_exe_in(&layout.git_dir());
            let repo = tmp.path().join("repo with spaces");
            std::fs::create_dir_all(&repo).unwrap();
            let path = bundle_probe_path(&layout.git_dir(), asset, &system_root);
            // An empty global config file, not `NUL`: Git on windows-11-arm
            // fails `git init` with "unable to access 'NUL'".
            let global_config = tmp.path().join("empty-global.gitconfig");
            std::fs::write(&global_config, "").unwrap();
            let run = |args: &[&str]| {
                let mut command = std::process::Command::new(&git);
                command
                    .args(args)
                    .current_dir(&repo)
                    .env("PATH", &path)
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CONFIG_GLOBAL", &global_config)
                    .env("GIT_TERMINAL_PROMPT", "0");
                let output = run_probe(command, Duration::from_secs(120)).unwrap();
                assert!(
                    output.success,
                    "git {args:?}: {} {}",
                    output.stdout, output.stderr
                );
                output
            };
            run(&["init", "-q"]);
            run(&["config", "user.name", "HQ PortableGit test"]);
            run(&["config", "user.email", "portable-git@example.invalid"]);
            std::fs::write(repo.join("one.txt"), "one\n").unwrap();
            std::fs::write(
                repo.join(".git").join("hooks").join("pre-commit"),
                "#!/usr/bin/bash\nset -euo pipefail\nitems=(one two)\n[[ ${#items[@]} == 2 ]]\nprintf 'hook-ok\\n' > hook-proof.txt\n",
            )
            .unwrap();
            run(&["add", "one.txt"]);
            run(&["commit", "-qm", "portable git proof"]);
            assert!(repo.join("hook-proof.txt").is_file(), "Bash hook ran");
            run(&["worktree", "add", "-q", "-b", "other", "../worktree copy"]);

            // Upgrade (reinstall of the pin), then roll back and forward.
            let again = install_portable_git(&layout, asset, &bytes, &mut host).unwrap();
            assert_eq!(again.replaced, ManagedGitBundle::PortableGit);
            assert_eq!(
                classify_managed_git_bundle(&layout.previous_dir()),
                ManagedGitBundle::PortableGit
            );
            rollback_managed_git(&layout, &mut host).unwrap();
            host.verify_live(&layout.git_dir()).unwrap();
            rollback_managed_git(&layout, &mut host).unwrap();
            host.verify_live(&layout.git_dir()).unwrap();
        }
    }
}
