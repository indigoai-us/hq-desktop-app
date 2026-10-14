//! signals-local-meetings-v1 US-007 acceptance tests — one module per
//! acceptance criterion (ac0..ac7).
use super::extractor::*;
use super::ontology_tools::*;
use super::sanitize::*;
use super::store::{self, *};
use crate::commands::local_signal_runs::{
    self as runs, Provider, ProviderChoice, ProviderSession, RunRequestInput, RunState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const COMPANY: &str = "cmp_fixture";
const MEMBER: &str = "prs_alice";
const JOB: &str = "0b6f6a52-6f1c-4c55-9d43-5f9d1b2c3a4e";

fn ctx() -> RunContext {
    RunContext {
        job_id: JOB.into(),
        company_uid: COMPANY.into(),
        member_uid: MEMBER.into(),
        device_id: "device-a".into(),
        source_id: "bot-abc".into(),
        source_ref: "sources/meetings/bot-abc.md".into(),
        source_digest: "d1".repeat(32),
        audience_key: "aud-123".into(),
        audience_version: 1,
        audience_receipt_ref: "sources/meetings/bot-abc.audience.json".into(),
        extractor_provider: "claude".into(),
        extractor_model: "claude-opus".into(),
        prompt_version: PROMPT_VERSION.into(),
        schema_version: SCHEMA_VERSION.into(),
        projection_watermark: "pending".into(),
        projection_state: "pending".into(),
        ontology_version: "ontology/v1".into(),
        classification: "company-eligible".into(),
        extracted_at: "2026-10-13T12:00:00.000Z".into(),
    }
}

fn transcript() -> LocalTranscript {
    LocalTranscript {
        source_ref: ctx().source_ref,
        source_digest: ctx().source_digest,
        duration_ms: 180_000,
    }
}

const ENTITIES: &str = concat!(
    r#"{"entityId":"ent-project-atlas","type":"project","canonicalName":"Atlas","aliases":["Project Atlas"]}"#,
    "\n",
    r#"{"entityId":"ent-person-ben","type":"person","canonicalName":"Ben Ortiz","aliases":["Ben"]}"#,
    "\n",
    r#"{"entityId":"ent-org-northwind","type":"company","canonicalName":"Northwind","aliases":[]}"#,
    "\n",
);

fn projection(state: &str, generated_at: &str) -> Projection {
    let digest: String = Sha256::digest(ENTITIES.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let manifest = json!({
        "schemaVersion": PROJECTION_SCHEMA, "companyUid": COMPANY, "memberUid": MEMBER,
        "generatedAt": generated_at, "watermark": "wm-42", "sourceMode": "read_model",
        "state": state, "complete": state == "ready", "entityCount": 3, "digest": digest,
    });
    Projection::from_pulled(Some(&manifest.to_string()), Some(ENTITIES), COMPANY, MEMBER)
}

const NOW: &str = "2026-10-13T12:00:00.000Z";
fn now_ms() -> i64 {
    chrono::DateTime::parse_from_rfc3339(NOW)
        .unwrap()
        .timestamp_millis()
}

fn host(hq: &Path, p: Projection) -> ToolHost {
    ToolHost::new(hq, COMPANY, JOB, &ctx().source_ref, p, now_ms()).unwrap()
}

fn ready_host(hq: &Path) -> ToolHost {
    host(hq, projection("ready", NOW))
}

fn obs(ty: &str, content: &str, start: u64) -> Value {
    json!({ "type": ty, "content": content, "citations": [{ "startMs": start, "endMs": start + 4000 }],
            "entityRefs": [], "candidateRefs": [] })
}

fn all_eight() -> Vec<Value> {
    let mut v = vec![
        obs("summary", "Weekly sync on Atlas and Northwind.", 0),
        obs("key_point", "Atlas beta is on track.", 10_000),
        obs("decision", "Ship the Atlas beta on November 3.", 20_000),
        obs(
            "action_item",
            "Draft the Atlas launch checklist by Friday.",
            30_000,
        ),
        obs(
            "participant_contribution",
            "Led the launch discussion.",
            40_000,
        ),
        obs("risk", "Northwind renewal could slip a quarter.", 50_000),
        obs("commitment", "Checklist deadline holds.", 60_000),
        obs("question", "Who owns the billing migration?", 70_000),
    ];
    v[2]["reasoning"] = json!("Legal cleared the beta terms.");
    v[3]["owner"] = json!("Ben Ortiz");
    v[4]["speaker"] = json!("Ava Chen");
    v
}

fn output(observations: Vec<Value>) -> Value {
    let c = ctx();
    json!({
        "schema": OUTPUT_SCHEMA, "schemaVersion": SCHEMA_VERSION,
        "extractor": { "provider": "claude", "mode": "interactive" },
        "memberUid": c.member_uid, "sourceRef": c.source_ref, "sourceDigest": c.source_digest,
        "audienceKey": c.audience_key, "audienceReceiptRef": c.audience_receipt_ref,
        "observations": observations,
    })
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
    files_under(hq)
        .into_iter()
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()) == Some("md")
                && !p.to_string_lossy().ends_with(".prompt.md")
        })
        .collect()
}

