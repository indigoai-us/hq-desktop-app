//! Recover the website visitor id from the URL the installer came from.
//!
//! The marketing site appends `?aid=<anonId>&src=<surface>` to the final
//! installer URL. The OS records that URL next to the downloaded file:
//!
//! - macOS: the `com.apple.metadata:kMDItemWhereFroms` extended attribute,
//!   a binary plist array of URL strings. Finder/LaunchServices usually carry
//!   it onto the app bundle copied out of the DMG.
//! - Windows: the `Zone.Identifier` alternate data stream (`HostUrl=`,
//!   `ReferrerUrl=`), read from the running exe and, as a fallback, from
//!   the newest recent `HQ-*.exe` in the Downloads folder.
//!
//! Only `aid` and `src` are ever extracted or returned. The full URL can
//! carry other parameters and is never logged or stored. Every reader is
//! bounded and returns `None` on malformed input; nothing here panics.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Extended attribute that holds the download origin on macOS.
pub const WHERE_FROMS_XATTR: &str = "com.apple.metadata:kMDItemWhereFroms";
/// Upper bound on any attribute / stream we read.
pub const MAX_TAG_BYTES: usize = 16 * 1024;
/// Downloads fallback only trusts installers this recent.
pub const DOWNLOADS_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_AID_LEN: usize = 128;
const MAX_SRC_LEN: usize = 64;
const MAX_DOWNLOADS_ENTRIES: usize = 2_000;

/// Where the tag was found. Telemetry label via [`TagSource::label`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagSource {
    WhereFroms,
    ZoneIdentifier,
}

impl TagSource {
    pub fn label(self) -> &'static str {
        match self {
            TagSource::WhereFroms => "whereFroms",
            TagSource::ZoneIdentifier => "zoneIdentifier",
        }
    }
}

/// The two values the website put on the download URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadTag {
    pub anon_id: String,
    pub install_source: Option<String>,
    pub source: TagSource,
}

fn safe_value(value: &str, max: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')))
    .then(|| value.to_string())
}

/// `(aid, src)` from one URL. `aid` is required; `src` is optional.
/// Values outside `[A-Za-z0-9._-]` or over length are rejected.
pub fn tag_from_url(url: &str) -> Option<(String, Option<String>)> {
    let url = url::Url::parse(url.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let mut aid = None;
    let mut src = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "aid" if aid.is_none() => aid = safe_value(&value, MAX_AID_LEN),
            "src" if src.is_none() => src = safe_value(&value, MAX_SRC_LEN),
            _ => {}
        }
    }
    aid.map(|aid| (aid, src))
}

/// First URL in the list that carries a valid `aid`.
pub fn tag_from_urls<'a, I>(urls: I, source: TagSource) -> Option<DownloadTag>
where
    I: IntoIterator<Item = &'a str>,
{
    urls.into_iter().find_map(|url| {
        tag_from_url(url).map(|(anon_id, install_source)| DownloadTag {
            anon_id,
            install_source,
            source,
        })
    })
}

// ---------------------------------------------------------------- bplist

