//! Reads only the active installation's own download provenance. The value is
//! an opaque 256-bit funnel correlation token, never a credential.

use std::process::Command;

const TOKEN_PREFIX: &str = "downloadToken=";

fn token_from_url(url: &str, expected_asset: &str) -> Option<String> {
    let url = url.trim().trim_matches(['"', ',', ' ']);
    let (path, query) = url.split_once('?')?;
    let expected = format!(
        "https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/{expected_asset}"
    );
    if path != expected || !query.starts_with(TOKEN_PREFIX) || query.contains('&') {
        return None;
    }
    let token = &query[TOKEN_PREFIX.len()..];
    (token.len() == 43
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
    .then(|| token.to_owned())
}

fn token_from_windows_host_url(host_url: &str, architecture: &str) -> Option<String> {
    let asset = match architecture {
        "x86_64" => "HQ_x64-setup.exe",
        "aarch64" => "HQ_arm64-setup.exe",
        _ => return None,
    };
    token_from_url(host_url, asset)
}

fn token_from_mac_where_froms(where_froms: &str) -> Option<String> {
    where_froms
        .lines()
        .filter_map(|line| token_from_url(line, "HQ.dmg"))
        .next()
}

#[tauri::command]
pub fn first_launch_download_token() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let path = dirs::home_dir()?.join(".hq").join("download-token");
        let token = std::fs::read_to_string(&path).ok();
        // Consume the installer receipt once; a later reinstall must not
        // attribute an unrelated first launch to this download.
        let _ = std::fs::remove_file(path);
        return token.and_then(|value| {
            let host_url = format!(
                "https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/HQ_{}-setup.exe?downloadToken={}",
                if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" },
                value.trim()
            );
            token_from_windows_host_url(&host_url, std::env::consts::ARCH)
        });
    }

    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().ok()?;
        let app_bundle = executable
            .ancestors()
            .find(|path| path.extension().is_some_and(|extension| extension == "app"))?;
        let output = Command::new("mdls")
            .args(["-raw", "-name", "kMDItemWhereFroms"])
            .arg(app_bundle)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        return token_from_mac_where_froms(std::str::from_utf8(&output.stdout).ok()?);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{token_from_mac_where_froms, token_from_windows_host_url};

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456";

    #[test]
    fn reads_only_first_party_windows_installer_host_urls() {
        let valid = format!(
            "https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/HQ_x64-setup.exe?downloadToken={TOKEN}"
        );
        assert_eq!(token_from_windows_host_url(&valid, "x86_64").as_deref(), Some(TOKEN));
        assert_eq!(token_from_windows_host_url(&valid, "aarch64"), None);
        assert_eq!(token_from_windows_host_url("https://evil.test/?downloadToken=x", "x86_64"), None);
        assert_eq!(token_from_windows_host_url(&format!("{valid}&other=1"), "x86_64"), None);
    }

    #[test]
    fn reads_only_first_party_mac_dmg_source_urls() {
        let valid = format!(
            "(\n  \"https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/HQ.dmg?downloadToken={TOKEN}\",\n  \"https://github.com\"\n)"
        );
        assert_eq!(token_from_mac_where_froms(&valid).as_deref(), Some(TOKEN));
        assert_eq!(token_from_mac_where_froms("(null)"), None);
        assert_eq!(
            token_from_mac_where_froms(&format!("https://evil.test/HQ.dmg?downloadToken={TOKEN}")),
            None
        );
    }
}