fn stored(o: ExtractOutcome) -> (CommitOutcome, ProjectionStatus) {
    match o {
        ExtractOutcome::Stored { commit, projection } => (commit, projection),
        other => panic!("expected stored, got {other:?}"),
    }
}

fn rejected(o: ExtractOutcome) -> Vec<GuardFailure> {
    match o {
        ExtractOutcome::Rejected { failures } => failures,
        other => panic!("expected rejected, got {other:?}"),
    }
}

mod ac0_interactive_only {
    use super::*;

    #[test]
    fn claude_and_codex_plans_are_visible_interactive_sessions() {
        let ws = Path::new("/tmp/hq");
        let kick = kickoff_prompt(JOB);
        let mcp = Path::new("/tmp/hq/p.mcp.json");
        let SessionPlan::ClaudeTerminal { command, .. } =
            plan_session(Provider::Claude, ws, &kick, mcp).unwrap()
        else {
            panic!()
        };
        assert!(command.starts_with("claude --mcp-config "), "{command}");
        let words = shell_words(&command);
        let flags: Vec<&String> = words.iter().take_while(|w| *w != "--").collect();
        for bad in FORBIDDEN_INVOCATIONS {
            assert!(!flags.iter().any(|a| *a == bad), "{bad}");
        }
        let codex_kick = codex_kickoff_prompt(JOB, Path::new("/tmp/hq/p.prompt.md"));
        let SessionPlan::CodexApp { thread_url, .. } =
            plan_session(Provider::Codex, ws, &codex_kick, mcp).unwrap()
        else {
            panic!()
        };
        assert!(thread_url.starts_with("codex://threads/new?prompt="));
    }

    #[test]
    fn headless_plans_are_refused() {
        for command in [
            "claude -p 'go'",
            "claude --print 'go'",
            "claude --output-format json 'go'",
            "codex exec 'go'",
            "claude --mcp-config /x --strict-mcp-config --tools '' -p -- 'go'",
            "claude --mcp-config /x --strict-mcp-config --tools '' --print -- 'go'",
        ] {
            let plan = SessionPlan::ClaudeTerminal {
                workspace: "/tmp".into(),
                command: command.into(),
                args: vec![],
            };
            assert!(assert_interactive(&plan).is_err(), "{command}");
        }
        let plan = SessionPlan::CodexApp {
            workspace: "/tmp".into(),
            thread_url: "https://api.example.com/v1/responses".into(),
        };
        assert!(assert_interactive(&plan).is_err());
    }

    #[test]
    fn cloud_or_headless_output_is_never_accepted() {
        let d = tempfile::tempdir().unwrap();
        for extractor in [
            json!({"provider":"cloud","mode":"interactive"}),
            json!({"provider":"claude","mode":"headless"}),
            json!({"provider":"codex","mode":"interactive"}),
            Value::Null,
        ] {
            let mut out = output(all_eight());
            out["extractor"] = extractor;
            let f = rejected(
                extract_and_store(d.path(), ctx(), &out, &transcript(), &ready_host(d.path()))
                    .unwrap(),
            );
            assert!(f.iter().any(|g| g.code == "non_interactive_extractor"));
        }
        assert!(observation_files(d.path()).is_empty());
    }

