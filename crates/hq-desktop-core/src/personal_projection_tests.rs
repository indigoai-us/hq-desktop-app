//! Hermetic tests for the personal-projection client. A fake runner records
//! every request and replays canned exit codes and stdout; nothing is spawned
//! except the `/bin/sh` fixtures in the `run_bounded` tests.

use super::*;
use std::cell::RefCell;
use std::collections::VecDeque;

const ROOT: &str = "/tmp/h8-root/hq";
const DIGEST: &str = "sha256:plan-digest";

struct FakeRunner {
    replies: RefCell<VecDeque<RunOutput>>,
    calls: RefCell<Vec<(Action, Vec<u8>)>>,
}

impl FakeRunner {
    fn new(replies: Vec<RunOutput>) -> Self {
        Self {
            replies: RefCell::new(replies.into()),
            calls: RefCell::new(Vec::new()),
        }
    }
}

impl ProjectionRunner for &FakeRunner {
    fn run(&self, action: Action, stdin: &[u8]) -> RunOutput {
        self.calls.borrow_mut().push((action, stdin.to_vec()));
        self.replies
            .borrow_mut()
            .pop_front()
            .expect("unexpected extra wrapper call")
    }
}

fn exited(code: i32, stdout: &str) -> RunOutput {
    RunOutput::Exited {
        code: Some(code),
        stdout: stdout.as_bytes().to_vec(),
    }
}

fn new_root() -> RunOutput {
    exited(0, r#"{"schemaVersion":1,"status":"new_root"}"#)
}

fn actions(fake: &FakeRunner) -> Vec<Action> {
    fake.calls.borrow().iter().map(|(a, _)| *a).collect()
}

fn paused(reason: &str, retryable: bool, required: &str, exit: i32) -> RunOutput {
    exited(
        exit,
        &format!(
            r#"{{"schemaVersion":1,"status":"paused","reason":"{reason}","retryable":{retryable},"requiredAction":"{required}"}}"#
        ),
    )
}

/// Field order and spacing deliberately differ from serde's own output so a
/// re-encoding would be caught by the byte comparison.
fn plan_json() -> String {
    format!(
        r#"{{ "transactionId":"tx-1","schemaVersion":1,"rootPath":"{ROOT}","stateDirectory":"/tmp/h8-state",
"destination":{{"uid":"psn_1","bucket":"b","endpoint":"https://s3","region":"us-east-1"}},
"authorityDigest":"a","inventoryDigest":"i","approvedPlanDigest":"{DIGEST}","fileCount":2,"byteCount":10,
"historicalUids":[],"historicalBucket":"unknown",
"uploadEntries":[{{"key":"a.md","kind":"file","localHash":"l","wireHash":"w","size":5,"wireSize":5}}],
"preservedOnly":[{{"key":".env","reason":"secret"}}],
"permissions":{{"upload":true,"remoteDelete":false,"localDelete":false,"overwriteExisting":false}},
"maxUploadRows":10,"maxUploadBytes":100,"maxDurationMs":600000,
"rootDevice":1,"rootInode":2,"stateDevice":null,"stateInode":null }}"#
    )
}

fn plan_reply() -> RunOutput {
    exited(
        0,
        &format!(
            r#"{{"schemaVersion":1,"status":"review_required","plan":{}}}"#,
            plan_json()
        ),
    )
}

fn approval(phase: Phase) -> UserApproval {
    UserApproval {
        phase,
        plan_digest: DIGEST.to_string(),
    }
}

#[test]
fn every_action_has_the_contract_argv_and_limit() {
    let names: Vec<&str> = Action::ALL.iter().map(|a| a.as_str()).collect();
    assert_eq!(
        names,
        [
            "inspect",
            "initialize",
            "plan-adoption",
            "preserve",
            "adopt",
            "baseline",
            "resume"
        ]
    );
    for action in Action::ALL {
        assert_eq!(
            action.argv(),
            ["personal-projection", action.as_str(), "--stdin-json"]
        );
    }
    assert_eq!(Action::Inspect.request_limit(), 65_536);
    assert_eq!(Action::PlanAdoption.request_limit(), 65_536);
    assert_eq!(Action::Baseline.request_limit(), 16 * 1024 * 1024);
}

