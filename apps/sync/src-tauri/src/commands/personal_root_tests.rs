//! Hermetic tests for the gated paired personal-root flow. A fake wrapper
//! records each action and replays canned typed results; roots and state live
//! in temp folders. Nothing here touches the real HQ folder or state.

use super::*;
use hq_desktop_core::personal_projection::{Action, RunOutput};
use std::cell::RefCell;
use std::collections::VecDeque;

struct FakeWrapper {
    replies: RefCell<VecDeque<RunOutput>>,
    calls: RefCell<Vec<(Action, Vec<u8>)>>,
}

impl FakeWrapper {
    fn new(replies: Vec<RunOutput>) -> Self {
        Self {
            replies: RefCell::new(replies.into()),
            calls: RefCell::new(Vec::new()),
        }
    }

    fn actions(&self) -> Vec<Action> {
        self.calls.borrow().iter().map(|(a, _)| *a).collect()
    }
}

impl ProjectionRunner for &FakeWrapper {
    fn run(&self, action: Action, stdin: &[u8]) -> RunOutput {
        self.calls.borrow_mut().push((action, stdin.to_vec()));
        self.replies
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| panic!("unexpected wrapper call: {action:?}"))
    }
}

fn exited(code: i32, stdout: impl Into<String>) -> RunOutput {
    RunOutput::Exited {
        code: Some(code),
        stdout: stdout.into().into_bytes(),
    }
}

fn inspect(status: &str) -> RunOutput {
    let code = if status == "adoption_required" { 3 } else { 0 };
    exited(
        code,
        format!(r#"{{"schemaVersion":1,"status":"{status}"}}"#),
    )
}

fn inspect_owner(projection: &str) -> RunOutput {
    exited(
        0,
        format!(r#"{{"schemaVersion":1,"status":"owner_observed","projectionId":"{projection}"}}"#),
    )
}

fn paused(reason: &str, retryable: bool, required: &str) -> RunOutput {
    exited(
        3,
        format!(
            r#"{{"schemaVersion":1,"status":"paused","reason":"{reason}","retryable":{retryable},"requiredAction":"{required}"}}"#
        ),
    )
}

fn initialized(root: &str) -> RunOutput {
    exited(
        0,
        format!(
            r#"{{"schemaVersion":1,"status":"initialized","projectionId":"p1","rootPath":"{root}","journalScope":"journal:__hq_personal_vault__"}}"#
        ),
    )
}

const DIGEST: &str = "sha256:digest-1";

fn plan_json(root: &str, state: &str) -> String {
    format!(
        r#"{{"schemaVersion":1, "transactionId":"tx","rootPath":"{root}","stateDirectory":"{state}","destination":{{"uid":"psn_1","bucket":"b","endpoint":"https://s3","region":"us-east-1"}},"authorityDigest":"a","inventoryDigest":"i","approvedPlanDigest":"{DIGEST}","fileCount":3,"byteCount":30,"historicalUids":["psn_old"],"historicalBucket":"unknown","uploadEntries":[{{"key":"a.md","kind":"file","localHash":"l","wireHash":"w","size":10,"wireSize":10}}],"preservedOnly":[{{"key":".env","reason":"secret"}}],"permissions":{{"upload":true,"remoteDelete":false,"localDelete":false,"overwriteExisting":false}},"maxUploadRows":5,"maxUploadBytes":50,"maxDurationMs":600000,"rootDevice":1,"rootInode":2,"stateDevice":null,"stateInode":null}}"#
    )
}

struct Fixture {
    _tmp: tempfile::TempDir,
    base: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(tmp.path()).unwrap();
        let state = base.join("state");
        Self {
            _tmp: tmp,
            base,
            state,
        }
    }

    fn root(&self, name: &str) -> PathBuf {
        self.base.join("Work").join(name)
    }
}

fn s(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn a_new_root_is_initialized_before_anything_creates_it() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    let fake = FakeWrapper::new(vec![inspect("new_root"), initialized(&s(&root))]);
    let client = PersonalProjectionClient::new(&fake);

    let record = prepare_with(&client, &s(&root), &fx.state);

    assert_eq!(record.phase, RootPhase::Initialized);
    assert_eq!(record.projection_id.as_deref(), Some("p1"));
    assert_eq!(fake.actions(), [Action::Inspect, Action::Initialize]);
    // The Desktop prepared only the parent; the leaf is the wrapper's to make.
    assert!(root.parent().unwrap().is_dir());
    assert!(!root.exists());
    assert_eq!(
        read_record(&fx.state).unwrap().phase,
        RootPhase::Initialized
    );
}

#[test]
fn an_existing_empty_folder_goes_to_review_and_is_never_initialized() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    std::fs::create_dir_all(&root).unwrap();
    let fake = FakeWrapper::new(vec![inspect("adoption_required")]);
    let client = PersonalProjectionClient::new(&fake);

    let record = prepare_with(&client, &s(&root), &fx.state);

    assert_eq!(record.phase, RootPhase::AdoptionReview);
    assert_eq!(fake.actions(), [Action::Inspect]);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn an_orphan_journal_pauses_initialize_into_review() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    let fake = FakeWrapper::new(vec![
        inspect("new_root"),
        paused("adoption_required", false, "review_adoption"),
    ]);
    let client = PersonalProjectionClient::new(&fake);
    let record = prepare_with(&client, &s(&root), &fx.state);
    assert_eq!(record.phase, RootPhase::AdoptionReview);
    assert!(!root.exists());
}