    #[test]
    fn extractor_module_spawns_no_process_itself() {
        let src = include_str!("extractor.rs");
        for needle in [
            "Command::new",
            "std::process",
            "tokio::process",
            "reqwest",
            "aws_sdk",
        ] {
            assert!(!src.contains(needle), "{needle}");
        }
    }
}

mod ac1_eight_types {
    use super::*;

    #[test]
    fn prompt_registers_all_eight_types_and_required_fields() {
        let d = tempfile::tempdir().unwrap();
        let h = ready_host(d.path());
        let p = build_prompt(&PromptInput {
            ctx: &ctx(),
            transcript_markdown: "[00:00] Ava: hi",
            projection: &h.status(),
        });
        for t in SignalType::ALL {
            assert!(p.contains(t.as_str()), "{}", t.as_str());
        }
        for f in [
            "\"owner\"",
            "\"reasoning\"",
            "\"speaker\"",
            "startMs",
            "endMs",
            "[00:00] Ava: hi",
        ] {
            assert!(p.contains(f), "{f}");
        }
    }

    #[test]
    fn a_result_using_all_eight_types_is_stored_with_owner_reasoning_and_speaker() {
        let d = tempfile::tempdir().unwrap();
        let (commit, _) = stored(
            extract_and_store(
                d.path(),
                ctx(),
                &output(all_eight()),
                &transcript(),
                &ready_host(d.path()),
            )
            .unwrap(),
        );
        assert!(
            matches!(commit, CommitOutcome::Complete { ref output_ids, .. } if output_ids.len() == 8)
        );
        let fms: Vec<_> = observation_files(d.path())
            .iter()
            .map(|f| read_observation(f).unwrap())
            .collect();
        assert_eq!(fms.len(), 8);
        let get = |t: SignalType| fms.iter().find(|f| f.signal_type == t).unwrap();
        assert_eq!(
            get(SignalType::ActionItem).owner.as_deref(),
            Some("Ben Ortiz")
        );
        assert_eq!(
            get(SignalType::Decision).reasoning.as_deref(),
            Some("Legal cleared the beta terms.")
        );
        assert_eq!(
            get(SignalType::ParticipantContribution).speaker.as_deref(),
            Some("Ava Chen")
        );
    }

    #[test]
    fn required_ownership_reasoning_and_speaker_are_enforced() {
        let d = tempfile::tempdir().unwrap();
        let mut o = all_eight();
        for i in [2, 3, 4] {
            o[i].as_object_mut()
                .unwrap()
                .retain(|k, _| !matches!(k.as_str(), "owner" | "reasoning" | "speaker"));
        }
        let codes: Vec<_> = rejected(
            extract_and_store(
                d.path(),
                ctx(),
                &output(o),
                &transcript(),
                &ready_host(d.path()),
            )
            .unwrap(),
        )
        .into_iter()
        .map(|g| g.code)
        .collect();
        for c in ["missing_reasoning", "missing_owner", "missing_speaker"] {
            assert!(codes.iter().any(|x| x == c), "{c}");
        }
    }
}

mod ac2_tool_allowlist {
    use super::*;

    #[test]
    fn only_the_four_tools_are_callable() {
        let d = tempfile::tempdir().unwrap();
        let mut h = ready_host(d.path());
        assert_eq!(
            TOOL_NAMES,
            [
                "ontology.list",
                "ontology.inspect",
                "ontology.search_alias",
                "queue_entity_candidate"
            ]
        );
        for t in [
            "fs.read",
            "ontology.read",
            "ontology.entities",
            "Read",
            "bash",
            "ontology.write",
            "",
        ] {
            assert!(
                matches!(h.call(t, &json!({})), Err(ToolError::UnknownTool(_))),
                "{t}"
            );
        }
        assert!(h.call("ontology.list", &json!({})).is_ok());
        assert!(h
            .call("ontology.inspect", &json!({"entityId":"ent-person-ben"}))
            .is_ok());
        assert!(h
            .call("ontology.search_alias", &json!({"query":"atlas"}))
            .is_ok());
        assert!(h
            .call("queue_entity_candidate", &json!({"name":"Globex"}))
            .is_ok());
    }

