use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hq_engine::{
    CancellationFlag, Engine, EngineBackend, EngineDomainEvent, EngineError, EngineEventBus,
};
use hq_engine_protocol::{EnvelopeKind, ResponseEnvelope};
use hq_engine_sidecar::{
    event_supervisor_for_bus, run_session, run_session_with_supervisor, DomainEvent,
    EventSupervisor,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Default)]
struct EchoBackend;

impl EngineBackend for EchoBackend {
    fn execute(
        &self,
        method: &str,
        params: &Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError> {
        cancellation.check()?;
        Ok(json!({"method": method, "params": params}))
    }
}

#[derive(Default)]
struct BlockingState {
    started: AtomicBool,
}

#[derive(Clone, Default)]
struct BlockingBackend {
    state: Arc<BlockingState>,
}

impl EngineBackend for BlockingBackend {
    fn execute(
        &self,
        _method: &str,
        _params: &Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError> {
        self.state.started.store(true, Ordering::Release);
        while !cancellation.is_cancelled() {
            std::thread::sleep(Duration::from_millis(1));
        }
        Err(EngineError::cancelled())
    }
}

#[derive(Clone, Default)]
struct LifecycleBackend {
    shutdown_called: Arc<AtomicBool>,
}

impl EngineBackend for LifecycleBackend {
    fn execute(
        &self,
        method: &str,
        params: &Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError> {
        cancellation.check()?;
        Ok(json!({"method": method, "params": params}))
    }

    fn shutdown(&self) {
        self.shutdown_called.store(true, Ordering::Release);
    }
}

fn decode_output(output: &[u8]) -> Vec<ResponseEnvelope> {
    std::str::from_utf8(output)
        .expect("stdout is UTF-8")
        .lines()
        .map(|line| serde_json::from_str(line).expect("stdout contains only protocol JSON"))
        .collect()
}

#[tokio::test]
async fn emits_startup_handshake_before_reading_requests() {
    let input = &b""[..];
    let mut output = Vec::new();
    let engine = Arc::new(Engine::new("0.10.21", EchoBackend));

    let summary = run_session(input, &mut output, engine, |_| {})
        .await
        .expect("session succeeds");
    let frames = decode_output(&output);

    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].kind, EnvelopeKind::Handshake);
    assert_eq!(frames[0].sequence, Some(0));
    assert!(!summary.graceful_shutdown);
}

#[tokio::test]
async fn stdin_eof_shuts_down_the_backend_before_the_session_returns() {
    let backend = LifecycleBackend::default();
    let shutdown_called = Arc::clone(&backend.shutdown_called);
    let engine = Arc::new(Engine::new("0.10.21", backend));
    let mut output = Vec::new();

    tokio::time::timeout(
        Duration::from_secs(1),
        run_session(&b""[..], &mut output, engine, |_| {}),
    )
    .await
    .expect("EOF shutdown returned before the deadline")
    .expect("session succeeds");

    assert!(
        shutdown_called.load(Ordering::Acquire),
        "closing the app-host pipe must stop lifecycle-owned backend workers"
    );
}

#[tokio::test]
async fn health_heartbeat_returns_pong_and_shutdown_is_the_final_frame() {
    let input = concat!(
        "{\"protocolVersion\":1,\"id\":\"health-1\",\"method\":\"health\",\"params\":{}}\n",
        "{\"protocolVersion\":1,\"id\":\"shutdown-1\",\"method\":\"shutdown\",\"params\":{}}\n"
    );
    let mut output = Vec::new();
    let engine = Arc::new(Engine::new("0.10.21", EchoBackend));

    let summary = run_session(input.as_bytes(), &mut output, engine, |_| {})
        .await
        .expect("session succeeds");
    let frames = decode_output(&output);

    assert_eq!(
        frames.iter().map(|frame| frame.kind).collect::<Vec<_>>(),
        vec![
            EnvelopeKind::Handshake,
            EnvelopeKind::Pong,
            EnvelopeKind::Event,
            EnvelopeKind::End,
        ]
    );
    assert_eq!(frames[2].event.as_deref(), Some("engine:shutting_down"));
    assert_eq!(frames[2].sequence, Some(1));
    assert_eq!(frames[3].id.as_deref(), Some("shutdown-1"));
    assert!(summary.graceful_shutdown);
    assert_eq!(summary.requests_received, 2);
}

#[tokio::test]
async fn malformed_input_becomes_a_protocol_error_and_diagnostics_never_hit_stdout() {
    let input = concat!(
        "not-json\n",
        "{\"protocolVersion\":1,\"id\":\"shutdown-2\",\"method\":\"shutdown\",\"params\":{}}\n"
    );
    let mut output = Vec::new();
    let diagnostics = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = diagnostics.clone();
    let engine = Arc::new(Engine::new("0.10.21", EchoBackend));

    let summary = run_session(input.as_bytes(), &mut output, engine, move |message| {
        captured.lock().unwrap().push(message.to_string());
    })
    .await
    .expect("session succeeds");
    let frames = decode_output(&output);

    assert_eq!(frames[0].kind, EnvelopeKind::Handshake);
    assert_eq!(frames[1].kind, EnvelopeKind::Error);
    assert_eq!(frames[1].error.as_ref().unwrap().code, "invalid_request");
    assert_eq!(summary.malformed_frames, 1);
    assert_eq!(diagnostics.lock().unwrap().len(), 1);
    assert!(!std::str::from_utf8(&output).unwrap().contains("not-json"));
}

#[tokio::test]
async fn eof_drains_dispatched_requests_before_returning() {
    let input =
        "{\"protocolVersion\":1,\"id\":\"projects-1\",\"method\":\"projects.list\",\"params\":{}}\n";
    let mut output = Vec::new();
    let engine = Arc::new(Engine::new("0.10.21", EchoBackend));

    let summary = run_session(input.as_bytes(), &mut output, engine, |_| {})
        .await
        .expect("session succeeds");
    let frames = decode_output(&output);

    assert_eq!(frames.len(), 2);
    assert_eq!(frames[1].id.as_deref(), Some("projects-1"));
    assert_eq!(frames[1].kind, EnvelopeKind::Result);
    assert_eq!(summary.requests_received, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_is_processed_while_a_domain_request_is_running() {
    let (mut feeder, input) = tokio::io::duplex(4_096);
    let backend = BlockingBackend::default();
    let state = backend.state.clone();
    let engine = Arc::new(Engine::new("0.10.21", backend));
    let mut output = Vec::new();

    let feed = tokio::spawn(async move {
        feeder
            .write_all(
                b"{\"protocolVersion\":1,\"id\":\"sessions-1\",\"method\":\"sessions.list\",\"params\":{}}\n",
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !state.started.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking request started");
        feeder
            .write_all(
                concat!(
                    "{\"protocolVersion\":1,\"id\":\"cancel-1\",\"method\":\"cancel\",\"params\":{\"requestId\":\"sessions-1\"}}\n",
                    "{\"protocolVersion\":1,\"id\":\"shutdown-3\",\"method\":\"shutdown\",\"params\":{}}\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });

    let summary = run_session(input, &mut output, engine, |_| {})
        .await
        .expect("session succeeds");
    feed.await.unwrap();
    let frames = decode_output(&output);

    let cancel = frames
        .iter()
        .find(|frame| frame.id.as_deref() == Some("cancel-1"))
        .expect("cancel response");
    assert_eq!(cancel.result.as_ref().unwrap()["cancelled"], true);
    let cancelled_work = frames
        .iter()
        .find(|frame| frame.id.as_deref() == Some("sessions-1"))
        .expect("cancelled work response");
    assert_eq!(
        cancelled_work.error.as_ref().unwrap().code,
        "request_cancelled"
    );
    assert_eq!(frames.last().unwrap().kind, EnvelopeKind::End);
    assert!(summary.graceful_shutdown);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_domain_events_and_request_responses_share_one_ndjson_writer() {
    let input =
        "{\"protocolVersion\":1,\"id\":\"projects-2\",\"method\":\"projects.list\",\"params\":{}}\n";
    let mut output = Vec::new();
    let engine = Arc::new(Engine::new("0.10.21", EchoBackend));
    let mut supervisor = EventSupervisor::new(4);
    supervisor.spawn(|source| async move {
        source
            .send(DomainEvent::new(
                Some("sync-2".to_string()),
                "sync:progress",
                json!({"completed": 1, "total": 2}),
            ))
            .await
            .unwrap();
        source.cancelled().await;
    });

    let summary =
        run_session_with_supervisor(input.as_bytes(), &mut output, engine, supervisor, |_| {})
            .await
            .expect("session succeeds");
    let frames = decode_output(&output);

    assert_eq!(frames[0].kind, EnvelopeKind::Handshake);
    assert!(frames
        .iter()
        .any(|frame| frame.id.as_deref() == Some("projects-2")));
    let event = frames
        .iter()
        .find(|frame| frame.event.as_deref() == Some("sync:progress"))
        .expect("domain event reached the single writer");
    assert_eq!(event.sequence, Some(1));
    assert_eq!(event.data.as_ref().unwrap()["completed"], 1);
    assert_eq!(summary.source_events_emitted, 1);
    assert_eq!(summary.producer_tasks_drained, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn engine_event_bus_forwards_through_the_single_writer_and_drains_on_shutdown() {
    let input =
        "{\"protocolVersion\":1,\"id\":\"shutdown-bus\",\"method\":\"shutdown\",\"params\":{}}\n";
    let mut output = Vec::new();
    let engine = Arc::new(Engine::new("0.10.21", EchoBackend));
    let bus = EngineEventBus::bounded(4);
    let supervisor = event_supervisor_for_bus(&bus, 4);
    assert_eq!(
        bus.emit(EngineDomainEvent::new(
            Some("sync-bus".to_string()),
            "sync:progress",
            json!({"completed": 3, "total": 4}),
        )),
        1,
        "the sidecar adapter subscribes before the session starts"
    );

    let summary =
        run_session_with_supervisor(input.as_bytes(), &mut output, engine, supervisor, |_| {})
            .await
            .expect("session succeeds");
    let frames = decode_output(&output);
    let event_index = frames
        .iter()
        .position(|frame| frame.event.as_deref() == Some("sync:progress"))
        .expect("engine bus event reached stdout");
    let end_index = frames
        .iter()
        .position(|frame| frame.kind == EnvelopeKind::End)
        .expect("shutdown end frame");

    assert!(event_index < end_index);
    assert_eq!(frames[event_index].id.as_deref(), Some("sync-bus"));
    assert_eq!(frames[event_index].data.as_ref().unwrap()["completed"], 3);
    assert_eq!(summary.source_events_emitted, 1);
    assert_eq!(summary.producer_tasks_drained, 1);
    assert!(summary.graceful_shutdown);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graceful_shutdown_cancels_producers_and_drains_buffered_events_before_end() {
    let input =
        "{\"protocolVersion\":1,\"id\":\"shutdown-events\",\"method\":\"shutdown\",\"params\":{}}\n";
    let mut output = Vec::new();
    let engine = Arc::new(Engine::new("0.10.21", EchoBackend));
    let observed_cancel = Arc::new(AtomicBool::new(false));
    let observed_cancel_in_task = observed_cancel.clone();
    let mut supervisor = EventSupervisor::new(4);
    supervisor.spawn(move |source| async move {
        source
            .send(DomainEvent::new(
                None,
                "sync:progress",
                json!({"completed": 2, "total": 2}),
            ))
            .await
            .unwrap();
        source.cancelled().await;
        observed_cancel_in_task.store(true, Ordering::Release);
    });

    let summary =
        run_session_with_supervisor(input.as_bytes(), &mut output, engine, supervisor, |_| {})
            .await
            .expect("session succeeds");
    let frames = decode_output(&output);

    assert!(observed_cancel.load(Ordering::Acquire));
    assert_eq!(frames.last().unwrap().kind, EnvelopeKind::End);
    let source_event_index = frames
        .iter()
        .position(|frame| frame.event.as_deref() == Some("sync:progress"))
        .expect("buffered event was drained");
    assert!(source_event_index < frames.len() - 1);
    let event_sequences: Vec<u64> = frames
        .iter()
        .filter_map(|frame| {
            (frame.kind == EnvelopeKind::Event)
                .then_some(frame.sequence)
                .flatten()
        })
        .collect();
    assert_eq!(event_sequences, vec![1, 2]);
    assert_eq!(summary.source_events_emitted, 1);
    assert_eq!(summary.producer_tasks_drained, 1);
    assert!(summary.graceful_shutdown);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_sidecar_shutdown_reaps_the_child_process_without_an_orphan() {
    let state_root = tempfile::tempdir().unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_hq-engine-sidecar"))
        .args([
            "--application-version",
            "0.10.21",
            "--state-root",
            state_root.path().to_str().unwrap(),
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the bundled sidecar binary");
    let mut stdin = child.stdin.take().expect("sidecar stdin");
    let stdout = child.stdout.take().expect("sidecar stdout");
    let mut lines = BufReader::new(stdout).lines();

    let handshake_line = tokio::time::timeout(Duration::from_secs(2), lines.next_line())
        .await
        .expect("sidecar emitted a handshake before the deadline")
        .expect("read sidecar handshake")
        .expect("handshake frame");
    let handshake: ResponseEnvelope =
        serde_json::from_str(&handshake_line).expect("handshake is protocol JSON");
    assert_eq!(handshake.kind, EnvelopeKind::Handshake);

    stdin
        .write_all(
            b"{\"protocolVersion\":1,\"id\":\"shutdown-process\",\"method\":\"shutdown\",\"params\":{}}\n",
        )
        .await
        .expect("write shutdown frame");
    stdin.flush().await.expect("flush shutdown frame");

    let end = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let line = lines
                .next_line()
                .await
                .expect("read sidecar response")
                .expect("sidecar closed before the end frame");
            let frame: ResponseEnvelope =
                serde_json::from_str(&line).expect("stdout contains only protocol JSON");
            if frame.kind == EnvelopeKind::End {
                break frame;
            }
        }
    })
    .await
    .expect("sidecar emitted its terminal end frame before the deadline");
    assert_eq!(end.id.as_deref(), Some("shutdown-process"));
    drop(stdin);

    let status = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(result) => result.expect("wait for sidecar process"),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            panic!("sidecar returned an end frame but left an orphan process");
        }
    };
    assert!(status.success(), "sidecar exited with {status}");
    assert!(
        child.try_wait().expect("query reaped sidecar").is_some(),
        "shutdown must leave no running child process"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_sidecar_stdin_eof_exits_promptly_without_an_orphan() {
    let state_root = tempfile::tempdir().unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_hq-engine-sidecar"))
        .args([
            "--application-version",
            "0.10.21",
            "--state-root",
            state_root.path().to_str().unwrap(),
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the bundled sidecar binary");
    let stdin = child.stdin.take().expect("sidecar stdin");
    let stdout = child.stdout.take().expect("sidecar stdout");
    let mut lines = BufReader::new(stdout).lines();

    let handshake_line = tokio::time::timeout(Duration::from_secs(2), lines.next_line())
        .await
        .expect("sidecar emitted a handshake before the deadline")
        .expect("read sidecar handshake")
        .expect("handshake frame");
    let handshake: ResponseEnvelope =
        serde_json::from_str(&handshake_line).expect("handshake is protocol JSON");
    assert_eq!(handshake.kind, EnvelopeKind::Handshake);
    drop(stdin);

    let status = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(result) => result.expect("wait for sidecar process"),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            panic!("closing stdin left an orphan sidecar process");
        }
    };
    assert!(status.success(), "sidecar exited with {status}");
    assert!(
        child.try_wait().expect("query reaped sidecar").is_some(),
        "EOF must leave no running child process"
    );
}
