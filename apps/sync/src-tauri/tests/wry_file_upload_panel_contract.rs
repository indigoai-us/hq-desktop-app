use std::{fs, path::PathBuf};

fn wry_delegate_source() -> String {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(
        manifest_dir.join("../../../vendor/wry/src/wkwebview/class/wry_web_view_ui_delegate.rs"),
    )
    .expect("vendored Wry WebKit delegate source should be available")
}

#[test]
fn nil_open_panel_is_reported_shown_and_returned_to_webkit_as_cancelled() {
    let source = wry_delegate_source();
    let upload_handler = source
        .split("fn run_file_upload_panel(")
        .nth(1)
        .expect("Wry file upload panel handler should exist");
    let upload_handler = upload_handler
        .split("#[unsafe(method(webView:requestMediaCapturePermissionForOrigin:")
        .next()
        .expect("file upload handler should end before media capture handler");

    assert!(upload_handler.contains("MainThreadMarker::new()"));
    assert!(upload_handler.contains("try_create_panel(panel_kind"));
    assert!(upload_handler.contains("Retained::retain(ptr)"));
    assert!(upload_handler.contains("capture_open_panel_creation_failure(panel_kind, true)"));
    assert!(upload_handler.contains("show_file_upload_panel_failure(mtm)"));
    assert!(upload_handler.contains("(*handler).call((null_mut(),))"));
    assert!(!upload_handler.contains("NSOpenPanel::openPanel(mtm)"));
}
