//! signals-local-meetings-v1 US-002 — acceptance tests, one module per
//! criterion. They drive the public contract the way the Meetings action and
//! an interactive session would, and read the durable files back from disk.
use super::*;
use std::collections::HashSet;

const COMPANY: &str = "cmp_acc";
const MEMBER: &str = "prs_acc";

fn input(choice: ProviderChoice) -> RunRequestInput {
    RunRequestInput {
        company_uid: COMPANY.into(),
        member_uid: MEMBER.into(),
        source_ref: "sources/meetings/mtg-acc.md".into(),
        source_digest: "sha256:aaa".into(),
        audience_receipt_ref: "meetings/_audience/mtg-acc.json".into(),
        provider: choice,
        prompt_version: "signals-prompt/3".into(),
        schema_version: "signal-schema/2".into(),
    }
}
fn sess(p: Provider, id: &str) -> ProviderSession {
    ProviderSession {
        provider: p,
        session_id: id.into(),
        interactive: true,
    }
}
fn headless(p: Provider, id: &str) -> ProviderSession {
    ProviderSession {
        provider: p,
        session_id: id.into(),
        interactive: false,
    }
}
fn on_disk(dir: &Path, job: &str) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(record_path(dir, job)).unwrap()).unwrap()
}
fn files(dir: &Path) -> usize {
    std::fs::read_dir(dir).map(|e| e.count()).unwrap_or(0)
}
/// Request → claim → extracting → stored parse, as one session would.
fn run_to_parse(dir: &Path, sid: &str, pid: Option<u32>) -> String {
    let job = request(dir, input(ProviderChoice::Claude))
        .unwrap()
        .request
        .job_id;
    claim(dir, &job, &sess(Provider::Claude, sid), pid).unwrap();
    progress(dir, &job, sid, RunState::Extracting, None).unwrap();
    store_parsed_result(
        dir,
        &job,
        sid,
        &serde_json::json!({ "signals": [{ "type": "decision" }] }),
    )
    .unwrap();
    job
}

mod ac0_versioned_request {
    use super::*;

    #[test]
    fn durable_record_carries_every_required_field() {
        let d = tempfile::tempdir().unwrap();
        let rec = request(d.path(), input(ProviderChoice::Codex)).unwrap();
        let req = &on_disk(d.path(), &rec.request.job_id)["request"];
        assert_eq!(req["schema"], RUN_REQUEST_SCHEMA);
        assert_eq!(req["companyUid"], COMPANY);
        assert_eq!(req["memberUid"], MEMBER);
        assert_eq!(req["sourceRef"], "sources/meetings/mtg-acc.md");
        assert_eq!(req["sourceDigest"], "sha256:aaa");
        assert_eq!(req["audienceReceiptRef"], "meetings/_audience/mtg-acc.json");
        assert_eq!(req["provider"], "codex");
        assert_eq!(req["promptVersion"], "signals-prompt/3");
        assert_eq!(req["schemaVersion"], "signal-schema/2");
        let job = req["jobId"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(job).is_ok());
        assert_eq!(job, rec.request.job_id);
    }

    #[test]
    fn job_ids_are_unique_across_distinct_requests() {
        let d = tempfile::tempdir().unwrap();
        let mut ids = HashSet::new();
        for i in 0..25 {
            let mut inp = input(ProviderChoice::Any);
            inp.source_digest = format!("sha256:{i}");
            assert!(ids.insert(request(d.path(), inp).unwrap().request.job_id));
        }
    }

    #[test]
    fn caller_cannot_supply_job_id_or_omit_a_field() {
        let mut v = serde_json::to_value(input(ProviderChoice::Any)).unwrap();
        v["jobId"] = "11111111-1111-1111-1111-111111111111".into();
        assert!(serde_json::from_value::<RunRequestInput>(v).is_err());
        for field in [
            "companyUid",
            "memberUid",
            "sourceDigest",
            "audienceReceiptRef",
            "promptVersion",
            "schemaVersion",
        ] {
            let mut v = serde_json::to_value(input(ProviderChoice::Any)).unwrap();
            v.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<RunRequestInput>(v).is_err(),
                "{field} optional"
            );
        }
        let d = tempfile::tempdir().unwrap();
        let mut empty = input(ProviderChoice::Any);
        empty.audience_receipt_ref = String::new();
        assert!(request(d.path(), empty).is_err());
        assert_eq!(files(d.path()), 0);
    }
}

