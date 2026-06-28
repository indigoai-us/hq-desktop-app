//! Pure staging classification and eligibility predicates.

use std::collections::{BTreeMap, BTreeSet};

/// Phase-1 eligibility domain. Mirrors `meetings::ALLOWED_DOMAIN` and the
/// `daemon.rs` event-push gate — the leading `@` blocks look-alikes like
/// `forgetindigo.ai`.
const ALLOWED_DOMAIN: &str = "@getindigo.ai";

/// Where a drifted file's content was found in the promotion pipeline.
/// Serialized to a flat wire string so the Svelte side can render it without
/// a tagged-union switch: `"staging-main"`, `"pr:182"`, `"unaccounted"`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(into = "String", try_from = "String")]
pub enum StagingStatus {
    /// Local content matches the file on staging `main`.
    StagingMain,
    /// Local content matches the file at the head of this open PR.
    StagingPr(u32),
    /// Local content matches nothing in the staging pipeline.
    Unaccounted,
}

impl StagingStatus {
    pub fn to_wire(&self) -> String {
        match self {
            StagingStatus::StagingMain => "staging-main".to_string(),
            StagingStatus::StagingPr(n) => format!("pr:{n}"),
            StagingStatus::Unaccounted => "unaccounted".to_string(),
        }
    }

    pub fn from_wire(s: &str) -> Result<Self, String> {
        match s {
            "staging-main" => Ok(StagingStatus::StagingMain),
            "unaccounted" => Ok(StagingStatus::Unaccounted),
            other => {
                if let Some(num) = other.strip_prefix("pr:") {
                    num.parse::<u32>()
                        .map(StagingStatus::StagingPr)
                        .map_err(|_| format!("bad PR number in staging status: {other:?}"))
                } else {
                    Err(format!("unrecognized staging status: {other:?}"))
                }
            }
        }
    }
}

impl From<StagingStatus> for String {
    fn from(s: StagingStatus) -> String {
        s.to_wire()
    }
}

impl TryFrom<String> for StagingStatus {
    type Error = String;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        StagingStatus::from_wire(&s)
    }
}

/// In-memory index of every blob SHA each path carries across the staging
/// pipeline. Built once per drift scan, queried per drifted file.
#[derive(Debug, Default)]
pub struct StagingIndex {
    /// path -> set of blob SHAs present on staging `main`.
    main: BTreeMap<String, BTreeSet<String>>,
    /// (PR number, path -> set of blob SHAs at PR head), kept sorted by
    /// number so classification picks the lowest matching PR deterministically.
    prs: Vec<(u32, BTreeMap<String, BTreeSet<String>>)>,
}

impl StagingIndex {
    pub fn from_parts(
        main: BTreeMap<String, BTreeSet<String>>,
        prs: Vec<(u32, BTreeMap<String, BTreeSet<String>>)>,
    ) -> Self {
        Self { main, prs }
    }

    /// Classify one drifted file. `main` wins over any PR (already merged →
    /// most "settled"); otherwise the lowest-numbered open PR that carries a
    /// byte-identical copy wins.
    pub fn classify(&self, path: &str, local_sha: &str) -> StagingStatus {
        if self
            .main
            .get(path)
            .is_some_and(|shas| shas.contains(local_sha))
        {
            return StagingStatus::StagingMain;
        }
        let mut prs_sorted: Vec<&(u32, BTreeMap<String, BTreeSet<String>>)> =
            self.prs.iter().collect();
        prs_sorted.sort_by_key(|(n, _)| *n);
        for (num, files) in prs_sorted {
            if files.get(path).is_some_and(|shas| shas.contains(local_sha)) {
                return StagingStatus::StagingPr(*num);
            }
        }
        StagingStatus::Unaccounted
    }
}

/// Pure email gate — public for unit testing. Case-insensitive suffix match.
pub fn is_eligible_email(email: Option<&str>) -> bool {
    match email {
        Some(s) if !s.is_empty() => s.trim().to_ascii_lowercase().ends_with(ALLOWED_DOMAIN),
        _ => false,
    }
}

