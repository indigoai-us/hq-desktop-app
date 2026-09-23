//! Safe mapping and reporting for native open-panel creation failures.

pub const WEBVIEW_FILE_UPLOAD_PANEL_KIND: &str = "webview_file_upload";
const OPEN_PANEL_CREATE_FAILED_FINGERPRINT: &str = "nsopenpanel-create-failed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PanelCreationError {
    pub panel_kind: &'static str,
}

/// Run an injectable panel factory and turn a nil result into a typed error.
pub fn try_create_panel<T>(
    panel_kind: &'static str,
    factory: impl FnOnce() -> Option<T>,
) -> Result<T, PanelCreationError> {
    factory().ok_or(PanelCreationError { panel_kind })
}

/// Report a handled native panel creation failure with stable grouping fields.
pub fn capture_open_panel_creation_failure(panel_kind: &'static str, on_main_thread: bool) {
    sentry::with_scope(
        |scope| {
            let fingerprint = [OPEN_PANEL_CREATE_FAILED_FINGERPRINT, panel_kind];
            scope.set_fingerprint(Some(&fingerprint));
            scope.set_tag("panel_kind", panel_kind);
            scope.set_tag(
                "on_main_thread",
                if on_main_thread { "true" } else { "false" },
            );
        },
        || sentry::capture_message("NSOpenPanel creation failed", sentry::Level::Error),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nil_factory_result_returns_an_error() {
        let mut called = false;
        let result = try_create_panel(WEBVIEW_FILE_UPLOAD_PANEL_KIND, || {
            called = true;
            None::<()>
        });

        assert!(called, "the injected factory must be evaluated");
        assert_eq!(
            result,
            Err(PanelCreationError {
                panel_kind: WEBVIEW_FILE_UPLOAD_PANEL_KIND,
            })
        );
    }

    #[test]
    fn created_panel_is_returned_unchanged() {
        let result = try_create_panel(WEBVIEW_FILE_UPLOAD_PANEL_KIND, || Some(17));
        assert_eq!(result, Ok(17));
    }

    #[test]
    fn failure_event_has_stable_fingerprint_and_tags() {
        let events = sentry::test::with_captured_events(|| {
            capture_open_panel_creation_failure(WEBVIEW_FILE_UPLOAD_PANEL_KIND, true);
            capture_open_panel_creation_failure(WEBVIEW_FILE_UPLOAD_PANEL_KIND, false);
        });

        assert_eq!(events.len(), 2);
        let event = &events[0];
        assert_eq!(
            event
                .fingerprint
                .iter()
                .map(|part| part.as_ref())
                .collect::<Vec<_>>(),
            vec!["nsopenpanel-create-failed", "webview_file_upload"]
        );
        assert_eq!(
            event.tags.get("panel_kind").map(String::as_str),
            Some("webview_file_upload")
        );
        assert_eq!(
            event.tags.get("on_main_thread").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            events[1].tags.get("on_main_thread").map(String::as_str),
            Some("false")
        );
    }
}
