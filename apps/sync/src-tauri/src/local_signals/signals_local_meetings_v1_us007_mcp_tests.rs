//! signals-local-meetings-v1 US-007 — the outside-session MCP transport.
//! Covers AC0 (interactive only), AC2 (only the four tools plus prompt and
//! delivery), AC6 (validation before store), and AC7 (transport loss leaves
//! the run recoverable with one Resume action).
use super::*;
use crate::commands::local_signal_runs::{ProviderChoice, RunRequestInput};
use crate::local_signals::extractor::{
    assert_interactive, claude_mcp_args, kickoff_prompt, mcp_tool_names, plan_session,
    SessionPlan, FORBIDDEN_INVOCATIONS, PROMPT_VERSION, SCHEMA_VERSION,
};
use crate::local_signals::store;
use serde_json::json;
use std::io::Cursor;

const COMPANY: &str = "cmp_fixture";
const SLUG: &str = "fixture";
const MEMBER: &str = "prs_alice";
const BOT: &str = "bot-abc";

struct Fixture {
    hq: tempfile::TempDir,
    runs: tempfile::TempDir,
    ctx: RunContext,
    job_path: PathBuf,
}

fn digest() -> String {
    "d1".repeat(32)
}

fn fixture() -> Fixture {
    let hq = tempfile::tempdir().unwrap();
    let runs_dir = tempfile::tempdir().unwrap();
    let rec = runs::request(
        runs_dir.path(),
        RunRequestInput {
            company_uid: COMPANY.into(),
            member_uid: MEMBER.into(),
            source_ref: format!("sources/meetings/{BOT}.md"),
            source_digest: digest(),
            audience_receipt_ref: format!("sources/meetings/{BOT}.audience.json"),
            provider: ProviderChoice::Any,
            prompt_version: PROMPT_VERSION.into(),
            schema_version: SCHEMA_VERSION.into(),
        },
    )
    .unwrap();
    let ctx = RunContext {
        job_id: rec.request.job_id.clone(),
        company_uid: COMPANY.into(),
        member_uid: MEMBER.into(),
        device_id: "device-a".into(),
        source_id: BOT.into(),
        source_ref: format!("sources/meetings/{BOT}.md"),
        source_digest: digest(),
        audience_key: "aud-123".into(),
        audience_version: 1,
        audience_receipt_ref: format!("sources/meetings/{BOT}.audience.json"),
        extractor_provider: "claude".into(),
        extractor_model: "interactive-session".into(),
        prompt_version: PROMPT_VERSION.into(),
        schema_version: SCHEMA_VERSION.into(),
        projection_watermark: "pending".into(),
        projection_state: "pending".into(),
        ontology_version: "ontology/v1".into(),
        classification: "company-eligible".into(),
        extracted_at: "2026-10-13T12:00:00.000Z".into(),
    };
    let exe = Path::new("/Applications/HQ.app/Contents/MacOS/hq-sync-menubar");
    let (plan, _) = crate::commands::local_signals::prepare_session(
        hq.path(),
        runs_dir.path(),
        exe,
        SLUG,
        BOT,
        Provider::Claude,
        &ctx,
        "[00:00:01] Alice: hello\n",
    )
    .unwrap();
    assert!(matches!(plan, SessionPlan::ClaudeTerminal { .. }));
    let job_path = extractor::job_config_path(hq.path(), COMPANY, &ctx.job_id).unwrap();
    Fixture {
        hq,
        runs: runs_dir,
        ctx,
        job_path,
    }
}

fn transcript_ok() -> TranscriptFn {
    Box::new(|cfg: &JobConfig| {
        Ok(LocalTranscript {
            source_ref: cfg.context.source_ref.clone(),
            source_digest: cfg.context.source_digest.clone(),
            duration_ms: 180_000,
        })
    })
}

fn server(f: &Fixture, session: &str) -> Server {
    let cfg = load_job_config(&f.job_path, Some(f.runs.path())).unwrap();
    Server::new(cfg, session.into(), None, transcript_ok(), Box::new(|_| true))
}

fn req(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
}

fn call(s: &mut Server, name: &str, args: Value) -> Value {
    s.handle(&req(9, "tools/call", json!({"name":name,"arguments":args})))
        .unwrap()["result"]
        .clone()
}

fn text(r: &Value) -> String {
    r["content"][0]["text"].as_str().unwrap_or("").to_string()
}

fn init(s: &mut Server) -> Value {
    s.handle(&req(1, "initialize", json!({"protocolVersion":"2025-06-18"})))
        .unwrap()
}