    #[test]
    fn raw_ontology_paths_are_inaccessible() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("companies/indigo/ontology/entities")).unwrap();
        std::fs::write(
            d.path()
                .join("companies/indigo/ontology/entities/secret.md"),
            "secret",
        )
        .unwrap();
        let mut h = ready_host(d.path());
        for input in [
            json!({"entityId":"ontology/entities/secret.md"}),
            json!({"entityId":"../../ontology/entities/secret"}),
            json!({"entityId":"ent-person-ben","path":"ontology/entities/secret.md"}),
        ] {
            assert!(
                matches!(
                    h.call("ontology.inspect", &input),
                    Err(ToolError::InvalidInput(_))
                ),
                "{input}"
            );
        }
        assert!(h
            .call("ontology.list", &json!({"path":"ontology/entities"}))
            .is_err());
        assert!(h
            .call(
                "ontology.list",
                &json!({"cursor":"Li4vb250b2xvZ3kvZW50aXRpZXM"})
            )
            .is_err());
        let r = h
            .call(
                "ontology.search_alias",
                &json!({"query":"ontology/entities/secret"}),
            )
            .unwrap();
        assert_eq!(r["matches"], json!([]));
        let mut keys: Vec<_> = r.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "matches",
                "provisionalCandidates",
                "query",
                "state",
                "watermark"
            ]
        );
    }

    #[test]
    fn lookup_limits_follow_the_hq_pro_contract() {
        let d = tempfile::tempdir().unwrap();
        let mut h = ready_host(d.path());
        assert!(h.call("ontology.list", &json!({"limit":0})).is_err());
        assert!(h
            .call("ontology.search_alias", &json!({"query":"x".repeat(201)}))
            .is_err());
        assert!(h
            .call("ontology.list", &json!({"type":"spaceship"}))
            .is_err());
        let page = h.call("ontology.list", &json!({"limit":2})).unwrap();
        assert_eq!(page["entities"].as_array().unwrap().len(), 2);
        let next = h
            .call("ontology.list", &json!({"cursor": page["nextCursor"]}))
            .unwrap();
        assert_eq!(next["entities"].as_array().unwrap().len(), 1);
        let s = h
            .call(
                "ontology.search_alias",
                &json!({"query":"  PROJECT  atlas!"}),
            )
            .unwrap();
        assert_eq!(s["matches"][0]["entity"]["entityId"], "ent-project-atlas");
        assert_eq!(s["matches"][0]["matchedOn"], "alias");
        assert_eq!(s["matches"][0]["exact"], true);
        assert_eq!(normalize_name("Nörthwínd, Inc."), "northwind inc");
    }
}

mod ac3_same_run_entity_refs {
    use super::*;

