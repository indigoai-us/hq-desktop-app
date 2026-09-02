use std::future::Future;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;

#[derive(Debug, Clone, PartialEq)]
pub struct DomainEvent {
    pub request_id: Option<String>,
    pub name: String,
    pub data: Value,
}

impl DomainEvent {
    pub fn new(request_id: Option<String>, name: impl Into<String>, data: Value) -> Self {
        Self {
            request_id,
            name: name.into(),
            data,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EventSource {
    sender: mpsc::Sender<DomainEvent>,
    cancellation: watch::Receiver<bool>,
}

impl EventSource {
    pub async fn send(
        &self,
        event: DomainEvent,
    ) -> Result<(), mpsc::error::SendError<DomainEvent>> {
        self.sender.send(event).await
    }

    pub async fn cancelled(&self) {
        let mut cancellation = self.cancellation.clone();
        if *cancellation.borrow() {
            return;
        }
        while cancellation.changed().await.is_ok() {
            if *cancellation.borrow() {
                return;
            }
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct EventShutdown {
    pub producer_tasks_drained: usize,
    pub events: Vec<DomainEvent>,
}

pub struct EventSupervisor {
    sender: Option<mpsc::Sender<DomainEvent>>,
    receiver: mpsc::Receiver<DomainEvent>,
    cancellation: watch::Sender<bool>,
    producers: JoinSet<()>,
}

impl EventSupervisor {
    pub fn new(capacity: usize) -> Self {
        let (sender, receiver) = mpsc::channel(capacity.max(1));
        let (cancellation, _) = watch::channel(false);
        Self {
            sender: Some(sender),
            receiver,
            cancellation,
            producers: JoinSet::new(),
        }
    }

    pub fn source(&self) -> EventSource {
        EventSource {
            sender: self
                .sender
                .as_ref()
                .expect("event supervisor source requested after shutdown")
                .clone(),
            cancellation: self.cancellation.subscribe(),
        }
    }

    pub fn spawn<F, Fut>(&mut self, producer: F)
    where
        F: FnOnce(EventSource) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let source = self.source();
        self.producers.spawn(producer(source));
    }

    pub(crate) async fn next(&mut self) -> Option<DomainEvent> {
        self.receiver.recv().await
    }

    pub(crate) async fn shutdown(&mut self) -> EventShutdown {
        let _ = self.cancellation.send(true);
        self.sender.take();

        let mut producer_tasks_drained = 0;
        let cooperative = tokio::time::timeout(Duration::from_millis(250), async {
            while self.producers.join_next().await.is_some() {
                producer_tasks_drained += 1;
            }
        })
        .await;
        if cooperative.is_err() {
            self.producers.abort_all();
            while self.producers.join_next().await.is_some() {
                producer_tasks_drained += 1;
            }
        }

        self.receiver.close();
        let mut events = Vec::new();
        while let Some(event) = self.receiver.recv().await {
            events.push(event);
        }
        EventShutdown {
            producer_tasks_drained,
            events,
        }
    }
}