#[test]
fn an_old_binary_stops_setup_and_creates_nothing() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    let fake = FakeWrapper::new(vec![exited(2, "Usage: hq-cloud <command>")]);
    let client = PersonalProjectionClient::new(&fake);

    let record = prepare_with(&client, &s(&root), &fx.state);

    assert_eq!(record.phase, RootPhase::Paused);
    assert_eq!(record.reason.as_deref(), Some("unsupported_cli"));
    assert!(
        !root.parent().unwrap().exists(),
        "no parent before a typed new_root"
    );
    assert_eq!(
        seed_decision_with(true, &s(&root), &fx.state),
        Err(
            "HQ has not finished preparing this folder. Go back to the folder step and try again."
                .to_string()
        )
    );
}

#[test]
fn a_root_that_contains_the_state_dir_is_refused_without_spawning() {
    let fx = Fixture::new();
    let fake = FakeWrapper::new(vec![]);
    let client = PersonalProjectionClient::new(&fake);
    let record = prepare_with(&client, &s(&fx.base), &fx.state);
    assert_eq!(record.reason.as_deref(), Some("state_inside_root"));
    assert!(fake.actions().is_empty());
}

#[test]
fn a_second_root_under_the_same_state_dir_is_refused() {
    let fx = Fixture::new();
    let first = fx.root("hq");
    let fake = FakeWrapper::new(vec![inspect("new_root"), initialized(&s(&first))]);
    prepare_with(&PersonalProjectionClient::new(&fake), &s(&first), &fx.state);

    let other = fx.root("hq-two");
    let fake = FakeWrapper::new(vec![]);
    let record = prepare_with(&PersonalProjectionClient::new(&fake), &s(&other), &fx.state);
    assert_eq!(record.reason.as_deref(), Some("state_in_use_by_other_root"));
    assert!(fake.actions().is_empty());
    // The first root's record is untouched.
    assert_eq!(read_record(&fx.state).unwrap().root_path, s(&first));
}

#[test]
fn seeding_follows_the_record_and_never_repeats() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    assert_eq!(
        seed_decision_with(false, &s(&root), &fx.state),
        Ok(SeedDecision::Legacy)
    );

    let fake = FakeWrapper::new(vec![inspect("new_root"), initialized(&s(&root))]);
    prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    // Stand in for the wrapper creating the leaf.
    std::fs::create_dir(&root).unwrap();
    assert_eq!(
        seed_decision_with(true, &s(&root), &fx.state),
        Ok(SeedDecision::Seed)
    );
    mark_seeded(&fx.state, &s(&root));
    assert_eq!(
        seed_decision_with(true, &s(&root), &fx.state),
        Ok(SeedDecision::KeepExisting)
    );
}

