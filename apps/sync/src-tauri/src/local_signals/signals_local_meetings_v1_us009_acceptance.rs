//! signals-local-meetings-v1 US-009 acceptance tests (Rust half). One module
//! per acceptance criterion, plus the folded-in desktop halves of US-007 AC7
//! and US-008 AC5/AC6. The UI half is in
//! `apps/sync/src/components/MeetingsWindow.local-signals.test.ts`.
use super::eligibility::{self, IneligibleReason};
use super::extractor::{handle_provider_failure, ProviderFailure, PROMPT_VERSION, SCHEMA_VERSION};
use super::receipt::{self, ReceiptStatus};
use super::store::*;
use super::upload::{self, UploadStatus};
use crate::commands::local_signal_runs::{
    self as runs, Provider, ProviderChoice, ProviderSession, RunState,
};
use crate::commands::meeting_signals::{context_for, generate_in, latest_run, status_for};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::Path;

pub(super) const CO: &str = "cmp_a";
pub(super) const SLUG: &str = "co-a";
pub(super) const ME: &str = "prs_alice";
pub(super) const BOT: &str = "bot-abc";
pub(super) const BODY: &str = "**Ava** [00:00]: Ship the Atlas beta on November 3.\n**Ben** [01:30]: I will draft the checklist.\n";

pub(super) fn seed(hq: &Path, fm_extra: &str, roster: &[&str], body_override: Option<&str>) {
    let dir = hq.join("companies").join(SLUG).join("sources/meetings");
    std::fs::create_dir_all(&dir).unwrap();
    let digest = eligibility::sha256_digest(BODY);
    let key = format!("sha256:{}", "aa".repeat(32));
    let receipt = json!({
        "schema": "meeting-audience.v1", "companyUid": CO, "meetingId": BOT,
        "sourceRef": {"channel": "meeting", "source_id": BOT, "key": format!("sources/meetings/{BOT}.md")},
        "sourceDigest": digest, "botCaptureId": BOT, "invitedMemberUids": roster,
        "unresolvedInvitedEmails": [], "evidenceKind": "calendar-invitation-roster",
        "audienceKey": key, "audienceVersion": 1, "createdAt": "2026-10-13T00:00:00.000Z"
    });
    std::fs::write(
        dir.join(format!("{BOT}.audience.json")),
        receipt.to_string(),
    )
    .unwrap();
    let md = format!(
        "---\nchannel: meeting\nsource_id: {BOT}\ncompany_id: {CO}\norigin: recall.ai\nrecall_bot_id: {BOT}\naudience_key: \"{key}\"\naudience_version: 1\naudience_receipt_ref: sources/meetings/{BOT}.audience.json\n{fm_extra}---\n{}",
        body_override.unwrap_or(BODY)
    );
    std::fs::write(dir.join(format!("{BOT}.md")), md).unwrap();
}

pub(super) fn eligible_hq() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    seed(d.path(), "", &[ME, "prs_bob"], None);
    d
}

/// Drive a run to a complete local receipt, as a session plus extraction would.
pub(super) fn complete_local_run(
    hq: &Path,
    runs_dir: &Path,
    contents: &[(&str, SignalType)],
) -> RunContext {
    generate_in(hq, runs_dir, CO, ME, BOT, ProviderChoice::Any).unwrap();
    let e = eligibility::evaluate(hq, CO, ME, BOT);
    let run = latest_run(runs_dir, CO, ME, &e).unwrap().unwrap();
    let mut ctx = context_for(&run, &e, Provider::Claude, "device-a");
    ctx.projection_state = "ready".into();
    ctx.projection_watermark = "wm-1".into();
    let parsed = ParsedResult {
        observations: contents
            .iter()
            .enumerate()
            .map(|(i, (c, t))| ParsedObservation {
                signal_type: *t,
                content: (*c).into(),
                citations: vec![Citation {
                    source_ref: ctx.source_ref.clone(),
                    start_ms: i as u64 * 1000,
                    end_ms: i as u64 * 1000 + 500,
                }],
                entities: vec![],
                owner: (*t == SignalType::ActionItem).then(|| "Ben".to_string()),
                reasoning: (*t == SignalType::Decision).then(|| "Legal cleared it.".to_string()),
                speaker: None,
            })
            .collect(),
    };
    let t = LocalTranscript {
        source_ref: ctx.source_ref.clone(),
        source_digest: ctx.source_digest.clone(),
        duration_ms: e.duration_ms,
    };
    assert!(matches!(
        commit(hq, ctx.clone(), parsed, &t).unwrap(),
        CommitOutcome::Complete { .. }
    ));
    ctx
}

