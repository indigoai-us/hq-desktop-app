//! Portable Win32 path simplification.
//!
//! Copy path, Explorer Reveal, HQ-path persist/resolve, and the Claude Code
//! deep link share this helper so a reserved DOS name, trailing dot/space,
//! `.`/`..`, oversize component, or MAX_PATH-length path keeps the `\\?\`
//! prefix. Implemented as string checks (not `dunce::simplified`) so
//! Linux/macOS CI can lock the Windows contract; dunce no-ops off Windows.
//!
//! Lives in `hq-desktop-core` because `claude_launch` — which canonicalizes a
//! path and then hands it to another application — needs it, and the core
//! crate cannot depend on the Tauri app. `apps/sync/src-tauri` re-exports it
//! as `crate::util::win32_path`, so existing call sites are unchanged.

const WINDOWS_LEGACY_MAX_UTF16: usize = 260;

fn windows_dos_stem(component: &str) -> &str {
    let trimmed = component.trim_end_matches([' ', '.']);
    match trimmed.split_once('.') {
        Some((stem, _)) => stem,
        None => trimmed,
    }
}

fn is_reserved_dos_device(component: &str) -> bool {
    let stem = windows_dos_stem(component);
    // Superscript ¹ ² ³ are DOS digits for COM/LPT (Win32 naming-a-file).
    // Do not gate on UTF-8 `len()` — `COM¹` is 5 bytes / 4 UTF-16 units.
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "AUX"
            | "NUL"
            | "PRN"
            | "CON"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM\u{00B9}"
            | "COM\u{00B2}"
            | "COM\u{00B3}"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT\u{00B9}"
            | "LPT\u{00B2}"
            | "LPT\u{00B3}"
    )
}

fn is_valid_legacy_win32_component(component: &str) -> bool {
    if component.is_empty() || component.encode_utf16().count() > 255 {
        return false;
    }
    if component.ends_with(' ') || component.ends_with('.') {
        return false;
    }
    !component.bytes().any(|c| {
        matches!(
            c,
            0..=31 | b'<' | b'>' | b':' | b'"' | b'/' | b'\\' | b'|' | b'?' | b'*'
        )
    })
}

/// True when `legacy` can be named without a Win32 verbatim prefix.
fn win32_legacy_is_safe(legacy: &str) -> bool {
    // MAX_PATH is 260 including the terminating NUL, so 259 usable code units.
    if legacy.encode_utf16().count() >= WINDOWS_LEGACY_MAX_UTF16 {
        return false;
    }
    for component in legacy.split(['\\', '/']) {
        if component.is_empty() {
            continue;
        }
        let bytes = component.as_bytes();
        if bytes.len() == 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            continue;
        }
        if !is_valid_legacy_win32_component(component) || is_reserved_dos_device(component) {
            return false;
        }
    }
    true
}

/// Strip Windows' internal verbatim prefix (`\\?\C:\…`, `\\?\UNC\…`) only when
/// the remainder is a safe legacy Win32 path.
pub fn strip_windows_verbatim_prefix(path: &str) -> String {
    const UNC: &[u8] = br"\\?\UNC\";
    const VERBATIM: &str = r"\\?\";
    let bytes = path.as_bytes();
    // Prefixes are ASCII, so a byte match is a char-boundary match. Never
    // slice the UTF-8 `str` at a fixed byte offset — `C:\ééé` is ≥ 8 bytes
    // with index 8 inside a multibyte character.
    if bytes.len() >= UNC.len() && bytes[..UNC.len()].eq_ignore_ascii_case(UNC) {
        let rewritten = format!(r"\\{}", &path[UNC.len()..]);
        if win32_legacy_is_safe(&rewritten) {
            rewritten
        } else {
            path.to_string()
        }
    } else if let Some(rest) = path.strip_prefix(VERBATIM) {
        // Only VerbatimDisk (`\\?\C:\…`). Volume GUID / device namespaces must
        // keep the prefix; stripping yields a relative `Volume{GUID}\…`.
        if is_win32_drive_path(rest) && win32_legacy_is_safe(rest) {
            rest.to_string()
        } else {
            path.to_string()
        }
    } else {
        path.to_string()
    }
}

