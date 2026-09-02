//! Recorded and hand-shaped `stream-json` lines used by the wire and
//! normalizer tests.
//!
//! Provenance is marked per fixture:
//!
//! - `RECORDED` — copied verbatim from a real `claude` 2.1.247 run driven with
//!   `--print --input-format stream-json --output-format stream-json --verbose
//!   --include-partial-messages --permission-prompt-tool stdio
//!   --permission-mode default --model haiku --session-id <uuid>`. The
//!   scenario name in parentheses matches the capture
//!   (`allow`/`allow2`/`write-allow`/`write-deny`/`ask`/`interrupt`). Long
//!   arrays and thinking signatures are TRUNCATED; nothing else is altered.
//! - `DERIVED` — a recorded frame with one field changed, for a state the
//!   capture session could not reach.
//! - `SHAPED` — hand-written to the shape documented by the harness reference.
//!   No subagent run was captured, so those two are the only fully synthetic
//!   frames here; re-verify them against a live subagent run.
//!
//! Generated once from `workspace/tmp/claude-spike/*.jsonl`; edit by hand.

/// RECORDED (`allow`). The session handshake; carries everything `Started` needs.
/// Long arrays truncated; nothing else altered.
pub const SYSTEM_INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/Users/jacobposel/Documents/HQ","session_id":"c34ee513-e375-415f-ae7b-1fb9a71b5953","tools":["Task","AskUserQuestion","Bash"],"mcp_servers":[{"name":"plugin:vercel:vercel","status":"needs-auth"}],"model":"claude-haiku-4-5-20251001","permissionMode":"default","slash_commands":["ask-andrew","ask-hormozi"],"terminal_slash_commands":["doctor","color"],"apiKeySource":"none","claude_code_version":"2.1.247","output_style":"HQ","agents":["claude","Explore"],"skills":["ask-andrew","ask-hormozi"],"plugins":[{"name":"vercel","path":"/Users/jacobposel/.claude/plugins/cache/claude-plugins-official/vercel/0.45.1","source":"vercel@claude-plugins-official","version":"0.45.1"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"8ee2c346-72f7-40a6-a8e3-fc0be5731d63","messaging_socket_path":"/tmp/cc-socks/4805.sock","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}"#;

/// DERIVED from `SYSTEM_INIT`: a repeat `init` for the same run with a
/// DIFFERENT session id, so the dedupe test can observe the silent id update.
pub const SYSTEM_INIT_SECOND: &str = r#"{"type":"system","subtype":"init","cwd":"/Users/jacobposel/Documents/HQ","session_id":"second-session-id","tools":["Bash"],"mcp_servers":[{"name":"plugin:vercel:vercel","status":"needs-auth"}],"model":"claude-haiku-4-5-20251001","permissionMode":"default","slash_commands":[],"terminal_slash_commands":["doctor","color"],"apiKeySource":"none","claude_code_version":"2.1.247","output_style":"HQ","agents":["claude","Explore"],"skills":["ask-andrew","ask-hormozi"],"plugins":[{"name":"vercel","path":"/Users/jacobposel/.claude/plugins/cache/claude-plugins-official/vercel/0.45.1","source":"vercel@claude-plugins-official","version":"0.45.1"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"8ee2c346-72f7-40a6-a8e3-fc0be5731d63","messaging_socket_path":"/tmp/cc-socks/4805.sock","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}"#;

/// RECORDED (`allow`). Turn-lifecycle ping — must produce no event.
pub const SYSTEM_STATUS: &str = r#"{"type":"system","subtype":"status","status":"requesting","session_id":"c34ee513-e375-415f-ae7b-1fb9a71b5953","uuid":"cd7bdaf6-cae7-4760-9ae5-670fd58e2e25"}"#;

