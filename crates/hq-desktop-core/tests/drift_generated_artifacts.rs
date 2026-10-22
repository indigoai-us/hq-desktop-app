use std::fs;

use hq_desktop_core::drift_scope::{
    drift_blob_sha, drift_blob_sha_for_path, excluded_scope_paths_for, normalized_or_raw_drift_sha,
    path_in_excluded_scope, settings_drift_matches, walk_local_under_scope,
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
        drift_blob_sha(generated.as_bytes()),
        "the local walker retains the real Git blob hash"
    );
    assert_eq!(
        drift_blob_sha_for_path(".claude/settings.json", generated.as_bytes()),
        drift_blob_sha(&stripped_upstream),
        "the semantic settings hash ignores the HQ-generated env.PATH"
    );
    assert!(settings_drift_matches(
        &local[".claude/settings.json"].0,
        Some(&drift_blob_sha_for_path(
            ".claude/settings.json",
            generated.as_bytes()
        )),
        &drift_blob_sha_for_path(".claude/settings.json", upstream.as_bytes()),
    ));

    let edited =
        r#"{"permissions":{"allow":["Read","Write"]},"env":{"PATH":"/managed/bin:/usr/bin"}}"#;
    fs::write(&settings, edited).unwrap();
    let local = walk_local_under_scope(root, &locked);
    assert_ne!(
        drift_blob_sha_for_path(".claude/settings.json", edited.as_bytes()),
        drift_blob_sha(&stripped_upstream),
        "a user edit outside env.PATH must remain visible as drift"
    );
    assert!(!settings_drift_matches(
        &local[".claude/settings.json"].0,
        Some(&drift_blob_sha_for_path(
            ".claude/settings.json",
            edited.as_bytes()
        )),
        &drift_blob_sha_for_path(".claude/settings.json", upstream.as_bytes()),
    ));
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

#[test]
fn failed_settings_normalization_keeps_raw_sha_and_returns_the_error_for_logging() {
    let raw_sha = "raw-tree-sha";
    let (chosen_sha, error) = normalized_or_raw_drift_sha(raw_sha, Err("HTTP 403".to_string()));
    assert_eq!(chosen_sha, raw_sha);
    assert_eq!(error.as_deref(), Some("HTTP 403"));

    let (chosen_sha, error) =
        normalized_or_raw_drift_sha(raw_sha, Ok("normalized-sha".to_string()));
    assert_eq!(chosen_sha, "normalized-sha");
    assert_eq!(error, None);
}

#[test]
fn settings_normalization_canonicalizes_json_formatting() {
    let compact = br#"{"permissions":{"allow":["Read"]}}"#;
    let reordered_and_pretty = br#"{
      "env": { "PATH": "/generated/bin" },
      "permissions": { "allow": [ "Read" ] }
    }"#;
    assert_eq!(
        drift_blob_sha_for_path(".claude/settings.json", compact),
        drift_blob_sha_for_path(".claude/settings.json", reordered_and_pretty)
    );
}

/// The Core state check stores the env.PATH-stripped hash in place of the
/// baseline and target settings SHAs before it classifies files. A copy
/// restored byte-for-byte from upstream must count as unchanged against that
/// stored hash, not as drift.
#[test]
fn restored_settings_match_the_normalized_baseline_sha() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let path = ".claude/settings.json";
    let settings = root.join(path);
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let locked = vec![path.to_string()];

    let upstream = "{\n  \"permissions\": {\n    \"allow\": [\"Read\"]\n  },\n  \"hooks\": {}\n}\n";
    let upstream_raw_sha = drift_blob_sha(upstream.as_bytes());
    let (normalized_baseline_sha, error) = normalized_or_raw_drift_sha(
        &upstream_raw_sha,
        Ok(drift_blob_sha_for_path(path, upstream.as_bytes())),
    );
    assert!(error.is_none());

    let matches = |bytes: &[u8]| {
        fs::write(&settings, bytes).unwrap();
        let local = walk_local_under_scope(root, &locked);
        let local_settings_sha = drift_blob_sha_for_path(path, bytes);
        (
            settings_drift_matches(
                &local[path].0,
                Some(&local_settings_sha),
                &normalized_baseline_sha,
            ),
            settings_drift_matches(&local[path].0, Some(&local_settings_sha), &upstream_raw_sha),
        )
    };

    // Restored from upstream: unchanged against the normalized SHA, and
    // against the raw SHA kept when normalization could not run.
    assert_eq!(matches(upstream.as_bytes()), (true, true));

    // Only a generated env.PATH added: unchanged against the normalized SHA.
    let with_path = "{\n  \"permissions\": {\n    \"allow\": [\"Read\"]\n  },\n  \"hooks\": {},\n  \"env\": {\n    \"PATH\": \"/managed/bin:/usr/bin\"\n  }\n}\n";
    assert!(matches(with_path.as_bytes()).0);

    // Any other edit is still drift.
    let edited =
        "{\n  \"permissions\": {\n    \"allow\": [\"Read\", \"Write\"]\n  },\n  \"hooks\": {}\n}\n";
    assert_eq!(matches(edited.as_bytes()), (false, false));
}