pub(super) fn local_receipt(hq: &Path, ctx: &RunContext) -> receipt::Receipt {
    let root = company_root(hq, CO).unwrap();
    receipt::read(
        &receipt::receipt_path(
            &root,
            BOT,
            &ctx.source_digest,
            PROMPT_VERSION,
            SCHEMA_VERSION,
        )
        .unwrap(),
    )
    .unwrap()
    .unwrap()
}

/// A fake hq-pro: records every request body and answers from a script.
struct FakeServer {
    seen: RefCell<Vec<Value>>,
    answer: Box<dyn Fn(&Value, usize) -> Result<(u16, Value), String>>,
}
impl FakeServer {
    fn new(answer: impl Fn(&Value, usize) -> Result<(u16, Value), String> + 'static) -> Self {
        FakeServer {
            seen: RefCell::new(vec![]),
            answer: Box::new(answer),
        }
    }
    async fn send(&self, body: Value) -> Result<(u16, Value), String> {
        let n = self.seen.borrow().len();
        let r = (self.answer)(&body, n);
        self.seen.borrow_mut().push(body);
        r
    }
}

pub(super) fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

mod ac0_visible_only_when_enabled_and_eligible {
    use super::*;

    #[test]
    fn flag_off_hides_everything() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        let s = status_for(hq.path(), runs.path(), false, CO, ME, BOT).unwrap();
        assert!(
            !s.enabled && !s.eligible && s.run.is_none() && !s.local_complete && s.upload.is_none()
        );
    }

    #[test]
    fn eligible_bot_meeting_offers_the_action() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        let s = status_for(hq.path(), runs.path(), true, CO, ME, BOT).unwrap();
        assert!(s.enabled && s.eligible);
        assert!(s.run.is_none(), "no run is fabricated before activation");
        let e = eligibility::evaluate(hq.path(), CO, ME, BOT);
        assert_eq!(e.company_slug.as_deref(), Some(SLUG));
        assert_eq!(e.duration_ms, 90_000 + 60_000);
    }

    #[test]
    fn ineligible_and_private_sources_never_offer_it() {
        let cases: Vec<(&str, Box<dyn Fn(&Path)>, IneligibleReason)> = vec![
            ("missing", Box::new(|_| {}), IneligibleReason::MissingSource),
            (
                "private",
                Box::new(|p| seed(p, "visibility: private\n", &[ME], None)),
                IneligibleReason::PrivateSource,
            ),
            (
                "not on roster",
                Box::new(|p| seed(p, "", &["prs_bob"], None)),
                IneligibleReason::NotOnRoster,
            ),
            (
                "sdk",
                Box::new(|p| seed(p, "capture_source: hq-sync-desktop-sdk\n", &[ME], None)),
                IneligibleReason::NotBotCapture,
            ),
            (
                "tampered",
                Box::new(|p| seed(p, "", &[ME], Some("edited transcript\n"))),
                IneligibleReason::DigestMismatch,
            ),
            (
                "missing receipt",
                Box::new(|p| {
                    seed(p, "", &[ME], None);
                    std::fs::remove_file(
                        p.join("companies/co-a/sources/meetings/bot-abc.audience.json"),
                    )
                    .unwrap();
                }),
                IneligibleReason::MissingReceipt,
            ),
        ];
        for (name, setup, reason) in cases {
            let hq = tempfile::tempdir().unwrap();
            setup(hq.path());
            let runs = tempfile::tempdir().unwrap();
            let s = status_for(hq.path(), runs.path(), true, CO, ME, BOT).unwrap();
            assert!(!s.eligible, "{name}");
            assert_eq!(s.ineligible_reason, Some(reason), "{name}");
            assert!(
                s.run.is_none() && !s.local_complete && s.upload.is_none(),
                "{name}"
            );
            assert!(
                generate_in(hq.path(), runs.path(), CO, ME, BOT, ProviderChoice::Any).is_err(),
                "{name}"
            );
            assert!(runs::list(runs.path()).unwrap().is_empty(), "{name}");
        }
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        assert_eq!(
            status_for(hq.path(), runs.path(), true, "cmp_other", ME, BOT)
                .unwrap()
                .ineligible_reason,
            Some(IneligibleReason::WrongCompany)
        );
    }
}