/// RECORDED (`allow`). HQ's own hooks fire under `--print`.
pub const SYSTEM_HOOK_STARTED: &str = r#"{"type":"system","subtype":"hook_started","hook_id":"f9329b3f-a71c-4d59-8e86-6db1c0ac7fb7","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"55febeda-5848-4cf0-acb4-4de2ef025ef7","session_id":"c34ee513-e375-415f-ae7b-1fb9a71b5953"}"#;

/// RECORDED (`allow`).
pub const SYSTEM_HOOK_RESPONSE: &str = r#"{"type":"system","subtype":"hook_response","hook_id":"6a344346-fd9e-43ca-ac90-a7e7682799fa","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","uuid":"333bb103-682b-4da1-9b32-b07f41a5e133","session_id":"c34ee513-e375-415f-ae7b-1fb9a71b5953"}"#;

/// RECORDED (`allow`, hook stdout/stderr shortened).
pub const SYSTEM_HOOK_PROGRESS: &str = r#"{"type":"system","subtype":"hook_progress","hook_id":"7653ab0c-1ee0-40c8-b804-d319d6492704","hook_name":"SessionStart:startup","hook_event":"SessionStart","stdout":"","stderr":"awk: towc: multibyte conversion failure\n","output":"awk: towc: multibyte conversion failure\n","uuid":"e3959269-2800-4190-b0f9-f079fba91fbf","session_id":"c34ee513-e375-415f-ae7b-1fb9a71b5953"}"#;

/// RECORDED (`allow2`). Extended-thinking token meter — no event.
pub const SYSTEM_THINKING_TOKENS: &str = r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":7,"estimated_tokens_delta":7,"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","uuid":"a1bf594f-7c19-454a-ad3e-505bd0b429f0"}"#;

/// RECORDED (`allow2`). Not a delta — no event.
pub const STREAM_MESSAGE_START: &str = r#"{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CedhRCWuqWsRKio4vUmy4","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":54340,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":54340},"output_tokens":7,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null}},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"4b13b033-3498-49d7-95a8-c9034f289853","ttft_ms":1486}"#;

/// RECORDED (`allow2`). Not a delta — no event.
pub const STREAM_BLOCK_START: &str = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"9f7e3cc7-f601-4b00-a254-8c6eff11bdb6"}"#;

/// RECORDED (`allow2`).
pub const STREAM_TEXT_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"core.yaml\ndocs\nhook-tests"}},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"88ebeaae-2bd4-4c9b-a3de-5488ab4dabbd"}"#;

/// RECORDED (`allow2`).
pub const STREAM_THINKING_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user is asking me to run","estimated_tokens":null}},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"abd2b57e-f644-41ef-84a2-cf7817ee99ad"}"#;

/// RECORDED (`allow2`, signature truncated). Not renderable — no event.
pub const STREAM_SIGNATURE_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"Eu4DCrIBCBEYAipA/ruBijzz…"}},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"53ddc93b-02c3-47ce-849b-d53a733d4307"}"#;

/// RECORDED (`allow2`). Tool input being generated — no event.
pub const STREAM_INPUT_JSON_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"b058b036-f8ba-49d1-b32d-b27e6d605658"}"#;

/// RECORDED (`allow2`). No event.
pub const STREAM_BLOCK_STOP: &str = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"49723ed9-c422-4028-ae19-78eaf9b1138c"}"#;

/// RECORDED (`allow2`). No event.
pub const STREAM_MESSAGE_DELTA: &str = r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null,"stop_details":null},"usage":{"input_tokens":10,"cache_creation_input_tokens":54340,"cache_read_input_tokens":0,"output_tokens":143,"output_tokens_details":{"thinking_tokens":59},"iterations":[{"input_tokens":10,"output_tokens":143,"cache_read_input_tokens":0,"cache_creation_input_tokens":54340,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":54340},"type":"message"}]},"context_management":{"applied_edits":[]}},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"0184595e-c37e-4fca-8418-3d919bc3e086"}"#;

/// RECORDED (`allow2`). No event.
pub const STREAM_MESSAGE_STOP: &str = r#"{"type":"stream_event","event":{"type":"message_stop"},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":null,"uuid":"2f464f5b-ab79-4719-a2fa-ddf3f711fa36"}"#;

/// SHAPED from the recorded text delta (no subagent run was captured):
/// the same frame tagged with a `parent_tool_use_id`.
pub const STREAM_TEXT_DELTA_SUBAGENT: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"child"}},"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","parent_tool_use_id":"toolu_parent","uuid":"88ebeaae-2bd4-4c9b-a3de-5488ab4dabbd"}"#;