fn output(ctx: &RunContext, candidate: Option<&str>) -> Value {
    json!({
        "schema": extractor::OUTPUT_SCHEMA,
        "extractor": {"provider":"claude","mode":"interactive"},
        "memberUid": ctx.member_uid,
        "sourceRef": ctx.source_ref,
        "sourceDigest": ctx.source_digest,
        "audienceKey": ctx.audience_key,
        "audienceReceiptRef": ctx.audience_receipt_ref,
        "schemaVersion": SCHEMA_VERSION,
        "observations": [{
            "type":"summary","content":"The team reviewed the launch plan.",
            "citations":[{"startMs":0,"endMs":1000}],
            "entityRefs":[],"candidateRefs": candidate.map(|c| vec![c]).unwrap_or_default(),
            "owner":null,"reasoning":null,"speaker":null
        }]
    })
}

fn state(f: &Fixture) -> runs::RunRecord {
    runs::load(f.runs.path(), &f.ctx.job_id).unwrap()
}

mod job_config {
    use super::*;

    #[test]
    fn prepare_session_writes_a_job_and_an_mcp_client_config_for_this_binary() {
        let f = fixture();
        let cfg = load_job_config(&f.job_path, Some(f.runs.path())).unwrap();
        assert_eq!(cfg.context, f.ctx);
        assert_eq!(cfg.bot_id, BOT);
        assert_eq!(cfg.company_slug, SLUG);
        let mcp_path = extractor::mcp_config_path(f.hq.path(), COMPANY, &f.ctx.job_id).unwrap();
        let mcp: Value = serde_json::from_slice(&std::fs::read(mcp_path).unwrap()).unwrap();
        let srv = &mcp["mcpServers"][MCP_SERVER_NAME];
        assert_eq!(srv["command"], "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar");
        assert_eq!(
            srv["args"],
            json!([MCP_ARG, f.job_path.display().to_string()])
        );
        assert_eq!(mcp["mcpServers"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn a_moved_tampered_or_foreign_job_config_is_refused() {
        let f = fixture();
        // Copied elsewhere: not in its run directory.
        let other = tempfile::tempdir().unwrap();
        let moved = other.path().join("job.mcp-job.json");
        std::fs::copy(&f.job_path, &moved).unwrap();
        assert!(load_job_config(&moved, None).is_err());
        // Runs dir outside the app's root.
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(load_job_config(&f.job_path, Some(elsewhere.path())).is_err());
        // Context that does not match the durable run.
        let mut v: Value = serde_json::from_slice(&std::fs::read(&f.job_path).unwrap()).unwrap();
        v["context"]["sourceDigest"] = json!("e2".repeat(32));
        std::fs::write(&f.job_path, serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(load_job_config(&f.job_path, None).is_err());
        // Unknown fields are refused.
        v["context"]["sourceDigest"] = json!(digest());
        v["extraTool"] = json!("Read");
        std::fs::write(&f.job_path, serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(load_job_config(&f.job_path, None).is_err());
    }
}

mod ac0_claude_launch_is_interactive_and_mcp_locked {
    use super::*;

    #[test]
    fn the_claude_line_loads_only_this_server_with_builtin_tools_off() {
        let cfg = Path::new("/tmp/hq/run.mcp.json");
        let kick = kickoff_prompt("job-1");
        let SessionPlan::ClaudeTerminal { command, args, .. } =
            plan_session(Provider::Claude, Path::new("/tmp/hq"), &kick, cfg).unwrap()
        else {
            panic!()
        };
        assert_eq!(args, claude_mcp_args(cfg, &kick));
        let words = extractor::shell_words(&command);
        assert_eq!(words[0], "claude");
        assert_eq!(&words[1..], &args[..]);
        let flags: Vec<&String> = words.iter().take_while(|w| *w != "--").collect();
        for bad in FORBIDDEN_INVOCATIONS {
            assert!(!flags.iter().any(|w| *w == bad), "{bad}");
        }
        let pos = |f: &str| flags.iter().position(|w| *w == f).unwrap();
        assert_eq!(flags[pos("--mcp-config") + 1], "/tmp/hq/run.mcp.json");
        assert!(flags.contains(&&"--strict-mcp-config".to_string()));
        assert_eq!(flags[pos("--tools") + 1], "", "every built-in tool is off");
        let allowed = flags[pos("--allowedTools") + 1].split(',').collect::<Vec<_>>();
        assert_eq!(allowed.len(), 6);
        assert!(allowed.iter().all(|t| t.starts_with("mcp__hq-local-signals__")));
        assert!(!kick.contains('/'), "no file path is handed to the session");
    }

    #[test]
    fn claude_lines_without_the_mcp_lock_or_with_headless_flags_are_refused() {
        for command in [
            "claude 'go'",
            "claude --mcp-config /x.json --strict-mcp-config -- 'go'",
            "claude --mcp-config /x.json --tools '' -- 'go'",
            "claude --mcp-config /x.json --strict-mcp-config --tools '' -p -- 'go'",
            "claude --mcp-config /x.json --strict-mcp-config --tools Read -- 'go'",
        ] {
            let plan = SessionPlan::ClaudeTerminal {
                workspace: "/tmp".into(),
                command: command.into(),
                args: vec![],
            };
            assert!(assert_interactive(&plan).is_err(), "{command}");
        }
    }

    #[test]
    fn main_dispatches_the_mcp_mode_before_any_app_init() {
        let src = include_str!("../main.rs");
        let at = |n: &str| src.find(n).unwrap_or_else(|| panic!("{n}"));
        let dispatch = at("local_signals::mcp_server::run_if_requested();");
        assert!(dispatch < at("launchd_task::run_if_requested();"));
        assert!(dispatch < at("hq_telemetry::init_with_identity("));
        assert!(dispatch < at("tauri_plugin_single_instance::init("));
    }
}

mod ac2_only_the_registered_tools {
    use super::*;

    #[test]
    fn tools_list_is_the_prompt_the_four_ontology_tools_and_delivery() {
        let f = fixture();
        let mut s = server(&f, "sess-a");
        init(&mut s);
        let r = s.handle(&req(2, "tools/list", json!({}))).unwrap();
        let names: Vec<String> = r["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, mcp_tool_names());
        assert_eq!(
            names,
            [
                "get_meeting_prompt",
                "ontology_list",
                "ontology_inspect",
                "ontology_search_alias",
                "queue_entity_candidate",
                "submit_signals"
            ]
        );
    }

    #[test]
    fn anything_else_is_refused_and_raw_paths_stay_unreadable() {
        let f = fixture();
        let mut s = server(&f, "sess-a");
        init(&mut s);
        for name in ["Read", "ontology.list", "fs.read", "bash", ""] {
            let r = call(&mut s, name, json!({}));
            assert_eq!(r["isError"], true, "{name}");
        }
        let r = call(
            &mut s,
            "ontology_inspect",
            json!({"entityId":"../../ontology/entities/secret"}),
        );
        assert_eq!(r["isError"], true);
        assert!(s.handle(&req(3, "resources/read", json!({"uri":"file:///etc/hosts"})))
            .unwrap()
            .get("error")
            .is_some());
    }

    #[test]
    fn tools_need_an_initialized_claim() {
        let f = fixture();
        let mut s = server(&f, "sess-a");
        let r = s
            .handle(&req(2, "tools/call", json!({"name":"get_meeting_prompt"})))
            .unwrap();
        assert!(r.get("error").is_some());
        assert_eq!(state(&f).state, RunState::Pending);
    }
}

mod end_to_end {
    use super::*;

    #[test]
    fn initialize_claims_prompt_extracts_and_submit_stores_and_completes() {
        let f = fixture();
        let mut s = server(&f, "sess-a");
        let r = init(&mut s);
        assert_eq!(r["result"]["serverInfo"]["name"], MCP_SERVER_NAME);
        let rec = state(&f);
        assert_eq!(rec.state, RunState::Claimed);
        assert_eq!(rec.provider_session_id.as_deref(), Some("sess-a"));
        assert_eq!(rec.claimed_by, Some(Provider::Claude));

        let p = call(&mut s, "get_meeting_prompt", json!({}));
        assert_eq!(p["isError"], false);
        assert!(text(&p).contains("Alice: hello"));
        assert_eq!(state(&f).state, RunState::Extracting);

        let q = call(&mut s, "queue_entity_candidate", json!({"name":"Globex"}));
        assert_eq!(q["isError"], false, "{}", text(&q));
        let cand: Value = serde_json::from_str(&text(&q)).unwrap();
        let cid = cand["candidateId"].as_str().unwrap().to_string();

        // Invalid first: reasons come back, nothing is stored.
        let mut bad = output(&f.ctx, Some(&cid));
        bad["observations"][0]["citations"] = json!([{"startMs":0,"endMs":999_999_999}]);
        let r = call(&mut s, "submit_signals", json!({"result": bad}));
        assert_eq!(r["isError"], true);
        assert!(text(&r).contains("citation_out_of_bounds"));
        assert!(state(&f).parsed_result_digest.is_none());
        assert!(!store::is_complete(
            f.hq.path(), COMPANY, BOT, &digest(), PROMPT_VERSION, SCHEMA_VERSION
        )
        .unwrap());

        let r = call(&mut s, "submit_signals", json!({"result": output(&f.ctx, Some(&cid))}));
        assert_eq!(r["isError"], false, "{}", text(&r));
        let rec = state(&f);
        assert_eq!(rec.state, RunState::Complete);
        assert!(rec.parsed_result_digest.is_some());
        assert!(store::is_complete(
            f.hq.path(), COMPANY, BOT, &digest(), PROMPT_VERSION, SCHEMA_VERSION
        )
        .unwrap());

        // EOF after completion changes nothing.
        s.on_eof();
        assert_eq!(state(&f).state, RunState::Complete);
    }

    #[test]
    fn serve_speaks_newline_delimited_json_rpc() {
        let f = fixture();
        let mut s = server(&f, "sess-a");
        let input = [
            req(1, "initialize", json!({"protocolVersion":"2025-06-18"})).to_string(),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(),
            req(2, "tools/list", json!({})).to_string(),
            "not json".to_string(),
        ]
        .join("\n");
        let mut out = Vec::new();
        s.serve(Cursor::new(input), &mut out);
        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 3, "the notification gets no reply");
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[1]["result"]["tools"].as_array().unwrap().len(), 6);
        assert_eq!(lines[2]["error"]["code"], -32700);
        // stdin closed with no result: released for Resume.
        let rec = state(&f);
        assert_eq!(rec.state, RunState::Pending);
        assert_eq!(rec.recovery.as_deref(), Some("resume"));
    }
}

mod ac7_transport_loss {
    use super::*;

    #[test]
    fn eof_without_a_result_leaves_one_resume_action_and_a_new_session_recovers() {
        let f = fixture();
        let mut s = server(&f, "sess-a");
        init(&mut s);
        call(&mut s, "get_meeting_prompt", json!({}));
        s.on_eof();
        let rec = state(&f);
        assert_eq!(rec.state, RunState::Pending);
        assert!(rec.provider_session_id.is_none());
        assert_eq!(rec.recovery.as_deref(), Some("resume"));
        for raw in ["error", "Error", "EOF", "stdin", "{", "pipe"] {
            assert!(!rec.status.contains(raw), "{raw}: {}", rec.status);
        }
        let mut s2 = server(&f, "sess-b");
        assert!(init(&mut s2).get("result").is_some());
        let rec = state(&f);
        assert_eq!(rec.provider_session_id.as_deref(), Some("sess-b"));
        assert!(rec.recovery.is_none());
    }

    #[test]
    fn a_stored_parse_finishes_on_reconnect_without_another_model_call() {
        let f = fixture();
        // A previous session stored a valid parse, then lost its transport.
        let s1 = ProviderSession {
            provider: Provider::Claude,
            session_id: "sess-old".into(),
            interactive: true,
        };
        runs::claim(f.runs.path(), &f.ctx.job_id, &s1, None).unwrap();
        runs::progress(f.runs.path(), &f.ctx.job_id, "sess-old", RunState::Extracting, None)
            .unwrap();
        runs::store_parsed_result(f.runs.path(), &f.ctx.job_id, "sess-old", &output(&f.ctx, None))
            .unwrap();
        extractor::handle_provider_failure(
            f.runs.path(),
            &f.ctx.job_id,
            "sess-old",
            Provider::Claude,
            ProviderFailure::TransportLost,
        )
        .unwrap();
        let mut s = server(&f, "sess-new");
        init(&mut s);
        assert_eq!(state(&f).state, RunState::Complete);
        let r = call(&mut s, "submit_signals", json!({"result": {}}));
        assert!(text(&r).contains("already saved"));
    }
}

mod cancellation_is_scoped {
    use super::*;

    #[test]
    fn cancelling_in_hq_stops_this_session_and_eof_keeps_it_cancelled() {
        let f = fixture();
        let mut s = server(&f, "sess-a");
        init(&mut s);
        call(&mut s, "get_meeting_prompt", json!({}));
        runs::cancel(f.runs.path(), &f.ctx.job_id, None).unwrap();
        let r = call(&mut s, "ontology_list", json!({}));
        assert_eq!(r["isError"], true);
        assert!(text(&r).contains("cancelled"));
        let r = call(&mut s, "submit_signals", json!({"result": output(&f.ctx, None)}));
        assert_eq!(r["isError"], true);
        s.on_eof();
        let rec = state(&f);
        assert_eq!(rec.state, RunState::Cancelled);
        assert!(rec.parsed_result_digest.is_none());
    }
}