mod ac1_lifecycle_states {
    use super::*;

    #[test]
    fn activation_is_durable_and_duplicate_activations_reuse_the_job() {
        let hq = eligible_hq();
        let runs = tempfile::tempdir().unwrap();
        let first = generate_in(hq.path(), runs.path(), CO, ME, BOT, ProviderChoice::Any).unwrap();
        let run = first.run.clone().unwrap();
        assert_eq!(run.state, RunState::Pending);
        let second = generate_in(hq.path(), runs.path(), CO, ME, BOT, ProviderChoice::Any).unwrap();
        assert_eq!(
            second.run.as_ref().unwrap().request.job_id,
            run.request.job_id
        );
        assert_eq!(second.run.unwrap().activations, 2);
        assert_eq!(runs::list(runs.path()).unwrap().len(), 1);
    }

    #[test]
    fn every_run_state_is_visible_through_status() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        let job = generate_in(hq.path(), runs_d.path(), CO, ME, BOT, ProviderChoice::Any)
            .unwrap()
            .run
            .unwrap()
            .request
            .job_id;
        let s = ProviderSession {
            provider: Provider::Claude,
            session_id: "s1".into(),
            interactive: true,
        };
        runs::claim(runs_d.path(), &job, &s, None).unwrap();
        let seen = |want: RunState| {
            let st = status_for(hq.path(), runs_d.path(), true, CO, ME, BOT).unwrap();
            assert_eq!(st.run.unwrap().state, want);
        };
        seen(RunState::Claimed);
        runs::progress(runs_d.path(), &job, "s1", RunState::Extracting, None).unwrap();
        seen(RunState::Extracting);
        runs::store_parsed_result(runs_d.path(), &job, "s1", &json!({"observations": []})).unwrap();
        runs::progress(runs_d.path(), &job, "s1", RunState::Writing, None).unwrap();
        seen(RunState::Writing);
        runs::progress(runs_d.path(), &job, "s1", RunState::Uploading, None).unwrap();
        seen(RunState::Uploading);
        runs::progress(runs_d.path(), &job, "s1", RunState::Complete, None).unwrap();
        seen(RunState::Complete);
    }

    #[test]
    fn a_complete_local_receipt_makes_generate_a_no_op() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        complete_local_run(
            hq.path(),
            runs_d.path(),
            &[("Ship the Atlas beta on November 3.", SignalType::Decision)],
        );
        let before = runs::list(runs_d.path()).unwrap();
        let s = generate_in(hq.path(), runs_d.path(), CO, ME, BOT, ProviderChoice::Any).unwrap();
        assert!(s.local_complete);
        assert_eq!(runs::list(runs_d.path()).unwrap().len(), before.len());
    }
}

mod ac2_no_provider_session_stays_pending {
    use super::*;

    #[test]
    fn without_a_session_the_run_stays_pending_and_nothing_is_spawned() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        let run = generate_in(hq.path(), runs_d.path(), CO, ME, BOT, ProviderChoice::Any)
            .unwrap()
            .run
            .unwrap();
        let after = runs::dispatch(runs_d.path(), &run.request.job_id, &[]).unwrap();
        assert_eq!(after.state, RunState::Pending);
        let src = include_str!("../commands/meeting_signals.rs");
        for needle in [
            "Command::new",
            "std::process",
            "tokio::process",
            "/v1/signals",
            "inference",
        ] {
            assert!(!src.contains(needle), "{needle}");
        }
        // The only network call in the module is the contribution upload route.
        assert_eq!(src.matches(".post(").count(), 1);
        assert!(src.contains("/v1/files/contributions/company/{slug}/meetings"));
    }
}

mod ac3_plain_failures_and_retry {
    use super::*;