/// RECORDED (`allow2`). A completed assistant text block.
pub const ASSISTANT_TEXT: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CedhRxWpX13JMjExLcef7","type":"message","role":"assistant","content":[{"type":"text","text":"core.yaml\ndocs\nhook-tests"}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":2474,"cache_read_input_tokens":54340,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":2474},"output_tokens":3,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","uuid":"9ecc7b70-66d5-4361-88f6-53bc6a2e1838","timestamp":"2026-09-02T00:52:34.133Z","request_id":"req_011CedhRwqPmcj3nnKoqWB5G"}"#;

/// RECORDED (`allow2`, signature truncated). A completed thinking block —
/// already streamed as deltas, so it must NOT re-emit as text.
pub const ASSISTANT_THINKING: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CedhRCWuqWsRKio4vUmy4","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"The user is asking me to run a bash command to list the contents of the core directory and show the first 3 items, then reply with exactly those three names, nothing else.\n\nLet me run the command: `ls core | head -3`","signature":"Eu4DCrIBCBEYAipA/ruBijzz…"}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":54340,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":54340},"output_tokens":7,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","uuid":"e67adf79-3073-49e9-af23-f1f956f8df6b","timestamp":"2026-09-02T00:52:23.938Z","request_id":"req_011CedhRBtxPUQ4tHF5xFMyZ"}"#;

/// RECORDED (`write-allow`). A `tool_use` block (the Write that triggered
/// the permission prompt below).
pub const ASSISTANT_TOOL_USE: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CedhYCFjGqQnSudUgUaty","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01XBi6iRqmAPhVzA57VVYt2U","name":"Write","input":{"file_path":"/Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt","content":"hello"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":39452,"cache_read_input_tokens":14926,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":39452},"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"febcaa44-9f0f-4ae7-ad70-748009748653","uuid":"2d0c467f-405d-4d42-8a05-c139c04b5a86","timestamp":"2026-09-02T00:53:59.223Z","request_id":"req_011CedhYBdGsCqHR5fD69yH9"}"#;

/// RECORDED (`ask`). The `AskUserQuestion` tool call.
pub const ASSISTANT_ASK_USER_QUESTION: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CedhcE1kujyGwQzvPeHq9","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01VbzzqawEeJjviJQo3G5fkZ","name":"AskUserQuestion","input":{"questions":[{"question":"Which color do you prefer?","header":"Color","multiSelect":false,"options":[{"label":"Red","description":"The color red"},{"label":"Blue","description":"The color blue"}]}]},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":39422,"cache_read_input_tokens":14926,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":39422},"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"dbfd3230-2b20-43fa-aaee-aab699908393","uuid":"d9fea0ba-9e64-4be0-9454-49724bb011ca","timestamp":"2026-09-02T00:54:53.722Z","request_id":"req_011CedhcDL5fdBHJCgzKYfVT"}"#;

/// RECORDED (`allow`, pre-login). A failed turn carries a terse `error` code
/// here — usually the ONLY place the failure is visible.
pub const ASSISTANT_AUTH_ERROR: &str = r#"{"type":"assistant","message":{"diagnostics":null,"id":"2f5e984c-4259-4e77-9a37-33dd4803a886","container":null,"model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"output_tokens_details":null,"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null},"content":[{"type":"text","text":"Failed to authenticate: OAuth session expired and could not be refreshed"}],"context_management":null},"parent_tool_use_id":null,"session_id":"c34ee513-e375-415f-ae7b-1fb9a71b5953","uuid":"c409aff5-ea79-4ace-b5d2-d81e6065e3f8","timestamp":"2026-09-02T00:48:23.872Z","error":"authentication_failed","is_api_error_message":true}"#;

