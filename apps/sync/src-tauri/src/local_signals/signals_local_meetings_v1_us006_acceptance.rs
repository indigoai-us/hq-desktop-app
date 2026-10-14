//! signals-local-meetings-v1 US-006 acceptance tests — one module per
//! acceptance criterion (ac0..ac6).
use super::receipt::{self, ReceiptStatus};
use super::store::*;
use std::path::{Path, PathBuf};

const COMPANY: &str = "cmp_fixture";
const SOURCE_ID: &str = "bot-abc";

fn ctx() -> RunContext {
    RunContext {
        job_id: "0b6f6a52-6f1c-4c55-9d43-5f9d1b2c3a4e".into(),
        company_uid: COMPANY.into(),
        member_uid: "prs_alice".into(),
        device_id: "device-a".into(),
        source_id: SOURCE_ID.into(),
        source_ref: "sources/meetings/bot-abc.md".into(),
        source_digest: "d1".repeat(32),
        audience_key: "aud-123".into(),
        audience_version: 1,
        audience_receipt_ref: "sources/meetings/bot-abc.audience.json".into(),
        extractor_provider: "claude".into(),
        extractor_model: "claude-opus".into(),
        prompt_version: "local-signals-prompt/v1".into(),
        schema_version: "local-signal/v1".into(),
        projection_watermark: "2026-10-13T00:00:00.000Z".into(),
        projection_state: "ready".into(),
        ontology_version: "ontology/v1".into(),
        classification: "company-eligible".into(),
        extracted_at: "2026-10-13T12:00:00.000Z".into(),
    }
}

fn cite(start: u64, end: u64) -> Citation {
    Citation {
        source_ref: "sources/meetings/bot-abc.md".into(),
        start_ms: start,
        end_ms: end,
    }
}

fn parsed() -> ParsedResult {
    let contents = [
        "Weekly product sync covered the Atlas beta and Northwind.",
        "Atlas beta is on track.",
        "Ship the Atlas beta on November 3.",
        "Ben drafts the Atlas launch checklist by Friday.",
        "Ava led the launch discussion.",
        "Northwind renewal could slip a quarter.",
        "Ben committed to the checklist deadline.",
        "Who owns the billing migration?",
    ];
    ParsedResult {
        observations: SignalType::ALL
            .iter()
            .zip(contents)
            .enumerate()
            .map(|(i, (t, c))| ParsedObservation {
                signal_type: *t,
                content: c.into(),
                citations: vec![cite(i as u64 * 10_000, i as u64 * 10_000 + 5_000)],
                entities: vec![
                    EntityRef {
                        entity_id: Some("ent-project-atlas".into()),
                        name: "Atlas".into(),
                        status: EntityStatus::Resolved,
                    },
                    EntityRef {
                        entity_id: None,
                        name: "Northwind".into(),
                        status: EntityStatus::Provisional,
                    },
                ],
                owner: None,
                reasoning: None,
                speaker: None,
            })
            .collect(),
    }
}