mod ac1_one_request_per_activation {
    use super::*;

    #[test]
    fn repeated_activations_reuse_one_job_and_count_each_activation() {
        let d = tempfile::tempdir().unwrap();
        let first = request(d.path(), input(ProviderChoice::Any)).unwrap();
        for n in 2..=4 {
            let again = request(d.path(), input(ProviderChoice::Any)).unwrap();
            assert_eq!(again.request.job_id, first.request.job_id);
            assert_eq!(again.activations, n);
        }
        assert_eq!(list(d.path()).unwrap().len(), 1);
    }

    #[test]
    fn digest_prompt_or_schema_change_creates_a_new_job() {
        let d = tempfile::tempdir().unwrap();
        let base = request(d.path(), input(ProviderChoice::Any))
            .unwrap()
            .request
            .job_id;
        let mut seen = HashSet::from([base]);
        let mut a = input(ProviderChoice::Any);
        a.source_digest = "sha256:bbb".into();
        let mut b = input(ProviderChoice::Any);
        b.prompt_version = "signals-prompt/4".into();
        let mut c = input(ProviderChoice::Any);
        c.schema_version = "signal-schema/3".into();
        for inp in [a, b, c] {
            let rec = request(d.path(), inp).unwrap();
            assert_eq!(rec.activations, 1);
            assert!(seen.insert(rec.request.job_id));
        }
        assert_eq!(list(d.path()).unwrap().len(), 4);
    }

    #[test]
    fn reactivating_an_in_flight_job_does_not_restart_or_reclaim_it() {
        let d = tempfile::tempdir().unwrap();
        let job = run_to_parse(d.path(), "s-a", Some(1));
        let again = request(d.path(), input(ProviderChoice::Claude)).unwrap();
        assert_eq!(again.request.job_id, job);
        assert_eq!(again.state, RunState::Extracting);
        assert_eq!(again.provider_session_id.as_deref(), Some("s-a"));
        let after = dispatch(d.path(), &job, &[sess(Provider::Claude, "s-b")]).unwrap();
        assert_eq!(after.provider_session_id.as_deref(), Some("s-a"));
    }

    #[test]
    fn different_members_never_share_a_job() {
        let d = tempfile::tempdir().unwrap();
        let a = request(d.path(), input(ProviderChoice::Any)).unwrap();
        let mut other = input(ProviderChoice::Any);
        other.member_uid = "prs_other".into();
        assert_ne!(
            request(d.path(), other).unwrap().request.job_id,
            a.request.job_id
        );
    }
}

mod ac2_states_timestamps_status {
    use super::*;