/// SHAPED (no subagent run captured): a tagged assistant frame with a text
/// block and a tool call.
pub const ASSISTANT_SUBAGENT: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CedhYCFjGqQnSudUgUaty","type":"message","role":"assistant","content":[{"type":"text","text":"child text"},{"type":"tool_use","id":"toolu_child","name":"Read","input":{"file_path":"/a"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":39452,"cache_read_input_tokens":14926,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":39452},"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":"toolu_parent","session_id":"febcaa44-9f0f-4ae7-ad70-748009748653","uuid":"2d0c467f-405d-4d42-8a05-c139c04b5a86","timestamp":"2026-09-02T00:53:59.223Z","request_id":"req_011CedhYBdGsCqHR5fD69yH9"}"#;

/// RECORDED (`write-allow`). Note there is NO `is_error` key on success.
pub const USER_TOOL_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01XBi6iRqmAPhVzA57VVYt2U","type":"tool_result","content":"File created successfully at: /Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt (file state is current in your context — no need to Read it back)"}]},"parent_tool_use_id":null,"session_id":"febcaa44-9f0f-4ae7-ad70-748009748653","uuid":"7df1c1f3-1634-4ace-b1e5-af531e8a6d62","timestamp":"2026-09-02T00:54:04.138Z","tool_use_result":{"type":"create","filePath":"/Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt","content":"hello","structuredPatch":[],"originalFile":null,"userModified":false}}"#;

/// RECORDED (`write-deny`). Our deny message comes back as an ERRORED tool
/// result and the model continues — the CLI never hangs.
pub const USER_TOOL_RESULT_DENIED: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Spike: user denied this tool call. Explain what you would have done instead.","is_error":true,"tool_use_id":"toolu_016hcS56bGt8sieB3DR9jAZ1"}]},"parent_tool_use_id":null,"session_id":"4040ce87-6e95-4820-b67f-6c56d42420b5","uuid":"32b8de90-7275-4f7e-b3c0-18e8c6e34992","timestamp":"2026-09-02T00:54:28.455Z","tool_use_result":"Error: Spike: user denied this tool call. Explain what you would have done instead.","tool_result_meta":[{"id":"toolu_016hcS56bGt8sieB3DR9jAZ1","non_execution_kind":"permission-rule"}]}"#;

/// RECORDED (`ask`). The answers echo back as a normal tool result.
pub const USER_TOOL_RESULT_ANSWERS: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Your questions have been answered: \"Which color do you prefer?\"=\"Blue\". You can now continue with these answers in mind.","tool_use_id":"toolu_01VbzzqawEeJjviJQo3G5fkZ"}]},"parent_tool_use_id":null,"session_id":"dbfd3230-2b20-43fa-aaee-aab699908393","uuid":"e204bc38-79f9-4ebd-90ed-d2afda7f2410","timestamp":"2026-09-02T00:54:53.899Z","tool_use_result":{"questions":[{"question":"Which color do you prefer?","header":"Color","options":[{"label":"Red","description":"The color red"},{"label":"Blue","description":"The color blue"}],"multiSelect":false}],"answers":{"Which color do you prefer?":"Blue"}}}"#;

/// RECORDED (`interrupt`). A synthetic text block, not conversation — no event.
pub const USER_INTERRUPT_TEXT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null,"session_id":"c551f5ce-a8ed-460e-8d94-3c17ffd83217","uuid":"882a7154-2333-4f28-b55c-608a8823b005","timestamp":"2026-09-02T00:57:42.736Z"}"#;