fn transcript() -> LocalTranscript {
    LocalTranscript {
        source_ref: "sources/meetings/bot-abc.md".into(),
        source_digest: "d1".repeat(32),
        duration_ms: 180_000,
    }
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(files_under(&p));
            } else {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn observation_files(hq: &Path) -> Vec<PathBuf> {
    files_under(&hq.join("personal/signals").join(COMPANY).join("meetings"))
        .into_iter()
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .collect()
}

fn complete_ids(o: CommitOutcome) -> Vec<String> {
    match o {
        CommitOutcome::Complete { output_ids, .. } => output_ids,
        other => panic!("expected complete, got {other:?}"),
    }
}

fn receipt_at(hq: &Path, c: &RunContext) -> receipt::Receipt {
    let root = company_root(hq, COMPANY).unwrap();
    let p = receipt::receipt_path(
        &root,
        &c.source_id,
        &c.source_digest,
        &c.prompt_version,
        &c.schema_version,
    )
    .unwrap();
    receipt::read(&p).unwrap().unwrap()
}

mod ac0_personal_path_only {
    use super::*;

    #[test]
    fn every_observation_lands_under_the_personal_meeting_path_and_none_under_signals() {
        let d = tempfile::tempdir().unwrap();
        let ids = complete_ids(commit(d.path(), ctx(), parsed(), &transcript()).unwrap());
        let files = observation_files(d.path());
        assert_eq!(files.len(), 8);
        let base = d
            .path()
            .join("personal/signals")
            .join(COMPANY)
            .join("meetings")
            .join("@aud-123");
        for f in &files {
            let rel = f
                .strip_prefix(&base)
                .expect("observation outside @{audienceKey}");
            let parts: Vec<_> = rel
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect();
            assert_eq!(parts.len(), 2, "{rel:?}");
            assert!(SignalType::ALL.iter().any(|t| t.as_str() == parts[0]));
            assert!(ids.contains(&parts[1].trim_end_matches(".md").to_string()));
        }
        assert!(
            !d.path().join("signals").exists(),
            "wrote below the cloud signals/** tree"
        );
        assert!(files_under(d.path())
            .iter()
            .all(|p| p.starts_with(d.path().join("personal"))));
    }

    #[test]
    fn hostile_path_segments_are_refused() {
        let d = tempfile::tempdir().unwrap();
        for bad in ["../signals", "a/b", "..", ".hidden", ""] {
            let mut c = ctx();
            c.audience_key = bad.into();
            assert!(
                commit(d.path(), c, parsed(), &transcript()).is_err(),
                "{bad}"
            );
            let mut c = ctx();
            c.company_uid = bad.into();
            assert!(
                commit(d.path(), c, parsed(), &transcript()).is_err(),
                "{bad}"
            );
        }
        assert!(files_under(d.path()).is_empty());
    }
}

mod ac1_v1_fields {
    use super::*;

    #[test]
    fn every_required_v1_field_is_present_and_bounded() {
        let d = tempfile::tempdir().unwrap();
        commit(d.path(), ctx(), parsed(), &transcript()).unwrap();
        let c = ctx();
        for f in observation_files(d.path()) {
            let raw = std::fs::read_to_string(&f).unwrap();
            let fm = read_observation(&f).unwrap();
            for key in [
                "schema",
                "observation_id",
                "signal_type",
                "content",
                "citations",
                "entities",
                "source_id",
                "source_ref",
                "source_digest",
                "company_uid",
                "member_uid",
                "device_id",
                "audience_key",
                "audience_version",
                "audience_receipt_ref",
                "extractor_provider",
                "extractor_model",
                "prompt_version",
                "schema_version",
                "projection_watermark",
                "projection_state",
                "ontology_version",
                "classification",
                "job_id",
                "extracted_at",
            ] {
                assert!(raw.contains(&format!("\n{key}:")), "missing {key}");
            }
            assert_eq!(fm.schema, OBSERVATION_SCHEMA);
            assert_eq!(fm.company_uid, c.company_uid);
            assert_eq!(fm.member_uid, c.member_uid);
            assert_eq!(fm.device_id, c.device_id);
            assert_eq!(fm.audience_key, c.audience_key);
            assert_eq!(fm.audience_version, 1);
            assert_eq!(fm.audience_receipt_ref, c.audience_receipt_ref);
            assert_eq!(fm.source_digest, c.source_digest);
            assert_eq!(fm.classification, c.classification);
            assert_eq!(fm.projection_state, "ready");
            assert!(!fm.content.is_empty() && fm.content.chars().count() <= MAX_CONTENT_CHARS);
            assert!(!fm.citations.is_empty() && fm.citations.len() <= MAX_CITATIONS);
            assert!(fm.entities.len() <= MAX_ENTITIES);
            assert!(
                raw.trim_end().ends_with(&fm.content),
                "body repeats content"
            );
        }
    }

    #[test]
    fn unbounded_input_is_refused_before_any_write() {
        let d = tempfile::tempdir().unwrap();
        let mut p = parsed();
        p.observations[0].content = "x".repeat(MAX_CONTENT_CHARS + 1);
        assert!(commit(d.path(), ctx(), p, &transcript()).is_err());
        let mut p = parsed();
        p.observations[0].citations = vec![cite(0, 1); MAX_CITATIONS + 1];
        assert!(commit(d.path(), ctx(), p, &transcript()).is_err());
        let mut p = parsed();
        p.observations[0].citations.clear();
        assert!(commit(d.path(), ctx(), p, &transcript()).is_err());
        let mut c = ctx();
        c.device_id = "d".repeat(MAX_FIELD_CHARS + 1);
        assert!(commit(d.path(), c, parsed(), &transcript()).is_err());
        assert!(files_under(d.path()).is_empty());
    }
}

mod ac2_observation_id {
    use super::*;

    fn id(c: &RunContext, t: SignalType, content: &str) -> String {
        observation_id(
            &c.member_uid,
            &c.source_ref,
            &c.source_digest,
            t,
            &c.audience_key,
            content,
            &c.prompt_version,
            &c.schema_version,
        )
    }

    #[test]
    fn two_devices_produce_identical_ids_and_files_named_by_them() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let mut cb = ctx();
        cb.device_id = "device-b".into();
        cb.extracted_at = "2026-10-14T09:30:00.000Z".into();
        cb.job_id = "11111111-2222-3333-4444-555555555555".into();
        let ia = complete_ids(commit(a.path(), ctx(), parsed(), &transcript()).unwrap());
        let ib = complete_ids(commit(b.path(), cb, parsed(), &transcript()).unwrap());
        assert_eq!(ia, ib);
        let names = |p: &Path| {
            observation_files(p)
                .iter()
                .map(|f| f.file_name().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(a.path()), names(b.path()));
    }

    #[test]
    fn id_is_sha256_hex_and_normalizes_whitespace_and_case() {
        let c = ctx();
        let x = id(
            &c,
            SignalType::Decision,
            "Ship  the Atlas beta\n on November 3.",
        );
        assert_eq!(x.len(), 64);
        assert!(x.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_eq!(
            x,
            id(
                &c,
                SignalType::Decision,
                "  ship the atlas BETA on november 3."
            )
        );
    }

    #[test]
    fn every_bound_input_changes_the_id() {
        let base = ctx();
        let x = id(&base, SignalType::Decision, "c");
        let variants: Vec<Box<dyn Fn(&mut RunContext)>> = vec![
            Box::new(|c| c.member_uid = "prs_bob".into()),
            Box::new(|c| c.source_ref = "sources/meetings/other.md".into()),
            Box::new(|c| c.source_digest = "ee".repeat(32)),
            Box::new(|c| c.audience_key = "aud-999".into()),
            Box::new(|c| c.prompt_version = "local-signals-prompt/v2".into()),
            Box::new(|c| c.schema_version = "local-signal/v2".into()),
        ];
        for v in variants {
            let mut c = base.clone();
            v(&mut c);
            assert_ne!(id(&c, SignalType::Decision, "c"), x);
        }
        assert_ne!(id(&base, SignalType::Risk, "c"), x);
        assert_ne!(id(&base, SignalType::Decision, "d"), x);
    }
}

mod ac3_run_record_first {
    use super::*;

    #[test]
    fn parsed_result_is_durable_even_when_no_observation_is_written() {
        // A citation failure stops the run before the first observation write,
        // which is the same storage state a crash at that point leaves.
        let d = tempfile::tempdir().unwrap();
        let short = LocalTranscript {
            duration_ms: 1_000,
            ..transcript()
        };
        let out = commit(d.path(), ctx(), parsed(), &short).unwrap();
        assert!(matches!(out, CommitOutcome::Invalid { .. }));
        assert!(observation_files(d.path()).is_empty());
        let path = d
            .path()
            .join("personal/signals")
            .join(COMPANY)
            .join("meetings/_runs")
            .join(format!("{}.json", ctx().job_id));
        assert!(path.is_file());
        let rec = read_run_record(d.path(), COMPANY, &ctx().job_id)
            .unwrap()
            .unwrap();
        assert_eq!(rec.parsed, parsed());
        assert_eq!(rec.schema, RUN_RECORD_SCHEMA);
    }

    #[test]
    fn source_order_writes_the_run_record_before_observations() {
        let src = include_str!("store.rs");
        let body = src.split("pub fn commit(").nth(1).unwrap();
        let run = body.find("write_atomic(&run_path").unwrap();
        let fin = body.find("finish(&root").unwrap();
        assert!(run < fin);
        let finish_body = src.split("fn finish(").nth(1).unwrap();
        assert!(
            finish_body.find("validate_citations").unwrap()
                < finish_body.find("write_new(").unwrap()
        );
    }

    #[test]
    fn a_different_second_parse_for_the_same_job_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let short = LocalTranscript {
            duration_ms: 1_000,
            ..transcript()
        };
        commit(d.path(), ctx(), parsed(), &short).unwrap();
        let mut other = parsed();
        other.observations.truncate(1);
        assert!(commit(d.path(), ctx(), other, &transcript()).is_err());
    }
}

mod ac4_receipts {
    use super::*;

    #[test]
    fn receipt_path_and_complete_status_with_exact_output_ids() {
        let d = tempfile::tempdir().unwrap();
        let ids = complete_ids(commit(d.path(), ctx(), parsed(), &transcript()).unwrap());
        let c = ctx();
        let expected = d
            .path()
            .join("personal/signals")
            .join(COMPANY)
            .join("receipts/meetings")
            .join(SOURCE_ID)
            .join(format!(
                "{}-local-signals-prompt_2fv1-local-signal_2fv1.json",
                c.source_digest
            ));
        assert!(expected.is_file(), "{expected:?}");
        let r = receipt_at(d.path(), &c);
        assert_eq!(r.status, ReceiptStatus::Complete);
        assert_eq!(r.output_ids, ids);
        let on_disk: Vec<String> = observation_files(d.path())
            .iter()
            .map(|f| f.file_stem().unwrap().to_string_lossy().to_string())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        assert_eq!(r.output_ids, on_disk);
    }

    #[test]
    fn pending_receipt_lists_the_ids_the_run_will_produce() {
        let d = tempfile::tempdir().unwrap();
        let short = LocalTranscript {
            duration_ms: 1_000,
            ..transcript()
        };
        commit(d.path(), ctx(), parsed(), &short).unwrap();
        let pending = receipt_at(d.path(), &ctx());
        assert_eq!(pending.status, ReceiptStatus::Pending);
        assert_eq!(pending.output_ids.len(), 8);
        let ids = complete_ids(resume(d.path(), COMPANY, &ctx().job_id, &transcript()).unwrap());
        assert_eq!(pending.output_ids, ids);
    }
}

mod ac5_enqueue_and_supersede {
    use super::*;
    use crate::commands::local_signal_runs::{ProviderChoice, RunRequestInput};
    use crate::commands::local_signals::{enqueue, EnqueueOutcome};

    fn input(c: &RunContext) -> RunRequestInput {
        RunRequestInput {
            company_uid: c.company_uid.clone(),
            member_uid: c.member_uid.clone(),
            source_ref: c.source_ref.clone(),
            source_digest: c.source_digest.clone(),
            audience_receipt_ref: c.audience_receipt_ref.clone(),
            provider: ProviderChoice::Any,
            prompt_version: c.prompt_version.clone(),
            schema_version: c.schema_version.clone(),
        }
    }

    #[test]
    fn complete_receipt_makes_enqueue_a_no_op() {
        let hq = tempfile::tempdir().unwrap();
        let runs = tempfile::tempdir().unwrap();
        assert!(matches!(
            enqueue(hq.path(), runs.path(), SOURCE_ID, input(&ctx())).unwrap(),
            EnqueueOutcome::Queued { .. }
        ));
        commit(hq.path(), ctx(), parsed(), &transcript()).unwrap();
        let before = files_under(runs.path());
        assert!(matches!(
            enqueue(hq.path(), runs.path(), SOURCE_ID, input(&ctx())).unwrap(),
            EnqueueOutcome::Skipped
        ));
        assert_eq!(files_under(runs.path()), before);
        // Committing the same run again is also a no-op.
        assert!(matches!(
            commit(hq.path(), ctx(), parsed(), &transcript()).unwrap(),
            CommitOutcome::Skipped { .. }
        ));
    }

    #[test]
    fn changed_transcript_prompt_and_schema_each_mint_a_receipt_and_supersede_without_deletion() {
        let hq = tempfile::tempdir().unwrap();
        let runs = tempfile::tempdir().unwrap();
        commit(hq.path(), ctx(), parsed(), &transcript()).unwrap();
        let mut history = vec![ctx()];
        let changes: Vec<Box<dyn Fn(&mut RunContext, &mut LocalTranscript)>> = vec![
            Box::new(|c, t| {
                c.source_digest = "e2".repeat(32);
                t.source_digest = c.source_digest.clone();
            }),
            Box::new(|c, _| c.prompt_version = "local-signals-prompt/v2".into()),
            Box::new(|c, _| c.schema_version = "local-signal/v2".into()),
        ];
        let mut t = transcript();
        let mut c = ctx();
        for (n, change) in changes.iter().enumerate() {
            change(&mut c, &mut t);
            c.job_id = format!("00000000-0000-0000-0000-00000000000{n}");
            let files_before = observation_files(hq.path());
            assert!(matches!(
                enqueue(hq.path(), runs.path(), SOURCE_ID, input(&c)).unwrap(),
                EnqueueOutcome::Queued { .. }
            ));
            let out = commit(hq.path(), c.clone(), parsed(), &t).unwrap();
            let CommitOutcome::Complete { superseded, .. } = out else {
                panic!("expected complete")
            };
            assert_eq!(superseded.len(), 1);
            for f in &files_before {
                assert!(f.is_file(), "prior observation deleted: {f:?}");
            }
            assert_eq!(observation_files(hq.path()).len(), files_before.len() + 8);
            for prior in &history {
                let r = receipt_at(hq.path(), prior);
                assert_eq!(r.status, ReceiptStatus::Superseded);
                assert!(r.superseded_by.is_some());
            }
            assert_eq!(receipt_at(hq.path(), &c).status, ReceiptStatus::Complete);
            history.push(c.clone());
        }
        assert_eq!(
            receipt::list_for_source(&company_root(hq.path(), COMPANY).unwrap(), SOURCE_ID)
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn observation_files_are_never_rewritten() {
        let d = tempfile::tempdir().unwrap();
        commit(d.path(), ctx(), parsed(), &transcript()).unwrap();
        let f = &observation_files(d.path())[0];
        let bytes = std::fs::read(f).unwrap();
        // Same logical content from another device in a new pending run of the same versions.
        let root = company_root(d.path(), COMPANY).unwrap();
        let rp = receipt::receipt_path(
            &root,
            SOURCE_ID,
            &ctx().source_digest,
            &ctx().prompt_version,
            &ctx().schema_version,
        )
        .unwrap();
        let mut r = receipt::read(&rp).unwrap().unwrap();
        r.status = ReceiptStatus::Pending;
        receipt::write(&rp, &r).unwrap();
        let mut c = ctx();
        c.device_id = "device-b".into();
        c.job_id = "99999999-9999-9999-9999-999999999999".into();
        commit(d.path(), c, parsed(), &transcript()).unwrap();
        assert_eq!(std::fs::read(f).unwrap(), bytes);
    }
}

mod ac6_citation_validation {
    use super::*;

    #[test]
    fn out_of_range_timestamp_is_rejected_and_the_run_stays_recoverable() {
        let d = tempfile::tempdir().unwrap();
        let mut p = parsed();
        p.observations[3].citations = vec![cite(170_000, 999_000)];
        let out = commit(d.path(), ctx(), p.clone(), &transcript()).unwrap();
        let CommitOutcome::Invalid { errors, .. } = out else {
            panic!("expected invalid")
        };
        assert!(errors
            .iter()
            .any(|e| e.contains("timestamp outside the transcript")));
        assert!(observation_files(d.path()).is_empty());
        let r = receipt_at(d.path(), &ctx());
        assert_eq!(r.status, ReceiptStatus::Pending);
        assert!(r.last_error.as_deref().unwrap().contains("timestamp"));
        assert_eq!(
            read_run_record(d.path(), COMPANY, &ctx().job_id)
                .unwrap()
                .unwrap()
                .parsed,
            p
        );
        // The local transcript later resolves the range: resume finishes from the stored parse.
        let longer = LocalTranscript {
            duration_ms: 1_000_000,
            ..transcript()
        };
        assert_eq!(
            complete_ids(resume(d.path(), COMPANY, &ctx().job_id, &longer).unwrap()).len(),
            8
        );
    }

    #[test]
    fn inverted_range_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        let mut p = parsed();
        p.observations[0].citations = vec![cite(5_000, 1_000)];
        assert!(matches!(
            commit(d.path(), ctx(), p, &transcript()).unwrap(),
            CommitOutcome::Invalid { .. }
        ));
    }

    #[test]
    fn wrong_source_reference_is_rejected_and_recoverable() {
        let d = tempfile::tempdir().unwrap();
        let mut p = parsed();
        p.observations[0].citations[0].source_ref = "sources/meetings/other.md".into();
        let out = commit(d.path(), ctx(), p, &transcript()).unwrap();
        let CommitOutcome::Invalid { errors, .. } = out else {
            panic!("expected invalid")
        };
        assert!(errors
            .iter()
            .any(|e| e.contains("unknown source reference")));
        assert!(observation_files(d.path()).is_empty());
        assert!(read_run_record(d.path(), COMPANY, &ctx().job_id)
            .unwrap()
            .is_some());
        assert_eq!(receipt_at(d.path(), &ctx()).status, ReceiptStatus::Pending);
    }

    #[test]
    fn transcript_for_another_source_or_digest_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        let wrong = LocalTranscript {
            source_digest: "ff".repeat(32),
            ..transcript()
        };
        let CommitOutcome::Invalid { errors, .. } =
            commit(d.path(), ctx(), parsed(), &wrong).unwrap()
        else {
            panic!()
        };
        assert!(errors.iter().any(|e| e.contains("digest")));
        let wrong = LocalTranscript {
            source_ref: "sources/meetings/x.md".into(),
            ..transcript()
        };
        let CommitOutcome::Invalid { errors, .. } =
            resume(d.path(), COMPANY, &ctx().job_id, &wrong).unwrap()
        else {
            panic!()
        };
        assert!(errors.iter().any(|e| e.contains("different source")));
        assert!(observation_files(d.path()).is_empty());
    }
}
