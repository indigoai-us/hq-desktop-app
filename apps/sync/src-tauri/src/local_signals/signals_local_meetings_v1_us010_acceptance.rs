//! signals-local-meetings-v1 US-010 acceptance tests (Rust half). One module
//! per acceptance criterion. The UI half is in
//! `apps/sync/src/lib/localMeetingSignals.test.ts`.
use super::eligibility;
use super::results::{citation_excerpt, open_citation, results_for, time_label, UploadBadge};
use super::store::*;
use super::upload;
use super::us009_acceptance::{block_on, eligible_hq, seed, BOT, CO, ME};
use crate::commands::local_signal_runs::{Provider, ProviderChoice};
use crate::commands::meeting_signals::{context_for, generate_in, latest_run};
use serde_json::json;
use std::path::Path;

fn obs(
    t: SignalType,
    content: &str,
    start: u64,
    end: u64,
    entities: Vec<EntityRef>,
) -> ParsedObservation {
    ParsedObservation {
        signal_type: t,
        content: content.into(),
        citations: vec![Citation {
            source_ref: "sources/meetings/bot-abc.md".into(),
            start_ms: start,
            end_ms: end,
        }],
        entities,
        owner: (t == SignalType::ActionItem).then(|| "Ben".into()),
        reasoning: (t == SignalType::Decision).then(|| "Legal cleared it.".into()),
        speaker: (t == SignalType::ParticipantContribution).then(|| "Ava".into()),
    }
}

fn all_eight() -> Vec<ParsedObservation> {
    let atlas = EntityRef {
        entity_id: Some("ent-project-atlas".into()),
        name: "Atlas".into(),
        status: EntityStatus::Resolved,
    };
    let globex = EntityRef {
        entity_id: None,
        name: "Globex".into(),
        status: EntityStatus::Provisional,
    };
    SignalType::ALL
        .iter()
        .enumerate()
        .map(|(i, t)| {
            obs(
                *t,
                &format!("Observation {i} for {}.", t.as_str()),
                0,
                90_000,
                if i == 0 {
                    vec![atlas.clone(), globex.clone()]
                } else {
                    vec![]
                },
            )
        })
        .collect()
}

/// Commit `parsed` as the run for the current transcript; returns the context.
fn commit_run(
    hq: &Path,
    runs: &Path,
    parsed: Vec<ParsedObservation>,
    prompt: Option<&str>,
) -> RunContext {
    generate_in(hq, runs, CO, ME, BOT, ProviderChoice::Any).unwrap();
    let e = eligibility::evaluate(hq, CO, ME, BOT);
    let run = latest_run(runs, CO, ME, &e).unwrap().unwrap();
    let mut ctx = context_for(&run, &e, Provider::Codex, "device-a");
    ctx.projection_state = "stale".into();
    ctx.projection_watermark = "wm-7".into();
    ctx.extractor_model = "gpt-5-codex".into();
    if let Some(p) = prompt {
        ctx.prompt_version = p.into();
        ctx.job_id = format!("{}-old", ctx.job_id);
    }
    let t = LocalTranscript {
        source_ref: ctx.source_ref.clone(),
        source_digest: ctx.source_digest.clone(),
        duration_ms: e.duration_ms,
    };
    assert!(matches!(
        commit(
            hq,
            ctx.clone(),
            ParsedResult {
                observations: parsed
            },
            &t
        )
        .unwrap(),
        CommitOutcome::Complete { .. }
    ));
    ctx
}

fn current(hq: &Path) -> super::results::ResultVersion {
    let e = eligibility::evaluate(hq, CO, ME, BOT);
    results_for(hq, CO, BOT, &e)
        .unwrap()
        .current
        .expect("current version")
}

mod ac0_grouped_by_all_eight_types {
    use super::*;