/// SHAPED from the recorded success result: the same frame tagged with a
/// `parent_tool_use_id`.
pub const USER_TOOL_RESULT_SUBAGENT: &str = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_child","type":"tool_result","content":"File created successfully at: /Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt (file state is current in your context — no need to Read it back)"}]},"parent_tool_use_id":"toolu_parent","session_id":"febcaa44-9f0f-4ae7-ad70-748009748653","uuid":"7df1c1f3-1634-4ace-b1e5-af531e8a6d62","timestamp":"2026-09-02T00:54:04.138Z","tool_use_result":{"type":"create","filePath":"/Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt","content":"hello","structuredPatch":[],"originalFile":null,"userModified":false}}"#;

/// RECORDED (`allow2`). Emitted once per turn even when nothing is blocked —
/// only `rejected` may surface.
pub const RATE_LIMIT_ALLOWED: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788321600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":1788321600},"seven_day":{"utilization":0.07,"resetsAt":1788825600}}},"uuid":"4c1ec6dd-d299-4e42-a752-db3622af612a","session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06"}"#;

/// DERIVED from `RATE_LIMIT_ALLOWED` with `status: rejected` (no real
/// rejection was captured).
pub const RATE_LIMIT_REJECTED: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788321600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":1788321600},"seven_day":{"utilization":0.07,"resetsAt":1788825600}}},"uuid":"4c1ec6dd-d299-4e42-a752-db3622af612a","session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06"}"#;

/// RECORDED (`allow2`). A clean turn.
pub const RESULT_SUCCESS: &str = r#"{"duration_api_ms":4448,"stop_reason":"end_turn","session_id":"bda49ac8-be7a-402e-aa29-530eb37cad06","total_cost_usd":0.12023500000000001,"usage":{"input_tokens":18,"cache_creation_input_tokens":56814,"cache_read_input_tokens":54340,"output_tokens":231,"output_tokens_details":{"thinking_tokens":132},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":56814,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":8,"output_tokens":88,"cache_read_input_tokens":54340,"cache_creation_input_tokens":2474,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":2474},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":18,"outputTokens":231,"cacheReadInputTokens":54340,"cacheCreationInputTokens":56814,"webSearchRequests":0,"costUSD":0.12023500000000001,"contextWindow":200000,"maxOutputTokens":32000,"thinkingTokens":132,"canonicalModel":"claude-haiku-4-5","provider":"firstParty","costBasis":"list"}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"is_error":false,"num_turns":2,"subtype":"success","api_error_status":null,"result":"core.yaml\ndocs\nhook-tests","ttft_ms":8694,"type":"result","duration_ms":27201,"uuid":"251e3302-b7ef-4c45-9175-a01aaf83c712","ttft_stream_ms":7984,"time_to_request_ms":6497,"queued_turn_count":0}"#;

/// RECORDED (`allow`, pre-login). `subtype:"success"` WITH `is_error:true` —
/// status must be decided by `is_error`, never the subtype alone.
pub const RESULT_AUTH_FAILURE: &str = r#"{"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"c34ee513-e375-415f-ae7b-1fb9a71b5953","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"api_error","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"is_error":true,"num_turns":1,"subtype":"success","api_error_status":null,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","type":"result","duration_ms":2418,"uuid":"1b58bcb0-d73a-45ca-91ba-5e45fa19cb51","queued_turn_count":0}"#;

/// RECORDED (`interrupt`) after we sent an interrupt control request:
/// `error_during_execution`, `is_error:true`, no `result` text, and only an
/// internal `[ede_diagnostic]` breadcrumb in `errors`.
pub const RESULT_INTERRUPTED: &str = r#"{"duration_api_ms":0,"stop_reason":null,"session_id":"c551f5ce-a8ed-460e-8d94-3c17ffd83217","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"aborted_streaming","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"is_error":true,"num_turns":2,"subtype":"error_during_execution","errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],"type":"result","duration_ms":36437,"uuid":"b9629cd0-55b1-4917-97e6-50e8479816be","queued_turn_count":0}"#;