    #[test]
    fn server_answers_map_to_bounded_statuses() {
        let cases = [
            (200, json!({"status":"created"}), UploadStatus::Created),
            (200, json!({"status":"unchanged"}), UploadStatus::Unchanged),
            (200, json!({"status":"repaired"}), UploadStatus::Repaired),
            (200, json!({"status":"???"}), UploadStatus::Retryable),
            (
                409,
                json!({"code":"CONTRIBUTION_CONFLICT"}),
                UploadStatus::Conflict,
            ),
            (
                422,
                json!({"code":"CONTRIBUTION_REJECTED","reasons":["source_ineligible"]}),
                UploadStatus::Ineligible,
            ),
            (
                403,
                json!({"code":"CONTRIBUTION_DISABLED"}),
                UploadStatus::Disabled,
            ),
            (
                403,
                json!({"code":"CONTRIBUTION_NOT_MEMBER"}),
                UploadStatus::Blocked,
            ),
            (402, json!({}), UploadStatus::Blocked),
            (401, json!({}), UploadStatus::Retryable),
            (429, json!({}), UploadStatus::Retryable),
            (503, Value::Null, UploadStatus::Retryable),
        ];
        for (code, body, want) in cases {
            assert_eq!(upload::classify(code, &body).0, want, "{code} {body}");
        }
        assert_eq!(
            upload::classify(422, &json!({"reasons":["source_ineligible","x"]})).1,
            vec!["source_ineligible", "x"]
        );
    }

    #[test]
    fn transport_failures_are_recorded_as_retryable_without_raw_text() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        let ctx = complete_local_run(
            hq.path(),
            runs_d.path(),
            &[("Ship the Atlas beta on November 3.", SignalType::Decision)],
        );
        let rec = local_receipt(hq.path(), &ctx);
        let root = company_root(hq.path(), CO).unwrap();
        let server =
            FakeServer::new(
                |_, _| Err("connection reset by peer (os error 54) at 10.0.0.1".into()),
            );
        let s = block_on(upload::upload_pending(&root, &rec, |b| server.send(b))).unwrap();
        assert_eq!(s.retryable, 1);
        assert_eq!(s.reasons, vec!["transport"]);
        let text = serde_json::to_string(
            &upload::read_record(&root, &rec.output_ids[0])
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(!text.contains("os error") && !text.contains("10.0.0.1"));
        // Retried on the next pass, attempts counted.
        let ok = FakeServer::new(|_, _| Ok((200, json!({"status":"created"}))));
        let s = block_on(upload::upload_pending(&root, &rec, |b| ok.send(b))).unwrap();
        assert_eq!((s.created, s.sent), (1, 1));
        assert_eq!(
            upload::read_record(&root, &rec.output_ids[0])
                .unwrap()
                .unwrap()
                .attempts,
            2
        );
    }
}

mod ac4_cancel_and_retry_are_job_scoped {
    use super::*;

    #[test]
    fn cancelling_one_meeting_leaves_another_job_and_session_untouched() {
        let runs_d = tempfile::tempdir().unwrap();
        let mk = |src: &str| {
            runs::request(
                runs_d.path(),
                runs::RunRequestInput {
                    company_uid: CO.into(),
                    member_uid: ME.into(),
                    source_ref: src.into(),
                    source_digest: "sha256:x".into(),
                    audience_receipt_ref: "r".into(),
                    provider: ProviderChoice::Any,
                    prompt_version: PROMPT_VERSION.into(),
                    schema_version: SCHEMA_VERSION.into(),
                },
            )
            .unwrap()
            .request
            .job_id
        };
        let (a, b) = (mk("sources/meetings/a.md"), mk("sources/meetings/b.md"));
        let sb = ProviderSession {
            provider: Provider::Codex,
            session_id: "sb".into(),
            interactive: true,
        };
        runs::claim(runs_d.path(), &b, &sb, None).unwrap();
        let before = runs::load(runs_d.path(), &b).unwrap();
        runs::cancel(runs_d.path(), &a, None).unwrap();
        assert_eq!(
            runs::load(runs_d.path(), &a).unwrap().state,
            RunState::Cancelled
        );
        assert_eq!(runs::load(runs_d.path(), &b).unwrap(), before);
        // Retry re-queues the same durable job in place.
        let again = runs::request(
            runs_d.path(),
            runs::RunRequestInput {
                company_uid: CO.into(),
                member_uid: ME.into(),
                source_ref: "sources/meetings/a.md".into(),
                source_digest: "sha256:x".into(),
                audience_receipt_ref: "r".into(),
                provider: ProviderChoice::Any,
                prompt_version: PROMPT_VERSION.into(),
                schema_version: SCHEMA_VERSION.into(),
            },
        )
        .unwrap();
        assert_eq!(again.request.job_id, a);
        assert_eq!(again.state, RunState::Pending);
        assert_eq!(runs::load(runs_d.path(), &b).unwrap(), before);
    }
}