    #[test]
    fn current_observations_are_grouped_by_type_in_canonical_order() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        commit_run(hq.path(), runs.path(), all_eight(), None);
        let v = current(hq.path());
        assert_eq!(
            v.groups.iter().map(|g| g.signal_type).collect::<Vec<_>>(),
            SignalType::ALL.to_vec()
        );
        for g in &v.groups {
            assert_eq!(g.items.len(), 1, "{:?}", g.signal_type);
            assert_eq!(g.items[0].signal_type, g.signal_type);
        }
        assert_eq!(v.missing, 0);
        assert!(v.current_transcript);
    }

    #[test]
    fn empty_types_still_appear_and_no_run_means_no_current_version() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        let e = eligibility::evaluate(hq.path(), CO, ME, BOT);
        assert!(results_for(hq.path(), CO, BOT, &e)
            .unwrap()
            .current
            .is_none());
        commit_run(
            hq.path(),
            runs.path(),
            vec![obs(SignalType::Risk, "One risk.", 0, 1000, vec![])],
            None,
        );
        let v = current(hq.path());
        assert_eq!(v.groups.len(), 8);
        assert_eq!(v.groups.iter().filter(|g| !g.items.is_empty()).count(), 1);
    }
}

mod ac1_item_fields {
    use super::*;

    #[test]
    fn items_carry_content_citations_entities_provider_projection_and_upload() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        commit_run(hq.path(), runs.path(), all_eight(), None);
        let v = current(hq.path());
        let first = &v.groups[0].items[0];
        assert_eq!(first.content, "Observation 0 for summary.");
        assert_eq!(first.citations[0].label, "0:00");
        assert!(first.citations[0].valid);
        assert_eq!(first.entities.len(), 2);
        assert_eq!(
            (
                first.entities[0].name.as_str(),
                first.entities[0].entity_id.as_deref(),
                first.entities[0].provisional
            ),
            ("Atlas", Some("ent-project-atlas"), false)
        );
        assert_eq!(
            (
                first.entities[1].name.as_str(),
                first.entities[1].entity_id.as_deref(),
                first.entities[1].provisional
            ),
            ("Globex", None, true)
        );
        assert_eq!(
            (
                first.provider.as_str(),
                first.model.as_str(),
                first.projection_state.as_str()
            ),
            ("codex", "gpt-5-codex", "stale")
        );
        assert_eq!(first.upload, UploadBadge::Pending);
        let decision = &v
            .groups
            .iter()
            .find(|g| g.signal_type == SignalType::Decision)
            .unwrap()
            .items[0];
        assert_eq!(decision.reasoning.as_deref(), Some("Legal cleared it."));
        let action = &v
            .groups
            .iter()
            .find(|g| g.signal_type == SignalType::ActionItem)
            .unwrap()
            .items[0];
        assert_eq!(action.owner.as_deref(), Some("Ben"));
    }

    #[test]
    fn content_is_bounded() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        commit_run(
            hq.path(),
            runs.path(),
            vec![obs(
                SignalType::Summary,
                &"word ".repeat(380),
                0,
                1000,
                vec![],
            )],
            None,
        );
        let item = &current(hq.path()).groups[0].items[0];
        assert!(item.content.chars().count() <= super::super::results::MAX_RESULT_CONTENT_CHARS);
        assert_eq!(time_label(3_725_000), "1:02:05");
    }
}

mod ac2_citations_resolve_locally {
    use super::*;

