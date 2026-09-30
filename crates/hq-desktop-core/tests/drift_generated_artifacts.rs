use std::fs;

use hq_desktop_core::drift_scope::{
    drift_blob_sha, excluded_scope_paths_for, path_in_excluded_scope, walk_local_under_scope,
};

fn without_generated_path(settings: &str) -> Vec<u8> {
    let mut value: serde_json::Value = serde_json::from_str(settings).unwrap();
    let object = value.as_object_mut().unwrap();
    if let Some(env) = object
        .get_mut("env")
        .and_then(serde_json::Value::as_object_mut)
    {
        env.remove("PATH");
        if env.is_empty() {
            object.remove("env");
        }
    }
    serde_json::to_vec(&value).unwrap()
}

#[test]
fn generated_path_is_ignored_but_other_settings_edits_remain_visible() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let settings = root.join(".claude/settings.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();

    let upstream = r#"{"permissions":{"allow":["Read"]}}"#;
    let generated = r#"{"permissions":{"allow":["Read"]},"env":{"PATH":"/managed/bin:/usr/bin"}}"#;
    fs::write(&settings, generated).unwrap();

    let locked = vec![".claude/settings.json".to_string()];
    let local = walk_local_under_scope(root, &locked);
    let stripped_upstream = without_generated_path(upstream);
    assert_eq!(
        local.get(".claude/settings.json").unwrap().0,
        drift_blob_sha(&stripped_upstream),
        "an HQ-generated env.PATH must not appear as user drift"
    );

    let edited =
        r#"{"permissions":{"allow":["Read","Write"]},"env":{"PATH":"/managed/bin:/usr/bin"}}"#;
    fs::write(&settings, edited).unwrap();
    let local = walk_local_under_scope(root, &locked);
    assert_ne!(
        local.get(".claude/settings.json").unwrap().0,
        drift_blob_sha(&stripped_upstream),
        "a user edit outside env.PATH must remain visible as drift"
    );
}

#[test]
fn company_skill_wrapper_marker_is_excluded_without_excluding_neighboring_skills() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let marker = ".claude/skills/company/.hq-company-skill-wrappers";
    fs::create_dir_all(root.join(".claude/skills/company")).unwrap();
    fs::write(root.join(marker), b"generated marker").unwrap();
    fs::write(
        root.join(".claude/skills/company/user-skill.md"),
        b"user content",
    )
    .unwrap();

    let excluded = excluded_scope_paths_for(root);
    assert!(path_in_excluded_scope(marker, &excluded));
    assert!(!path_in_excluded_scope(
        ".claude/skills/company/user-skill.md",
        &excluded
    ));
    let local = walk_local_under_scope(root, &[".claude/skills/".to_string()]);
    assert!(!local.contains_key(marker));
    assert!(local.contains_key(".claude/skills/company/user-skill.md"));
}