    #[test]
    fn looked_up_ids_resolve_and_unresolved_names_become_minimal_candidates() {
        let d = tempfile::tempdir().unwrap();
        let mut h = ready_host(d.path());
        h.call("ontology.search_alias", &json!({"query":"Atlas"}))
            .unwrap();
        let cand = h
            .call(
                "queue_entity_candidate",
                &json!({"name":"Globex","type":"company"}),
            )
            .unwrap();
        let mut o = all_eight();
        o[1]["entityRefs"] = json!(["ent-project-atlas"]);
        o[1]["candidateRefs"] = json!([cand["candidateId"]]);
        stored(extract_and_store(d.path(), ctx(), &output(o), &transcript(), &h).unwrap());
        let fm = observation_files(d.path())
            .iter()
            .map(|f| read_observation(f).unwrap())
            .find(|f| f.signal_type == SignalType::KeyPoint)
            .unwrap();
        assert_eq!(fm.entities.len(), 2);
        assert_eq!(
            fm.entities[0],
            EntityRef {
                entity_id: Some("ent-project-atlas".into()),
                name: "Atlas".into(),
                status: EntityStatus::Resolved
            }
        );
        assert_eq!(
            fm.entities[1],
            EntityRef {
                entity_id: None,
                name: "Globex".into(),
                status: EntityStatus::Provisional
            }
        );
        // The candidate is minimal and lives in the personal store, not ontology/entities/**.
        let cands: Value =
            serde_json::from_slice(&std::fs::read(h.candidates_path()).unwrap()).unwrap();
        assert_eq!(cands.as_array().unwrap().len(), 1);
        let mut keys: Vec<_> = cands[0].as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["candidateId", "jobId", "name", "sourceRef", "type"]);
        assert!(h
            .candidates_path()
            .starts_with(d.path().join("personal/signals").join(COMPANY)));
        assert!(files_under(d.path())
            .iter()
            .all(|p| !p.to_string_lossy().contains("ontology/entities")));
    }

    #[test]
    fn an_id_not_returned_by_a_lookup_in_this_run_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        // Known to the projection, but never looked up in this run.
        let h = ready_host(d.path());
        let mut o = all_eight();
        o[0]["entityRefs"] = json!(["ent-person-ben"]);
        let f = rejected(
            extract_and_store(d.path(), ctx(), &output(o.clone()), &transcript(), &h).unwrap(),
        );
        assert!(f.iter().any(|g| g.code == "entity_ref_not_looked_up"));
        // Looked up in an earlier run's ledger does not count for this run.
        let mut earlier = ready_host(d.path());
        earlier
            .call("ontology.inspect", &json!({"entityId":"ent-person-ben"}))
            .unwrap();
        let fresh = ready_host(d.path());
        let f = rejected(
            extract_and_store(d.path(), ctx(), &output(o), &transcript(), &fresh).unwrap(),
        );
        assert!(f.iter().any(|g| g.code == "entity_ref_not_looked_up"));
        let mut bogus = all_eight();
        bogus[0]["candidateRefs"] = json!(["cand_made_up"]);
        let f = rejected(
            extract_and_store(d.path(), ctx(), &output(bogus), &transcript(), &fresh).unwrap(),
        );
        assert!(f.iter().any(|g| g.code == "unknown_candidate"));
        assert!(observation_files(d.path()).is_empty());
    }

    #[test]
    fn the_ledger_persists_across_separate_tool_calls_for_one_job() {
        let d = tempfile::tempdir().unwrap();
        let path = ToolHost::ledger_path(d.path(), COMPANY, JOB).unwrap();
        let mut a = ready_host(d.path());
        a.call("ontology.inspect", &json!({"entityId":"ent-person-ben"}))
            .unwrap();
        a.save_ledger(&path).unwrap();
        let mut b = ready_host(d.path());
        b.load_ledger(&path).unwrap();
        assert_eq!(
            b.seen_entity("ent-person-ben").as_deref(),
            Some("Ben Ortiz")
        );
        assert!(path.starts_with(d.path().join("personal/signals")));
    }
}

mod ac4_sanitize_up {
    use super::*;

    fn local_observation(hq: &Path) -> ObservationFrontmatter {
        let mut o = all_eight();
        o[5]["content"] = json!("Northwind renewal could slip; see /Users/alice/HQ/personal/notes/northwind.md. Ava said we will lose the renewal if legal stalls.");
        o[5]["candidateRefs"] = json!([]);
        stored(extract_and_store(hq, ctx(), &output(o), &transcript(), &ready_host(hq)).unwrap());
        observation_files(hq)
            .iter()
            .map(|f| read_observation(f).unwrap())
            .find(|f| f.signal_type == SignalType::Risk)
            .unwrap()
    }

    fn extras() -> LocalExtras {
        LocalExtras {
            transcript_excerpt: Some("Ava said we will lose the renewal if legal stalls.".into()),
            source_body: Some(
                "[00:50] Ava Chen: Risk: the Northwind contract renewal could slip a quarter."
                    .into(),
            ),
            personal_note: Some("Ava suspects Northwind budget cuts.".into()),
            local_rank: Some(1),
            dismissed: true,
            device_path: Some("/Users/alice/HQ/personal/notes/northwind.md".into()),
            related_context: Some("Unrelated hiring thread about the design lead.".into()),
        }
    }