mod us007_ac7_recovery_action {
    use super::*;

    #[test]
    fn provider_loss_records_one_named_action_and_a_claim_clears_it() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        let job = generate_in(hq.path(), runs_d.path(), CO, ME, BOT, ProviderChoice::Any)
            .unwrap()
            .run
            .unwrap()
            .request
            .job_id;
        let s = ProviderSession {
            provider: Provider::Claude,
            session_id: "s1".into(),
            interactive: true,
        };
        runs::claim(runs_d.path(), &job, &s, None).unwrap();
        handle_provider_failure(
            runs_d.path(),
            &job,
            "s1",
            Provider::Claude,
            ProviderFailure::LoggedOut,
        )
        .unwrap();
        let st = status_for(hq.path(), runs_d.path(), true, CO, ME, BOT)
            .unwrap()
            .run
            .unwrap();
        assert_eq!(st.recovery.as_deref(), Some("sign_in_again"));
        assert_eq!(st.state, RunState::Pending);
        let s2 = ProviderSession {
            provider: Provider::Claude,
            session_id: "s2".into(),
            interactive: true,
        };
        runs::claim(runs_d.path(), &job, &s2, None).unwrap();
        assert_eq!(runs::load(runs_d.path(), &job).unwrap().recovery, None);
        runs::progress(runs_d.path(), &job, "s2", RunState::Extracting, None).unwrap();
        handle_provider_failure(
            runs_d.path(),
            &job,
            "s2",
            Provider::Claude,
            ProviderFailure::TransportLost,
        )
        .unwrap();
        assert_eq!(
            runs::load(runs_d.path(), &job).unwrap().recovery.as_deref(),
            Some("resume")
        );
    }
}

mod us008_ac5_upload_after_local_completion {
    use super::*;

