//! Concurrent stdio runner for the native HQ engine sidecar.

mod event_supervisor;

use std::io;
use std::sync::Arc;

use hq_engine::{Engine, EngineBackend, EngineEventBus};
use hq_engine_protocol::{
    decode_request_line, encode_response_line, method, ErrorBody, ResponseEnvelope,
};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::task::JoinSet;

use event_supervisor::EventShutdown;
pub use event_supervisor::{DomainEvent, EventSource, EventSupervisor};

pub fn event_supervisor_for_bus(bus: &EngineEventBus, capacity: usize) -> EventSupervisor {
    let mut receiver = bus.subscribe();
    let mut supervisor = EventSupervisor::new(capacity);
    supervisor.spawn(move |source| async move {
        loop {
            tokio::select! {
                biased;
                event = receiver.recv() => {
                    match event {
                        Ok(event) => {
                            if source
                                .send(DomainEvent::new(
                                    event.request_id,
                                    event.name,
                                    event.data,
                                ))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = source.cancelled() => break,
            }
        }
    });
    supervisor
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunSummary {
    pub requests_received: usize,
    pub malformed_frames: usize,
    pub source_events_emitted: usize,
    pub producer_tasks_drained: usize,
    pub graceful_shutdown: bool,
}

pub async fn run_session<R, W, B, D>(
    input: R,
    output: &mut W,
    engine: Arc<Engine<B>>,
    diagnostics: D,
) -> io::Result<RunSummary>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    B: EngineBackend,
    D: Fn(&str) + Send + Sync,
{
    run_session_with_supervisor(input, output, engine, EventSupervisor::new(1), diagnostics).await
}

pub async fn run_session_with_supervisor<R, W, B, D>(
    input: R,
    output: &mut W,
    engine: Arc<Engine<B>>,
    mut supervisor: EventSupervisor,
    diagnostics: D,
) -> io::Result<RunSummary>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    B: EngineBackend,
    D: Fn(&str) + Send + Sync,
{
    let mut summary = RunSummary::default();
    let mut lines = BufReader::new(input).lines();
    let mut tasks: JoinSet<ResponseEnvelope> = JoinSet::new();

    write_frame(output, &engine.startup_handshake()).await?;

    loop {
        tokio::select! {
            event = supervisor.next() => {
                if let Some(event) = event {
                    write_source_event(output, &engine, event).await?;
                    summary.source_events_emitted += 1;
                }
            }
            joined = tasks.join_next(), if !tasks.is_empty() => {
                match joined {
                    Some(Ok(response)) => write_frame(output, &response).await?,
                    Some(Err(error)) => {
                        diagnostics(&format!("engine request task failed: {error}"));
                    }
                    None => {}
                }
            }
            line = lines.next_line() => {
                let Some(line) = line? else {
                    break;
                };
                let request = match decode_request_line(&line) {
                    Ok(request) => request,
                    Err(error) => {
                        summary.malformed_frames += 1;
                        diagnostics(&format!(
                            "rejected malformed protocol frame: {}",
                            error.code
                        ));
                        let id = recover_request_id(&line);
                        write_frame(output, &ResponseEnvelope::error(id, error)).await?;
                        continue;
                    }
                };
                summary.requests_received += 1;

                match request.method.as_str() {
                    method::HEALTH | method::CANCEL => {
                        let response = engine.handle(request).await;
                        write_frame(output, &response).await?;
                    }
                    method::SHUTDOWN => {
                        let request_id = request.id.clone();
                        let end = engine.handle(request).await;
                        let event = engine.event(
                            Some(request_id),
                            "engine:shutting_down",
                            json!({"graceful": true}),
                        );
                        write_frame(output, &event).await?;
                        drain_tasks(&mut tasks, output, &diagnostics).await?;
                        let event_shutdown = supervisor.shutdown().await;
                        drain_source_events(
                            output,
                            &engine,
                            event_shutdown,
                            &mut summary,
                        )
                        .await?;
                        write_frame(output, &end).await?;
                        output.flush().await?;
                        summary.graceful_shutdown = true;
                        return Ok(summary);
                    }
                    _ => {
                        let request_engine = engine.clone();
                        tasks.spawn(async move { request_engine.handle(request).await });
                    }
                }
            }
        }
    }

    let cooperative_drain = drain_tasks_for(
        &mut tasks,
        output,
        &diagnostics,
        std::time::Duration::from_millis(50),
    )
    .await;
    engine.shutdown_for_host().await;
    cooperative_drain?;
    drain_tasks(&mut tasks, output, &diagnostics).await?;
    let event_shutdown = supervisor.shutdown().await;
    drain_source_events(output, &engine, event_shutdown, &mut summary).await?;
    output.flush().await?;
    Ok(summary)
}

async fn drain_source_events<W, B>(
    output: &mut W,
    engine: &Engine<B>,
    shutdown: EventShutdown,
    summary: &mut RunSummary,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    B: EngineBackend,
{
    summary.producer_tasks_drained += shutdown.producer_tasks_drained;
    for event in shutdown.events {
        write_source_event(output, engine, event).await?;
        summary.source_events_emitted += 1;
    }
    Ok(())
}

async fn write_source_event<W, B>(
    output: &mut W,
    engine: &Engine<B>,
    event: DomainEvent,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    B: EngineBackend,
{
    let envelope = engine.event(event.request_id, event.name, event.data);
    write_frame(output, &envelope).await
}

async fn drain_tasks<W, D>(
    tasks: &mut JoinSet<ResponseEnvelope>,
    output: &mut W,
    diagnostics: &D,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    D: Fn(&str),
{
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(response) => write_frame(output, &response).await?,
            Err(error) => diagnostics(&format!("engine request task failed: {error}")),
        }
    }
    Ok(())
}

async fn drain_tasks_for<W, D>(
    tasks: &mut JoinSet<ResponseEnvelope>,
    output: &mut W,
    diagnostics: &D,
    grace: std::time::Duration,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    D: Fn(&str),
{
    match tokio::time::timeout(grace, drain_tasks(tasks, output, diagnostics)).await {
        Ok(result) => result,
        Err(_) => Ok(()),
    }
}

async fn write_frame<W>(output: &mut W, response: &ResponseEnvelope) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let frame = encode_response_line(response).map_err(protocol_io_error)?;
    output.write_all(frame.as_bytes()).await
}

fn recover_request_id(line: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("id").and_then(ValueExt::non_empty_string))
}

trait ValueExt {
    fn non_empty_string(&self) -> Option<String>;
}

impl ValueExt for serde_json::Value {
    fn non_empty_string(&self) -> Option<String> {
        self.as_str()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    }
}

fn protocol_io_error(error: ErrorBody) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{}: {}", error.code, error.message),
    )
}
