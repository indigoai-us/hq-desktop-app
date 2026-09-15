//! OS-level permission primitives for meeting detection.

const LOG_TAG: &str = "permissions";

// Native macOS APIs — used to force TCC to register `hq-sync-menubar` (and
// hence the parent .app bundle) for permissions the Recall SDK's child
// process can't claim on our behalf.
#[cfg(target_os = "macos")]
pub mod macos {
    use std::ffi::c_void;

    // Accessibility — exists in the ApplicationServices framework.
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// Returns true if the process is trusted for Accessibility. Calling
        /// it registers the app in the Accessibility list (denied by default).
        pub fn AXIsProcessTrusted() -> bool;

        /// Variant that accepts an options dict. Passing
        /// `{ kAXTrustedCheckOptionPrompt: true }` makes macOS show the
        /// system prompt directing the user to System Settings when the app
        /// is not yet trusted (see `accessibility_register_with_prompt`).
        /// Passing null registers the app silently but never nudges the
        /// user — which is why startup registration MUST pass the option,
        /// otherwise Accessibility never surfaces and meeting-detect quietly
        /// fails with no signal to the user.
        pub fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    // Screen Recording — CoreGraphics functions (macOS 10.15+).
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        /// Triggers the system prompt on first call; silently returns
        /// current authorization status on subsequent calls. Either way,
        /// the calling binary gets registered in Screen Recording.
        pub fn CGRequestScreenCaptureAccess() -> bool;

