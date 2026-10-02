//! Pure planning and acknowledged-offset decisions for desktop usage uploads.
//!
//! HTTP, consent and retry policy stay in the app. This module only decides
//! when a batch is full, applies a per-sync request/byte budget, and identifies
//! source offsets that are safe to commit after a complete acknowledgement.

use std::collections::BTreeMap;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageUploadSource {
    pub file_path: String,
    pub end_offset: u64,
    pub mtime: u64,
    /// Codex rollout context is kept opaque to the planner and round-tripped by
    /// the desktop app. `None` identifies a Claude source.
    pub context: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsageUploadLimits {
    pub max_requests: usize,
    pub max_bytes: usize,
}

/// Sync-wide limits used by the shipped desktop usage collector.
pub const fn desktop_usage_sync_limits() -> Option<UsageUploadLimits> {
    None
}

#[derive(Debug, PartialEq, Eq)]
pub enum AddUsageEvent {
    Added,
    FlushCurrentBatch,
    TooLarge,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UsageUploadBatch {
    pub events: Vec<Value>,
    pub sources: Vec<UsageUploadSource>,
    pub body_bytes: usize,
}

impl UsageUploadBatch {
    pub fn contains_codex(&self) -> bool {
        self.sources.iter().any(|source| source.context.is_some())
    }
}

#[derive(Debug)]
pub struct UsageUploadPlanner {
    batch_overhead_bytes: usize,
    max_batch_bytes: usize,
    limits: Option<UsageUploadLimits>,
    requests_reserved: usize,
    bytes_reserved: usize,
    event_bytes: usize,
    events: Vec<Value>,
    sources: Vec<UsageUploadSource>,
}

impl UsageUploadPlanner {
    pub fn for_desktop_usage(batch_overhead_bytes: usize, max_batch_bytes: usize) -> Self {
        Self::new(
            batch_overhead_bytes,
            max_batch_bytes,
            desktop_usage_sync_limits(),
        )
    }

    pub fn new(
        batch_overhead_bytes: usize,
        max_batch_bytes: usize,
        limits: Option<UsageUploadLimits>,
    ) -> Self {
        Self {
            batch_overhead_bytes,
            max_batch_bytes,
            limits,
            requests_reserved: 0,
            bytes_reserved: 0,
            event_bytes: 0,
            events: Vec::new(),
            sources: Vec::new(),
        }
    }

    /// Add a sanitized event. If it would exceed the per-request cap, the
    /// caller must send the current batch and retry this same event.
    pub fn add_event(
        &mut self,
        event: Value,
        source: UsageUploadSource,
    ) -> Result<AddUsageEvent, serde_json::Error> {
        let event_bytes = serde_json::to_vec(&event)?.len();
        let separators = usize::from(!self.events.is_empty());
        let candidate_bytes = self
            .batch_overhead_bytes
            .saturating_add(self.event_bytes)
            .saturating_add(separators)
            .saturating_add(event_bytes);

        if candidate_bytes > self.max_batch_bytes {
            return Ok(if self.events.is_empty() {
                AddUsageEvent::TooLarge
            } else {
                AddUsageEvent::FlushCurrentBatch
            });
        }
        self.event_bytes = self.event_bytes.saturating_add(separators + event_bytes);
        self.events.push(event);
        self.record_source(source);
        Ok(AddUsageEvent::Added)
    }

    /// Record progress over a source row that does not produce a telemetry
    /// event. Such progress is committed with the next acknowledged batch, or
    /// locally when the whole scan contains no events.
    pub fn record_source(&mut self, source: UsageUploadSource) {
        if let Some(existing) = self
            .sources
            .iter_mut()
            .find(|existing| existing.file_path == source.file_path)
        {
            if source.end_offset > existing.end_offset {
                *existing = source;
            }
        } else {
            self.sources.push(source);
        }
    }

    pub fn budget_exhausted(&self) -> bool {
        self.limits.is_some_and(|limits| {
            self.requests_reserved >= limits.max_requests || self.bytes_reserved >= limits.max_bytes
        })
    }

    pub fn take_batch(&mut self) -> Option<UsageUploadBatch> {
        if self.events.is_empty() {
            return None;
        }
        let body_bytes = self.batch_overhead_bytes.saturating_add(self.event_bytes);
        self.event_bytes = 0;
        Some(UsageUploadBatch {
            events: std::mem::take(&mut self.events),
            sources: std::mem::take(&mut self.sources),
            body_bytes,
        })
    }

    pub fn take_zero_event_sources(&mut self) -> Option<Vec<UsageUploadSource>> {
        self.events
            .is_empty()
            .then(|| std::mem::take(&mut self.sources))
    }

    /// Reserve an attempted request before network I/O. Failed or lost
    /// responses consume the cycle budget but never commit source offsets.
    pub fn reserve_request(&mut self, body_bytes: usize) -> bool {
        if let Some(limits) = self.limits {
            if self.requests_reserved >= limits.max_requests
                || self.bytes_reserved.saturating_add(body_bytes) > limits.max_bytes
            {
                return false;
            }
        }
        self.requests_reserved = self.requests_reserved.saturating_add(1);
        self.bytes_reserved = self.bytes_reserved.saturating_add(body_bytes);
        true
    }

    /// Only a complete server acknowledgement may make these offsets
    /// committable. An unacknowledged or lost response returns no progress.
    pub fn committable_sources(
        batch: &UsageUploadBatch,
        acknowledged: bool,
    ) -> Vec<UsageUploadSource> {
        if !acknowledged {
            return Vec::new();
        }
        let mut by_path = BTreeMap::<String, UsageUploadSource>::new();
        for source in &batch.sources {
            by_path
                .entry(source.file_path.clone())
                .and_modify(|current| {
                    if source.end_offset > current.end_offset {
                        *current = source.clone();
                    }
                })
                .or_insert_with(|| source.clone());
        }
        by_path.into_values().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BATCH_OVERHEAD: usize = 128;
    const MAX_BATCH_BYTES: usize = 1_000_000;
    const MAX_REQUESTS: usize = 4;
    const MAX_SYNC_BYTES: usize = 4 * 1024 * 1024;

    fn source(index: usize, codex: bool) -> UsageUploadSource {
        UsageUploadSource {
            file_path: if codex {
                format!("rollout-{index}")
            } else {
                "claude-session.jsonl".to_string()
            },
            end_offset: (index as u64 + 1) * 100,
            mtime: 10,
            context: codex.then(|| json!({ "sessionId": format!("codex-{index}") })),
        }
    }

    fn rows(
        count: usize,
        row_bytes: usize,
        codex_after: Option<usize>,
    ) -> Vec<(Value, UsageUploadSource)> {
        (0..count)
            .map(|index| {
                let value = json!({
                    "id": format!("event-{index:03}"),
                    "payload": "x".repeat(row_bytes.saturating_sub(24))
                });
                (
                    value,
                    source(index, codex_after.is_some_and(|after| index >= after)),
                )
            })
            .collect()
    }

    fn drain_cycle(
        planner: &mut UsageUploadPlanner,
        rows: &[(Value, UsageUploadSource)],
    ) -> (Vec<UsageUploadBatch>, Vec<UsageUploadSource>) {
        let mut sent = Vec::new();
        let mut commits = Vec::new();
        let mut index = 0;
        while index < rows.len() {
            match planner
                .add_event(rows[index].0.clone(), rows[index].1.clone())
                .unwrap()
            {
                AddUsageEvent::Added => index += 1,
                AddUsageEvent::TooLarge => panic!("test row exceeds the batch size"),
                AddUsageEvent::FlushCurrentBatch => {
                    let batch = planner.take_batch().unwrap();
                    if !planner.reserve_request(batch.body_bytes) {
                        break;
                    }
                    commits.extend(UsageUploadPlanner::committable_sources(&batch, true));
                    sent.push(batch);
                }
            }
        }
        if let Some(batch) = planner.take_batch() {
            if planner.reserve_request(batch.body_bytes) {
                commits.extend(UsageUploadPlanner::committable_sources(&batch, true));
                sent.push(batch);
            }
        }
        (sent, commits)
    }

    fn production_planner() -> UsageUploadPlanner {
        UsageUploadPlanner::for_desktop_usage(BATCH_OVERHEAD, MAX_BATCH_BYTES)
    }

    #[test]
    fn current_claude_backlog_is_unbounded_per_sync() {
        let mut planner = UsageUploadPlanner::new(BATCH_OVERHEAD, MAX_BATCH_BYTES, None);
        let (sent, _) = drain_cycle(&mut planner, &rows(20, 500_000, None));
        assert!(sent.len() > MAX_REQUESTS);
    }

    #[test]
    fn claude_backlog_respects_sync_budget_and_resumes_without_gaps_or_duplicates() {
        let backlog = rows(5, 800_000, None);
        let mut first_cycle = production_planner();
        let (first_batches, first_commits) = drain_cycle(&mut first_cycle, &backlog);
        let first_events = first_batches
            .iter()
            .flat_map(|batch| batch.events.iter())
            .collect::<Vec<_>>();
        let first_bytes: usize = first_batches.iter().map(|batch| batch.body_bytes).sum();
        assert!(
            first_batches.len() <= MAX_REQUESTS,
            "request budget exceeded"
        );
        assert!(first_bytes <= MAX_SYNC_BYTES, "byte budget exceeded");
        assert!(!first_events.is_empty() && first_events.len() < backlog.len());
        assert_eq!(
            first_events
                .iter()
                .map(|event| event["id"].clone())
                .collect::<Vec<_>>(),
            (0..first_events.len())
                .map(|i| json!(format!("event-{i:03}")))
                .collect::<Vec<_>>()
        );
        let committed_offset = first_commits
            .iter()
            .map(|source| source.end_offset)
            .max()
            .unwrap_or_default();
        assert_eq!(committed_offset, first_events.len() as u64 * 100);

        let remaining = &backlog[first_events.len()..];
        let mut second_cycle = production_planner();
        let (second_batches, _) = drain_cycle(&mut second_cycle, remaining);
        let all_ids = first_batches
            .iter()
            .chain(second_batches.iter())
            .flat_map(|batch| {
                batch
                    .events
                    .iter()
                    .map(|event| event["id"].as_str().unwrap())
            })
            .collect::<Vec<_>>();
        assert_eq!(all_ids.len(), backlog.len());
        assert_eq!(
            all_ids
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            all_ids.len()
        );
        assert_eq!(all_ids.first().copied(), Some("event-000"));
        assert_eq!(all_ids.last().copied(), Some("event-004"));
    }

    #[test]
    fn lost_usage_response_commits_no_offsets_and_is_planned_again() {
        let row = rows(1, 50, None).remove(0);
        let mut first_cycle = production_planner();
        assert_eq!(
            first_cycle.add_event(row.0.clone(), row.1.clone()).unwrap(),
            AddUsageEvent::Added
        );
        let lost = first_cycle.take_batch().unwrap();
        assert!(first_cycle.reserve_request(lost.body_bytes));
        assert!(UsageUploadPlanner::committable_sources(&lost, false).is_empty());

        let mut retry_cycle = production_planner();
        assert_eq!(
            retry_cycle.add_event(row.0.clone(), row.1.clone()).unwrap(),
            AddUsageEvent::Added
        );
        let retry = retry_cycle.take_batch().unwrap();
        assert_eq!(retry.events, lost.events);
        assert_eq!(
            UsageUploadPlanner::committable_sources(&retry, true),
            vec![row.1]
        );
    }

    #[test]
    fn claude_and_codex_share_the_same_sync_budget() {
        let mixed = rows(24, 350_000, Some(4));
        let mut planner = production_planner();
        let (batches, _) = drain_cycle(&mut planner, &mixed);
        assert!(
            batches.len() <= MAX_REQUESTS,
            "shared request budget exceeded"
        );
        let bytes: usize = batches.iter().map(|batch| batch.body_bytes).sum();
        assert!(bytes <= MAX_SYNC_BYTES, "shared byte budget exceeded");
        let all_sources = batches
            .iter()
            .flat_map(|batch| &batch.sources)
            .collect::<Vec<_>>();
        assert!(all_sources.iter().any(|source| source.context.is_none()));
        assert!(all_sources.iter().any(|source| source.context.is_some()));
    }
}
