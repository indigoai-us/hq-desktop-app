//! Core Drift with the core-skills pack (skills-cli-pack US-008).
//!
//! When the local `core/core.yaml` carries `coreResidentSkills`, only those
//! `.claude/skills/<name>` entries are hq-core release content. Pack links,
//! fork links and real non-resident folders must not count as drift; edits to a
//! resident skill still must.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use hq_desktop_core::drift_scope::{
    drift_blob_sha, excluded_scope_paths_for, is_non_resident_skill_rel, non_resident_skill_scopes,
    parse_core_resident_skills, path_in_excluded_scope, path_in_locked_scope,
    walk_local_under_scope,
};

const CORE_YAML_WITH_LIST: &str = "version: 1\nhqVersion: \"17.0.0\"\nrules:\n  locked:\n    - .claude/\n    - core/\ncoreResidentSkills: [hq-checkup, setup]\n";
const CORE_YAML_WITHOUT_LIST: &str =
    "version: 1\nhqVersion: \"16.0.36\"\nrules:\n  locked:\n    - .claude/\n    - core/\n";

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[cfg(unix)]
fn link_dir(target: &str, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// Windows pack and fork landings are often junctions or copies. A real copy
/// is the case that would show up as drift, so the fixture uses one there.
#[cfg(windows)]
fn link_dir(target: &str, link: &Path) {
    let source = link.parent().unwrap().join(target);
    for entry in walkdir::WalkDir::new(&source) {
        let entry = entry.unwrap();
        let dest = link.join(entry.path().strip_prefix(&source).unwrap());
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest).unwrap();
        } else {
            fs::copy(entry.path(), &dest).unwrap();
        }
    }
}

/// Floor tree of a post-cutover release: resident skills only, as git blobs.
fn floor_blobs() -> BTreeMap<String, String> {
    let mut floor = BTreeMap::new();
    floor.insert(
        ".claude/skills/hq-checkup/SKILL.md".to_string(),
        drift_blob_sha(b"---\nname: hq-checkup\n---\ncheckup\n"),
    );
    floor.insert(
        ".claude/skills/setup/SKILL.md".to_string(),
        drift_blob_sha(b"---\nname: setup\n---\nsetup\n"),
    );
    floor.insert(
        ".claude/CLAUDE.md".to_string(),
        drift_blob_sha(b"charter\n"),
    );
    floor
}

/// Build an HQ root after migration: resident skills as real folders, pack
/// links, one fork link into personal/, one deferred real folder, the pack
/// payload, and a stale floor-era skill blob in the floor map.
fn fixture(root: &Path, core_yaml: &str) {
    write(root, "core/core.yaml", core_yaml.as_bytes());
    write(root, ".claude/CLAUDE.md", b"charter\n");
    write(
        root,
        ".claude/skills/hq-checkup/SKILL.md",
        b"---\nname: hq-checkup\n---\ncheckup\n",
    );
    write(
        root,
        ".claude/skills/setup/SKILL.md",
        b"---\nname: setup\n---\nsetup\n",
    );
    write(
        root,
        "core/packages/hq-pack-core-skills/package.yaml",
        b"name: hq-pack-core-skills\nsurface: unprefixed\ncontributes:\n  skills: [prd, handoff, _shared]\n",
    );
    write(
        root,
        "core/packages/hq-pack-core-skills/skills/prd/SKILL.md",
        b"---\nname: prd\n---\npack prd\n",
    );
    write(
        root,
        "core/packages/hq-pack-core-skills/skills/handoff/SKILL.md",
        b"---\nname: handoff\n---\npack handoff\n",
    );
    write(
        root,
        "core/packages/hq-pack-core-skills/skills/_shared/journal.sh",
        b"#!/bin/sh\n",
    );
    write(
        root,
        "personal/skills/review/SKILL.md",
        b"---\nname: review\nforked_from: hq-pack-core-skills@1.0.0\n---\nmy review\n",
    );
    let skills = root.join(".claude/skills");
    link_dir(
        "../../core/packages/hq-pack-core-skills/skills/handoff",
        &skills.join("handoff"),
    );
    link_dir(
        "../../core/packages/hq-pack-core-skills/skills/_shared",
        &skills.join("_shared"),
    );
    link_dir("../../personal/skills/review", &skills.join("review"));
    // A non-resident real folder: an unmigrated core skill the migration
    // deferred, or a user's own skill. Not release content either way.
    write(
        root,
        ".claude/skills/my-tool/SKILL.md",
        b"---\nname: my-tool\n---\nmine\n",
    );
}

/// Files the Core Drift scan would report against `floor`, filtered the same
/// way `hq_core_state` filters local, target and floor maps.
fn drifted_paths(root: &Path, floor: BTreeMap<String, String>) -> BTreeSet<String> {
    let locked = vec![".claude/".to_string(), "core/".to_string()];
    let excluded = excluded_scope_paths_for(root);
    let local: BTreeMap<String, String> = walk_local_under_scope(root, &locked)
        .into_iter()
        .filter(|(p, _)| !path_in_excluded_scope(p, &excluded))
        .map(|(p, (sha, _))| (p, sha))
        .collect();
    let floor: BTreeMap<String, String> = floor
        .into_iter()
        .filter(|(p, _)| path_in_locked_scope(p, &locked))
        .filter(|(p, _)| !path_in_excluded_scope(p, &excluded))
        .collect();
    let mut drift = BTreeSet::new();
    for (path, sha) in &floor {
        if local.get(path) != Some(sha) {
            drift.insert(path.clone());
        }
    }
    for path in local.keys() {
        if !floor.contains_key(path) {
            drift.insert(path.clone());
        }
    }
    drift
}