    #[test]
    fn a_complete_local_run_uploads_each_observation_to_the_member_route_contract() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        let ctx = complete_local_run(
            hq.path(),
            runs_d.path(),
            &[
                ("Ship the Atlas beta on November 3.", SignalType::Decision),
                ("Draft the checklist.", SignalType::ActionItem),
            ],
        );
        let rec = local_receipt(hq.path(), &ctx);
        assert_eq!(rec.status, ReceiptStatus::Complete);
        let root = company_root(hq.path(), CO).unwrap();
        let server = FakeServer::new(|_, _| {
            Ok((
                200,
                json!({"status":"created","objectKey":"k","receiptKey":"r"}),
            ))
        });
        let s = block_on(upload::upload_pending(&root, &rec, |b| server.send(b))).unwrap();
        assert_eq!((s.total, s.uploaded, s.created, s.sent), (2, 2, 2, 2));
        let allowed = [
            "schema",
            "sanitizerVersion",
            "observationId",
            "signalType",
            "content",
            "citations",
            "sourceRef",
            "sourceDigest",
            "entityRefs",
            "provisionalEntities",
            "owner",
            "reasoning",
            "speaker",
            "companyUid",
            "memberUid",
            "audienceKey",
            "audienceVersion",
            "audienceReceiptRef",
            "promptVersion",
            "schemaVersion",
            "classification",
            "projectionState",
            "projectionWatermark",
        ];
        for body in server.seen.borrow().iter() {
            let c = &body["contribution"];
            for k in c.as_object().unwrap().keys() {
                assert!(
                    allowed.contains(&k.as_str()),
                    "{k} is not in the hq-pro contract"
                );
            }
            assert_eq!(c["schema"], "sanitized-contribution.v1");
            assert_eq!(c["memberUid"], ME);
            assert_eq!(c["audienceKey"], format!("sha256:{}", "aa".repeat(32)));
            let id = c["observationId"].as_str().unwrap();
            let want = format!(
                "member-signals/{ME}/observations/meetings/@sha256-{}/{}/{id}.md",
                "aa".repeat(32),
                c["signalType"].as_str().unwrap()
            );
            assert_eq!(body["destination"], want);
        }
        let st = status_for(hq.path(), runs_d.path(), true, CO, ME, BOT).unwrap();
        assert!(st.local_complete);
        assert_eq!(st.upload.unwrap().uploaded, 2);
    }

    #[test]
    fn server_refusals_are_recorded_for_the_row() {
        for (code, body, field) in [
            (
                422,
                json!({"code":"CONTRIBUTION_REJECTED","reasons":["source_ineligible"]}),
                "ineligible",
            ),
            (403, json!({"code":"CONTRIBUTION_NOT_MEMBER"}), "blocked"),
            (403, json!({"code":"CONTRIBUTION_DISABLED"}), "disabled"),
        ] {
            let hq = eligible_hq();
            let runs_d = tempfile::tempdir().unwrap();
            let ctx = complete_local_run(
                hq.path(),
                runs_d.path(),
                &[("Ship it.", SignalType::Decision)],
            );
            let rec = local_receipt(hq.path(), &ctx);
            let root = company_root(hq.path(), CO).unwrap();
            let b2 = body.clone();
            let server = FakeServer::new(move |_, _| Ok((code, b2.clone())));
            let s = block_on(upload::upload_pending(&root, &rec, |b| server.send(b))).unwrap();
            let v = serde_json::to_value(&s).unwrap();
            assert_eq!(v[field], 1, "{field}");
            assert_eq!(s.uploaded, 0);
        }
    }

    #[test]
    fn content_the_sanitizer_would_change_stays_local_and_is_never_sent() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        let ctx = complete_local_run(
            hq.path(),
            runs_d.path(),
            &[(
                "See /Users/alice/notes/atlas.md for the plan.",
                SignalType::KeyPoint,
            )],
        );
        let rec = local_receipt(hq.path(), &ctx);
        let root = company_root(hq.path(), CO).unwrap();
        let server = FakeServer::new(|_, _| Ok((200, json!({"status":"created"}))));
        let s = block_on(upload::upload_pending(&root, &rec, |b| server.send(b))).unwrap();
        assert_eq!((s.blocked, s.sent), (1, 0));
        assert_eq!(s.reasons, vec!["sanitized_content_changed"]);
        assert!(server.seen.borrow().is_empty());
    }
}

mod us008_ac6_repair_from_local_receipt {
    use super::*;

    #[test]
    fn settled_uploads_are_not_resent_and_retries_only_send_the_rest() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        let ctx = complete_local_run(
            hq.path(),
            runs_d.path(),
            &[
                ("One.", SignalType::Summary),
                ("Two.", SignalType::Risk),
                ("Three.", SignalType::Question),
            ],
        );
        let rec = local_receipt(hq.path(), &ctx);
        let root = company_root(hq.path(), CO).unwrap();
        // First pass: first created, second interrupted, third conflicts.
        let first = FakeServer::new(|_, n| match n {
            0 => Ok((200, json!({"status":"created"}))),
            1 => Err("timeout".into()),
            _ => Ok((409, json!({"code":"CONTRIBUTION_CONFLICT"}))),
        });
        let s = block_on(upload::upload_pending(&root, &rec, |b| first.send(b))).unwrap();
        assert_eq!((s.created, s.retryable, s.conflict), (1, 1, 1));
        // Retry: only the interrupted one is resent; the server repairs its receipt.
        let retry = FakeServer::new(|_, _| Ok((200, json!({"status":"repaired"}))));
        let s = block_on(upload::upload_pending(&root, &rec, |b| retry.send(b))).unwrap();
        assert_eq!(s.sent, 1);
        assert_eq!(
            (s.created, s.repaired, s.conflict, s.retryable),
            (1, 1, 1, 0)
        );
        // Everything settled: a further pass sends nothing. Extraction never reruns.
        let idle = FakeServer::new(|_, _| panic!("nothing should be sent"));
        let s = block_on(upload::upload_pending(&root, &rec, |b| idle.send(b))).unwrap();
        assert_eq!(s.sent, 0);
        assert_eq!(
            read_run_record(hq.path(), CO, &ctx.job_id)
                .unwrap()
                .unwrap()
                .context
                .job_id,
            ctx.job_id
        );
    }

    #[test]
    fn a_duplicate_send_after_lost_local_state_is_answered_unchanged() {
        let hq = eligible_hq();
        let runs_d = tempfile::tempdir().unwrap();
        let ctx = complete_local_run(hq.path(), runs_d.path(), &[("One.", SignalType::Summary)]);
        let rec = local_receipt(hq.path(), &ctx);
        let root = company_root(hq.path(), CO).unwrap();
        let server = FakeServer::new(|_, _| Ok((200, json!({"status":"unchanged"}))));
        let s = block_on(upload::upload_pending(&root, &rec, |b| server.send(b))).unwrap();
        assert_eq!((s.unchanged, s.uploaded), (1, 1));
    }

    #[test]
    fn real_audience_keys_are_path_safe() {
        assert_eq!(audience_segment("sha256:abc"), "sha256-abc");
        assert_eq!(audience_segment("aud-1"), "aud-1");
    }
}

