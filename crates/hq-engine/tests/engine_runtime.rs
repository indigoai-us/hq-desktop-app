use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hq_engine::{
    capabilities, parity_command_registration, CancellationFlag, CoreBackend, Engine,
    EngineBackend, EngineDomainEvent, EngineError, EngineEventBus, ParityCommandStatus,
};
use hq_engine_protocol::{EnvelopeKind, RequestEnvelope, PROTOCOL_VERSION};
use serde_json::{json, Value};

#[derive(Default)]
struct MockState {
    calls: Mutex<Vec<String>>,
    blocking_started: AtomicBool,
}

#[derive(Clone, Default)]
struct MockBackend {
    state: Arc<MockState>,
}

impl MockBackend {
    fn calls(&self) -> Vec<String> {
        self.state.calls.lock().unwrap().clone()
    }

    fn blocking_started(&self) -> bool {
        self.state.blocking_started.load(Ordering::Acquire)
    }
}

impl EngineBackend for MockBackend {
    fn execute(
        &self,
        method: &str,
        params: &Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError> {
        self.state.calls.lock().unwrap().push(method.to_string());
        if method == "sessions.list" && params["block"] == true {
            self.state.blocking_started.store(true, Ordering::Release);
            while !cancellation.is_cancelled() {
                std::thread::sleep(Duration::from_millis(1));
            }
            return Err(EngineError::cancelled());
        }
        cancellation.check()?;
        Ok(json!({"method": method, "params": params}))
    }
}

fn request(id: &str, method: &str, params: Value) -> RequestEnvelope {
    RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        id: id.to_string(),
        method: method.to_string(),
        params,
    }
}