    #[test]
    fn state_vocabulary_is_exactly_the_eight_states() {
        let names = [
            "pending",
            "claimed",
            "extracting",
            "writing",
            "uploading",
            "complete",
            "cancelled",
            "failed",
        ];
        for n in names {
            let s: RunState = serde_json::from_value(n.into()).unwrap();
            assert_eq!(serde_json::to_value(s).unwrap(), n);
            assert!(!s.default_status().is_empty());
        }
        for bad in ["queued", "running", "done", "Pending"] {
            assert!(
                serde_json::from_value::<RunState>(bad.into()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn full_lifecycle_records_each_state_with_ordered_timestamps() {
        let d = tempfile::tempdir().unwrap();
        let job = run_to_parse(d.path(), "s-a", None);
        progress(d.path(), &job, "s-a", RunState::Writing, None).unwrap();
        progress(d.path(), &job, "s-a", RunState::Uploading, None).unwrap();
        let rec = progress(d.path(), &job, "s-a", RunState::Complete, None).unwrap();
        let states: Vec<_> = rec.history.iter().map(|t| t.state).collect();
        assert_eq!(
            states,
            [
                RunState::Pending,
                RunState::Claimed,
                RunState::Extracting,
                RunState::Writing,
                RunState::Uploading,
                RunState::Complete
            ]
        );
        let times: Vec<_> = rec
            .history
            .iter()
            .map(|t| chrono::DateTime::parse_from_rfc3339(&t.at).unwrap())
            .collect();
        assert!(times.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(rec.updated_at, rec.history.last().unwrap().at);
        assert_eq!(rec.status, RunState::Complete.default_status());
        assert_eq!(load(d.path(), &job).unwrap(), rec);
    }

    #[test]
    fn status_is_plain_and_bounded() {
        let d = tempfile::tempdir().unwrap();
        let job = run_to_parse(d.path(), "s-a", None);
        let noisy = format!("Writing\u{1b}[31m\n{}", "x".repeat(5000));
        let rec = progress(d.path(), &job, "s-a", RunState::Writing, Some(&noisy)).unwrap();
        assert!(rec.status.chars().count() <= 160);
        assert!(!rec.status.chars().any(|c| c.is_control()));
    }

    #[test]
    fn failed_is_reachable_and_terminal() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input(ProviderChoice::Claude))
            .unwrap()
            .request
            .job_id;
        claim(d.path(), &job, &sess(Provider::Claude, "s-a"), None).unwrap();
        let rec = progress(
            d.path(),
            &job,
            "s-a",
            RunState::Failed,
            Some("Model output did not parse."),
        )
        .unwrap();
        assert_eq!(rec.state, RunState::Failed);
        assert!(progress(d.path(), &job, "s-a", RunState::Extracting, None).is_err());
    }
}

mod ac3_session_scoping {
    use super::*;

    #[test]
    fn concurrent_sessions_only_move_their_own_job() {
        let d = tempfile::tempdir().unwrap();
        let ja = request(d.path(), input(ProviderChoice::Claude))
            .unwrap()
            .request
            .job_id;
        let mut ib = input(ProviderChoice::Codex);
        ib.source_ref = "sources/meetings/mtg-other.md".into();
        let jb = request(d.path(), ib).unwrap().request.job_id;
        claim(d.path(), &ja, &sess(Provider::Claude, "s-a"), Some(11)).unwrap();
        claim(d.path(), &jb, &sess(Provider::Codex, "s-b"), Some(22)).unwrap();

        let before_b = load(d.path(), &jb).unwrap();
        assert!(progress(d.path(), &jb, "s-a", RunState::Extracting, None).is_err());
        assert!(store_parsed_result(d.path(), &jb, "s-a", &serde_json::json!({})).is_err());
        assert!(cancel(d.path(), &jb, Some("s-a")).is_err());
        assert!(recover(
            d.path(),
            &jb,
            &sess(Provider::Codex, "s-a"),
            Some(11),
            |_| true
        )
        .is_err());
        assert_eq!(load(d.path(), &jb).unwrap(), before_b);

        progress(d.path(), &ja, "s-a", RunState::Extracting, None).unwrap();
        assert_eq!(load(d.path(), &jb).unwrap(), before_b);
        assert_eq!(load(d.path(), &ja).unwrap().owner_pid, Some(11));
    }

    #[test]
    fn a_claimed_job_cannot_be_claimed_again() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input(ProviderChoice::Any))
            .unwrap()
            .request
            .job_id;
        claim(d.path(), &job, &sess(Provider::Claude, "s-a"), Some(1)).unwrap();
        assert!(claim(d.path(), &job, &sess(Provider::Codex, "s-b"), Some(2)).is_err());
        assert_eq!(
            load(d.path(), &job).unwrap().provider_session_id.as_deref(),
            Some("s-a")
        );
    }

    #[test]
    fn recovery_takes_over_only_when_the_owner_process_is_gone() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input(ProviderChoice::Claude))
            .unwrap()
            .request
            .job_id;
        claim(d.path(), &job, &sess(Provider::Claude, "s-a"), Some(4242)).unwrap();
        assert!(recover(
            d.path(),
            &job,
            &sess(Provider::Claude, "s-b"),
            Some(7),
            |_| true
        )
        .is_err());
        let plan = recover(
            d.path(),
            &job,
            &sess(Provider::Claude, "s-b"),
            Some(7),
            |p| p != 4242,
        )
        .unwrap();
        assert_eq!(plan.record.provider_session_id.as_deref(), Some("s-b"));
        assert_eq!(plan.record.owner_pid, Some(7));
        // The displaced session can no longer touch the run.
        assert!(progress(d.path(), &job, "s-a", RunState::Extracting, None).is_err());
    }

    #[test]
    fn ui_cancel_releases_ownership_and_stops_the_session() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input(ProviderChoice::Claude))
            .unwrap()
            .request
            .job_id;
        claim(d.path(), &job, &sess(Provider::Claude, "s-a"), Some(1)).unwrap();
        let rec = cancel(d.path(), &job, None).unwrap();
        assert_eq!(rec.state, RunState::Cancelled);
        assert!(rec.provider_session_id.is_none() && rec.owner_pid.is_none());
        assert!(progress(d.path(), &job, "s-a", RunState::Extracting, None).is_err());
    }
}