/// Read-only real-data check, opt-in only:
/// `HQ_REAL_ROOT=/path/to/HQ HQ_REAL_MEMBER=prs_... cargo test --bins real_data_eligibility -- --ignored --nocapture`.
/// Never writes. Reports how the eligibility gate classifies every synced
/// bot-captured meeting on this machine.
mod real_data {
    use super::*;

    #[test]
    #[ignore]
    fn real_data_eligibility_scan() {
        let Ok(root) = std::env::var("HQ_REAL_ROOT") else {
            return;
        };
        let member = std::env::var("HQ_REAL_MEMBER").unwrap_or_default();
        let root = std::path::PathBuf::from(root);
        let mut counts = std::collections::BTreeMap::<String, usize>::new();
        let mut scanned = 0;
        for company in std::fs::read_dir(root.join("companies")).unwrap().flatten() {
            let dir = company.path().join("sources/meetings");
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for f in entries.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                let Some(bot) = name.strip_suffix(".md") else {
                    continue;
                };
                let Ok(text) = std::fs::read_to_string(f.path()) else {
                    continue;
                };
                let Some((yaml, _)) = eligibility::split_frontmatter(&text) else {
                    continue;
                };
                let fm: serde_yaml::Value = serde_yaml::from_str(yaml).unwrap_or_default();
                if fm.get("origin").and_then(|v| v.as_str()) != Some("recall.ai") {
                    continue;
                }
                let co = fm
                    .get("company_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let e = eligibility::evaluate(&root, &co, &member, bot);
                scanned += 1;
                let key = if e.eligible {
                    "eligible".to_string()
                } else {
                    format!("{:?}", e.reason.unwrap())
                };
                *counts.entry(key).or_default() += 1;
            }
        }
        println!("real-data eligibility: scanned={scanned} {counts:?}");
    }
}

/// US-008 AC8 + `indigo-feature-flags-default-on-as-fail-safes`: the
/// `desktop.signals-local-meetings-v1` reader keeps the feature ON when the
/// flag row is absent, archived (omitted by resolve), or unreadable; only an
/// explicit `false` turns it off. Supersedes the older US-009 AC7 wording.
mod flag_is_a_default_on_kill_switch {
    use crate::commands::meeting_signals::{flag_on_from, SIGNALS_FLAG};

    #[test]
    fn only_explicit_false_turns_it_off() {
        assert_eq!(SIGNALS_FLAG, "desktop.signals-local-meetings-v1");
        assert!(flag_on_from(Ok(Some(true))));
        assert!(flag_on_from(Ok(None)), "absent or archived row stays on");
        assert!(flag_on_from(Err(())), "unreadable stays on");
        assert!(!flag_on_from(Ok(Some(false))), "explicit false is the kill switch");
    }

    #[test]
    fn every_command_reads_the_flag_through_the_kill_switch_reader() {
        let src = include_str!("../commands/meeting_signals.rs");
        assert!(src.contains("flag_on_from(super::hq_pro::feature_flag_read_for_company(SIGNALS_FLAG, company_uid).await)"));
        assert!(!src.contains("feature_flag_enabled_for_company"));
    }
}