    #[test]
    fn a_valid_citation_returns_the_matching_transcript_lines() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        commit_run(
            hq.path(),
            runs.path(),
            vec![obs(
                SignalType::ActionItem,
                "Draft the checklist.",
                90_000,
                95_000,
                vec![],
            )],
            None,
        );
        let e = eligibility::evaluate(hq.path(), CO, ME, BOT);
        let id = current(hq.path())
            .groups
            .iter()
            .flat_map(|g| g.items.clone())
            .next()
            .unwrap()
            .observation_id;
        let lines = open_citation(hq.path(), CO, BOT, &e, &id, 0).unwrap();
        assert_eq!(lines, vec!["**Ben** [01:30]: I will draft the checklist."]);
    }

    #[test]
    fn tampered_out_of_range_and_unknown_citations_are_rejected() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        let ctx = commit_run(
            hq.path(),
            runs.path(),
            vec![obs(SignalType::Summary, "Summary.", 0, 1000, vec![])],
            None,
        );
        let e = eligibility::evaluate(hq.path(), CO, ME, BOT);
        let item = current(hq.path()).groups[0].items[0].clone();
        // Tamper the stored observation: point the citation at another file and past the end.
        let path = observation_path(
            &company_root(hq.path(), CO).unwrap(),
            &ctx.audience_key,
            SignalType::Summary,
            &item.observation_id,
        )
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(
            &path,
            text.replace(
                "sourceRef: sources/meetings/bot-abc.md",
                "sourceRef: ../../../etc/passwd",
            )
            .replace("endMs: 1000", "endMs: 99999999"),
        )
        .unwrap();
        let tampered = current(hq.path()).groups[0].items[0].clone();
        assert!(!tampered.citations[0].valid);
        assert_eq!(
            open_citation(hq.path(), CO, BOT, &e, &item.observation_id, 0),
            Err("citation_invalid".into())
        );
        assert_eq!(
            open_citation(hq.path(), CO, BOT, &e, &item.observation_id, 7),
            Err("citation_invalid".into())
        );
        assert_eq!(
            open_citation(hq.path(), CO, BOT, &e, "../../secret", 0),
            Err("citation_invalid".into())
        );
        assert_eq!(
            open_citation(hq.path(), CO, BOT, &e, &"f".repeat(64), 0),
            Err("citation_invalid".into())
        );
    }

    #[test]
    fn excerpts_are_bounded_and_take_no_path_from_the_caller() {
        let body: String = (0..40)
            .map(|i| format!("**S** [00:{i:02}]: line {i} {}\n", "x".repeat(400)))
            .collect();
        let lines = citation_excerpt(&body, 3_000, 30_000);
        assert!(lines.len() <= super::super::results::MAX_EXCERPT_LINES);
        assert!(lines
            .iter()
            .all(|l| l.chars().count() <= super::super::results::MAX_EXCERPT_LINE_CHARS));
        let src = include_str!("../commands/meeting_signals.rs");
        let cmd = &src[src.find("pub async fn meeting_signals_citation").unwrap()..];
        let sig = &cmd[..cmd.find(") ->").unwrap()];
        assert!(!sig.contains("path") && !sig.contains("url"), "{sig}");
    }
}

mod ac3_superseded_stay_in_history {
    use super::*;

    #[test]
    fn only_the_active_receipt_is_current_and_prior_versions_are_history() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        // An older prompt version produced a result first.
        commit_run(
            hq.path(),
            runs.path(),
            vec![obs(SignalType::Risk, "Old risk wording.", 0, 1000, vec![])],
            Some("local-signals-prompt/v0"),
        );
        // The shipped prompt then produced the current result, superseding it.
        commit_run(
            hq.path(),
            runs.path(),
            vec![obs(
                SignalType::Risk,
                "Current risk wording.",
                0,
                1000,
                vec![],
            )],
            None,
        );
        let e = eligibility::evaluate(hq.path(), CO, ME, BOT);
        let r = results_for(hq.path(), CO, BOT, &e).unwrap();
        let cur: Vec<String> = r
            .current
            .unwrap()
            .groups
            .iter()
            .flat_map(|g| g.items.iter().map(|i| i.content.clone()))
            .collect();
        assert_eq!(cur, vec!["Current risk wording."]);
        assert_eq!(r.history.len(), 1);
        let old: Vec<String> = r.history[0]
            .groups
            .iter()
            .flat_map(|g| g.items.iter().map(|i| i.content.clone()))
            .collect();
        assert_eq!(old, vec!["Old risk wording."]);
        assert_eq!(
            r.history[0].status,
            super::super::receipt::ReceiptStatus::Superseded
        );
    }

    #[test]
    fn a_changed_transcript_moves_the_old_result_to_history_with_unopenable_citations() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        // A run made against an earlier transcript digest of this meeting.
        generate_in(hq.path(), runs.path(), CO, ME, BOT, ProviderChoice::Any).unwrap();
        let e = eligibility::evaluate(hq.path(), CO, ME, BOT);
        let run = latest_run(runs.path(), CO, ME, &e).unwrap().unwrap();
        let mut old = context_for(&run, &e, Provider::Claude, "device-a");
        old.source_digest = format!("sha256:{}", "0e".repeat(32));
        old.job_id = "11111111-2222-3333-4444-555555555555".into();
        let t = LocalTranscript {
            source_ref: old.source_ref.clone(),
            source_digest: old.source_digest.clone(),
            duration_ms: e.duration_ms,
        };
        commit(
            hq.path(),
            old,
            ParsedResult {
                observations: vec![obs(
                    SignalType::Summary,
                    "Before the edit.",
                    0,
                    1000,
                    vec![],
                )],
            },
            &t,
        )
        .unwrap();
        let r = results_for(hq.path(), CO, BOT, &e).unwrap();
        assert!(
            r.current.is_none(),
            "an older transcript's result is never current"
        );
        assert_eq!(r.history.len(), 1);
        assert!(!r.history[0].current_transcript);
        let item = &r.history[0].groups[0].items[0];
        assert_eq!(item.content, "Before the edit.");
        assert!(
            item.citations.iter().all(|c| !c.valid),
            "history citations do not resolve against the new transcript"
        );
        // seed() is kept for the eligibility helpers; silence unused import.
        let _ = seed;
    }
}

