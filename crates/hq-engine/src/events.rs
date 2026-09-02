//! Typed, bounded domain-event transport shared by engine producers.

use serde_json::Value;
use tokio::sync::broadcast;

pub const DEFAULT_EVENT_BUS_CAPACITY: usize = 256;

#[derive(Debug, Clone, PartialEq)]
pub struct EngineDomainEvent {
    pub name: String,
    pub data: Value,
    pub request_id: Option<String>,
}

impl EngineDomainEvent {
    pub fn new(request_id: Option<String>, name: impl Into<String>, data: Value) -> Self {
        Self {
            name: name.into(),
            data,
            request_id,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EngineEventBus {
    sender: broadcast::Sender<EngineDomainEvent>,
}

impl EngineEventBus {
    pub fn bounded(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(1));
        Self { sender }
    }

    /// Publish synchronously. A missing subscriber is a safe no-op so domain
    /// work never fails merely because the native UI is not attached.
    pub fn emit(&self, event: EngineDomainEvent) -> usize {
        self.sender.send(event).unwrap_or(0)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineDomainEvent> {
        self.sender.subscribe()
    }
}

impl Default for EngineEventBus {
    fn default() -> Self {
        Self::bounded(DEFAULT_EVENT_BUS_CAPACITY)
    }
}