#[test]
fn pack_links_fork_and_non_resident_folders_report_zero_skill_drift() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fixture(root, CORE_YAML_WITH_LIST);
    // A pack link created after the `prd` payload landed.
    link_dir(
        "../../core/packages/hq-pack-core-skills/skills/prd",
        &root.join(".claude/skills/prd"),
    );

    let mut floor = floor_blobs();
    // A floor-era blob for a skill the pack now owns must not read as
    // "deleted locally" either.
    floor.insert(
        ".claude/skills/prd/SKILL.md".to_string(),
        drift_blob_sha(b"---\nname: prd\n---\nold core prd\n"),
    );

    let drift = drifted_paths(root, floor);
    let skill_drift: Vec<_> = drift
        .iter()
        .filter(|p| p.starts_with(".claude/skills/"))
        .collect();
    assert!(
        skill_drift.is_empty(),
        "pack links, forks and non-resident folders must not drift: {skill_drift:?}"
    );
}

#[test]
fn resident_skill_edits_still_count_as_drift() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fixture(root, CORE_YAML_WITH_LIST);
    write(
        root,
        ".claude/skills/setup/SKILL.md",
        b"---\nname: setup\n---\nlocally edited setup\n",
    );
    write(root, ".claude/skills/hq-checkup/extra.md", b"added file\n");

    let drift = drifted_paths(root, floor_blobs());
    assert!(drift.contains(".claude/skills/setup/SKILL.md"));
    assert!(drift.contains(".claude/skills/hq-checkup/extra.md"));
    assert!(!drift
        .iter()
        .any(|p| p.starts_with(".claude/skills/my-tool")));
}

#[test]
fn without_the_list_non_resident_folders_stay_in_drift_scope() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fixture(root, CORE_YAML_WITHOUT_LIST);

    assert!(non_resident_skill_scopes(root).is_empty());
    let drift = drifted_paths(root, floor_blobs());
    assert!(
        drift.contains(".claude/skills/my-tool/SKILL.md"),
        "pre-cutover releases keep today's behavior: {drift:?}"
    );
}

#[test]
fn non_resident_scopes_cover_links_real_folders_and_files() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fixture(root, CORE_YAML_WITH_LIST);
    write(
        root,
        ".claude/skills/.hq-company-skill-wrappers",
        b"marker\n",
    );

    let scopes = non_resident_skill_scopes(root);
    assert_eq!(
        scopes,
        vec![
            ".claude/skills/.hq-company-skill-wrappers",
            ".claude/skills/_shared",
            ".claude/skills/handoff",
            ".claude/skills/my-tool",
            ".claude/skills/review",
        ]
    );
    let excluded = excluded_scope_paths_for(root);
    assert!(path_in_excluded_scope(
        ".claude/skills/review/SKILL.md",
        &excluded
    ));
    assert!(!path_in_excluded_scope(
        ".claude/skills/setup/SKILL.md",
        &excluded
    ));
    // `setup` is resident; `setup-extra` shares its prefix but is a different skill.
    assert!(!path_in_excluded_scope(
        ".claude/skills/setup-extra/SKILL.md",
        &excluded
    ));
}

#[test]
fn resident_list_parsing_matches_hq_cloud() {
    let flow = parse_core_resident_skills("coreResidentSkills: [a, b-c, '../x', 7]\n").unwrap();
    assert_eq!(flow, BTreeSet::from(["a".to_string(), "b-c".to_string()]));
    let block =
        parse_core_resident_skills("rules: {}\ncoreResidentSkills:\n  - setup\n  - hq.x_1\n")
            .unwrap();
    assert_eq!(
        block,
        BTreeSet::from(["setup".to_string(), "hq.x_1".to_string()])
    );
    // An empty list is active: every skill is pack-owned.
    assert_eq!(
        parse_core_resident_skills("coreResidentSkills: []\n"),
        Some(BTreeSet::new())
    );
    assert_eq!(parse_core_resident_skills("version: 1\n"), None);
    assert_eq!(
        parse_core_resident_skills("coreResidentSkills: setup\n"),
        None
    );
    assert_eq!(parse_core_resident_skills(": : not yaml ["), None);

    let resident = BTreeSet::from(["setup".to_string()]);
    assert!(is_non_resident_skill_rel(".claude/skills/prd", &resident));
    assert!(is_non_resident_skill_rel(
        ".claude/skills/prd/SKILL.md",
        &resident
    ));
    assert!(!is_non_resident_skill_rel(
        ".claude/skills/setup/SKILL.md",
        &resident
    ));
    assert!(!is_non_resident_skill_rel(".claude/skills", &resident));
    assert!(!is_non_resident_skill_rel(".claude/CLAUDE.md", &resident));
}
