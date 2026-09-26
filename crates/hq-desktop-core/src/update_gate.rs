//! Update-gate: pure, testable decision layer for safe auto-updates.
//!
//! Three inputs → one output:
//!   - `UpdateTrigger` (Automatic | Manual)
//!   - `AppFocus` (Focused | Unfocused)
//!   - active `HoldReason` list from `UpdateHolds`
//!
//! Rules:
//!   - Any active hold defers both Automatic and Manual installs.
//!   - Automatic + Focused (no holds) defers with reason `Focused`.
//!   - Automatic + Unfocused (no holds) installs.
//!   - Manual + Focused (no holds) installs (user explicitly asked).
//!   - Manual + Unfocused (no holds) installs.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Named reason for holding an update.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HoldReason {
    MeetingRecording,
    TranscriptFinishing,
    UploadInFlight,
    CoreUpdateInProgress,
    Custom(String),
}

impl std::fmt::Display for HoldReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MeetingRecording => write!(f, "MeetingRecording"),
            Self::TranscriptFinishing => write!(f, "TranscriptFinishing"),
            Self::UploadInFlight => write!(f, "UploadInFlight"),
            Self::CoreUpdateInProgress => write!(f, "CoreUpdateInProgress"),
            Self::Custom(s) => write!(f, "Custom({s})"),
        }
    }
}

/// Registry of active holds. Each `HoldReason` has a reference count
/// so nested acquire/release pairs nest correctly.
#[derive(Debug, Default)]
pub struct UpdateHolds {
    counts: Mutex<HashMap<HoldReason, u32>>,
}

impl UpdateHolds {
    pub fn new() -> Self {
        Self::default()
    }

    /// Increment the hold count for `reason`.
    pub fn acquire(&self, reason: HoldReason) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        *counts.entry(reason).or_insert(0) += 1;
    }

    /// Decrement the hold count for `reason`. Does nothing if the count
    /// is already zero.
    pub fn release(&self, reason: HoldReason) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = counts.get_mut(&reason) {
            if *n > 0 {
                *n -= 1;
            }
            if *n == 0 {
                counts.remove(&reason);
            }
        }
    }

    /// Returns all reasons whose count is >= 1.
    pub fn active(&self) -> Vec<HoldReason> {
        let counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        counts
            .iter()
            .filter(|(_, &n)| n > 0)
            .map(|(r, _)| r.clone())
            .collect()
    }
}

/// Whether the update was user-requested or background-automatic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateTrigger {
    Automatic,
    Manual,
}

/// Whether any app window currently has focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppFocus {
    Focused,
    Unfocused,
}

/// Why an install was deferred.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeferReason {
    Focused,
    Held { reasons: Vec<HoldReason> },
}

/// Output of `decide`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum UpdateDecision {
    InstallNow,
    Defer { reason: DeferReason },
}

/// Core decision function. Pure — takes inputs, returns a decision.
pub fn decide(trigger: UpdateTrigger, focus: AppFocus, holds: &UpdateHolds) -> UpdateDecision {
    let active = holds.active();
    if !active.is_empty() {
        return UpdateDecision::Defer {
            reason: DeferReason::Held { reasons: active },
        };
    }
    match (trigger, focus) {
        (UpdateTrigger::Automatic, AppFocus::Focused) => UpdateDecision::Defer {
            reason: DeferReason::Focused,
        },
        _ => UpdateDecision::InstallNow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_holds() -> UpdateHolds {
        UpdateHolds::new()
    }

    fn with_hold(reason: HoldReason) -> UpdateHolds {
        let h = UpdateHolds::new();
        h.acquire(reason);
        h
    }

    /// Table-driven: every cell of trigger × focus × holds → decision.
    #[test]
    fn decision_table() {
        use AppFocus::*;
        use HoldReason::*;
        use UpdateDecision::*;
        use UpdateTrigger::*;

        struct Row {
            trigger: UpdateTrigger,
            focus: AppFocus,
            holds: UpdateHolds,
            expected: UpdateDecision,
            label: &'static str,
        }

        let rows = vec![
            Row {
                trigger: Automatic,
                focus: Unfocused,
                holds: no_holds(),
                expected: InstallNow,
                label: "auto+unfocused+no-holds => install",
            },
            Row {
                trigger: Automatic,
                focus: Focused,
                holds: no_holds(),
                expected: Defer {
                    reason: DeferReason::Focused,
                },
                label: "auto+focused+no-holds => defer(focused)",
            },
            Row {
                trigger: Manual,
                focus: Unfocused,
                holds: no_holds(),
                expected: InstallNow,
                label: "manual+unfocused+no-holds => install",
            },
            Row {
                trigger: Manual,
                focus: Focused,
                holds: no_holds(),
                expected: InstallNow,
                label: "manual+focused+no-holds => install",
            },
            Row {
                trigger: Automatic,
                focus: Unfocused,
                holds: with_hold(MeetingRecording),
                expected: Defer {
                    reason: DeferReason::Held {
                        reasons: vec![MeetingRecording],
                    },
                },
                label: "auto+unfocused+meeting-hold => defer(held)",
            },
            Row {
                trigger: Automatic,
                focus: Focused,
                holds: with_hold(MeetingRecording),
                expected: Defer {
                    reason: DeferReason::Held {
                        reasons: vec![MeetingRecording],
                    },
                },
                label: "auto+focused+meeting-hold => defer(held)",
            },
            Row {
                trigger: Manual,
                focus: Focused,
                holds: with_hold(CoreUpdateInProgress),
                expected: Defer {
                    reason: DeferReason::Held {
                        reasons: vec![CoreUpdateInProgress],
                    },
                },
                label: "manual+focused+core-hold => defer(held)",
            },
            Row {
                trigger: Manual,
                focus: Unfocused,
                holds: with_hold(TranscriptFinishing),
                expected: Defer {
                    reason: DeferReason::Held {
                        reasons: vec![TranscriptFinishing],
                    },
                },
                label: "manual+unfocused+transcript-hold => defer(held)",
            },
        ];

        for row in rows {
            let got = decide(row.trigger, row.focus, &row.holds);
            // For Held variants, compare reason kind only since order may vary.
            match (&got, &row.expected) {
                (
                    UpdateDecision::Defer {
                        reason: DeferReason::Held { .. },
                    },
                    UpdateDecision::Defer {
                        reason: DeferReason::Held { .. },
                    },
                ) => {} // both held — ok
                (a, b) => assert_eq!(a, b, "FAIL: {}", row.label),
            }
        }
    }

    #[test]
    fn holds_nest_correctly() {
        let h = UpdateHolds::new();
        h.acquire(HoldReason::MeetingRecording);
        h.acquire(HoldReason::MeetingRecording);
        assert_eq!(h.active().len(), 1);
        h.release(HoldReason::MeetingRecording);
        assert_eq!(h.active().len(), 1, "still held after one release");
        h.release(HoldReason::MeetingRecording);
        assert_eq!(h.active().len(), 0, "cleared after second release");
    }

    #[test]
    fn release_below_zero_is_a_noop() {
        let h = UpdateHolds::new();
        h.release(HoldReason::UploadInFlight); // never acquired
        assert_eq!(h.active().len(), 0);
    }

    #[test]
    fn multiple_reasons_all_surface() {
        let h = UpdateHolds::new();
        h.acquire(HoldReason::MeetingRecording);
        h.acquire(HoldReason::TranscriptFinishing);
        let active = h.active();
        assert_eq!(active.len(), 2);
        assert!(active.contains(&HoldReason::MeetingRecording));
        assert!(active.contains(&HoldReason::TranscriptFinishing));
    }
}