#[test]
fn inspect_sends_only_schema_and_root() {
    let fake = FakeRunner::new(vec![new_root()]);
    let client = PersonalProjectionClient::new(&fake);
    assert_eq!(
        client.inspect(ROOT),
        Outcome::Done(InspectReport {
            status: InspectStatus::NewRoot,
            projection_id: None
        })
    );
    let request: serde_json::Value = serde_json::from_slice(&fake.calls.borrow()[0].1).unwrap();
    assert_eq!(
        request,
        serde_json::json!({"schemaVersion": 1, "rootPath": ROOT})
    );
}

#[test]
fn initialize_runs_only_after_a_typed_inspect_probe() {
    let fake = FakeRunner::new(vec![
        new_root(),
        exited(
            0,
            &format!(
                r#"{{"schemaVersion":1,"status":"initialized","projectionId":"p1","rootPath":"{ROOT}","journalScope":"journal:__hq_personal_vault__"}}"#
            ),
        ),
    ]);
    let client = PersonalProjectionClient::new(&fake);
    let Outcome::Done(init) = client.initialize(ROOT) else {
        panic!("initialize should succeed");
    };
    assert_eq!(init.projection_id, "p1");
    assert_eq!(actions(&fake), [Action::Inspect, Action::Initialize]);
}

#[test]
fn usage_text_from_an_old_binary_is_unsupported_and_stops_the_session() {
    let fake = FakeRunner::new(vec![exited(2, "Usage: hq-cloud <command>\n")]);
    let client = PersonalProjectionClient::new(&fake);
    assert_eq!(
        client.initialize(ROOT),
        Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
    );
    // The probe failed, so initialize never ran, and later calls do not spawn.
    assert_eq!(actions(&fake), [Action::Inspect]);
    assert_eq!(
        client.inspect(ROOT),
        Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
    );
    assert_eq!(fake.calls.borrow().len(), 1);
}

