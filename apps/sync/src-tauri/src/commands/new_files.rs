use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const WINDOW_LABEL: &str = "new-files-detail";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFileEntry {
    pub path: String,
    pub bytes: u64,
    pub added_by: Option<String>,
}

/// Managed state: holds the pending file list so the detail window can
/// retrieve it on ready (race-free handshake instead of a timed delay).
pub struct PendingNewFiles(pub Mutex<Vec<NewFileEntry>>);

impl PendingNewFiles {
    fn replace(&self, files: Vec<NewFileEntry>) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = files;
    }

    fn snapshot(&self) -> Vec<NewFileEntry> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[tauri::command]
pub async fn open_new_files_detail(app: AppHandle, files: Vec<NewFileEntry>) -> Result<(), String> {
    // Stash the file list in managed state so detail_window_ready can
    // retrieve it after the webview finishes loading.
    if let Some(state) = app.try_state::<PendingNewFiles>() {
        state.replace(files.clone());
    }

    // If window already exists, focus it and re-send data
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        // Re-emit data to update the window contents
        app.emit_to(WINDOW_LABEL, "new-files:list", &files)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Create new window — starts hidden until the renderer signals ready
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("New Files")
    .inner_size(500.0, 400.0)
    .min_inner_size(420.0, 280.0)
    .resizable(true)
    .decorations(true)
    .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .transparent(true)
            .on_page_load(|loaded_window, payload| {
                if payload.event() != tauri::webview::PageLoadEvent::Finished {
                    return;
                }
                let window = loaded_window;
                let dispatcher = window.clone();
                let _ = dispatcher.run_on_main_thread(move || {
                    crate::glass::refresh_liquid_glass_window(&window);
                });
            });
    }

    let window = builder.build().map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        // A transparent Tauri window still gets an opaque WebKit under-page
        // color unless it is explicitly cleared, which would hide the native
        // glass material behind a flat system-gray rectangle.
        let _ = window.with_webview(|webview| {
            use objc2::{class, msg_send, runtime::AnyObject};
            // SAFETY: with_webview runs on AppKit's main thread; `inner()` is a
            // live WKWebView and both selectors are public WebKit/AppKit APIs.
            unsafe {
                let wk = webview.inner() as *mut AnyObject;
                let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
                let _: () = msg_send![wk, setUnderPageBackgroundColor: clear];
                let _: () =
                    msg_send![wk, setValue: clear, forKey: new_files_ns_string("backgroundColor")];
            }
        });

        let glass_window = window.clone();
        let _ = app.run_on_main_thread(move || {
            crate::glass::apply_compact_communications_glass_window(&glass_window);
        });
    }

    #[cfg(target_os = "windows")]
    {
        hq_platform::window_effects::apply_popover_vibrancy(&window);
    }

    Ok(())
}

/// Called by the detail window's Svelte component once its event listener
/// is registered. Emits the pending file list and shows the window — no
/// race because the renderer asked for the data, not a timer.
#[tauri::command]
pub async fn detail_window_ready(app: AppHandle) -> Result<(), String> {
    let files = app
        .try_state::<PendingNewFiles>()
        .map(|state| state.snapshot())
        .unwrap_or_default();

    app.emit_to(WINDOW_LABEL, "new-files:list", &files)
        .map_err(|e| e.to_string())?;

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn new_files_ns_string(value: &str) -> *mut objc2::runtime::AnyObject {
    use objc2::{class, msg_send};
    // SAFETY: the byte slice remains valid through NSString construction; the
    // returned autoreleased object is retained by the immediate KVC call.
    unsafe {
        let bytes = value.as_ptr() as *const std::ffi::c_void;
        msg_send![
            class!(NSString),
            stringWithBytes: bytes,
            length: value.len(),
            encoding: 4_usize
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, bytes: u64, added_by: Option<&str>) -> NewFileEntry {
        NewFileEntry {
            path: path.to_string(),
            bytes,
            added_by: added_by.map(str::to_string),
        }
    }

    #[test]
    fn pending_payload_replaces_the_previous_snapshot() {
        let pending = PendingNewFiles(Mutex::new(Vec::new()));
        pending.replace(vec![entry("old.md", 1, None)]);
        pending.replace(vec![entry("new.md", 2048, Some("maya@example.com"))]);

        let snapshot = pending.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].path, "new.md");
        assert_eq!(snapshot[0].bytes, 2048);
        assert_eq!(snapshot[0].added_by.as_deref(), Some("maya@example.com"));
    }

    #[test]
    fn payload_wire_shape_stays_camel_case_for_the_svelte_renderer() {
        let wire = serde_json::to_value(entry(
            "companies/indigo/knowledge/brief.md",
            1536,
            Some("maya@example.com"),
        ))
        .expect("new-file entry should serialize");

        assert_eq!(wire["path"], "companies/indigo/knowledge/brief.md");
        assert_eq!(wire["bytes"], 1536);
        assert_eq!(wire["addedBy"], "maya@example.com");
        assert!(wire.get("added_by").is_none());
    }
}