mod ac4_resume_without_second_model_call {
    use super::*;

    #[test]
    fn interrupted_after_parse_resumes_at_writing_with_no_model_call() {
        let d = tempfile::tempdir().unwrap();
        let job = run_to_parse(d.path(), "s-a", Some(99));
        let stored = read_parsed_result(d.path(), &job).unwrap().unwrap();
        // Owner process died mid-run; a new session picks it up from disk.
        let plan = recover(d.path(), &job, &sess(Provider::Claude, "s-b"), None, |_| {
            false
        })
        .unwrap();
        assert!(!plan.needs_model_call);
        assert_eq!(plan.record.state, RunState::Writing);
        assert_eq!(read_parsed_result(d.path(), &job).unwrap().unwrap(), stored);
        assert!(
            store_parsed_result(d.path(), &job, "s-b", &serde_json::json!({ "signals": [] }))
                .is_err()
        );
        progress(d.path(), &job, "s-b", RunState::Uploading, None).unwrap();
        assert_eq!(
            progress(d.path(), &job, "s-b", RunState::Complete, None)
                .unwrap()
                .state,
            RunState::Complete
        );
    }

    #[test]
    fn cancelled_after_parse_and_reactivated_keeps_the_parse() {
        let d = tempfile::tempdir().unwrap();
        let job = run_to_parse(d.path(), "s-a", None);
        let digest = load(d.path(), &job).unwrap().parsed_result_digest.clone();
        cancel(d.path(), &job, None).unwrap();
        let again = request(d.path(), input(ProviderChoice::Claude)).unwrap();
        assert_eq!(again.request.job_id, job);
        assert_eq!(again.state, RunState::Pending);
        assert_eq!(again.parsed_result_digest, digest);
        let plan = recover(d.path(), &job, &sess(Provider::Claude, "s-c"), None, |_| {
            false
        })
        .unwrap();
        assert!(!plan.needs_model_call);
        assert_eq!(plan.record.state, RunState::Writing);
    }

    #[test]
    fn interrupted_while_uploading_does_not_move_backwards() {
        let d = tempfile::tempdir().unwrap();
        let job = run_to_parse(d.path(), "s-a", Some(5));
        progress(d.path(), &job, "s-a", RunState::Writing, None).unwrap();
        progress(d.path(), &job, "s-a", RunState::Uploading, None).unwrap();
        let plan = recover(d.path(), &job, &sess(Provider::Claude, "s-b"), None, |_| {
            false
        })
        .unwrap();
        assert!(!plan.needs_model_call);
        assert_eq!(plan.record.state, RunState::Uploading);
    }

    #[test]
    fn interrupted_before_parse_still_needs_the_model() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input(ProviderChoice::Claude))
            .unwrap()
            .request
            .job_id;
        claim(d.path(), &job, &sess(Provider::Claude, "s-a"), Some(5)).unwrap();
        progress(d.path(), &job, "s-a", RunState::Extracting, None).unwrap();
        let plan = recover(d.path(), &job, &sess(Provider::Claude, "s-b"), None, |_| {
            false
        })
        .unwrap();
        assert!(plan.needs_model_call);
        assert_eq!(plan.record.state, RunState::Claimed);
    }

    #[test]
    fn tampered_stored_parse_is_refused_not_regenerated() {
        let d = tempfile::tempdir().unwrap();
        let job = run_to_parse(d.path(), "s-a", None);
        std::fs::write(result_path(d.path(), &job), b"{\"signals\":[\"forged\"]}").unwrap();
        assert!(read_parsed_result(d.path(), &job).is_err());
        let plan = recover(d.path(), &job, &sess(Provider::Claude, "s-a"), None, |_| {
            true
        })
        .unwrap();
        assert!(!plan.needs_model_call);
    }
}

mod ac5_no_session_stays_pending {
    use super::*;