fn be_uint(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || bytes.len() > 8 {
        return None;
    }
    Some(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
}

/// Minimal `bplist00` reader for the one shape `kMDItemWhereFroms` uses:
/// a top-level array of ASCII or UTF-16 strings. Anything else (or any
/// out-of-range offset) yields an empty list. Non-string members are skipped.
pub fn parse_bplist_string_array(data: &[u8]) -> Vec<String> {
    parse_bplist_inner(data).unwrap_or_default()
}

fn parse_bplist_inner(data: &[u8]) -> Option<Vec<String>> {
    if data.len() > MAX_TAG_BYTES || data.len() < 8 + 32 || !data.starts_with(b"bplist00") {
        return None;
    }
    let trailer = &data[data.len() - 32..];
    let offset_size = usize::from(trailer[6]);
    let ref_size = usize::from(trailer[7]);
    let num_objects = usize::try_from(be_uint(&trailer[8..16])?).ok()?;
    let top = usize::try_from(be_uint(&trailer[16..24])?).ok()?;
    let table_at = usize::try_from(be_uint(&trailer[24..32])?).ok()?;
    if !(1..=8).contains(&offset_size) || !(1..=8).contains(&ref_size) || top >= num_objects {
        return None;
    }
    let body_end = data.len() - 32;
    let table_len = num_objects.checked_mul(offset_size)?;
    let table = data.get(table_at..table_at.checked_add(table_len)?)?;
    if table_at.checked_add(table_len)? > body_end {
        return None;
    }
    let offset_of = |index: usize| -> Option<usize> {
        if index >= num_objects {
            return None;
        }
        let start = index * offset_size;
        let off = usize::try_from(be_uint(table.get(start..start + offset_size)?)?).ok()?;
        (off >= 8 && off < table_at).then_some(off)
    };
    // Returns (count, position after the marker + length bytes).
    let length_at = |pos: usize| -> Option<(usize, usize)> {
        let marker = *data.get(pos)?;
        let low = usize::from(marker & 0x0f);
        if low != 0x0f {
            return Some((low, pos + 1));
        }
        let int_marker = *data.get(pos + 1)?;
        if int_marker & 0xf0 != 0x10 {
            return None;
        }
        let width = 1usize.checked_shl(u32::from(int_marker & 0x0f))?;
        let bytes = data.get(pos + 2..pos + 2 + width)?;
        let count = usize::try_from(be_uint(bytes)?).ok()?;
        Some((count, pos + 2 + width))
    };

    let top_at = offset_of(top)?;
    if data[top_at] & 0xf0 != 0xa0 {
        return None;
    }
    let (count, refs_at) = length_at(top_at)?;
    let refs = data.get(refs_at..refs_at.checked_add(count.checked_mul(ref_size)?)?)?;
    let mut out = Vec::new();
    for chunk in refs.chunks_exact(ref_size).take(64) {
        let Some(index) = be_uint(chunk).and_then(|i| usize::try_from(i).ok()) else {
            continue;
        };
        let Some(at) = offset_of(index) else {
            continue;
        };
        let marker = data[at] & 0xf0;
        let Some((len, start)) = length_at(at) else {
            continue;
        };
        let string = match marker {
            0x50 => start
                .checked_add(len)
                .and_then(|end| data.get(start..end))
                .filter(|b| b.is_ascii())
                .map(|b| String::from_utf8_lossy(b).into_owned()),
            0x60 => len
                .checked_mul(2)
                .and_then(|n| start.checked_add(n))
                .and_then(|end| data.get(start..end))
                .map(|b| {
                    let units: Vec<u16> = b
                        .chunks_exact(2)
                        .map(|p| u16::from_be_bytes([p[0], p[1]]))
                        .collect();
                    String::from_utf16_lossy(&units)
                }),
            _ => None,
        };
        if let Some(s) = string {
            out.push(s);
        }
    }
    Some(out)
}

// ---------------------------------------------------------------- Zone.Identifier

/// `HostUrl` and `ReferrerUrl` values from a `Zone.Identifier` stream, in
/// that order. Tolerates CRLF, a UTF-8 BOM, and UTF-16LE (with BOM) text.
pub fn parse_zone_identifier(data: &[u8]) -> Vec<String> {
    let data = &data[..data.len().min(MAX_TAG_BYTES)];
    let text = if data.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = data[2..]
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(data.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(data)).into_owned()
    };
    let mut host = Vec::new();
    let mut referrer = Vec::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            k if k.eq_ignore_ascii_case("HostUrl") => host.push(value.trim().to_string()),
            k if k.eq_ignore_ascii_case("ReferrerUrl") => referrer.push(value.trim().to_string()),
            _ => {}
        }
    }
    host.extend(referrer);
    host
}

// ---------------------------------------------------------------- readers