/// SHAPED (no capped run captured): a run-limit failure with real errors.
pub const RESULT_MAX_TURNS: &str = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":30,"duration_ms":900,"duration_api_ms":800,"total_cost_usd":0.12,"session_id":"c34ee513-e375-415f-ae7b-1fb9a71b5953","errors":["hit the cap"],"usage":{"input_tokens":7,"output_tokens":8}}"#;

/// RECORDED (`write-allow`). A permission prompt on the stdio control
/// channel. Allowlisted tools never produce one.
pub const CONTROL_CAN_USE_TOOL: &str = r#"{"type":"control_request","request_id":"db52ed9a-0c32-46db-8ed8-d0a8531c7460","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/Users/jacobposel/Documents/HQ/workspace/tmp/claude-spike/hello-allow.txt","content":"hello"},"description":"workspace/tmp/claude-spike/hello-allow.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01XBi6iRqmAPhVzA57VVYt2U"}}"#;

/// RECORDED (`ask`). `AskUserQuestion` rides the same `can_use_tool`
/// channel, flagged `requires_user_interaction`.
pub const CONTROL_ASK_USER_QUESTION: &str = r#"{"type":"control_request","request_id":"9a1e5daf-f08e-4cc9-a2e5-5c527871b79b","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Which color do you prefer?","header":"Color","options":[{"label":"Red","description":"The color red"},{"label":"Blue","description":"The color blue"}],"multiSelect":false}]},"tool_use_id":"toolu_01VbzzqawEeJjviJQo3G5fkZ","requires_user_interaction":true}}"#;

/// RECORDED (`interrupt`). The receipt for our interrupt request.
pub const CONTROL_INTERRUPT_RECEIPT: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"int_1","response":{"still_queued":[]}}}"#;

/// RECORDED (`allow`; commands truncated to three — the first real entry, a
/// real entry WITH an `argumentHint`, and a blank-name entry that must be
/// dropped — and models truncated to one).
pub const CONTROL_INITIALIZE_RESPONSE: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"init_1","response":{"commands":[{"name":"ask-andrew","description":"Search locally indexed Andrew Faris Podcast transcripts and answer with attributed episode context and clickable timestamps. Use when a user asks what Andrew Faris has said, taught, recommended, tested, or believed about ecommerce, Meta ads, creative strategy, attribution, landing pages, agencies, or related operator topics. (user)","argumentHint":""},{"name":"conduct","description":"Put the session into orchestrator mode — every task is dispatched to a background worker agent on a user-chosen model (grok-worker on grok-4.5, ocx-self, ocx-gpt-5-6-sol-pro, or native Claude opus/sonnet/haiku), so the parent session stays free to accept and route new messages. Use when the user says \"/conduct\", \"use background agents for everything\", \"keep the session free\", \"orchestrate via workers\", or names a model for delegated work. (project)","argumentHint":"[agent] [task description] | status | off"},{"name":"  ","description":"blank name is dropped","argumentHint":""}],"agents":[{"name":"claude","description":"Catch-all for any task that doesn't fit a more specific agent. FleetView's default when no agent name is typed."}],"output_style":"HQ","available_output_styles":["default","Proactive","Concise","Explanatory","Learning","HQ","Cavebro","HQ Operator"],"models":[{"value":"default","resolvedModel":"claude-opus-5[1m]","displayName":"Default (recommended)","description":"Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsAdaptiveThinking":true,"supportsFastMode":true,"supportsAutoMode":true}],"account":{"tokenSource":"none","apiProvider":"firstParty"},"pid":4805,"current_permission_mode":"default","analytics_disabled":false,"remote_control_auto_enable":true,"remote_control_auto_on_by_default":true,"ide_rc_auto_enable_gate":true,"fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","session_state":"idle"}}}"#;