mod ac4_upload_states_are_plain {
    use super::*;

    #[test]
    fn each_upload_state_maps_to_a_plain_badge_without_raw_detail() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        let ctx = commit_run(
            hq.path(),
            runs.path(),
            vec![
                obs(SignalType::Summary, "Shared.", 0, 1000, vec![]),
                obs(SignalType::Risk, "Refused.", 0, 1000, vec![]),
                obs(SignalType::Question, "Retry later.", 0, 1000, vec![]),
                obs(
                    SignalType::KeyPoint,
                    "See /Users/alice/private/plan.md now.",
                    0,
                    1000,
                    vec![],
                ),
            ],
            None,
        );
        let root = company_root(hq.path(), CO).unwrap();
        let rec = super::super::receipt::read(
            &super::super::receipt::receipt_path(
                &root,
                BOT,
                &ctx.source_digest,
                &ctx.prompt_version,
                &ctx.schema_version,
            )
            .unwrap(),
        )
        .unwrap()
        .unwrap();
        let answer = |body: &serde_json::Value| -> Result<(u16, serde_json::Value), String> {
            match body["contribution"]["content"].as_str().unwrap() {
                "Shared." => Ok((200, json!({"status":"created"}))),
                "Refused." => Ok((
                    422,
                    json!({"code":"CONTRIBUTION_REJECTED","reasons":["source_ineligible"],"detail":["raw server detail"]}),
                )),
                _ => Err("error sending request: connection reset (os error 54)".into()),
            }
        };
        block_on(upload::upload_pending(&root, &rec, |b| {
            let r = answer(&b);
            async move { r }
        }))
        .unwrap();
        let v = current(hq.path());
        let badge = |content: &str| {
            v.groups
                .iter()
                .flat_map(|g| g.items.iter())
                .find(|i| i.content == content)
                .unwrap()
                .upload
        };
        assert_eq!(badge("Shared."), UploadBadge::Uploaded);
        assert_eq!(badge("Refused."), UploadBadge::Ineligible);
        assert_eq!(badge("Retry later."), UploadBadge::Retry);
        assert_eq!(
            badge("See /Users/alice/private/plan.md now."),
            UploadBadge::Private
        );
        let json = serde_json::to_string(&v).unwrap();
        for raw in [
            "raw server detail",
            "source_ineligible",
            "os error",
            "connection reset",
            "sanitized_content_changed",
        ] {
            assert!(!json.contains(raw), "{raw}");
        }
    }
}

mod ac5_stays_inside_meetings {
    #[test]
    fn the_reader_is_two_meetings_commands_and_no_new_window_or_route() {
        let src = include_str!("../commands/meeting_signals.rs");
        for needle in [
            "WebviewWindowBuilder",
            "open_destination",
            "desktop_alt",
            "company_view",
            "team_view",
            "canonical",
        ] {
            assert!(!src.contains(needle), "{needle}");
        }
        let results = include_str!("results.rs");
        for needle in [
            "WebviewWindowBuilder",
            "Command::new",
            "write_atomic",
            "reqwest",
        ] {
            assert!(!results.contains(needle), "{needle}");
        }
    }
}