async fn wait_until_started(backend: &MockBackend) {
    tokio::time::timeout(Duration::from_millis(500), async {
        while !backend.blocking_started() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("blocking backend did not start");
}

#[tokio::test]
async fn domain_event_bus_is_typed_synchronous_and_bounded() {
    let bus = EngineEventBus::bounded(2);
    let mut receiver = bus.subscribe();

    assert_eq!(
        bus.emit(EngineDomainEvent::new(
            Some("sync-1".to_string()),
            "sync:progress",
            json!({"completed": 1}),
        )),
        1
    );
    let first = receiver.recv().await.expect("typed event is delivered");
    assert_eq!(first.request_id.as_deref(), Some("sync-1"));
    assert_eq!(first.name, "sync:progress");
    assert_eq!(first.data["completed"], 1);

    bus.emit(EngineDomainEvent::new(
        None,
        "sync:progress",
        json!({"n": 2}),
    ));
    bus.emit(EngineDomainEvent::new(
        None,
        "sync:progress",
        json!({"n": 3}),
    ));
    bus.emit(EngineDomainEvent::new(
        None,
        "sync:progress",
        json!({"n": 4}),
    ));

    let lag = receiver
        .recv()
        .await
        .expect_err("bounded bus must report overwritten events");
    assert!(matches!(
        lag,
        tokio::sync::broadcast::error::RecvError::Lagged(1)
    ));
    assert_eq!(receiver.recv().await.unwrap().data["n"], 3);
    assert_eq!(receiver.recv().await.unwrap().data["n"], 4);
}

#[test]
fn domain_event_emission_without_a_subscriber_is_a_safe_noop() {
    let bus = EngineEventBus::bounded(4);
    assert_eq!(
        bus.emit(EngineDomainEvent::new(None, "sync:idle", json!({}))),
        0
    );
}

#[tokio::test]
async fn capabilities_are_only_implemented_methods() {
    let capabilities = capabilities();
    let unique = capabilities.iter().copied().collect::<BTreeSet<_>>();
    assert_eq!(
        unique.len(),
        capabilities.len(),
        "the handshake must never advertise duplicate capabilities"
    );

    let engine = Engine::new("0.10.21", MockBackend::default());
    for (index, capability) in capabilities.iter().enumerate() {
        if ["health", "cancel", "shutdown"].contains(capability) {
            continue;
        }
        let response = engine
            .handle(request(
                &format!("capability-{index}"),
                capability,
                json!({}),
            ))
            .await;
        assert_ne!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("method_not_found"),
            "{capability} is advertised without a dispatch implementation"
        );
        if let Some(registration) = parity_command_registration(capability) {
            assert!(
                matches!(
                    registration.status,
                    ParityCommandStatus::Implemented { method } if method == *capability
                ),
                "{capability} is advertised without a real parity implementation"
            );
        }
    }
}

#[test]
fn startup_handshake_declares_versions_and_capabilities() {
    let engine = Engine::new("0.10.21", MockBackend::default());
    let handshake = engine.startup_handshake();

    assert_eq!(handshake.kind, EnvelopeKind::Handshake);
    assert_eq!(handshake.sequence, Some(0));
    assert_eq!(
        handshake.result.as_ref().unwrap()["applicationVersion"],
        "0.10.21"
    );
    assert_eq!(
        handshake.result.as_ref().unwrap()["capabilities"],
        json!(capabilities())
    );
}

#[tokio::test]
async fn routes_domain_requests_and_echoes_the_request_id() {
    let backend = Arc::new(MockBackend::default());
    let engine = Engine::new("0.10.21", (*backend).clone());

    let response = engine
        .handle(request(
            "projects-1",
            "projects.list",
            json!({"company": "indigo"}),
        ))
        .await;

    assert_eq!(response.id.as_deref(), Some("projects-1"));
    assert_eq!(response.kind, EnvelopeKind::Result);
    assert_eq!(response.result.as_ref().unwrap()["method"], "projects.list");
    assert_eq!(backend.calls(), vec!["projects.list"]);
    assert_eq!(engine.in_flight_count(), 0);
}

#[tokio::test]
async fn rejects_unknown_methods_without_claiming_or_executing_them() {
    let backend = Arc::new(MockBackend::default());
    let engine = Engine::new("0.10.21", (*backend).clone());

    let response = engine
        .handle(request("unknown-1", "sync.run", json!({})))
        .await;

    assert_eq!(response.kind, EnvelopeKind::Error);
    assert_eq!(response.error.unwrap().code, "method_not_found");
    assert!(backend.calls().is_empty());
}

#[tokio::test]
async fn health_is_a_pong_with_current_lifecycle_state() {
    let engine = Engine::new("0.10.21", MockBackend::default());

    let response = engine
        .handle(request("health-1", "health", json!({})))
        .await;

    assert_eq!(response.kind, EnvelopeKind::Pong);
    assert_eq!(response.id.as_deref(), Some("health-1"));
    assert_eq!(response.result.as_ref().unwrap()["healthy"], true);
    assert_eq!(response.result.as_ref().unwrap()["shuttingDown"], false);
    assert_eq!(response.result.as_ref().unwrap()["inFlightRequests"], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_interrupts_an_in_flight_request() {
    let backend = Arc::new(MockBackend::default());
    let engine = Arc::new(Engine::new("0.10.21", (*backend).clone()));
    let work_engine = engine.clone();
    let work = tokio::spawn(async move {
        work_engine
            .handle(request(
                "sessions-1",
                "sessions.list",
                json!({"block": true}),
            ))
            .await
    });

    wait_until_started(&backend).await;
    let cancelled = engine
        .handle(request(
            "cancel-1",
            "cancel",
            json!({"requestId": "sessions-1"}),
        ))
        .await;
    let work_response = work.await.unwrap();

    assert_eq!(cancelled.kind, EnvelopeKind::Result);
    assert_eq!(cancelled.result.unwrap()["cancelled"], true);
    assert_eq!(work_response.kind, EnvelopeKind::Error);
    assert_eq!(work_response.error.unwrap().code, "request_cancelled");
    assert_eq!(engine.in_flight_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_cancels_work_and_returns_an_end_envelope() {
    let backend = Arc::new(MockBackend::default());
    let engine = Arc::new(Engine::new("0.10.21", (*backend).clone()));
    let work_engine = engine.clone();
    let work = tokio::spawn(async move {
        work_engine
            .handle(request(
                "sessions-2",
                "sessions.list",
                json!({"block": true}),
            ))
            .await
    });

    wait_until_started(&backend).await;
    let end = engine
        .handle(request("shutdown-1", "shutdown", json!({})))
        .await;
    let work_response = work.await.unwrap();

    assert_eq!(end.kind, EnvelopeKind::End);
    assert_eq!(end.result.unwrap()["accepted"], true);
    assert!(engine.is_shutting_down());
    assert_eq!(work_response.error.unwrap().code, "request_cancelled");

    let rejected = engine
        .handle(request("projects-2", "projects.list", json!({})))
        .await;
    assert_eq!(rejected.error.unwrap().code, "engine_shutting_down");
}

#[cfg(unix)]
fn unix_process_is_alive(pid: u32) -> bool {
    use std::os::raw::c_int;

    extern "C" {
        fn kill(pid: c_int, signal: c_int) -> c_int;
    }

    unsafe { kill(pid as c_int, 0) == 0 }
}

#[cfg(unix)]
fn force_kill_unix_process_group(pid: u32) {
    use std::os::raw::c_int;

    extern "C" {
        fn kill(pid: c_int, signal: c_int) -> c_int;
    }

    const SIGKILL: c_int = 9;
    let _ = unsafe { kill(-(pid as c_int), SIGKILL) };
}

#[cfg(unix)]
async fn wait_for_pid_file(path: &std::path::Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(value) = std::fs::read_to_string(path) {
                if let Ok(pid) = value.trim().parse::<u32>() {
                    break pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("managed process did not publish its pid")
}

#[cfg(unix)]
async fn spawn_long_lived_process(
    engine: &Engine<CoreBackend>,
    request_id: &str,
    root: &std::path::Path,
) -> u32 {
    let pid_path = root.join(format!("{request_id}.pid"));
    let response = engine
        .handle(request(
            request_id,
            "spawn_process",
            json!({
                "args": {
                    "cmd": "/bin/sh",
                    "args": [
                        "-c",
                        "echo $$ > \"$1\"; exec /bin/sleep 30",
                        "hq-engine-test",
                        pid_path
                    ],
                    "cwd": root
                }
            }),
        ))
        .await;
    assert_eq!(response.kind, EnvelopeKind::Result);
    wait_for_pid_file(&pid_path).await
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_reaps_only_managed_processes_owned_by_that_engine() {
    let first_root = tempfile::tempdir().unwrap();
    let second_root = tempfile::tempdir().unwrap();
    let first = Engine::new(
        "0.10.21",
        CoreBackend::with_roots(
            first_root.path(),
            first_root.path().join("claude"),
            first_root.path().join("codex"),
        ),
    );
    let second = Engine::new(
        "0.10.21",
        CoreBackend::with_roots(
            second_root.path(),
            second_root.path().join("claude"),
            second_root.path().join("codex"),
        ),
    );

    let first_pid = spawn_long_lived_process(&first, "spawn-first", first_root.path()).await;
    let second_pid = spawn_long_lived_process(&second, "spawn-second", second_root.path()).await;

    let shutdown = first
        .handle(request("shutdown-first", "shutdown", json!({})))
        .await;
    let first_alive_after_shutdown = unix_process_is_alive(first_pid);
    let second_alive_after_shutdown = unix_process_is_alive(second_pid);

    let _ = second
        .handle(request("shutdown-second", "shutdown", json!({})))
        .await;
    force_kill_unix_process_group(first_pid);
    force_kill_unix_process_group(second_pid);

    assert_eq!(shutdown.kind, EnvelopeKind::End);
    assert!(
        !first_alive_after_shutdown,
        "engine shutdown must reap its managed process group"
    );
    assert!(
        second_alive_after_shutdown,
        "engine shutdown must not signal a process owned by another engine"
    );
}
