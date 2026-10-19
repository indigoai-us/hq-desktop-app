//! `[first-run]` lines for every shell reload, remount and relaunch, so a
//! first run that suddenly shows a fresh window can be traced from the log
//! (PR #1670: the window "reloaded" mid-onboarding and the log could not say
//! why). The lines carry an event and a fixed reason word, never personal
//! data. The UI writes its own lines with the same shape
//! (`packages/ui/src/chat/first-run/first-run-timing.ts`, `formatShell`).

use crate::util::logfile::log;

/// The log tag, the same one the UI's first-run lines use.
const TAG: &str = "first-run";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellEvent {
    /// This process started.
    Launch,
    /// A webview reloads its document in place.
    Reload,
    /// This process exits so another HQ process takes over.
    Relaunch,
}

impl ShellEvent {
    fn as_str(self) -> &'static str {
        match self {
            ShellEvent::Launch => "launch",
            ShellEvent::Reload => "reload",
            ShellEvent::Relaunch => "relaunch",
        }
    }
}

/// `kind=shell event=<event> reason=<reason>`. The reason is reduced to
/// `[a-z0-9-]` so a caller can never put free text in the line.
fn format_shell_line(event: ShellEvent, reason: &str) -> String {
    let reason: String = reason
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    let reason = if reason.is_empty() {
        "unknown".to_string()
    } else {
        reason
    };
    format!("kind=shell event={} reason={reason}", event.as_str())
}

/// Write one shell line to the hq-sync log.
pub fn shell(event: ShellEvent, reason: &str) {
    log(TAG, &format_shell_line(event, reason));
}

#[cfg(test)]
mod tests {
    use super::{format_shell_line, ShellEvent};

    #[test]
    fn shell_lines_carry_the_event_and_a_reason_word() {
        assert_eq!(
            format_shell_line(ShellEvent::Launch, "process-start"),
            "kind=shell event=launch reason=process-start"
        );
        assert_eq!(
            format_shell_line(ShellEvent::Reload, "ui-hot-idle"),
            "kind=shell event=reload reason=ui-hot-idle"
        );
        assert_eq!(
            format_shell_line(ShellEvent::Relaunch, "update-launchd"),
            "kind=shell event=relaunch reason=update-launchd"
        );
    }

    #[test]
    fn a_reason_can_never_carry_free_text() {
        assert_eq!(
            format_shell_line(ShellEvent::Reload, "Pat /Users/x a@b.c"),
            "kind=shell event=reload reason=patusersxabc"
        );
        assert_eq!(
            format_shell_line(ShellEvent::Reload, ""),
            "kind=shell event=reload reason=unknown"
        );
    }
}
