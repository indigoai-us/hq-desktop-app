fn main() {
    println!("cargo:rerun-if-env-changed=HQ_SYNC_SENTRY_DSN");
    println!(
        "cargo:rustc-env=SENTRY_DSN={}",
        std::env::var("HQ_SYNC_SENTRY_DSN").unwrap_or_default()
    );

    // Emit the shipped npm/tauri.conf.json version as `APP_VERSION` so the
    // client-attribution headers report the user-facing release version
    // rather than the Cargo crate version. The two version numbers drift
    // deliberately — the Rust crate is internal, the npm package.json is
    // what users see in About-dialogs and DMG names. Reads ../package.json
    // at compile time so there's no runtime manifest lookup.
    println!("cargo:rerun-if-changed=../package.json");
    let pkg_json = std::fs::read_to_string("../package.json")
        .expect("build.rs: failed to read ../package.json");
    let version = extract_json_string_field(&pkg_json, "version")
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=APP_VERSION={}", version);

    // Pin the `wry` version this crate actually resolves to.
    //
    // `util::webview2_automation::WRY_DEFAULT_BROWSER_ARGS` is a hand
    // transcription of a string that lives inside wry's private
    // `create_environment`; wry exports nothing to diff it against, so no
    // assertion can check the transcription itself. What can be checked is its
    // input — that the wry in the dependency graph is still the version the
    // string was read out of. Emitting the resolved version here lets
    // `wry_default_args_match_the_reviewed_wry_version` fail on a `cargo
    // update` that moves wry, instead of every automated run silently getting
    // the wrong browser switches.
    let lockfile = nearest_cargo_lock();
    println!("cargo:rerun-if-changed={}", lockfile.display());
    let lock_text = std::fs::read_to_string(&lockfile)
        .unwrap_or_else(|e| panic!("build.rs: failed to read {}: {e}", lockfile.display()));
    println!(
        "cargo:rustc-env=RESOLVED_WRY_VERSIONS={}",
        locked_versions(&lock_text, "wry").join(",")
    );

    // Compile the native menu-bar helper (`hq-tray-helper`) on macOS so the
    // bundler can copy it into Contents/Resources. The helper is a tiny separate
    // AppKit process that owns the "HQ" status item — Tauri's tao runtime parks
    // an in-process status item off-screen on macOS Tahoe (a clean AppKit
    // process places it correctly). Fail loud: a release that silently dropped
    // the helper would ship with no menu-bar icon.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=helper/hq-tray-helper.swift");
        let status = std::process::Command::new("swiftc")
            .args([
                "-O",
                "helper/hq-tray-helper.swift",
                "-o",
                "helper/hq-tray-helper",
            ])
            .status()
            .expect("build.rs: failed to invoke swiftc to build hq-tray-helper");
        assert!(
            status.success(),
            "build.rs: swiftc failed to compile helper/hq-tray-helper.swift"
        );
    }

    tauri_build::build()
}

/// The nearest `Cargo.lock` at or above this crate's manifest directory.
///
/// `apps/sync/src-tauri` is currently excluded from the root workspace and so
/// carries its own lockfile; walking upwards keeps this correct if it is later
/// folded in as a workspace member (MIGRATION.md, Phase 4).
fn nearest_cargo_lock() -> std::path::PathBuf {
    let mut dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("build.rs: CARGO_MANIFEST_DIR is unset"),
    );
    loop {
        let candidate = dir.join("Cargo.lock");
        if candidate.is_file() {
            return candidate;
        }
        if !dir.pop() {
            panic!("build.rs: no Cargo.lock found at or above CARGO_MANIFEST_DIR");
        }
    }
}

/// Every resolved version of `name` in a Cargo.lock, sorted and de-duplicated.
///
/// Plural on purpose: two resolved copies of a crate mean part of the graph is
/// on a version nothing was checked against, which is just as wrong as one
/// unexpected version. Returning both makes the assertion fail rather than
/// pick a winner.
fn locked_versions(lock: &str, name: &str) -> Vec<String> {
    let mut versions = Vec::new();
    let mut in_package = false;

    for line in lock.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            in_package = false;
        } else if let Some(value) = line.strip_prefix("name = ") {
            // Only `[[package]]` entries have a bare `name = "..."` key;
            // `dependencies = [...]` members are plain quoted strings.
            in_package = value.trim_matches('"') == name;
        } else if in_package {
            if let Some(value) = line.strip_prefix("version = ") {
                versions.push(value.trim_matches('"').to_string());
                in_package = false;
            }
        }
    }

    versions.sort();
    versions.dedup();
    versions
}

// Tiny ad-hoc parse for top-level string fields in package.json. Avoids
// pulling serde_json into the build-script dep graph just to read one value.
fn extract_json_string_field(json: &str, field: &str) -> Option<String> {
    let needle = format!("\"{}\"", field);
    let start = json.find(&needle)?;
    let after_key = &json[start + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    let stripped = after_colon.strip_prefix('"')?;
    let end = stripped.find('"')?;
    Some(stripped[..end].to_string())
}