        /// Returns the current status without prompting.
        pub fn CGPreflightScreenCaptureAccess() -> bool;
    }

    // AVFoundation — needed to link the framework so AVCaptureDevice symbols
    // resolve at load time. The Rust side calls into it via objc2 / block2
    // (see `request_microphone_access`), not via these extern declarations.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// Returns the current AVAuthorizationStatus for the given media type
    /// WITHOUT prompting. Maps to:
    ///   0 = NotDetermined (we report as `Prompt`)
    ///   1 = Restricted    (we report as `Denied` — user can't grant)
    ///   2 = Denied
    ///   3 = Authorized
    /// Safe to call from any thread; takes no Rust-owned references.
    pub fn authorization_status_for_audio() -> i64 {
        use objc2::{
            class, msg_send,
            runtime::{AnyClass, AnyObject},
        };
        unsafe {
            let ns_string_cls: &AnyClass = class!(NSString);
            let audio_type: *mut AnyObject = msg_send![
                ns_string_cls,
                stringWithUTF8String: b"soun\0".as_ptr() as *const i8
            ];
            if audio_type.is_null() {
                return 0; // NotDetermined as a safe default
            }
            let av_cls: &AnyClass = class!(AVCaptureDevice);
            let status: i64 = msg_send![av_cls, authorizationStatusForMediaType: audio_type];
            status
        }
    }

    /// Build the options dictionary `{ kAXTrustedCheckOptionPrompt: true }`
    /// that `AXIsProcessTrustedWithOptions` consumes to show the "grant
    /// Accessibility" system prompt.
    ///
    /// We construct the key from its string value
    /// (`"AXTrustedCheckOptionPrompt"`) rather than linking the
    /// `kAXTrustedCheckOptionPrompt` CFString *data* symbol: CFDictionary
    /// compares keys with `CFEqual`, and an NSString with identical contents
    /// is `CFEqual` to the framework constant, so the hand-built dict is
    /// accepted by the API exactly as the imported constant would be. This
    /// avoids a brittle `extern` link to a data constant (which objc2 can't
    /// express as cleanly as a function symbol).
    ///
    /// Returns an autoreleased `NSDictionary*` (toll-free bridged to
    /// `CFDictionaryRef`) or null if allocation failed. The caller must use
    /// it synchronously — the AX call reads it and returns immediately.
    pub fn ax_prompt_options_dict() -> *mut objc2::runtime::AnyObject {
        use objc2::{
            class, msg_send,
            runtime::{AnyClass, AnyObject, Bool},
        };
        // SAFETY: NSString / NSNumber / NSDictionary are always present at
        // runtime on macOS; every msg_send targets a documented class method
        // and returns an autoreleased object we never retain across the call.
        unsafe {
            let ns_string_cls: &AnyClass = class!(NSString);
            let key: *mut AnyObject = msg_send![
                ns_string_cls,
                stringWithUTF8String: b"AXTrustedCheckOptionPrompt\0".as_ptr() as *const i8
            ];
            let ns_number_cls: &AnyClass = class!(NSNumber);
            let value: *mut AnyObject = msg_send![ns_number_cls, numberWithBool: Bool::new(true)];
            if key.is_null() || value.is_null() {
                return std::ptr::null_mut();
            }
            let ns_dict_cls: &AnyClass = class!(NSDictionary);
            let dict: *mut AnyObject = msg_send![
                ns_dict_cls,
                dictionaryWithObject: value,
                forKey: key
            ];
            dict
        }
    }

    /// Call `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt:
    /// true})` so macOS shows the prompt directing the user to System
    /// Settings when the app is not yet trusted for Accessibility. Returns
    /// the current trusted bool.
    ///
    /// Unlike Screen Recording / Microphone there is no programmatic grant
    /// for Accessibility — the prompt is the only built-in nudge, so passing
    /// the option (vs. the old null) is what makes the requirement visible.
    /// Falls back to the prompt-less `AXIsProcessTrusted()` only if the
    /// options dict couldn't be built (never observed in practice).
    pub fn accessibility_register_with_prompt() -> bool {
        let options = ax_prompt_options_dict();
        // SAFETY: AXIsProcessTrustedWithOptions is thread-safe and reads the
        // dict synchronously; `options` is a valid autoreleased dict (or null,
        // handled below) that outlives this call.
        unsafe {
            if options.is_null() {
                return AXIsProcessTrusted();
            }
            AXIsProcessTrustedWithOptions(options as *const c_void)
        }
    }

    /// Register the .app bundle with macOS TCC for Microphone (and System Audio
    /// by extension — on Sequoia+ they're consolidated into one privacy pane).
    ///
    /// macOS Microphone only gets populated when an app actively *requests*
    /// access via `+[AVCaptureDevice requestAccessForMediaType:completionHandler:]`.
    /// There's no `+` button in System Settings to add an app manually like
    /// there is for Accessibility or Screen Recording.
    ///
    /// The Recall SDK's helper binary already makes this request from inside
    /// the bundle, BUT TCC attributes it to the helper's own (ad-hoc) identity
    /// rather than the parent .app, so the prompt never fires and HQ Sync never
    /// appears in the Microphone list. Calling the same API from `hq-sync-menubar`
    /// (whose identity is the stable signed .app bundle) makes TCC attach the
    /// grant to "HQ Sync".
    ///
    /// Fire-and-forget — the completion handler is a no-op stack block. We
    /// don't need the granted bool here; the SDK's own polling reads back the
    /// status once TCC has the entry.
    pub fn request_microphone_access() {
        use block2::RcBlock;
        use hq_desktop_core::logfile::log;
        use objc2::{
            class, msg_send,
            runtime::{AnyClass, AnyObject, Bool},
        };

        // SAFETY: every msg_send below targets a class method on a documented
        // Apple framework class. AVCaptureDevice + NSString are always present
        // at runtime on macOS 10.7+. Pointer ownership is autorelease-pool
        // managed by ObjC; we never retain across the call boundary.
        unsafe {
            let av_cls: &AnyClass = class!(AVCaptureDevice);

            // AVMediaTypeAudio is the NSString constant @"soun". Build it from
            // a C string literal rather than dlsym'ing the global to keep this
            // self-contained.
            let ns_string_cls: &AnyClass = class!(NSString);
            let audio_type: *mut AnyObject = msg_send![
                ns_string_cls,
                stringWithUTF8String: b"soun\0".as_ptr() as *const i8
            ];
            if audio_type.is_null() {
                log(
                    super::LOG_TAG,
                    "request_microphone_access: NSString init failed",
                );
                return;
            }

            // The completion handler is non-optional per Apple's header (passing
            // nil crashes inside AVFoundation). RcBlock heap-allocates the block
            // with an internal retain count, so AVFoundation can hold its own
            // strong ref while we drop our handle here — the block stays alive
            // until AVFoundation invokes it once and releases.
            //
            // The selector signature is `^(BOOL granted)`. ObjC `BOOL` maps to
            // `objc2::runtime::Bool` (NOT Rust bool, which has a different ABI
            // on i386 — Bool is a u8 wrapper that always matches ObjC's contract).
            let handler = RcBlock::new(|granted: Bool| {
                log(
                    super::LOG_TAG,
                    &format!(
                        "AVCaptureDevice.requestAccess(audio) -> granted={}",
                        granted.as_bool()
                    ),
                );
            });

            log(
                super::LOG_TAG,
                "AVCaptureDevice.requestAccess(audio): calling",
            );
            let _: () = msg_send![
                av_cls,
                requestAccessForMediaType: audio_type,
                completionHandler: &*handler
            ];
        }
    }
}

/// Returns whether the current process is trusted for Accessibility.
#[cfg(target_os = "macos")]
pub fn accessibility_is_trusted() -> bool {
    // SAFETY: AXIsProcessTrusted is a documented thread-safe C function; it
    // takes no Rust references and never panics on the FFI boundary.
    unsafe { macos::AXIsProcessTrusted() }
}