#[test]
fn malformed_results_are_unsupported() {
    let cases = [
        exited(0, "not json"),
        exited(0, r#"{"schemaVersion":2,"status":"new_root"}"#),
        exited(0, r#"{"schemaVersion":1,"status":"brand_new"}"#),
        exited(0, r#"{"schemaVersion":1,"status":"new_root","extra":true}"#),
        exited(3, r#"{"schemaVersion":1,"status":"new_root"}"#),
        exited(0, r#"{"schemaVersion":1,"status":"adoption_required"}"#),
        paused("mystery", false, "review_recovery", 3),
        // retryable disagrees with the table
        paused("busy", false, "retry_when_idle", 3),
        // requiredAction disagrees with the table
        paused("owner_mismatch", false, "review_adoption", 3),
        // paused must exit 3
        paused("busy", true, "retry_when_idle", 0),
        // exit 2 without typed JSON
        exited(2, ""),
        RunOutput::ArtifactUnverified,
    ];
    for reply in cases {
        let fake = FakeRunner::new(vec![reply.clone()]);
        let client = PersonalProjectionClient::new(&fake);
        assert_eq!(
            client.inspect(ROOT),
            Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli)),
            "{reply:?}"
        );
    }
}

#[test]
fn both_adoption_required_shapes_route_to_review() {
    let fake = FakeRunner::new(vec![exited(
        3,
        r#"{"schemaVersion":1,"status":"adoption_required","projectionId":"p0"}"#,
    )]);
    let client = PersonalProjectionClient::new(&fake);
    let Outcome::Done(report) = client.inspect(ROOT) else {
        panic!("inspect adoption_required is a typed status");
    };
    assert!(report.requires_adoption());

    let fake = FakeRunner::new(vec![
        new_root(),
        exited(
            3,
            r#"{"schemaVersion":1,"status":"paused","reason":"adoption_required","retryable":false,"requiredAction":"review_adoption","recovery":{"schemaVersion":1,"commands":["hq-cloud personal-projection plan-adoption --stdin-json"],"approvalRequired":true}}"#,
        ),
    ]);
    let client = PersonalProjectionClient::new(&fake);
    let Outcome::Paused(pause) = client.initialize(ROOT) else {
        panic!("initialize should pause");
    };
    assert!(pause.requires_adoption());
    assert!(!pause.retryable());
}

#[test]
fn every_wire_reason_maps_with_its_exit_code() {
    let table = [
        ("adoption_required", false, "review_adoption", 3),
        ("owner_mismatch", false, "review_recovery", 3),
        ("authority_changed", false, "review_recovery", 3),
        ("authority_unavailable", true, "retry_authority", 3),
        ("state_unreadable", false, "review_recovery", 3),
        ("state_changed", false, "review_recovery", 3),
        ("root_replaced", false, "review_recovery", 3),
        ("busy", true, "retry_when_idle", 3),
        ("invalid_request", false, "correct_request", 2),
        ("lease_released", false, "review_recovery", 3),
    ];
    for (reason, retryable, required, exit) in table {
        let fake = FakeRunner::new(vec![paused(reason, retryable, required, exit)]);
        let client = PersonalProjectionClient::new(&fake);
        let Outcome::Paused(Pause::Wire(pause)) = client.inspect(ROOT) else {
            panic!("{reason} should be a typed pause");
        };
        assert_eq!(pause.retryable, retryable, "{reason}");
        assert_eq!(
            serde_json::to_value(pause.reason).unwrap(),
            serde_json::json!(reason)
        );
    }
}

#[test]
fn recovery_is_only_accepted_on_adoption_required() {
    let fake = FakeRunner::new(vec![exited(
        3,
        r#"{"schemaVersion":1,"status":"paused","reason":"busy","retryable":true,"requiredAction":"retry_when_idle","recovery":{"schemaVersion":1,"commands":[],"approvalRequired":true}}"#,
    )]);
    let client = PersonalProjectionClient::new(&fake);
    assert_eq!(
        client.inspect(ROOT),
        Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
    );
}

#[test]
fn initialize_naming_a_different_root_is_unsupported() {
    let fake = FakeRunner::new(vec![
        new_root(),
        exited(
            0,
            r#"{"schemaVersion":1,"status":"initialized","projectionId":"p1","rootPath":"/elsewhere/hq","journalScope":"j"}"#,
        ),
    ]);
    let client = PersonalProjectionClient::new(&fake);
    assert_eq!(
        client.initialize(ROOT),
        Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
    );
}

#[test]
fn relative_roots_are_refused_without_spawning() {
    let fake = FakeRunner::new(vec![]);
    let client = PersonalProjectionClient::new(&fake);
    assert_eq!(
        client.inspect("hq"),
        Outcome::Paused(Pause::Local(LocalPause::RequestRejected))
    );
    assert!(fake.calls.borrow().is_empty());
}

#[test]
fn local_runner_failures_keep_their_reason() {
    for (output, expected) in [
        (RunOutput::SpawnFailed, LocalPause::SpawnFailed),
        (RunOutput::Timeout, LocalPause::Timeout),
        (RunOutput::Cancelled, LocalPause::Cancelled),
        (RunOutput::ResponseTooLarge, LocalPause::ResponseTooLarge),
    ] {
        let fake = FakeRunner::new(vec![output]);
        let client = PersonalProjectionClient::new(&fake);
        assert_eq!(
            client.initialize(ROOT),
            Outcome::Paused(Pause::Local(expected))
        );
        // A failed probe never lets initialize run.
        assert_eq!(actions(&fake), [Action::Inspect]);
    }
}

#[test]
fn the_plan_round_trips_byte_identical_through_all_four_phases() {
    let fake = FakeRunner::new(vec![
        new_root(),
        plan_reply(),
        exited(
            0,
            &format!(
                r#"{{"schemaVersion":1,"status":"preserved_pending_adoption","transactionId":"tx-1","approvedPlanDigest":"{DIGEST}","snapshotDirectory":"/s","snapshotDigest":"sd","enrolled":false,"resumed":false,"stateDevice":1,"stateInode":2}}"#
            ),
        ),
        exited(
            0,
            r#"{"schemaVersion":1,"status":"adopted_pending_baseline","projectionId":"p1","resumed":false}"#,
        ),
        exited(
            0,
            r#"{"schemaVersion":1,"status":"baseline_ready","projectionId":"p1","receiptDigest":"rd","resumed":false}"#,
        ),
        exited(
            0,
            r#"{"schemaVersion":1,"status":"resume_authorized","projectionId":"p1","runnerStarted":false}"#,
        ),
    ]);
    let client = PersonalProjectionClient::new(&fake);
    let Outcome::Done(plan) = client.plan_adoption(ROOT) else {
        panic!("plan-adoption should succeed");
    };
    assert_eq!(plan.raw_json(), plan_json());
    assert!(matches!(
        client.preserve(&plan, &approval(Phase::Preserve)),
        Outcome::Done(_)
    ));
    assert!(matches!(
        client.adopt(&plan, &approval(Phase::Adopt)),
        Outcome::Done(_)
    ));
    let Outcome::Done(baseline) = client.baseline(&plan, &approval(Phase::Baseline)) else {
        panic!("baseline should succeed");
    };
    let Outcome::Done(resumed) = client.resume(&plan, &approval(Phase::Resume), &baseline) else {
        panic!("resume should succeed");
    };
    assert!(!resumed.runner_started);

    let calls = fake.calls.borrow();
    let expected_dispositions = [
        None,
        Some("reviewed-preserved-bytes-belong-to-authenticated-destination"),
        Some("upload-only-reviewed-snapshot-to-pinned-destination"),
        Some("resume-verified-personal-projection"),
    ];
    for (call, disposition) in calls[2..].iter().zip(expected_dispositions) {
        let body = std::str::from_utf8(&call.1).unwrap();
        assert!(
            body.contains(&plan_json()),
            "{:?} must carry the plan verbatim",
            call.0
        );
        let value: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(value["approval"]["planDigest"], DIGEST);
        assert_eq!(
            value["approval"]["disposition"].as_str(),
            disposition,
            "{:?}",
            call.0
        );
        assert_eq!(value.as_object().unwrap().len(), 3);
    }
    let resume: serde_json::Value = serde_json::from_slice(&calls[5].1).unwrap();
    assert_eq!(resume["approval"]["receiptDigest"], "rd");
}

#[test]
fn approvals_for_another_phase_or_digest_are_refused_without_spawning() {
    let fake = FakeRunner::new(vec![new_root(), plan_reply()]);
    let client = PersonalProjectionClient::new(&fake);
    let Outcome::Done(plan) = client.plan_adoption(ROOT) else {
        panic!("plan-adoption should succeed");
    };
    assert_eq!(
        client.adopt(&plan, &approval(Phase::Preserve)),
        Outcome::Paused(Pause::Local(LocalPause::RequestRejected))
    );
    let wrong = UserApproval {
        phase: Phase::Preserve,
        plan_digest: "sha256:other".to_string(),
    };
    assert_eq!(
        client.preserve(&plan, &wrong),
        Outcome::Paused(Pause::Local(LocalPause::RequestRejected))
    );
    assert_eq!(fake.calls.borrow().len(), 2);
}

#[test]
fn a_plan_that_breaks_the_fixed_permissions_is_unsupported() {
    let bad = plan_json().replace(r#""remoteDelete":false"#, r#""remoteDelete":true"#);
    let fake = FakeRunner::new(vec![
        new_root(),
        exited(
            0,
            &format!(r#"{{"schemaVersion":1,"status":"review_required","plan":{bad}}}"#),
        ),
    ]);
    let client = PersonalProjectionClient::new(&fake);
    assert!(matches!(
        client.plan_adoption(ROOT),
        Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
    ));
}

#[test]
fn resume_that_claims_it_started_a_runner_is_unsupported() {
    let fake = FakeRunner::new(vec![
        new_root(),
        plan_reply(),
        exited(
            0,
            r#"{"schemaVersion":1,"status":"resume_authorized","projectionId":"p1","runnerStarted":true}"#,
        ),
    ]);
    let client = PersonalProjectionClient::new(&fake);
    let Outcome::Done(plan) = client.plan_adoption(ROOT) else {
        panic!("plan-adoption should succeed");
    };
    let baseline: BaselineReady = serde_json::from_str(
        r#"{"schemaVersion":1,"status":"baseline_ready","projectionId":"p1","receiptDigest":"rd","resumed":false}"#,
    )
    .unwrap();
    assert_eq!(
        client.resume(&plan, &approval(Phase::Resume), &baseline),
        Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
    );
}

#[test]
fn an_oversized_phase_request_is_refused_without_spawning() {
    let huge_key = "k".repeat(PHASE_REQUEST_LIMIT);
    let big = plan_json().replace(r#""key":".env""#, &format!(r#""key":"{huge_key}""#));
    let plan = ReviewedPlan::from_persisted(&big).expect("plan parses");
    let fake = FakeRunner::new(vec![new_root()]);
    let client = PersonalProjectionClient::new(&fake);
    assert_eq!(
        client.preserve(&plan, &approval(Phase::Preserve)),
        Outcome::Paused(Pause::Local(LocalPause::RequestRejected))
    );
    // Only the probe ran.
    assert_eq!(actions(&fake), [Action::Inspect]);
}

#[test]
fn a_persisted_plan_keeps_its_exact_bytes() {
    let plan = ReviewedPlan::from_persisted(&plan_json()).unwrap();
    assert_eq!(plan.raw_json(), plan_json());
    assert_eq!(plan.plan().approved_plan_digest, DIGEST);
    assert!(ReviewedPlan::from_persisted("{}").is_none());
}

#[cfg(unix)]
mod process {
    use super::super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    fn sh(script: &str) -> std::process::Command {
        let mut command = std::process::Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    #[test]
    fn stdin_reaches_the_child_and_stdout_and_exit_come_back() {
        let out = run_bounded(
            sh("cat; exit 3"),
            b"{\"a\":1}",
            Duration::from_secs(10),
            None,
        );
        assert_eq!(
            out,
            RunOutput::Exited {
                code: Some(3),
                stdout: b"{\"a\":1}".to_vec()
            }
        );
    }

    #[test]
    fn a_hung_child_is_killed_at_the_timeout() {
        let started = Instant::now();
        let out = run_bounded(sh("sleep 30"), b"", Duration::from_millis(200), None);
        assert_eq!(out, RunOutput::Timeout);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_late_success_after_cancel_is_discarded() {
        let cancel = AtomicBool::new(true);
        let out = run_bounded(sh("echo '{}'"), b"", Duration::from_secs(10), Some(&cancel));
        assert_eq!(out, RunOutput::Cancelled);
    }

    #[test]
    fn a_missing_program_is_a_spawn_failure() {
        let out = run_bounded(
            std::process::Command::new("/definitely/not/here/hq-cloud"),
            b"",
            Duration::from_secs(1),
            None,
        );
        assert_eq!(out, RunOutput::SpawnFailed);
    }

    #[test]
    fn npx_args_name_the_hq_cloud_bin_and_the_action() {
        let runner = NpxProjectionRunner::for_exact_version("9.9.9");
        assert_eq!(
            runner.npx_args(Action::PlanAdoption),
            [
                "-y",
                "--package=@indigoai-us/hq-cloud@9.9.9",
                "hq-cloud",
                "personal-projection",
                "plan-adoption",
                "--stdin-json"
            ]
        );
    }
}