    #[test]
    fn candidate_excludes_private_and_device_fields_and_keeps_bounded_evidence() {
        let d = tempfile::tempdir().unwrap();
        let fm = local_observation(d.path());
        let s = sanitize_up(&fm, &extras()).unwrap();
        let text = serde_json::to_string(&s).unwrap();
        for leaked in [
            "Ava said we will lose",
            "budget cuts",
            "/Users/alice",
            "northwind.md",
            "device-a",
            "deviceId",
            "localRank",
            "dismissed",
            "personalNote",
            "transcriptExcerpt",
            "Unrelated hiring",
            "[00:50]",
            "jobId",
            "extractedAt",
        ] {
            assert!(!text.contains(leaked), "leaked {leaked}: {text}");
        }
        assert_eq!(s.schema, SANITIZED_SCHEMA);
        assert_eq!(s.observation_id, fm.observation_id);
        assert!(s.content.starts_with("Northwind renewal could slip"));
        assert!(s.content.chars().count() <= MAX_SANITIZED_CONTENT_CHARS);
        assert_eq!(
            s.citations,
            vec![SanitizedCitation {
                start_ms: 50_000,
                end_ms: 54_000
            }]
        );
        assert_eq!(s.source_digest, fm.source_digest);
        assert_eq!(s.audience_key, fm.audience_key);
    }

    #[test]
    fn sanitize_is_deterministic_and_fails_closed_for_non_eligible() {
        let d = tempfile::tempdir().unwrap();
        let fm = local_observation(d.path());
        assert_eq!(
            sanitize_up(&fm, &extras()).unwrap(),
            sanitize_up(&fm, &extras()).unwrap()
        );
        let mut private = fm.clone();
        private.classification = "private".into();
        assert!(sanitize_up(&private, &extras()).is_err());
        let mut many = fm;
        many.citations = vec![
            Citation {
                source_ref: many.source_ref.clone(),
                start_ms: 0,
                end_ms: 1
            };
            30
        ];
        assert_eq!(
            sanitize_up(&many, &LocalExtras::default())
                .unwrap()
                .citations
                .len(),
            MAX_SANITIZED_CITATIONS
        );
    }
}

mod ac5_degraded_projection {
    use super::*;

    #[test]
    fn stale_missing_and_disabled_complete_with_candidates_and_record_state() {
        let cases = [
            ("stale", projection("stale", NOW), Some("wm-42")),
            (
                "stale",
                projection("ready", "2026-10-13T10:00:00.000Z"),
                Some("wm-42"),
            ),
            ("disabled", projection("disabled", NOW), Some("wm-42")),
            ("missing", Projection::missing(), None),
            (
                "missing",
                Projection::from_pulled(Some("{}"), Some(ENTITIES), COMPANY, MEMBER),
                None,
            ),
            (
                "missing",
                Projection::from_pulled(
                    Some(&projection_manifest_for("prs_bob")),
                    Some(ENTITIES),
                    COMPANY,
                    MEMBER,
                ),
                None,
            ),
        ];
        for (want, p, wm) in cases {
            let d = tempfile::tempdir().unwrap();
            let mut h = host(d.path(), p);
            let s = h
                .call("ontology.search_alias", &json!({"query":"Atlas"}))
                .unwrap();
            assert_eq!(s["matches"], json!([]));
            assert_eq!(s["provisionalCandidates"], true);
            assert_eq!(s["state"], want);
            let insp = h
                .call("ontology.inspect", &json!({"entityId":"ent-project-atlas"}))
                .unwrap();
            assert_eq!(insp["error"], "not_found");
            let cand = h
                .call(
                    "queue_entity_candidate",
                    &json!({"name":"Atlas","type":"project"}),
                )
                .unwrap();
            let mut o = all_eight();
            o[2]["candidateRefs"] = json!([cand["candidateId"]]);
            let (_, status) =
                stored(extract_and_store(d.path(), ctx(), &output(o), &transcript(), &h).unwrap());
            assert_eq!(status.state.as_str(), want);
            for fm in observation_files(d.path())
                .iter()
                .map(|f| read_observation(f).unwrap())
            {
                assert_eq!(fm.projection_state, want);
                assert_eq!(fm.projection_watermark, wm.unwrap_or("none"));
                assert!(fm
                    .entities
                    .iter()
                    .all(|e| e.status == EntityStatus::Provisional && e.entity_id.is_none()));
            }
            // A canonical id cannot be fabricated while the projection is degraded.
            let mut fake = all_eight();
            fake[0]["entityRefs"] = json!(["ent-project-atlas"]);
            let d2 = tempfile::tempdir().unwrap();
            let f = rejected(
                extract_and_store(d2.path(), ctx(), &output(fake), &transcript(), &h).unwrap(),
            );
            assert!(
                f.iter().any(|g| g.code == "entity_ref_not_looked_up"),
                "{want}"
            );
        }
    }

