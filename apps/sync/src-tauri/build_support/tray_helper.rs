use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

pub const MACOS_DEPLOYMENT_TARGET: &str = "13.0";
const SUPPORTED_ARCHITECTURES: [&str; 2] = ["arm64", "x86_64"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwiftSlicePlan {
    pub arch: &'static str,
    pub target: String,
    pub output: PathBuf,
}

pub fn swift_slice_plans(output_directory: &Path) -> Vec<SwiftSlicePlan> {
    SUPPORTED_ARCHITECTURES
        .iter()
        .map(|&arch| SwiftSlicePlan {
            arch,
            target: format!("{arch}-apple-macosx{MACOS_DEPLOYMENT_TARGET}"),
            output: output_directory.join(format!("hq-tray-helper-{arch}")),
        })
        .collect()
}

pub fn validate_architectures(stdout: &str) -> Result<(), String> {
    let actual = stdout.split_whitespace().collect::<BTreeSet<_>>();
    let expected = SUPPORTED_ARCHITECTURES.into_iter().collect::<BTreeSet<_>>();

    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "universal helper architecture mismatch: expected {expected:?}, found {actual:?}"
        ))
    }
}

pub fn validate_minimum_versions(stdout: &str) -> Result<(), String> {
    let minimum_versions = stdout
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("minos ")
                .and_then(|value| value.split_whitespace().next())
        })
        .collect::<Vec<_>>();

    if minimum_versions.len() != SUPPORTED_ARCHITECTURES.len() {
        return Err(format!(
            "universal helper metadata must contain one minimum OS per architecture; found {minimum_versions:?}"
        ));
    }

    if minimum_versions
        .iter()
        .all(|version| *version == MACOS_DEPLOYMENT_TARGET)
    {
        Ok(())
    } else {
        Err(format!(
            "universal helper must target macOS {MACOS_DEPLOYMENT_TARGET}; found {minimum_versions:?}"
        ))
    }
}

pub fn build_universal_helper(
    source: &Path,
    output_directory: &Path,
    destination: &Path,
) -> Result<(), String> {
    fs::create_dir_all(output_directory).map_err(|error| {
        format!(
            "failed to create helper build directory {}: {error}",
            output_directory.display()
        )
    })?;

    let plans = swift_slice_plans(output_directory);
    for plan in &plans {
        let mut command = Command::new("xcrun");
        command
            .arg("swiftc")
            .arg("-parse-as-library")
            .arg("-O")
            .arg("-target")
            .arg(&plan.target)
            .arg(source)
            .arg("-o")
            .arg(&plan.output);
        run_command(
            &mut command,
            &format!("compile the {} tray-helper slice", plan.arch),
        )?;
    }

    let universal_output = output_directory.join("hq-tray-helper-universal");
    let mut lipo = Command::new("xcrun");
    lipo.arg("lipo").arg("-create");
    for plan in &plans {
        lipo.arg(&plan.output);
    }
    lipo.arg("-output").arg(&universal_output);
    run_command(&mut lipo, "combine the tray-helper slices")?;

    let mut inspect_architectures = Command::new("xcrun");
    inspect_architectures
        .arg("lipo")
        .arg("-archs")
        .arg(&universal_output);
    let architecture_output = run_command(
        &mut inspect_architectures,
        "inspect tray-helper architectures",
    )?;
    validate_architectures(&String::from_utf8_lossy(&architecture_output.stdout))?;

    let mut inspect_minimum_versions = Command::new("xcrun");
    inspect_minimum_versions
        .arg("vtool")
        .arg("-show-build")
        .arg(&universal_output);
    let minimum_version_output = run_command(
        &mut inspect_minimum_versions,
        "inspect tray-helper minimum OS metadata",
    )?;
    validate_minimum_versions(&String::from_utf8_lossy(&minimum_version_output.stdout))?;

    publish_verified_helper(&universal_output, destination)
}

fn run_command(command: &mut Command, description: &str) -> Result<Output, String> {
    let command_debug = format!("{command:?}");
    let output = command
        .output()
        .map_err(|error| format!("failed to {description} with {command_debug}: {error}"))?;
    if output.status.success() {
        return Ok(output);
    }

    Err(format!(
        "failed to {description} with {command_debug} (status {}): stdout: {}; stderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim(),
    ))
}

fn publish_verified_helper(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "tray-helper destination has no parent: {}",
            destination.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create tray-helper destination directory {}: {error}",
            parent.display()
        )
    })?;

    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "tray-helper destination has no UTF-8 file name: {}",
                destination.display()
            )
        })?;
    let temporary_destination =
        parent.join(format!(".{destination_name}.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&temporary_destination);
    fs::copy(source, &temporary_destination).map_err(|error| {
        format!(
            "failed to stage verified tray helper at {}: {error}",
            temporary_destination.display()
        )
    })?;
    set_executable(&temporary_destination)?;
    fs::rename(&temporary_destination, destination).map_err(|error| {
        let _ = fs::remove_file(&temporary_destination);
        format!(
            "failed to atomically publish verified tray helper to {}: {error}",
            destination.display()
        )
    })
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("failed to read permissions for {}: {error}", path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("failed to make {} executable: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_both_supported_architectures_at_the_bundle_minimum() {
        let plans = swift_slice_plans(Path::new("/tmp/hq-helper"));
        assert_eq!(
            plans,
            vec![
                SwiftSlicePlan {
                    arch: "arm64",
                    target: "arm64-apple-macosx13.0".to_string(),
                    output: PathBuf::from("/tmp/hq-helper/hq-tray-helper-arm64"),
                },
                SwiftSlicePlan {
                    arch: "x86_64",
                    target: "x86_64-apple-macosx13.0".to_string(),
                    output: PathBuf::from("/tmp/hq-helper/hq-tray-helper-x86_64"),
                },
            ],
        );
    }

    #[test]
    fn accepts_only_the_complete_universal_architecture_set() {
        assert!(validate_architectures("x86_64 arm64\n").is_ok());
        assert!(validate_architectures("arm64 x86_64\n").is_ok());
        assert!(validate_architectures("arm64\n").is_err());
        assert!(validate_architectures("arm64 x86_64 i386\n").is_err());
    }

    #[test]
    fn accepts_two_macos_13_slices_and_rejects_host_minimums() {
        let supported = r#"
Load command 10
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 13.0
Load command 11
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 13.0
"#;
        assert!(validate_minimum_versions(supported).is_ok());
        assert!(validate_minimum_versions("minos 13.0\n").is_err());
        assert!(validate_minimum_versions("minos 13.0\nminos 26.0\n").is_err());
        assert!(validate_minimum_versions("sdk 26.0\n").is_err());
    }
}