#[test]
fn owner_observed_keeps_files_and_a_changed_projection_is_recovery() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    std::fs::create_dir_all(&root).unwrap();
    let fake = FakeWrapper::new(vec![inspect_owner("p9")]);
    let record = prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    assert_eq!(record.phase, RootPhase::OwnerObserved);
    assert_eq!(
        seed_decision_with(true, &s(&root), &fx.state),
        Ok(SeedDecision::KeepExisting)
    );

    // Our own initialized root later reporting another projection.
    let fx = Fixture::new();
    let root = fx.root("hq");
    let fake = FakeWrapper::new(vec![inspect("new_root"), initialized(&s(&root))]);
    prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    std::fs::create_dir(&root).unwrap();
    let fake = FakeWrapper::new(vec![inspect_owner("p-other")]);
    let record = prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    assert_eq!(record.reason.as_deref(), Some("state_changed"));
}

fn adoption_fixture() -> (Fixture, PathBuf) {
    let fx = Fixture::new();
    let root = fx.root("hq");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("notes.md"), "mine").unwrap();
    let fake = FakeWrapper::new(vec![inspect("adoption_required")]);
    prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    (fx, root)
}

fn plan_reply(root: &Path, state: &Path) -> RunOutput {
    exited(
        0,
        format!(
            r#"{{"schemaVersion":1,"status":"review_required","plan":{}}}"#,
            plan_json(&s(root), &s(state))
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
fn each_phase_needs_its_own_approval_and_resume_starts_the_runner_once() {
    let (fx, root) = adoption_fixture();
    let fake = FakeWrapper::new(vec![
        inspect("adoption_required"),
        plan_reply(&root, &fx.state),
    ]);
    let record = plan_adoption_with(&PersonalProjectionClient::new(&fake), &fx.state).unwrap();
    assert_eq!(
        PersonalRootView::from_record(&record).next_phase.as_deref(),
        Some("preserve")
    );
    // The plan is kept byte for byte.
    let saved = std::fs::read_to_string(record_path(&fx.state)).unwrap();
    assert!(saved.contains(&plan_json(&s(&root), &fx.state.to_string_lossy())));

    // Skipping ahead is refused without spawning.
    let fake = FakeWrapper::new(vec![]);
    assert!(approve_with(
        &PersonalProjectionClient::new(&fake),
        &fx.state,
        &approval(Phase::Adopt)
    )
    .is_err());
    assert!(fake.actions().is_empty());

    let steps = [
        (
            Phase::Preserve,
            exited(
                0,
                format!(
                    r#"{{"schemaVersion":1,"status":"preserved_pending_adoption","transactionId":"tx","approvedPlanDigest":"{DIGEST}","snapshotDirectory":"/s","snapshotDigest":"sd","enrolled":false,"resumed":false,"stateDevice":1,"stateInode":2}}"#
                ),
            ),
            RootPhase::Preserved,
        ),
        (
            Phase::Adopt,
            exited(
                0,
                r#"{"schemaVersion":1,"status":"adopted_pending_baseline","projectionId":"p1","resumed":false}"#,
            ),
            RootPhase::Adopted,
        ),
        (
            Phase::Baseline,
            exited(
                0,
                r#"{"schemaVersion":1,"status":"baseline_ready","projectionId":"p1","receiptDigest":"rd","resumed":false}"#,
            ),
            RootPhase::BaselineReady,
        ),
        (
            Phase::Resume,
            exited(
                0,
                r#"{"schemaVersion":1,"status":"resume_authorized","projectionId":"p1","runnerStarted":false}"#,
            ),
            RootPhase::ResumeAuthorized,
        ),
    ];
    let mut runner_starts = 0;
    for (phase, reply, expected) in steps {
        // A fresh client per click: the probe runs, then exactly one phase.
        let fake = FakeWrapper::new(vec![inspect("adoption_required"), reply]);
        let result = approve_with(
            &PersonalProjectionClient::new(&fake),
            &fx.state,
            &approval(phase),
        )
        .unwrap();
        assert_eq!(result.record.phase, expected);
        assert_eq!(fake.actions().len(), 2, "{phase:?} ran exactly one phase");
        runner_starts += usize::from(result.start_runner);
    }
    assert_eq!(runner_starts, 1);

    // Nothing is left to approve.
    let fake = FakeWrapper::new(vec![]);
    assert!(approve_with(
        &PersonalProjectionClient::new(&fake),
        &fx.state,
        &approval(Phase::Resume)
    )
    .is_err());
    assert!(personal_sync_permitted(
        read_record(&fx.state).as_ref(),
        &root
    ));
}

#[test]
fn an_approval_for_another_plan_is_refused() {
    let (fx, root) = adoption_fixture();
    let fake = FakeWrapper::new(vec![
        inspect("adoption_required"),
        plan_reply(&root, &fx.state),
    ]);
    plan_adoption_with(&PersonalProjectionClient::new(&fake), &fx.state).unwrap();
    let fake = FakeWrapper::new(vec![]);
    let wrong = UserApproval {
        phase: Phase::Preserve,
        plan_digest: "sha256:other".to_string(),
    };
    assert!(approve_with(&PersonalProjectionClient::new(&fake), &fx.state, &wrong).is_err());
    assert!(fake.actions().is_empty());
}

#[test]
fn a_changed_folder_during_adoption_holds_at_its_phase_without_retrying() {
    let (fx, root) = adoption_fixture();
    let fake = FakeWrapper::new(vec![
        inspect("adoption_required"),
        plan_reply(&root, &fx.state),
    ]);
    plan_adoption_with(&PersonalProjectionClient::new(&fake), &fx.state).unwrap();

    let fake = FakeWrapper::new(vec![
        inspect("adoption_required"),
        paused("state_changed", false, "review_recovery"),
    ]);
    let result = approve_with(
        &PersonalProjectionClient::new(&fake),
        &fx.state,
        &approval(Phase::Preserve),
    )
    .unwrap();
    assert_eq!(result.record.reason.as_deref(), Some("state_changed"));
    assert!(!result.start_runner);
    // Saved state is unchanged: still waiting at preserve, plan intact.
    let saved = read_record(&fx.state).unwrap();
    assert_eq!(saved.phase, RootPhase::AdoptionReview);
    assert!(saved.plan.is_some());
}

#[test]
fn owner_mismatch_offers_no_adoption() {
    let (fx, _root) = adoption_fixture();
    let fake = FakeWrapper::new(vec![
        inspect("adoption_required"),
        paused("owner_mismatch", false, "review_recovery"),
    ]);
    let record = plan_adoption_with(&PersonalProjectionClient::new(&fake), &fx.state).unwrap();
    let view = PersonalRootView::from_record(&record);
    assert_eq!(view.phase, "paused");
    assert_eq!(view.reason.as_deref(), Some("owner_mismatch"));
    assert_eq!(view.next_phase, None);
}

#[test]
fn launch_holds_personal_sync_until_the_owner_is_confirmed() {
    // Upgraded user: an installed root with no owner record.
    let (fx, root) = adoption_fixture();
    let fake = FakeWrapper::new(vec![inspect("adoption_required")]);
    assert!(!launch_check_with(
        &PersonalProjectionClient::new(&fake),
        &s(&root),
        &fx.state
    ));
    assert_eq!(
        read_record(&fx.state).unwrap().phase,
        RootPhase::AdoptionReview
    );

    // A seeded root this Desktop initialized.
    let fx = Fixture::new();
    let root = fx.root("hq");
    let fake = FakeWrapper::new(vec![inspect("new_root"), initialized(&s(&root))]);
    prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    std::fs::create_dir(&root).unwrap();
    mark_seeded(&fx.state, &s(&root));
    let fake = FakeWrapper::new(vec![inspect_owner("p1")]);
    assert!(launch_check_with(
        &PersonalProjectionClient::new(&fake),
        &s(&root),
        &fx.state
    ));
}

#[test]
fn launch_never_initializes_a_missing_installed_root() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    let fake = FakeWrapper::new(vec![]);
    assert!(!launch_check_with(
        &PersonalProjectionClient::new(&fake),
        &s(&root),
        &fx.state
    ));
    assert!(fake.actions().is_empty());
    assert!(!root.exists());
}

#[test]
fn a_timeout_is_recovery_and_the_next_run_reinspects() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    let fake = FakeWrapper::new(vec![inspect("new_root"), RunOutput::Timeout]);
    let record = prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    assert_eq!(record.reason.as_deref(), Some("timeout"));
    assert!(!record.retryable);

    // The killed initialize left a partial root; the next run classifies it
    // instead of treating the folder as new.
    std::fs::create_dir(&root).unwrap();
    let fake = FakeWrapper::new(vec![inspect("adoption_required")]);
    let record = prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    assert_eq!(record.phase, RootPhase::AdoptionReview);
    assert_eq!(fake.actions(), [Action::Inspect]);
}

#[test]
fn busy_is_retryable_only_by_the_user() {
    let fx = Fixture::new();
    let root = fx.root("hq");
    let fake = FakeWrapper::new(vec![paused("busy", true, "retry_when_idle")]);
    let record = prepare_with(&PersonalProjectionClient::new(&fake), &s(&root), &fx.state);
    assert_eq!(record.reason.as_deref(), Some("busy"));
    assert!(record.retryable);
    assert_eq!(fake.actions(), [Action::Inspect]);
}

#[test]
fn the_gate_is_off_in_shipped_builds() {
    assert!(!hq_desktop_core::personal_projection::personal_projection_supported());
    assert!(!paired_root_gate_enabled());
    assert_eq!(personal_root_state(), PersonalRootView::legacy());
}

/// Opt-in run against a real local hq-cloud build (ignored by default).
mod artifact {
    // Opt-in end-to-end run of the gated paired-root flow against a real,
    // locally built hq-cloud artifact. Ignored by default; run with:
    //
    // ```text
    // HQ_H8_ARTIFACT_BIN=/tmp/h8art/.../dist/bin/sync-mutation.js \
    // HQ_H8_STUB_VAULT_URL=http://127.0.0.1:47811 \
    // HQ_H8_OLD_BIN=/path/to/published/dist/bin/sync-mutation.js \
    // cargo test --bin hq-sync-menubar -- --ignored personal_root_artifact
    // ```
    //
    // Every child gets a cleared environment with a temp HOME, a temp
    // HQ_STATE_DIR holding a fake session, Keychain reads off, and a local stub
    // vault. Roots live in a temp folder. Nothing reads or writes the real HQ
    // folder, state, or Keychain.

    use super::*;
    use base64::Engine as _;
    use hq_desktop_core::personal_projection::{run_bounded, Action, RunOutput};

    struct NodeWrapper {
        bin: String,
        home: PathBuf,
        state: PathBuf,
        vault: String,
    }

    impl ProjectionRunner for NodeWrapper {
        fn run(&self, action: Action, stdin: &[u8]) -> RunOutput {
            let mut command =
                std::process::Command::new(hq_desktop_core::paths::resolve_bin("node"));
            command
                .env_clear()
                .arg(&self.bin)
                .args(action.argv())
                .env("PATH", "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin")
                .env("HOME", &self.home)
                .env("HQ_STATE_DIR", &self.state)
                .env("HQ_TOKEN_KEYCHAIN", "0")
                .env("HQ_VAULT_API_URL", &self.vault);
            run_bounded(command, stdin, action.timeout(), None)
        }
    }

    fn b64(value: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value)
    }

    /// A fake, unsigned session that only the local stub vault ever sees.
    fn write_fake_session(state: &Path) {
        std::fs::create_dir_all(state).unwrap();
        let exp = chrono::Utc::now() + chrono::Duration::hours(1);
        let token = |claims: &str| format!("{}.{}.sig", b64(r#"{"alg":"none"}"#), b64(claims));
        let session = serde_json::json!({
            "accessToken": token(&format!(r#"{{"sub":"h8-test","exp":{},"token_use":"access"}}"#, exp.timestamp())),
            "idToken": token(&format!(r#"{{"sub":"h8-test","exp":{},"email":"h8@example.test"}}"#, exp.timestamp())),
            "refreshToken": "h8-test-only",
            "expiresAt": exp.to_rfc3339(),
        });
        std::fs::write(state.join("cognito-tokens.json"), session.to_string()).unwrap();
    }

    struct Env {
        _tmp: tempfile::TempDir,
        base: PathBuf,
    }

    impl Env {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let base = std::fs::canonicalize(tmp.path()).unwrap();
            Self { _tmp: tmp, base }
        }

        fn wrapper(&self, bin: &str, state: &Path) -> NodeWrapper {
            let home = self.base.join("home");
            std::fs::create_dir_all(&home).unwrap();
            write_fake_session(state);
            NodeWrapper {
                bin: bin.to_string(),
                home,
                state: state.to_path_buf(),
                vault: std::env::var("HQ_H8_STUB_VAULT_URL").expect("HQ_H8_STUB_VAULT_URL"),
            }
        }
    }

    fn artifact() -> String {
        std::env::var("HQ_H8_ARTIFACT_BIN").expect("HQ_H8_ARTIFACT_BIN")
    }

    #[test]
    #[ignore = "needs a local hq-cloud artifact and a stub vault"]
    fn personal_root_artifact_new_root_is_initialized_then_seeded_once() {
        let env = Env::new();
        let state = env.base.join("state");
        let root = env.base.join("Work").join("hq");
        let wrapper = env.wrapper(&artifact(), &state);
        let client = PersonalProjectionClient::new(wrapper);

        let record = prepare_with(&client, &s(&root), &state);
        assert_eq!(record.phase, RootPhase::Initialized, "{record:?}");
        assert!(record.projection_id.is_some());
        assert!(root.is_dir(), "initialize created the root");
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            0,
            "nothing seeded yet"
        );

        assert_eq!(
            seed_decision_with(true, &s(&root), &state),
            Ok(SeedDecision::Seed)
        );
        std::fs::write(root.join("README.md"), "seeded").unwrap();
        mark_seeded(&state, &s(&root));
        assert_eq!(
            seed_decision_with(true, &s(&root), &state),
            Ok(SeedDecision::KeepExisting)
        );

        // Next launch: a fresh client probes, inspect confirms the owner.
        let client = PersonalProjectionClient::new(env.wrapper(&artifact(), &state));
        assert!(launch_check_with(&client, &s(&root), &state));
    }

    #[test]
    #[ignore = "needs a local hq-cloud artifact and a stub vault"]
    fn personal_root_artifact_existing_folder_goes_to_review_never_initialize() {
        let env = Env::new();
        let state = env.base.join("state");
        let root = env.base.join("Existing").join("hq");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("notes.md"), "mine").unwrap();
        let client = PersonalProjectionClient::new(env.wrapper(&artifact(), &state));

        let record = prepare_with(&client, &s(&root), &state);
        assert_eq!(record.phase, RootPhase::AdoptionReview, "{record:?}");
        assert_eq!(
            std::fs::read_to_string(root.join("notes.md")).unwrap(),
            "mine"
        );

        // The plan step returns either the reviewed plan or a typed pause; never
        // an unsupported-binary result. Nothing is uploaded or deleted.
        let planned = plan_adoption_with(&client, &state).unwrap();
        eprintln!(
            "plan-adoption: phase={:?} reason={:?} plan={}",
            planned.phase,
            planned.reason,
            planned.plan.is_some()
        );
        assert_ne!(planned.reason.as_deref(), Some("unsupported_cli"));
        assert_eq!(
            std::fs::read_to_string(root.join("notes.md")).unwrap(),
            "mine"
        );

        // The real wrapper accepts the verbatim plan for the two local-only
        // phases. Preserve snapshots and adopt records pending ownership;
        // neither uploads. Baseline (upload) is not run here.
        let digest = PersonalRootView::from_record(&planned)
            .plan
            .expect("reviewed plan")
            .approved_plan_digest;
        for (phase, expected) in [
            (Phase::Preserve, RootPhase::Preserved),
            (Phase::Adopt, RootPhase::Adopted),
        ] {
            let client = PersonalProjectionClient::new(env.wrapper(&artifact(), &state));
            let approval = UserApproval {
                phase,
                plan_digest: digest.clone(),
            };
            let result = approve_with(&client, &state, &approval).unwrap();
            assert_eq!(result.record.phase, expected, "{:?}", result.record);
            assert!(!result.start_runner);
        }
        assert_eq!(
            std::fs::read_to_string(root.join("notes.md")).unwrap(),
            "mine"
        );
    }

    #[test]
    #[ignore = "needs a published hq-cloud build without the paired API"]
    fn personal_root_artifact_unsupported_binary_pauses_and_creates_nothing() {
        let old = std::env::var("HQ_H8_OLD_BIN").expect("HQ_H8_OLD_BIN");
        let env = Env::new();
        let state = env.base.join("state");
        let root = env.base.join("Work").join("hq");
        let client = PersonalProjectionClient::new(env.wrapper(&old, &state));

        let record = prepare_with(&client, &s(&root), &state);
        assert_eq!(
            record.reason.as_deref(),
            Some("unsupported_cli"),
            "{record:?}"
        );
        assert!(!root.exists());
        assert!(!root.parent().unwrap().exists());
    }
}
