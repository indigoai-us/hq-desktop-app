use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub mod claude;
pub mod codex;
pub mod history;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Running,
    AwaitingInput,
    Idle,
    Ended,
}

impl SessionStatus {
    pub fn is_live(self) -> bool {
        matches!(self, SessionStatus::Running | SessionStatus::AwaitingInput)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTool {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrigin {
    Local,
    Outpost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub tool: AgentTool,
    pub origin: AgentOrigin,
    pub cwd: String,
    pub project: String,
    pub company: String,
    pub model: String,
    pub status: SessionStatus,
    pub started_at: String,
    pub last_activity_at: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionControlSnapshot<HistoryEvent, OutpostStatus> {
    pub sessions: Vec<AgentSession>,
    pub history: Vec<HistoryEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outpost: Option<OutpostStatus>,
}

pub const SESSIONS_POLL_INTERVAL_SECS: u64 = 5;
pub const SESSIONS_POLL_FLOOR_SECS: u64 = 2;

pub fn resolve_poll_interval(env_value: Option<&str>) -> Duration {
    let secs = env_value
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
        .map(|n| n.max(SESSIONS_POLL_FLOOR_SECS))
        .unwrap_or(SESSIONS_POLL_INTERVAL_SECS);
    Duration::from_secs(secs)
}

pub fn merge_sessions(
    claude: Vec<AgentSession>,
    codex: Vec<AgentSession>,
    agents: liveness::RunningAgents,
    now: SystemTime,
) -> Vec<AgentSession> {
    claude
        .into_iter()
        .chain(codex)
        .map(|mut session| {
            session.status = liveness::derive_status(
                &session.last_activity_at,
                UNIX_EPOCH,
                session.tool,
                agents,
                now,
            );
            session
        })
        .collect()
}

pub mod liveness {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{AgentTool, SessionStatus};

    pub const RUNNING_WINDOW_SECS: u64 = 90;
    pub const AWAITING_WINDOW_SECS: u64 = 5 * 60;
    pub const IDLE_WINDOW_SECS: u64 = 30 * 60;

    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct RunningAgents {
        pub claude: bool,
        pub codex: bool,
    }

    impl RunningAgents {
        pub fn is_tool_live(self, tool: AgentTool) -> bool {
            match tool {
                AgentTool::Claude => self.claude,
                AgentTool::Codex => self.codex,
            }
        }
    }

    pub fn classify_processes(pgrep_output: &str) -> RunningAgents {
        let mut agents = RunningAgents::default();

        for line in pgrep_output.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let cmd = line
                .split_once(char::is_whitespace)
                .map(|(_, rest)| rest)
                .unwrap_or(line)
                .to_ascii_lowercase();

            if cmd.is_empty() {
                continue;
            }

            if cmd.contains("pgrep") {
                continue;
            }

            if cmd.contains("claude") {
                agents.claude = true;
            }
            if cmd.contains("codex") {
                agents.codex = true;
            }
        }

        agents
    }

    pub fn derive_status(
        last_activity_iso: &str,
        fallback_mtime: SystemTime,
        tool: AgentTool,
        agents: RunningAgents,
        now: SystemTime,
    ) -> SessionStatus {
        let activity_time =
            parse_rfc3339_to_system_time(last_activity_iso).unwrap_or(fallback_mtime);
        let age_secs = now
            .duration_since(activity_time)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        status_for(age_secs, agents.is_tool_live(tool))
    }

    pub fn status_for(age_secs: u64, tool_is_live: bool) -> SessionStatus {
        if !tool_is_live {
            return SessionStatus::Ended;
        }

        if age_secs <= RUNNING_WINDOW_SECS {
            SessionStatus::Running
        } else if age_secs <= AWAITING_WINDOW_SECS {
            SessionStatus::AwaitingInput
        } else if age_secs <= IDLE_WINDOW_SECS {
            SessionStatus::Idle
        } else {
            SessionStatus::Ended
        }
    }

    pub fn parse_rfc3339_to_system_time(iso: &str) -> Option<SystemTime> {
        let dt = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
        let secs = dt.timestamp();
        if secs < 0 {
            return None;
        }
        Some(UNIX_EPOCH + Duration::from_secs(secs as u64))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// All tools live — the common "everything running" inventory.
        fn all_live() -> RunningAgents {
            RunningAgents {
                claude: true,
                codex: true,
            }
        }

        /// Format a `SystemTime` as the RFC-3339 string the readers stamp into
        /// `lastActivityAt`, so `derive_status` round-trips a real timestamp under
        /// test (seconds precision, `Z` suffix).
        fn iso(t: SystemTime) -> String {
            let secs = t
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        }

        // ── status_for: every transition edge ──────────────────────────────────

        #[test]
        fn status_running_when_fresh_and_process_alive() {
            // Inside the running window, process alive → running.
            assert_eq!(status_for(0, true), SessionStatus::Running);
            assert_eq!(
                status_for(RUNNING_WINDOW_SECS, true),
                SessionStatus::Running
            );
        }

        #[test]
        fn status_awaiting_input_when_quiet_but_alive() {
            // Just past the running window, still within awaiting, process alive →
            // awaiting_input (the "blocked on the human" shape).
            assert_eq!(
                status_for(RUNNING_WINDOW_SECS + 1, true),
                SessionStatus::AwaitingInput
            );
            assert_eq!(
                status_for(AWAITING_WINDOW_SECS, true),
                SessionStatus::AwaitingInput
            );
        }

        #[test]
        fn status_idle_when_stale_but_alive() {
            // Past awaiting, within idle, process alive → idle.
            assert_eq!(
                status_for(AWAITING_WINDOW_SECS + 1, true),
                SessionStatus::Idle
            );
            assert_eq!(status_for(IDLE_WINDOW_SECS, true), SessionStatus::Idle);
        }

        #[test]
        fn status_ended_when_long_stale_even_if_process_alive() {
            // Past the idle window → ended, even though a process is alive (this
            // session's writes stopped long ago; some *other* agent of the same tool
            // is what's live).
            assert_eq!(status_for(IDLE_WINDOW_SECS + 1, true), SessionStatus::Ended);
            assert_eq!(status_for(u64::MAX, true), SessionStatus::Ended);
        }

        /// HARD requirement (PRD): a session with NO live process resolves to ended,
        /// regardless of how fresh its last activity looks.
        #[test]
        fn status_ended_when_no_live_process_regardless_of_freshness() {
            // age 0 (would otherwise be running) but no process → ended.
            assert_eq!(status_for(0, false), SessionStatus::Ended);
            // every other window with no process → ended too.
            assert_eq!(status_for(RUNNING_WINDOW_SECS, false), SessionStatus::Ended);
            assert_eq!(
                status_for(AWAITING_WINDOW_SECS, false),
                SessionStatus::Ended
            );
            assert_eq!(status_for(IDLE_WINDOW_SECS, false), SessionStatus::Ended);
        }

        // ── derive_status: end-to-end with timestamps + inventory ───────────────

        #[test]
        fn derive_running_from_fresh_timestamp() {
            let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
            let activity = now - Duration::from_secs(10);
            let iso = iso(activity);
            assert_eq!(
                derive_status(&iso, now, AgentTool::Claude, all_live(), now),
                SessionStatus::Running
            );
        }

        #[test]
        fn derive_awaiting_input_from_quiet_timestamp() {
            let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
            let activity = now - Duration::from_secs(RUNNING_WINDOW_SECS + 30);
            let iso = iso(activity);
            assert_eq!(
                derive_status(&iso, now, AgentTool::Codex, all_live(), now),
                SessionStatus::AwaitingInput
            );
        }

        #[test]
        fn derive_idle_from_stale_timestamp() {
            let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
            let activity = now - Duration::from_secs(AWAITING_WINDOW_SECS + 60);
            let iso = iso(activity);
            assert_eq!(
                derive_status(&iso, now, AgentTool::Claude, all_live(), now),
                SessionStatus::Idle
            );
        }

        #[test]
        fn derive_ended_when_owning_tool_has_no_process() {
            let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
            // A *fresh* Codex session, but only Claude is live → the Codex session is
            // ended (its process is gone; the fresh mtime is a leftover).
            let activity = now - Duration::from_secs(5);
            let iso = iso(activity);
            let only_claude = RunningAgents {
                claude: true,
                codex: false,
            };
            assert_eq!(
                derive_status(&iso, now, AgentTool::Codex, only_claude, now),
                SessionStatus::Ended,
                "fresh activity but no codex process → ended"
            );
            // And the Claude session in the same inventory is still running.
            assert_eq!(
                derive_status(&iso, now, AgentTool::Claude, only_claude, now),
                SessionStatus::Running
            );
        }

        #[test]
        fn derive_falls_back_to_mtime_when_timestamp_unparseable() {
            let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
            let mtime = now - Duration::from_secs(10); // fresh mtime
            assert_eq!(
                derive_status("not-a-timestamp", mtime, AgentTool::Claude, all_live(), now),
                SessionStatus::Running,
                "unparseable timestamp falls back to the fresh mtime"
            );
        }

        #[test]
        fn derive_handles_future_activity_as_fresh() {
            let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
            let future = now + Duration::from_secs(120); // clock skew
            let iso = iso(future);
            assert_eq!(
                derive_status(&iso, now, AgentTool::Claude, all_live(), now),
                SessionStatus::Running,
                "future activity (skew) treated as fresh, never panics"
            );
        }

        // ── classify_processes: pgrep output parsing ────────────────────────────

        #[test]
        fn classify_detects_claude_and_codex() {
            let out = "\
12345 node /Users/corey/.claude/local/claude --resume
67890 codex exec --model gpt-5.5
11111 /Applications/Some.app/Contents/MacOS/Some unrelated
";
            let agents = classify_processes(out);
            assert!(agents.claude, "claude command line detected");
            assert!(agents.codex, "codex command line detected");
        }

        #[test]
        fn classify_only_claude_when_no_codex_line() {
            let out = "12345 node /Users/corey/.claude/local/claude\n";
            let agents = classify_processes(out);
            assert!(agents.claude);
            assert!(!agents.codex);
        }

        #[test]
        fn classify_empty_output_is_no_agents() {
            assert_eq!(classify_processes(""), RunningAgents::default());
            assert_eq!(classify_processes("   \n  \n"), RunningAgents::default());
        }

        #[test]
        fn classify_ignores_pgrep_self_match() {
            // pgrep's own argv contains the pattern on some platforms — must not
            // count as a live agent.
            let out = "99999 pgrep -fl claude|codex\n";
            let agents = classify_processes(out);
            assert!(!agents.claude, "pgrep self-match is not a live claude");
            assert!(!agents.codex, "pgrep self-match is not a live codex");
        }

        #[test]
        fn classify_does_not_match_bare_pid_number() {
            // A line that is only a pid (no command) must not match anything.
            let agents = classify_processes("12345\n");
            assert_eq!(agents, RunningAgents::default());
        }

        #[test]
        fn running_agents_is_tool_live_maps_per_tool() {
            let only_claude = RunningAgents {
                claude: true,
                codex: false,
            };
            assert!(only_claude.is_tool_live(AgentTool::Claude));
            assert!(!only_claude.is_tool_live(AgentTool::Codex));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> AgentSession {
        AgentSession {
            id: "25f8d9da-435d-44e6-8bb7-849fd8ad67c8".to_string(),
            tool: AgentTool::Claude,
            origin: AgentOrigin::Local,
            cwd: "/Users/corey/Documents/HQ/repos/public/hq-sync".to_string(),
            project: "mission-control".to_string(),
            company: "indigo".to_string(),
            model: "claude-opus-4-8".to_string(),
            status: SessionStatus::Running,
            started_at: "2026-06-15T18:00:00Z".to_string(),
            last_activity_at: "2026-06-15T18:43:20Z".to_string(),
            source: "claude-jsonl".to_string(),
        }
    }

    #[test]
    fn status_serialises_to_taxonomy_strings() {
        // Must match the TS literal union exactly.
        assert_eq!(
            serde_json::to_string(&SessionStatus::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::to_string(&SessionStatus::AwaitingInput).unwrap(),
            "\"awaiting_input\""
        );
        assert_eq!(
            serde_json::to_string(&SessionStatus::Idle).unwrap(),
            "\"idle\""
        );
        assert_eq!(
            serde_json::to_string(&SessionStatus::Ended).unwrap(),
            "\"ended\""
        );
    }

    #[test]
    fn status_deserialises_from_taxonomy_strings() {
        assert_eq!(
            serde_json::from_str::<SessionStatus>("\"awaiting_input\"").unwrap(),
            SessionStatus::AwaitingInput
        );
        // An unknown status is rejected, not silently coerced.
        assert!(serde_json::from_str::<SessionStatus>("\"paused\"").is_err());
    }

    #[test]
    fn status_live_classification() {
        assert!(SessionStatus::Running.is_live());
        assert!(SessionStatus::AwaitingInput.is_live());
        assert!(!SessionStatus::Idle.is_live());
        assert!(!SessionStatus::Ended.is_live());
    }

    #[test]
    fn tool_and_origin_serialise_to_lowercase() {
        assert_eq!(
            serde_json::to_string(&AgentTool::Claude).unwrap(),
            "\"claude\""
        );
        assert_eq!(
            serde_json::to_string(&AgentTool::Codex).unwrap(),
            "\"codex\""
        );
        assert_eq!(
            serde_json::to_string(&AgentOrigin::Local).unwrap(),
            "\"local\""
        );
        assert_eq!(
            serde_json::to_string(&AgentOrigin::Outpost).unwrap(),
            "\"outpost\""
        );
    }

    #[test]
    fn agent_session_round_trips_through_json() {
        let original = sample();
        let json = serde_json::to_string(&original).unwrap();
        let back: AgentSession = serde_json::from_str(&json).unwrap();
        assert_eq!(original, back);
    }

    #[test]
    fn agent_session_serialises_camelcase_keys() {
        let value = serde_json::to_value(sample()).unwrap();
        let obj = value.as_object().unwrap();
        // camelCase keys present (matches the TS contract)…
        assert!(obj.contains_key("startedAt"));
        assert!(obj.contains_key("lastActivityAt"));
        // …and no snake_case leakage.
        assert!(!obj.contains_key("started_at"));
        assert!(!obj.contains_key("last_activity_at"));
        // Nested enums serialise as taxonomy strings, not structs.
        assert_eq!(obj.get("tool").unwrap(), "claude");
        assert_eq!(obj.get("origin").unwrap(), "local");
        assert_eq!(obj.get("status").unwrap(), "running");
    }

    // ── US-005: poll-interval resolution ────────────────────────────────────

    #[test]
    fn poll_interval_defaults_when_env_absent() {
        assert_eq!(
            resolve_poll_interval(None),
            Duration::from_secs(SESSIONS_POLL_INTERVAL_SECS)
        );
    }

    #[test]
    fn poll_interval_honours_a_valid_override() {
        assert_eq!(resolve_poll_interval(Some("15")), Duration::from_secs(15));
        // Whitespace is tolerated.
        assert_eq!(
            resolve_poll_interval(Some("  20 ")),
            Duration::from_secs(20)
        );
    }

    #[test]
    fn poll_interval_clamps_to_the_floor_and_rejects_garbage() {
        // Below the floor → clamped up.
        assert_eq!(
            resolve_poll_interval(Some("1")),
            Duration::from_secs(SESSIONS_POLL_FLOOR_SECS)
        );
        // Zero / non-numeric / empty → default.
        for bad in ["0", "abc", "", "-5"] {
            assert_eq!(
                resolve_poll_interval(Some(bad)),
                Duration::from_secs(SESSIONS_POLL_INTERVAL_SECS),
                "{bad:?} should fall back to the default"
            );
        }
    }

    // ── US-005: merge + liveness ────────────────────────────────────────────

    fn session(id: &str, tool: AgentTool, last_activity_at: &str) -> AgentSession {
        AgentSession {
            id: id.to_string(),
            tool,
            origin: AgentOrigin::Local,
            cwd: "/tmp".to_string(),
            project: "p".to_string(),
            company: "indigo".to_string(),
            model: "m".to_string(),
            // Deliberately a *stale* coarse status so we can prove the merge
            // re-derives it rather than trusting the reader's value.
            status: SessionStatus::Ended,
            started_at: "2026-06-15T18:00:00Z".to_string(),
            last_activity_at: last_activity_at.to_string(),
            source: "test".to_string(),
        }
    }

    /// RFC-3339 string for `now - age_secs` (seconds precision, `Z` suffix).
    fn iso_ago(now: SystemTime, age_secs: u64) -> String {
        let secs = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
            - age_secs as i64;
        chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    #[test]
    fn merge_preserves_order_and_reapplies_liveness() {
        let now = SystemTime::now();
        let claude = vec![session("c1", AgentTool::Claude, &iso_ago(now, 10))];
        let codex = vec![session("x1", AgentTool::Codex, &iso_ago(now, 10))];
        let agents = liveness::RunningAgents {
            claude: true,
            codex: true,
        };

        let merged = merge_sessions(claude, codex, agents, now);

        // Claude first, then Codex — readers' order preserved.
        assert_eq!(
            merged.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["c1", "x1"]
        );
        // Fresh activity + live process → re-derived to running (NOT the stale Ended).
        assert!(merged.iter().all(|s| s.status == SessionStatus::Running));
    }

    #[test]
    fn merge_marks_sessions_ended_when_no_live_process() {
        let now = SystemTime::now();
        // Fresh activity, but the owning tool has NO live process.
        let claude = vec![session("c1", AgentTool::Claude, &iso_ago(now, 5))];
        let agents = liveness::RunningAgents {
            claude: false,
            codex: false,
        };

        let merged = merge_sessions(claude, Vec::new(), agents, now);

        assert_eq!(merged.len(), 1);
        // HARD rule: no live process → ended, regardless of freshness.
        assert_eq!(merged[0].status, SessionStatus::Ended);
    }

    #[test]
    fn snapshot_omits_outpost_key_when_no_outpost() {
        // `outpost: None` must serialise to NO `outpost` key (skip_serializing_if)
        // so the existing frontend shape is unchanged when there's no box.
        let snapshot: MissionControlSnapshot<serde_json::Value, serde_json::Value> =
            MissionControlSnapshot {
                sessions: Vec::new(),
                history: Vec::new(),
                outpost: None,
            };
        let value = serde_json::to_value(&snapshot).unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("sessions"));
        assert!(obj.contains_key("history"));
        assert!(
            !obj.contains_key("outpost"),
            "absent outpost is omitted from the wire"
        );
    }
}