    #[test]
    fn no_or_incompatible_sessions_leave_the_run_pending_and_unowned() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input(ProviderChoice::Claude))
            .unwrap()
            .request
            .job_id;
        for sessions in [
            vec![],
            vec![headless(Provider::Claude, "h-1")],
            vec![sess(Provider::Codex, "s-codex")],
            vec![
                headless(Provider::Claude, "h-2"),
                sess(Provider::Codex, "s-codex"),
            ],
        ] {
            let rec = dispatch(d.path(), &job, &sessions).unwrap();
            assert_eq!(rec.state, RunState::Pending);
            assert!(
                rec.claimed_by.is_none()
                    && rec.provider_session_id.is_none()
                    && rec.owner_pid.is_none()
            );
            assert_eq!(rec.status, RunState::Pending.default_status());
        }
        assert_eq!(load(d.path(), &job).unwrap().history.len(), 1);
        // Only the record file exists: no result, no fallback artifact.
        assert_eq!(files(d.path()), 1);
    }

    #[test]
    fn headless_sessions_cannot_claim_or_recover() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input(ProviderChoice::Any))
            .unwrap()
            .request
            .job_id;
        assert!(claim(d.path(), &job, &headless(Provider::Claude, "h"), None).is_err());
        assert!(recover(
            d.path(),
            &job,
            &headless(Provider::Codex, "h"),
            None,
            |_| false
        )
        .is_err());
        assert_eq!(load(d.path(), &job).unwrap().state, RunState::Pending);
    }

    #[test]
    fn a_compatible_interactive_session_later_picks_it_up() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input(ProviderChoice::Codex))
            .unwrap()
            .request
            .job_id;
        dispatch(d.path(), &job, &[]).unwrap();
        let rec = dispatch(
            d.path(),
            &job,
            &[headless(Provider::Codex, "h"), sess(Provider::Codex, "s-x")],
        )
        .unwrap();
        assert_eq!(rec.state, RunState::Claimed);
        assert_eq!(rec.claimed_by, Some(Provider::Codex));
        assert_eq!(rec.provider_session_id.as_deref(), Some("s-x"));
    }

    #[test]
    fn module_names_no_cloud_or_headless_path() {
        let src = include_str!("local_signal_runs.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        for needle in [
            "reqwest",
            "http://",
            "https://",
            "bedrock",
            "--print",
            "\"-p\"",
            "headless(",
            "Command::new",
            "tokio::process",
        ] {
            assert!(!body.contains(needle), "unexpected {needle}");
        }
    }
}

mod ac6_async_commands_off_the_ui_thread {
    use super::*;

    fn command_fns(src: &str) -> Vec<String> {
        src.split("#[tauri::command]")
            .skip(1)
            .map(|s| {
                let end = s.find("\n}\n").expect("command body");
                s[..end].to_string()
            })
            .collect()
    }

    #[test]
    fn every_command_is_async_and_does_its_io_in_blocking() {
        let src = include_str!("local_signal_runs.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        let cmds = command_fns(body);
        assert_eq!(cmds.len(), 10);
        for c in &cmds {
            assert!(
                c.trim_start().starts_with("pub async fn local_signal_run_"),
                "{c}"
            );
            assert!(
                c.contains("blocking(move ||"),
                "command does I/O on the async thread: {c}"
            );
        }
        let helper = &body[body.find("async fn blocking").unwrap()..];
        assert!(helper[..helper.find("\n}\n").unwrap()].contains("tokio::task::spawn_blocking"));
    }

    #[test]
    fn every_command_is_registered_with_the_app() {
        let main = include_str!("../main.rs");
        let body = include_str!("local_signal_runs.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for c in command_fns(body) {
            let name = c
                .trim_start()
                .trim_start_matches("pub async fn ")
                .split('(')
                .next()
                .unwrap()
                .to_string();
            assert!(
                main.contains(&format!("commands::local_signal_runs::{name}")),
                "{name} not registered"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_work_leaves_the_async_thread_free() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let slow = tokio::spawn(blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "timed out".to_string())
        }));
        // On a single-threaded runtime this only runs if `blocking` yielded.
        let ui = tokio::spawn(async move {
            tx.send(()).unwrap();
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), ui)
            .await
            .unwrap()
            .unwrap();
        assert!(slow.await.unwrap().is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_activations_serialise_into_one_job() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().to_path_buf();
        let tasks: Vec<_> = (0..12)
            .map(|_| {
                let dir = dir.clone();
                tokio::spawn(blocking(move || request(&dir, input(ProviderChoice::Any))))
            })
            .collect();
        let mut ids = HashSet::new();
        for t in tasks {
            ids.insert(t.await.unwrap().unwrap().request.job_id);
        }
        assert_eq!(ids.len(), 1);
        let runs = list(&dir).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].activations, 12);
    }
}