fn is_win32_drive_path(legacy: &str) -> bool {
    let bytes = legacy.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

#[cfg(test)]
mod tests {
    use super::strip_windows_verbatim_prefix;

    #[test]
    fn strip_windows_verbatim_prefix_for_explorer() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\person\hq"),
            r"C:\Users\person\hq"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\HQ Setup"),
            r"C:\HQ Setup"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\HQ"),
            r"\\server\share\HQ"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\unc\server\share\HQ"),
            r"\\server\share\HQ"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"C:\Users\Ada\hq"),
            r"C:\Users\Ada\hq"
        );
        assert_eq!(
            strip_windows_verbatim_prefix("/Users/ada/hq"),
            "/Users/ada/hq"
        );
        // `C:\ééé` is ≥ `\\?\UNC\` bytes with a non-boundary at index 8.
        // The old `path[..UNC.len()]` str-slice panics here.
        let multibyte = "C:\\ééé";
        assert!(multibyte.len() >= br"\\?\UNC\".len());
        assert_eq!(strip_windows_verbatim_prefix(multibyte), multibyte);
    }

    #[test]
    fn strip_windows_verbatim_keeps_prefix_when_legacy_win32_cannot_name_path() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\COM1"),
            r"\\?\C:\COM1"
        );
        assert_eq!(
            strip_windows_verbatim_prefix("\\\\?\\C:\\COM\u{00B9}"),
            "\\\\?\\C:\\COM\u{00B9}"
        );
        assert_eq!(
            strip_windows_verbatim_prefix("\\\\?\\C:\\LPT\u{00B3}"),
            "\\\\?\\C:\\LPT\u{00B3}"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\person\CON.txt"),
            r"\\?\C:\Users\person\CON.txt"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\foo\..\bar"),
            r"\\?\C:\foo\..\bar"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\HQ.\repo"),
            r"\\?\C:\HQ.\repo"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\HQ \repo"),
            r"\\?\C:\HQ \repo"
        );
        assert_eq!(strip_windows_verbatim_prefix(r"\\?\C:\HQ "), r"\\?\C:\HQ ");
        assert_eq!(
            strip_windows_verbatim_prefix(
                r"\\?\Volume{26a21bda-a627-11d7-9931-806e6f6e6963}\Users\Ada\hq"
            ),
            r"\\?\Volume{26a21bda-a627-11d7-9931-806e6f6e6963}\Users\Ada\hq"
        );
        let long = format!(r"\\?\C:\{}", "a".repeat(260));
        assert_eq!(strip_windows_verbatim_prefix(&long), long);
        // Nested so no component exceeds 255. `C:\x\` + 255 a's = 260 UTF-16.
        let exact_legacy = format!(r"C:\x\{}", "a".repeat(255));
        assert_eq!(exact_legacy.encode_utf16().count(), 260);
        assert_eq!(
            strip_windows_verbatim_prefix(&format!(r"\\?\{exact_legacy}")),
            format!(r"\\?\{exact_legacy}")
        );
        // 256-char component is over MAX_COMPONENT_LENGTH even when total < 260.
        let oversize_component = format!(r"C:\{}", "a".repeat(256));
        assert_eq!(oversize_component.encode_utf16().count(), 259);
        assert_eq!(
            strip_windows_verbatim_prefix(&format!(r"\\?\{oversize_component}")),
            format!(r"\\?\{oversize_component}")
        );
        // Nested 259-unit path with components ≤ 255 still strips.
        let under_max = format!(r"C:\x\{}", "a".repeat(254));
        assert_eq!(under_max.encode_utf16().count(), 259);
        assert_eq!(
            strip_windows_verbatim_prefix(&format!(r"\\?\{under_max}")),
            under_max
        );
        // 128 `é` is 256 UTF-8 bytes but 128 UTF-16 units — still a legal component.
        let unicode_ok = format!(r"C:\{}", "é".repeat(128));
        assert!(unicode_ok.encode_utf16().count() < 260);
        assert_eq!(
            strip_windows_verbatim_prefix(&format!(r"\\?\{unicode_ok}")),
            unicode_ok
        );
    }
}
