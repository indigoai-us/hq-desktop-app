//! Hermetic tests for the personal-projection client. A fake runner records
//! every request and replays canned exit codes and stdout; nothing is spawned
//! except the `/bin/sh` fixtures in the `run_bounded` tests.

use super::*;
use std::cell::RefCell;
use std::collections::VecDeque;

const ROOT: &str = "/tmp/h8-root/hq";
const DIGEST: &str = "sha256:plan-digest";
const STATE: &str = "/tmp/h8-state";

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
    let Outcome::Done(plan) = client.plan_adoption(ROOT, STATE) else {
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
    let Outcome::Done(plan) = client.plan_adoption(ROOT, STATE) else {
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
        client.plan_adoption(ROOT, STATE),
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
    let Outcome::Done(plan) = client.plan_adoption(ROOT, STATE) else {
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

#[test]
fn a_plan_for_another_state_directory_is_unsupported() {
    let fake = FakeRunner::new(vec![new_root(), plan_reply()]);
    let client = PersonalProjectionClient::new(&fake);
    assert_eq!(
        client
            .plan_adoption(ROOT, "/Users/someone/.hq")
            .map_done(|_| ()),
        Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
    );
}

trait MapDone<T> {
    fn map_done<U>(self, f: impl FnOnce(T) -> U) -> Outcome<U>;
}

impl<T> MapDone<T> for Outcome<T> {
    fn map_done<U>(self, f: impl FnOnce(T) -> U) -> Outcome<U> {
        match self {
            Outcome::Done(value) => Outcome::Done(f(value)),
            Outcome::Paused(pause) => Outcome::Paused(pause),
        }
    }
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

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks for existence.
        unsafe { libc::kill(pid, 0) == 0 }
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

    /// Review C1: the leader exits but a descendant keeps stdout open. The
    /// call must return promptly, and the descendant must be killed.
    #[test]
    fn a_descendant_holding_stdout_cannot_hang_the_drain() {
        let started = Instant::now();
        let out = run_bounded(
            sh("sleep 30 & echo \"$!\"; exit 0"),
            b"",
            Duration::from_secs(60),
            None,
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "returned after {:?}",
            started.elapsed()
        );
        let RunOutput::Exited { code, stdout } = out else {
            panic!("expected Exited, got {out:?}");
        };
        assert_eq!(code, Some(0));
        let pid: i32 = String::from_utf8(stdout).unwrap().trim().parse().unwrap();
        // The owned tree was killed: the background sleep is gone (allow a
        // moment for the kernel to deliver SIGKILL and the reaper to run).
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(pid), "descendant {pid} still running");
    }

    /// The same during a cancel: the cancel returns promptly even though a
    /// descendant holds stdout, and the tree is killed.
    #[test]
    fn a_cancel_with_a_descendant_holding_stdout_returns_promptly() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let setter = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            setter.store(true, std::sync::atomic::Ordering::Release);
        });
        let started = Instant::now();
        let out = run_bounded(
            sh("sleep 30 & sleep 30"),
            b"",
            Duration::from_secs(60),
            Some(&cancel),
        );
        assert_eq!(out, RunOutput::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_hung_child_is_killed_at_the_timeout() {
        let started = Instant::now();
        let out = run_bounded(sh("sleep 30"), b"", Duration::from_millis(200), None);
        assert_eq!(out, RunOutput::Timeout);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// Review #9: the cancel lands after the child already exited
    /// successfully. The success must still be discarded.
    #[test]
    fn a_late_success_after_cancel_is_discarded() {
        let cancel = AtomicBool::new(false);
        let out = run_bounded_with_hook(
            sh("echo '{}'; exit 0"),
            b"",
            Duration::from_secs(10),
            Some(&cancel),
            &|| cancel.store(true, std::sync::atomic::Ordering::Release),
        );
        assert_eq!(out, RunOutput::Cancelled);
    }

    /// Review #8: a child that overflows stdout is stopped at once and
    /// reported as too large, not left to run until the timeout.
    #[test]
    fn oversized_output_is_stopped_promptly() {
        let started = Instant::now();
        let out = run_bounded(
            sh("yes 0123456789012345678901234567890123456789; sleep 30"),
            b"",
            Duration::from_secs(120),
            None,
        );
        assert_eq!(out, RunOutput::ResponseTooLarge);
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "took {:?}",
            started.elapsed()
        );
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
    fn node_args_run_the_verified_bin_with_the_action() {
        let bin = std::path::Path::new(
            "/cache/entry/node_modules/@indigoai-us/hq-cloud/dist/bin/sync-mutation.js",
        );
        assert_eq!(
            PinnedProjectionRunner::node_args(bin, Action::PlanAdoption),
            [
                "/cache/entry/node_modules/@indigoai-us/hq-cloud/dist/bin/sync-mutation.js",
                "personal-projection",
                "plan-adoption",
                "--stdin-json"
            ]
        );
    }
}

fn test_pin(version: &'static str) -> ArtifactPin {
    ArtifactPin {
        version,
        integrity: concat!(
            "sha512-",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
        ),
        installed_tree_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    }
}

mod pin {
    use super::*;

    #[test]
    fn the_shipped_pin_is_empty_so_the_client_is_unreachable() {
        assert_eq!(HQ_CLOUD_PERSONAL_PROJECTION_ARTIFACT, None);
        assert!(!personal_projection_supported());
        assert!(production_client().is_none());
    }

    #[test]
    fn only_an_exact_version_with_full_integrity_is_well_formed() {
        assert!(pin_is_well_formed(&test_pin("6.19.0")));
        for range in [
            "~6.19.0", "^6.19.0", ">=6.19.0", "6.19", "6.19.x", "latest", "",
        ] {
            assert!(!pin_is_well_formed(&test_pin(range)), "{range}");
        }
        let mut short = test_pin("6.19.0");
        short.integrity = "sha512-abc";
        assert!(!pin_is_well_formed(&short));
        let mut tree = test_pin("6.19.0");
        tree.installed_tree_sha256 = "not-hex";
        assert!(!pin_is_well_formed(&tree));
    }

    #[test]
    fn the_runner_must_use_the_same_exact_build() {
        assert!(supported_with(Some(test_pin("6.19.0")), "6.19.0"));
        assert!(!supported_with(Some(test_pin("6.19.0")), "~6.19.0"));
        assert!(!supported_with(Some(test_pin("6.19.0")), "6.19.1"));
        assert!(!supported_with(None, "6.19.0"));
        assert!(!supported_with(
            Some(test_pin("6.18.80")),
            crate::hq_cloud::HQ_CLOUD_VERSION
        ));
    }

    fn write_entry(dir: &std::path::Path, version: &str, integrity: &str) {
        let lock = serde_json::json!({
            "name": "npx-entry",
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {"@indigoai-us/hq-cloud": version}},
                "node_modules/@indigoai-us/hq-cloud": {"version": version, "integrity": integrity},
                "node_modules/left-pad": {"version": "1.0.0", "integrity": "sha512-left"},
            }
        });
        let package = dir.join("node_modules/@indigoai-us/hq-cloud");
        std::fs::create_dir_all(package.join("dist/bin")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/left-pad")).unwrap();
        std::fs::write(
            dir.join("node_modules/.package-lock.json"),
            serde_json::to_vec(&lock).unwrap(),
        )
        .unwrap();
        std::fs::write(
            package.join("package.json"),
            format!(
                r#"{{"version":"{version}","bin":{{"hq-cloud":"dist/bin/sync-mutation.js"}}}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            package.join("dist/bin/sync-mutation.js"),
            "#!/usr/bin/env node\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("node_modules/left-pad/index.js"),
            "module.exports = 1;\n",
        )
        .unwrap();
    }

    fn pin_for(dir: &std::path::Path, version: &'static str) -> ArtifactPin {
        let tree = installed_tree_digest(&dir.join("node_modules")).unwrap();
        ArtifactPin {
            version,
            integrity: test_pin(version).integrity,
            installed_tree_sha256: Box::leak(tree.into_boxed_str()),
        }
    }

    /// Review: verification binds the installed bytes, not lock metadata. One
    /// changed byte in any dependency file is refused, even with a matching
    /// lockfile.
    #[test]
    fn verification_binds_the_installed_bytes_of_the_whole_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        write_entry(&entry, "6.19.0", test_pin("6.19.0").integrity);
        let pin = pin_for(&entry, "6.19.0");
        let bin = verify_artifact_entry(&entry, &pin).expect("pinned build verifies");
        assert!(bin.ends_with("dist/bin/sync-mutation.js"));

        // Same lockfile, one dependency byte changed.
        std::fs::write(
            entry.join("node_modules/left-pad/index.js"),
            "module.exports = 2;\n",
        )
        .unwrap();
        assert!(verify_artifact_entry(&entry, &pin).is_err());

        // A file added to the tree.
        write_entry(&entry, "6.19.0", test_pin("6.19.0").integrity);
        assert_eq!(verify_artifact_entry(&entry, &pin).map(|_| ()), Ok(()));
        std::fs::write(entry.join("node_modules/left-pad/extra.js"), "").unwrap();
        assert!(verify_artifact_entry(&entry, &pin).is_err());

        // Lock metadata mismatches.
        let entry2 = tmp.path().join("entry2");
        write_entry(&entry2, "6.19.0", "sha512-other");
        assert!(verify_artifact_entry(&entry2, &pin_for(&entry2, "6.19.0")).is_err());

        // Not installed at all.
        assert!(verify_artifact_entry(&tmp.path().join("absent"), &pin).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_bin_that_points_outside_the_package_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        write_entry(&entry, "6.19.0", test_pin("6.19.0").integrity);
        std::fs::write(
            entry.join("node_modules/@indigoai-us/hq-cloud/package.json"),
            r#"{"version":"6.19.0","bin":{"hq-cloud":"../../left-pad/index.js"}}"#,
        )
        .unwrap();
        let pin = pin_for(&entry, "6.19.0");
        assert!(verify_artifact_entry(&entry, &pin).is_err());
    }

    #[test]
    fn an_unverified_artifact_is_unsupported_without_running_actions() {
        let fake = FakeRunner::new(vec![RunOutput::ArtifactUnverified]);
        let client = PersonalProjectionClient::new(&fake);
        assert_eq!(
            client.initialize(ROOT),
            Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
        );
        assert_eq!(actions(&fake), [Action::Inspect]);
    }
}