/// True when `folder` looks like a real HQ root, guarding the rescue/update
/// paths against operating on an unrelated directory.
///
/// Anchors on `companies/` (present and preserved on every HQ install) plus at
/// least one core scaffold marker — ANY of `.claude/`, `core/`, or `personal/`.
/// We accept any one because the layout drifted across releases: a faithful
/// v14.0.0 install ships NEITHER `personal/` (introduced in v15) NOR `core/`
/// (the v15 scaffold home) — only `.claude/`. The old check required
/// `companies/` AND `personal/`, which aborted every v14.0.0 user before the
/// rescue could run, leaving them with no upgrade path to v15 (DEV-1741).
/// `.claude/` exists on every release from v14 through v15, so this admits the
/// full upgrade range while still rejecting a directory that is not an HQ root.
pub fn looks_like_hq_root(folder: &std::path::Path) -> bool {
    folder.join("companies").is_dir()
        && (folder.join(".claude").is_dir()
            || folder.join("core").is_dir()
            || folder.join("personal").is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression for DEV-1741: the HQ-root gate must admit a faithful v14.0.0
    /// install — `companies/` + `.claude/` but NO `personal/` and NO `core/` —
    /// while still rejecting a directory that is not an HQ root.
    #[test]
    fn looks_like_hq_root_admits_v14_and_rejects_non_hq() {
        let tmp = tempfile::tempdir().unwrap();
        let mk = |name: &str, dirs: &[&str]| {
            let root = tmp.path().join(name);
            for d in dirs {
                std::fs::create_dir_all(root.join(d)).unwrap();
            }
            root
        };

        // Faithful v14.0.0: companies/ + .claude/, no personal/, no core/.
        let v14 = mk("v14", &["companies", ".claude", "repos", "workspace"]);
        assert!(!v14.join("personal").is_dir());
        assert!(!v14.join("core").is_dir());
        assert!(looks_like_hq_root(&v14), "v14.0.0 root must be admitted");

        // v15: companies/ + core/ + personal/.
        let v15 = mk("v15", &["companies", ".claude", "core", "personal"]);
        assert!(looks_like_hq_root(&v15));

        // core-only marker is enough alongside companies/.
        let core_only = mk("coreonly", &["companies", "core"]);
        assert!(looks_like_hq_root(&core_only));

        // companies/ with no scaffold marker -> not an HQ root.
        let bare = mk("bare", &["companies"]);
        assert!(!looks_like_hq_root(&bare));

        // marker but no companies/ -> not an HQ root.
        let no_co = mk("nocompanies", &[".claude", "core", "personal"]);
        assert!(!looks_like_hq_root(&no_co));
    }

    fn idx() -> StagingIndex {
        let mut main = BTreeMap::new();
        main.insert(
            "a.md".to_string(),
            BTreeSet::from(["sha-main-a".to_string()]),
        );

        let mut pr182 = BTreeMap::new();
        pr182.insert(
            "b.md".to_string(),
            BTreeSet::from(["sha-182-b".to_string()]),
        );
        pr182.insert(
            "shared.md".to_string(),
            BTreeSet::from(["sha-shared".to_string()]),
        );

        let mut pr183 = BTreeMap::new();
        pr183.insert(
            "c.md".to_string(),
            BTreeSet::from(["sha-183-c".to_string()]),
        );
        pr183.insert(
            "shared.md".to_string(),
            BTreeSet::from(["sha-shared".to_string()]),
        );

        StagingIndex {
            main,
            prs: vec![(183, pr183), (182, pr182)],
        }
    }

    #[test]
    fn classify_main_match() {
        assert_eq!(
            idx().classify("a.md", "sha-main-a"),
            StagingStatus::StagingMain
        );
    }

    #[test]
    fn classify_pr_match() {
        assert_eq!(
            idx().classify("b.md", "sha-182-b"),
            StagingStatus::StagingPr(182)
        );
        assert_eq!(
            idx().classify("c.md", "sha-183-c"),
            StagingStatus::StagingPr(183)
        );
    }

    #[test]
    fn classify_lowest_pr_when_multiple() {
        // `shared.md` with `sha-shared` exists in both 182 and 183 (inserted
        // 183-first) — the lower number must win deterministically.
        assert_eq!(
            idx().classify("shared.md", "sha-shared"),
            StagingStatus::StagingPr(182)
        );
    }

    #[test]
    fn classify_unaccounted() {
        assert_eq!(
            idx().classify("a.md", "different-sha"),
            StagingStatus::Unaccounted
        );
        assert_eq!(
            idx().classify("missing.md", "whatever"),
            StagingStatus::Unaccounted
        );
    }

    #[test]
    fn email_gate_allows_indigo() {
        assert!(is_eligible_email(Some("corey@getindigo.ai")));
        assert!(is_eligible_email(Some("Corey@GetIndigo.ai")));
    }

    #[test]
    fn email_gate_blocks_lookalike_and_empty() {
        assert!(!is_eligible_email(Some("attacker@forgetindigo.ai")));
        assert!(!is_eligible_email(Some("someone@example.com")));
        assert!(!is_eligible_email(Some("")));
        assert!(!is_eligible_email(None));
    }

    #[test]
    fn staging_status_wire_round_trip() {
        for s in [
            StagingStatus::StagingMain,
            StagingStatus::StagingPr(182),
            StagingStatus::Unaccounted,
        ] {
            let wire = s.to_wire();
            assert_eq!(StagingStatus::from_wire(&wire).unwrap(), s);
        }
        assert_eq!(StagingStatus::StagingMain.to_wire(), "staging-main");
        assert_eq!(StagingStatus::StagingPr(182).to_wire(), "pr:182");
        assert_eq!(StagingStatus::Unaccounted.to_wire(), "unaccounted");
        assert!(StagingStatus::from_wire("garbage").is_err());
        assert!(StagingStatus::from_wire("pr:notanum").is_err());
    }

    #[test]
    fn serde_round_trip_through_json() {
        let s = StagingStatus::StagingPr(182);
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, "\"pr:182\"");
        let back: StagingStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }
}