/// Non-macOS stub: meeting permissions are macOS-only, so there is no native
/// TCC gate to deny.
#[cfg(not(target_os = "macos"))]
pub fn accessibility_is_trusted() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn accessibility_register_with_prompt() -> bool {
    macos::accessibility_register_with_prompt()
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_register_with_prompt() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn screen_capture_preflight() -> bool {
    // SAFETY: CGPreflightScreenCaptureAccess is a documented thread-safe C
    // function; it takes no Rust references.
    unsafe { macos::CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
pub fn screen_capture_preflight() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn request_screen_capture_access() -> bool {
    // SAFETY: CGRequestScreenCaptureAccess is a documented thread-safe C
    // function; it takes no Rust references.
    unsafe { macos::CGRequestScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture_access() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn authorization_status_for_audio() -> i64 {
    macos::authorization_status_for_audio()
}

#[cfg(not(target_os = "macos"))]
pub fn authorization_status_for_audio() -> i64 {
    3
}

#[cfg(target_os = "macos")]
pub fn request_microphone_access() {
    macos::request_microphone_access();
}

#[cfg(not(target_os = "macos"))]
pub fn request_microphone_access() {}

/// Trigger native macOS API calls for Accessibility + Screen Recording +
/// Microphone from the app process itself. Idempotent — safe to call on every
/// app launch.
///
/// Returns a status report `(accessibility_trusted, screen_capture_authorized)`
/// that the caller logs. Microphone is fire-and-forget (the prompt is async;
/// the bool isn't useful in the return value).
pub fn force_native_register() -> Result<(bool, bool), String> {
    #[cfg(target_os = "macos")]
    {
        use hq_desktop_core::logfile::log;

        // Pass `{kAXTrustedCheckOptionPrompt: true}` so macOS shows the
        // Accessibility prompt the first time an un-decided app calls it.
        // Previously this passed null options, which registered the app
        // silently but never prompted — so users who hadn't already granted
        // Accessibility had meeting-detect quietly broken with no signal.
        let ax = accessibility_register_with_prompt();
        log(
            LOG_TAG,
            &format!("AXIsProcessTrustedWithOptions(prompt=true) -> {ax}"),
        );

        // Preflight first so we don't keep popping prompts after first deny.
        let pre = screen_capture_preflight();
        log(LOG_TAG, &format!("CGPreflightScreenCaptureAccess -> {pre}"));

        // Call request even when preflight is false — first time triggers
        // the dialog; subsequent calls are silent no-ops but still register
        // the binary in the Screen Recording list if it's not there yet.
        let sc = request_screen_capture_access();
        log(LOG_TAG, &format!("CGRequestScreenCaptureAccess -> {sc}"));

        // Microphone: fire a request from THIS process so TCC attributes
        // it to the .app bundle, not the SDK helper. First call shows the
        // prompt; subsequent calls are silent no-ops once a decision is
        // cached. Also covers System Audio on macOS Sequoia+, where the
        // two are consolidated under "Screen & System Audio Recording".
        request_microphone_access();

        Ok((ax, sc))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("permissions_force_native_register is macOS-only".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Regression: startup Accessibility registration MUST pass the
    /// `{ kAXTrustedCheckOptionPrompt: true }` options dict, not null. A null
    /// options dict registers the app silently and never shows the prompt,
    /// leaving users who haven't granted Accessibility with meeting-detect
    /// quietly broken (the bug this guards against).
    ///
    /// We assert the dict handed to `AXIsProcessTrustedWithOptions`
    /// round-trips the prompt key as a true boolean. We deliberately do NOT
    /// call `AXIsProcessTrustedWithOptions` itself — that would pop a real
    /// system dialog during `cargo test`.
    #[test]
    fn ax_prompt_options_dict_sets_prompt_true() {
        use objc2::rc::autoreleasepool;
        use objc2::{
            class, msg_send,
            runtime::{AnyClass, AnyObject, Bool},
        };

        autoreleasepool(|_| {
            let dict = macos::ax_prompt_options_dict();
            assert!(!dict.is_null(), "options dict must build");

            // SAFETY: dict is a valid autoreleased NSDictionary; we only read
            // it back. NSString / boolValue are documented and always present.
            unsafe {
                let ns_string_cls: &AnyClass = class!(NSString);
                let key: *mut AnyObject = msg_send![
                    ns_string_cls,
                    stringWithUTF8String: b"AXTrustedCheckOptionPrompt\0".as_ptr() as *const i8
                ];
                let value: *mut AnyObject = msg_send![dict, objectForKey: key];
                assert!(
                    !value.is_null(),
                    "dict must contain the kAXTrustedCheckOptionPrompt key"
                );
                let b: Bool = msg_send![value, boolValue];
                assert!(b.as_bool(), "prompt option must be true, not false/null");
            }
        });
    }
}