    fn projection_manifest_for(member: &str) -> String {
        let digest: String = Sha256::digest(ENTITIES.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        json!({"schemaVersion": PROJECTION_SCHEMA, "companyUid": COMPANY, "memberUid": member, "generatedAt": NOW,
               "watermark": "wm-42", "state": "ready", "digest": digest}).to_string()
    }
}

mod ac6_validation_before_store {
    use super::*;

    fn run(mutate: impl Fn(&mut Value), t: LocalTranscript) -> (Vec<String>, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let mut out = output(all_eight());
        mutate(&mut out);
        let f =
            rejected(extract_and_store(d.path(), ctx(), &out, &t, &ready_host(d.path())).unwrap());
        assert!(
            observation_files(d.path()).is_empty(),
            "observation committed"
        );
        assert!(
            !d.path()
                .join("personal/signals")
                .join(COMPANY)
                .join("receipts")
                .exists(),
            "receipt written"
        );
        let diag = read_diagnostics(d.path(), COMPANY, JOB)
            .unwrap()
            .expect("diagnostics");
        assert_eq!(diag.failures, f);
        let keep = d.keep();
        (f.into_iter().map(|g| g.code).collect(), keep)
    }

    #[test]
    fn each_guard_failure_is_recorded_exactly() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Value)>, LocalTranscript)> = vec![
            (
                "invalid_type",
                Box::new(|o| o["observations"][0]["type"] = json!("blocker")),
                transcript(),
            ),
            (
                "citation_out_of_bounds",
                Box::new(|o| {
                    o["observations"][1]["citations"] =
                        json!([{"startMs": 179_000, "endMs": 900_000}])
                }),
                transcript(),
            ),
            (
                "citation_out_of_bounds",
                Box::new(|o| o["observations"][1]["citations"] = json!([])),
                transcript(),
            ),
            (
                "member_mismatch",
                Box::new(|o| o["memberUid"] = json!("prs_mallory")),
                transcript(),
            ),
            (
                "digest_mismatch",
                Box::new(|o| o["sourceDigest"] = json!("ee".repeat(32))),
                transcript(),
            ),
            (
                "digest_mismatch",
                Box::new(|_| {}),
                LocalTranscript {
                    source_digest: "ff".repeat(32),
                    ..transcript()
                },
            ),
            (
                "audience_mismatch",
                Box::new(|o| {
                    o["audienceReceiptRef"] = json!("sources/meetings/other.audience.json")
                }),
                transcript(),
            ),
            (
                "audience_mismatch",
                Box::new(|o| o["audienceKey"] = json!("aud-999")),
                transcript(),
            ),
            (
                "schema_mismatch",
                Box::new(|o| o["schemaVersion"] = json!("local-signal/v0")),
                transcript(),
            ),
        ];
        for (code, m, t) in cases {
            let (codes, dir) = run(m, t);
            assert!(codes.iter().any(|c| c == code), "{code}: {codes:?}");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn invalid_type_detail_names_the_bad_value_and_index() {
        let (_, dir) = run(
            |o| o["observations"][4]["type"] = json!("insight"),
            transcript(),
        );
        let diag = read_diagnostics(&dir, COMPANY, JOB).unwrap().unwrap();
        let g = diag
            .failures
            .iter()
            .find(|g| g.code == "invalid_type")
            .unwrap();
        assert_eq!(g.observation, Some(4));
        assert!(g.detail.contains("insight"));
        let _ = std::fs::remove_dir_all(dir);
    }
}