/// Read at most [`MAX_TAG_BYTES`] of a file (or ADS path).
pub fn read_bounded(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(MAX_TAG_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .ok()?;
    (buf.len() <= MAX_TAG_BYTES).then_some(buf)
}

/// The value of one extended attribute, bounded. macOS only.
#[cfg(target_os = "macos")]
pub fn read_xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let c_name = CString::new(name).ok()?;
    let mut buf = vec![0u8; MAX_TAG_BYTES];
    // SAFETY: both strings are NUL-terminated and outlive the call; the buffer
    // pointer and length describe a live allocation we own.
    let n = unsafe {
        libc::getxattr(
            c_path.as_ptr(),
            c_name.as_ptr(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            0,
            0,
        )
    };
    if n <= 0 {
        return None;
    }
    buf.truncate(usize::try_from(n).ok()?.min(MAX_TAG_BYTES));
    Some(buf)
}

#[cfg(not(target_os = "macos"))]
pub fn read_xattr(_path: &Path, _name: &str) -> Option<Vec<u8>> {
    None
}

/// The enclosing `.app` bundle of an executable, then its parent directory.
pub fn macos_candidate_paths(exe: &Path) -> Vec<PathBuf> {
    let Some(bundle) = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")))
    else {
        return Vec::new();
    };
    let mut out = vec![bundle.to_path_buf()];
    if let Some(parent) = bundle.parent().filter(|p| !p.as_os_str().is_empty()) {
        out.push(parent.to_path_buf());
    }
    out
}

/// macOS: first tagged URL in `kMDItemWhereFroms` on any candidate path.
pub fn tag_from_where_froms(paths: &[PathBuf]) -> Option<DownloadTag> {
    paths.iter().find_map(|path| {
        let bytes = read_xattr(path, WHERE_FROMS_XATTR)?;
        let urls = parse_bplist_string_array(&bytes);
        tag_from_urls(urls.iter().map(String::as_str), TagSource::WhereFroms)
    })
}

fn zone_stream_path(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_os_string();
    s.push(":Zone.Identifier");
    PathBuf::from(s)
}

/// `Zone.Identifier` of one file. On non-NTFS systems the path simply
/// does not exist.
pub fn tag_from_zone_identifier(file: &Path) -> Option<DownloadTag> {
    let bytes = read_bounded(&zone_stream_path(file))?;
    let urls = parse_zone_identifier(&bytes);
    tag_from_urls(urls.iter().map(String::as_str), TagSource::ZoneIdentifier)
}

/// `HQ-*.exe` files in `dir` modified within [`DOWNLOADS_MAX_AGE`] of
/// `now`, newest first. Bounded directory walk; no recursion.
pub fn recent_installers(dir: &Path, now: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(SystemTime, PathBuf)> = entries
        .take(MAX_DOWNLOADS_ENTRIES)
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let lower = name.to_ascii_lowercase();
            if !(lower.starts_with("hq-") && lower.ends_with(".exe")) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let modified = meta.modified().ok()?;
            let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
            (age <= DOWNLOADS_MAX_AGE).then(|| (modified, entry.path()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// Windows: the running exe's stream, then the newest recent installer in
/// `downloads`.
pub fn tag_from_windows(
    exe: &Path,
    downloads: Option<&Path>,
    now: SystemTime,
) -> Option<DownloadTag> {
    tag_from_zone_identifier(exe).or_else(|| {
        recent_installers(downloads?, now)
            .iter()
            .find_map(|p| tag_from_zone_identifier(p))
    })
}

/// Platform dispatch for the running process.
pub fn discover(exe: &Path, downloads: Option<&Path>, now: SystemTime) -> Option<DownloadTag> {
    if cfg!(target_os = "macos") {
        tag_from_where_froms(&macos_candidate_paths(exe))
    } else if cfg!(target_os = "windows") {
        tag_from_windows(exe, downloads, now)
    } else {
        None
    }
}

/// The no-overwrite rule: a download tag may only fill an empty visitor id.
/// A visitor linked by the sign-in flow (or an earlier read) always wins.
pub fn should_adopt(existing_anon_id: Option<&str>) -> bool {
    existing_anon_id.map(str::trim).is_none_or(str::is_empty)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// `plistlib.dumps([tagged_url, "https://hqforwork.com/"], fmt=FMT_BINARY)`
    const ASCII_FIXTURE: &str = "62706c6973743030a201025f105868747470733a2f2f6871666f72776f726b2e636f6d2f646f776e6c6f61642f48512d302e31302e3338302e646d673f6169643d7679672d616263267372633d77656c636f6d652d696e7374616c6c2d61726d2675746d3d785f101668747470733a2f2f6871666f72776f726b2e636f6d2f080b66000000000000010100000000000000030000000000000000000000000000007f";
    /// `plistlib.dumps(["https://h.com/é?aid=vyg-1"], fmt=FMT_BINARY)` (UTF-16)
    const UTF16_FIXTURE: &str = "62706c6973743030a1016f101900680074007400700073003a002f002f0068002e0063006f006d002f00e9003f006100690064003d007600790067002d0031080a000000000000010100000000000000020000000000000000000000000000003f";

    #[test]
    fn parses_ascii_bplist_array() {
        let urls = parse_bplist_string_array(&hex(ASCII_FIXTURE));
        assert_eq!(urls.len(), 2);
        assert!(urls[0].ends_with("&utm=x"));
        assert_eq!(urls[1], "https://hqforwork.com/");
        let tag = tag_from_urls(urls.iter().map(String::as_str), TagSource::WhereFroms).unwrap();
        assert_eq!(tag.anon_id, "vyg-abc");
        assert_eq!(tag.install_source.as_deref(), Some("welcome-install-arm"));
    }

    #[test]
    fn parses_utf16_bplist_string() {
        let urls = parse_bplist_string_array(&hex(UTF16_FIXTURE));
        assert_eq!(urls, vec!["https://h.com/é?aid=vyg-1".to_string()]);
        assert_eq!(tag_from_url(&urls[0]), Some(("vyg-1".into(), None)));
    }

    #[test]
    fn malformed_bplist_never_panics() {
        let good = hex(ASCII_FIXTURE);
        assert!(parse_bplist_string_array(b"").is_empty());
        assert!(parse_bplist_string_array(b"bplist00").is_empty());
        assert!(parse_bplist_string_array(&[0u8; 64]).is_empty());
        // Every truncation and every single-byte corruption must be handled.
        for cut in 0..good.len() {
            let _ = parse_bplist_string_array(&good[..cut]);
        }
        for i in 0..good.len() {
            for v in [0x00, 0x0f, 0x7f, 0xaf, 0xff] {
                let mut b = good.clone();
                b[i] = v;
                let _ = parse_bplist_string_array(&b);
            }
        }
        let mut huge = good.clone();
        huge.resize(MAX_TAG_BYTES + 1, 0);
        assert!(parse_bplist_string_array(&huge).is_empty());
    }

    #[test]
    fn url_tag_rules() {
        assert_eq!(
            tag_from_url("https://x.com/HQ.dmg?aid=vyg-1&src=email-link"),
            Some(("vyg-1".into(), Some("email-link".into())))
        );
        assert_eq!(tag_from_url("https://x.com/HQ.dmg?src=a"), None);
        assert_eq!(tag_from_url("https://x.com/HQ.dmg?aid="), None);
        assert_eq!(tag_from_url("https://x.com/HQ.dmg?aid=a%20b"), None);
        assert_eq!(tag_from_url("https://x.com/HQ.dmg?aid=%C3%A9"), None);
        assert_eq!(tag_from_url("file:///HQ.dmg?aid=vyg-1"), None);
        assert_eq!(tag_from_url("not a url"), None);
        let long = format!("https://x.com/?aid={}", "a".repeat(129));
        assert_eq!(tag_from_url(&long), None);
        // Bad src is dropped, aid kept.
        assert_eq!(
            tag_from_url("https://x.com/?aid=vyg-1&src=%3Cscript%3E"),
            Some(("vyg-1".into(), None))
        );
    }

    #[test]
    fn zone_identifier_text() {
        let text = b"[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://hqforwork.com/download\r\nHostUrl=https://cdn.x.com/HQ-1.exe?aid=vyg-9&src=direct\r\n";
        let urls = parse_zone_identifier(text);
        assert_eq!(urls[0], "https://cdn.x.com/HQ-1.exe?aid=vyg-9&src=direct");
        let tag =
            tag_from_urls(urls.iter().map(String::as_str), TagSource::ZoneIdentifier).unwrap();
        assert_eq!(tag.anon_id, "vyg-9");
        assert_eq!(tag.install_source.as_deref(), Some("direct"));

        let mut utf16 = vec![0xff, 0xfe];
        for u in "HostUrl=https://a.com/?aid=vyg-2\r\n".encode_utf16() {
            utf16.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(
            parse_zone_identifier(&utf16),
            vec!["https://a.com/?aid=vyg-2"]
        );
        assert!(parse_zone_identifier(&[0xff, 0xfe, 0x41]).is_empty());
        assert!(parse_zone_identifier(b"\xc3").is_empty());
    }

    #[test]
    fn no_overwrite_rule() {
        assert!(should_adopt(None));
        assert!(should_adopt(Some("  ")));
        assert!(!should_adopt(Some("vyg-from-signin")));
    }

    #[test]
    fn candidate_paths_find_the_bundle() {
        let exe = Path::new("/Applications/HQ.app/Contents/MacOS/hq-sync");
        assert_eq!(
            macos_candidate_paths(exe),
            vec![
                PathBuf::from("/Applications/HQ.app"),
                PathBuf::from("/Applications")
            ]
        );
        assert!(macos_candidate_paths(Path::new("/usr/bin/hq")).is_empty());
    }

    #[test]
    fn downloads_fallback_picks_newest_recent_installer() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["HQ-0.1.exe", "HQ-0.2.exe", "other.exe", "HQ-0.3.dmg"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        let now = SystemTime::now() + Duration::from_secs(1);
        let found = recent_installers(dir.path(), now);
        assert_eq!(found.len(), 2);
        let later = now + DOWNLOADS_MAX_AGE + Duration::from_secs(60);
        assert!(recent_installers(dir.path(), later).is_empty());
        assert!(recent_installers(&dir.path().join("missing"), now).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_reads_zone_identifier_stream() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("HQ-1.exe");
        std::fs::write(&exe, b"x").unwrap();
        std::fs::write(
            zone_stream_path(&exe),
            b"[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://a.com/HQ-1.exe?aid=vyg-w\r\n",
        )
        .unwrap();
        let other = dir.path().join("hq-sync.exe");
        let tag = tag_from_windows(&other, Some(dir.path()), SystemTime::now()).unwrap();
        assert_eq!(tag.anon_id, "vyg-w");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reads_where_froms_xattr() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("HQ.app");
        let exe = bundle.join("Contents/MacOS/hq-sync");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(discover(&exe, None, SystemTime::now()), None);
        let status = std::process::Command::new("xattr")
            .args(["-wx", WHERE_FROMS_XATTR, ASCII_FIXTURE])
            .arg(&bundle)
            .status();
        let Ok(status) = status else {
            eprintln!("xattr unavailable; skipping");
            return;
        };
        if !status.success() {
            eprintln!("xattr -w failed; skipping");
            return;
        }
        let tag = discover(&exe, None, SystemTime::now()).unwrap();
        assert_eq!(tag.anon_id, "vyg-abc");
        assert_eq!(tag.install_source.as_deref(), Some("welcome-install-arm"));
        assert_eq!(tag.source, TagSource::WhereFroms);
    }
}
