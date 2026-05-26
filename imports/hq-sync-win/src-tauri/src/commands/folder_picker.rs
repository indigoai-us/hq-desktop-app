//! Native Windows folder picker dialog (IFileOpenDialog) wired through
//! `rfd::AsyncFileDialog`.
//!
//! The macOS implementation needed an AppKit modal-recovery hack
//! (`close_existing_file_panels` reaching into NSOpenPanel via objc2) to
//! deal with NSOpenPanel zombieing when the user clicked outside it. The
//! Windows IFileOpenDialog has no equivalent failure mode, so the Windows
//! port is just a thin wrapper around rfd plus a `ModalGuard` to keep the
//! popover visible behind the dialog.
//!
//! See `tray::ModalGuard` for why the guard is required (popover hide-on-blur
//! would otherwise dismiss the parent window of the IFileOpenDialog).

/// Open a native Windows folder picker dialog.
/// Returns the selected path, or None if the user cancelled.
///
/// Behaviour:
/// - Holds a `ModalGuard` for the lifetime of the dialog. Without it
///   the IFileOpenDialog would steal focus from the popover, which
///   triggers the `Focused(false)` hide handler in `tray.rs` — and once
///   the popover hides, the dialog's parent window is gone and the
///   dialog dismisses itself with no selection.
#[tauri::command]
pub async fn pick_folder(
    #[allow(unused_variables)] app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let _guard = crate::tray::ModalGuard::new();

    let result = rfd::AsyncFileDialog::new()
        .set_title("Choose HQ Folder")
        .pick_folder()
        .await;

    Ok(result.map(|handle| handle.path().to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dialog_builder_compiles() {
        // Verify rfd API is available and the builder pattern works.
        // We can't actually open a dialog in tests, but we can confirm
        // the builder chain compiles correctly.
        let _builder = rfd::AsyncFileDialog::new().set_title("Choose HQ Folder");
    }

    /// pick_folder is `async fn(AppHandle) -> Result<Option<String>, String>`.
    /// `None` is the user-cancelled path (rfd default — `pick_folder()`
    /// returns None when the IFileOpenDialog Cancel button fires).
    /// Compile-time witness that the signature is preserved across the
    /// Windows port — no breakage for the Svelte command-invoke layer.
    #[allow(dead_code)]
    fn pick_folder_signature_witness() -> fn(
        tauri::AppHandle,
    )
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>, String>> + Send>>
    {
        |app| Box::pin(pick_folder(app))
    }
}