mod ac7_provider_loss {
    use super::*;

    fn claimed(dir: &Path) -> String {
        let c = ctx();
        let rec = runs::request(
            dir,
            RunRequestInput {
                company_uid: c.company_uid,
                member_uid: c.member_uid,
                source_ref: c.source_ref,
                source_digest: c.source_digest,
                audience_receipt_ref: c.audience_receipt_ref,
                provider: ProviderChoice::Claude,
                prompt_version: c.prompt_version,
                schema_version: c.schema_version,
            },
        )
        .unwrap();
        let s = ProviderSession {
            provider: Provider::Claude,
            session_id: "sess-1".into(),
            interactive: true,
        };
        runs::claim(dir, &rec.request.job_id, &s, None).unwrap();
        runs::progress(
            dir,
            &rec.request.job_id,
            "sess-1",
            RunState::Extracting,
            None,
        )
        .unwrap();
        rec.request.job_id
    }

    #[test]
    fn logout_returns_the_run_to_pending_with_one_plain_action() {
        let d = tempfile::tempdir().unwrap();
        let job = claimed(d.path());
        let (rec, r) = handle_provider_failure(
            d.path(),
            &job,
            "sess-1",
            Provider::Claude,
            ProviderFailure::LoggedOut,
        )
        .unwrap();
        assert_eq!(rec.state, RunState::Pending);
        assert!(rec.provider_session_id.is_none());
        assert_eq!(r.action, RecoveryAction::SignInAgain);
        assert_eq!(r.label, "Sign in to Claude");
        assert_eq!(rec.status, r.message);
        for raw in ["error", "Error", "ECONN", "401", "status", "token", "{"] {
            assert!(!r.message.contains(raw) && !r.label.contains(raw), "{raw}");
        }
        // Pending again, so a fresh interactive session can claim it.
        let s2 = ProviderSession {
            provider: Provider::Claude,
            session_id: "sess-2".into(),
            interactive: true,
        };
        assert!(runs::claim(d.path(), &job, &s2, None).is_ok());
    }

    #[test]
    fn transport_loss_after_a_stored_parse_is_recoverable_without_another_model_call() {
        let d = tempfile::tempdir().unwrap();
        let job = claimed(d.path());
        runs::store_parsed_result(d.path(), &job, "sess-1", &output(all_eight())).unwrap();
        let (rec, r) = handle_provider_failure(
            d.path(),
            &job,
            "sess-1",
            Provider::Codex,
            ProviderFailure::TransportLost,
        )
        .unwrap();
        assert_eq!(rec.state, RunState::Extracting);
        assert!(rec.provider_session_id.is_none());
        assert_eq!(r.action, RecoveryAction::Resume);
        assert_eq!(r.label, "Resume");
        let s2 = ProviderSession {
            provider: Provider::Claude,
            session_id: "sess-2".into(),
            interactive: true,
        };
        let plan = runs::recover(d.path(), &job, &s2, None, |_| true).unwrap();
        assert!(!plan.needs_model_call);
    }

    #[test]
    fn another_session_cannot_release_the_run() {
        let d = tempfile::tempdir().unwrap();
        let job = claimed(d.path());
        assert!(handle_provider_failure(
            d.path(),
            &job,
            "sess-other",
            Provider::Claude,
            ProviderFailure::LoggedOut
        )
        .is_err());
        assert_eq!(
            runs::load(d.path(), &job).unwrap().state,
            RunState::Extracting
        );
    }
}

#[allow(dead_code)]
fn _store_is_used(_: store::ParsedResult) {}
