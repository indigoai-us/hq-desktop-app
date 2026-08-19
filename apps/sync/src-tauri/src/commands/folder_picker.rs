/// Force-terminate any stuck NSOpenPanel / NSSavePanel modal session.
///
/// `rfd::AsyncFileDialog::pick_folder()` opens an application-modal
/// NSOpenPanel via `[NSApp runModalForWindow:]`. The Rust future
/// resolves only when the panel's completion handler fires — which
/// happens when the modal session ends with a response code.
///
/// Observed failure mode on the menubar popover: clicking outside the
/// panel leaves it in `NSApp.windows` with `isVisible=false` but the
/// rfd future still pending. `[panel close]` on the zombied panel is
/// a no-op — the completion handler never fires, the future hangs,
/// and the next `pick_folder()` trips AppKit's "modal already active"
/// guard and produces NSBeep on every subsequent click.
///
/// Fix: send `cancel:` to every panel (fires the Cancel IBAction which
/// ends the modal session with NSModalResponseCancel; rfd resolves the
/// prior future with `None`). Then call `[NSApp abortModal]` if AppKit
/// still reports a live modalWindow — belt-and-suspenders for any
/// session that didn't have a panel attached to cancel.
///
/// Must run on the main thread — AppKit is not thread-safe. Callers
/// use `AppHandle::run_on_main_thread` to guarantee this.
#[cfg(target_os = "macos")]
fn close_existing_file_panels() {
    use objc2::{class, msg_send, runtime::AnyObject};

    unsafe {
        let app_cls = class!(NSApplication);
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if app.is_null() {
            return;
        }
        let windows: *mut AnyObject = msg_send![app, windows];
        if windows.is_null() {
            return;
        }
        let count: usize = msg_send![windows, count];

        // Snapshot handles first. `cancel:` / `close` mutate the
        // `windows` array — iterating it live would be undefined.
        let mut handles: Vec<*mut AnyObject> = Vec::with_capacity(count);
        for i in 0..count {
            let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            handles.push(w);
        }

        let nil: *mut AnyObject = std::ptr::null_mut();
        for window in handles {
            if window.is_null() {
                continue;
            }
            let class_name: *mut AnyObject = msg_send![window, className];
            if class_name.is_null() {
                continue;
            }
            let utf8: *const std::os::raw::c_char = msg_send![class_name, UTF8String];
            if utf8.is_null() {
                continue;
            }
            let name = std::ffi::CStr::from_ptr(utf8).to_string_lossy();
            if name == "NSOpenPanel" || name == "NSSavePanel" {
                let _: () = msg_send![window, cancel: nil];
                let _: () = msg_send![window, close];
            }
        }

        let modal_window: *mut AnyObject = msg_send![app, modalWindow];
        if !modal_window.is_null() {
            let _: () = msg_send![app, abortModal];
        }
    }
}

/// Bring this Accessory (menu-bar) app frontmost so an application-modal
/// panel opens on top of, and receives events over, the popover / onboarding
/// card. `NSApplicationActivationPolicyAccessory` apps are NOT activated just
/// by showing a window, so without an explicit `activateIgnoringOtherApps:`
/// the folder panel can open behind the card and look like a hang.
///
/// Must run on the main thread — AppKit is not thread-safe.
#[cfg(target_os = "macos")]
fn activate_app() {
    use objc2::{class, msg_send, runtime::AnyObject};

    unsafe {
        let app_cls = class!(NSApplication);
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if app.is_null() {
            return;
        }
        let _: () = msg_send![app, activateIgnoringOtherApps: true];
    }
}

/// Open a native macOS folder picker dialog.
/// Returns the selected path, or None if the user cancelled.
///
/// Behaviour (macOS):
/// - Runs the picker as an **application-modal** `NSOpenPanel`
///   (`rfd::FileDialog::pick_folder`, backed by `runModal`) on the main
///   thread. An app-modal panel stays up until the user clicks Open or
///   Cancel — it cannot be dismissed by clicking outside it. That closes
///   the hang where the async *sheet* variant lost key-window status
///   (an outside click or a focus shift), got ordered out WITHOUT ending
///   its modal session, and left its completion handler — and therefore
///   the awaiting Rust future — pending forever.
/// - Calls `activate_app()` first so this Accessory app is frontmost and
///   the panel is presented on top and is interactable.
/// - Still holds a `ModalGuard` (suppresses the `Focused(false)` hide in
///   `tray.rs`) and still force-cancels any stray panel from a prior
///   interaction before opening — belt-and-suspenders now that the picker
///   is app-modal.
/// - The result flows back to this async command over a oneshot channel,
///   so the caller's `.await` resolves exactly when the modal ends. A
///   dropped sender surfaces as an error instead of a silent hang.
#[tauri::command]
pub async fn pick_folder(
    #[allow(unused_variables)] app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let _guard = crate::tray::ModalGuard::new();

    #[cfg(target_os = "macos")]
    {
        use crate::util::logfile::log;

        log(
            "folder_picker",
            "pick_folder: opening app-modal folder picker",
        );

        let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();

        // Everything below runs on the main thread. rfd's sync `pick_folder`
        // itself dispatches to main via `run_on_main`; since we are already
        // there, it runs inline (no double-dispatch deadlock).
        let run = app.run_on_main_thread(move || {
            // Recover from any zombied panel a prior interaction left behind,
            // then bring the app frontmost so the modal panel is on top.
            close_existing_file_panels();
            activate_app();

            let picked = rfd::FileDialog::new()
                .set_title("Choose HQ Folder")
                .pick_folder()
                .map(|path| path.to_string_lossy().to_string());

            // The receiver is dropped only if the command future was
            // cancelled; ignore the send error in that case.
            let _ = tx.send(picked);
        });

        if let Err(err) = run {
            log(
                "folder_picker",
                &format!("pick_folder: run_on_main_thread failed: {err}"),
            );
            return Err(format!("Could not open the folder picker: {err}"));
        }

        let result = rx.await.map_err(|_| {
            log(
                "folder_picker",
                "pick_folder: main-thread picker dropped before returning",
            );
            "The folder picker closed unexpectedly.".to_string()
        })?;

        log(
            "folder_picker",
            &format!("pick_folder: closed, selection={}", result.is_some()),
        );

        return Ok(result);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        let result = rfd::AsyncFileDialog::new()
            .set_title("Choose HQ Folder")
            .pick_folder()
            .await;

        Ok(result.map(|handle| handle.path().to_string_lossy().to_string()))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_dialog_builder_compiles() {
        // Verify rfd API is available and the builder pattern works.
        // We can't actually open a dialog in tests, but we can confirm
        // the builder chain compiles correctly.
        let _builder = rfd::AsyncFileDialog::new().set_title("Choose HQ Folder");
    }

    #[test]
    fn test_sync_dialog_builder_compiles() {
        // The macOS picker now runs the synchronous, app-modal
        // `FileDialog::pick_folder` (via `runModal`) on the main thread so
        // an outside click can't zombie the panel. Confirm that builder
        // chain compiles too — the actual modal only runs on-device.
        let _builder = rfd::FileDialog::new().set_title("Choose HQ Folder");
    }
}
