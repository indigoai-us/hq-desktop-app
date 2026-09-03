//! Native macOS notifications via `UNUserNotificationCenter`.
//!
//! On macOS Sequoia the legacy `NSUserNotification` / `mac-notification-sys`
//! deliver path is permanently denied once any code touches
//! `UNUserNotificationCenter` (which the permission probe in `notifications.rs`
//! does at launch — and `register_delegate` below always does at startup). The
//! app falls back to `osascript display notification`, which renders fine but
//! **cannot carry a click callback**. To get a banner the user can click — to
//! open the desktop-alt window — we deliver through `UNUserNotificationCenter`
//! *and* install a `UNUserNotificationCenterDelegate` to intercept the click.
//!
//! Two public delivery entry points, both used only on the `customBanner: false`
//! native fallback (the default surface is the in-app custom banner):
//!   * [`deliver_clickable`] — meeting-detected prompts (opens the Meetings
//!     screen on click, cold or warm).
//!   * [`deliver_message`] — DM / share notifications. These previously fired
//!     through the now-dead `mac_notification_sys` path and so produced no OS
//!     banner at all; they now take the same UN-when-granted / osascript-else
//!     route as meetings, with the click routed by `kind` in `userInfo`.
//!
//! This module is compiled empty off macOS (inner `#![cfg]`), mirroring the
//! `dm_mqtt` pattern of an unconditional `pub mod` declaration plus gated use.
#![cfg(target_os = "macos")]

use std::sync::OnceLock;

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{class, define_class, msg_send, AnyThread};
use tauri::AppHandle;

/// AppHandle captured at delegate registration so a *cold* click (no
/// desktop-alt window open, hence no frontend `notification:meeting-action`
/// listener) can still open the window straight from Rust.
static DELEGATE_APP: OnceLock<AppHandle> = OnceLock::new();
/// Guards against re-installing the delegate (the center keeps only a weak
/// reference, so we leak exactly one delegate for the process lifetime).
static DELEGATE_REGISTERED: OnceLock<()> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "HQMeetingNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    impl NotificationDelegate {
        /// Show the banner even when the app is frontmost.
        /// Options bitmask: banner(16) | list(8) | sound(2) = 26.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: *mut AnyObject,
            _notification: *mut AnyObject,
            completion: &Block<dyn Fn(usize)>,
        ) {
            completion.call((26usize,));
        }

        /// Body-click (default action) → open the desktop-alt window on the
        /// screen that matches the notification's `kind` (carried in
        /// `userInfo`). Arrives on the main thread.
        ///
        /// Routing:
        ///   * `"meeting"` (or a legacy notification with no `kind`) → the
        ///     Meetings screen, so the click surfaces the detected meeting with
        ///     its Record control.
        ///   * `"dm"` / `"share"` → the default desktop-alt view (Inbox), where
        ///     the message / shared file lives.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: *mut AnyObject,
            response: *mut AnyObject,
            completion: &Block<dyn Fn()>,
        ) {
            let kind = unsafe { response_kind(response) };
            if let Some(app) = DELEGATE_APP.get() {
                let route = click_route_for_kind(&kind);
                // Only meeting prompts carry a tray prompt badge to clear; DM /
                // share notifications do not touch it.
                if route == Some("meetings") {
                    let pending = crate::tray::get_prompt_pending().saturating_sub(1);
                    crate::tray::set_prompt_badge(app, pending);
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    // Keep the delegate registered during app launch so macOS
                    // does not drop a cold notification response, but defer the
                    // user-visible destination until bundled frontend cache
                    // eviction/reload has reached a terminal ready state.
                    crate::webview_asset_cache::wait_until_ready().await;

                    if let Err(e) = crate::commands::desktop_alt::open_desktop_alt_window_inner(
                        app,
                        route,
                    )
                    .await
                    {
                        crate::util::logfile::log(
                            "notify",
                            &format!("UN didReceive: open desktop-alt failed: {e}"),
                        );
                    }
                });
            }
            completion.call(());
        }
    }
);

impl NotificationDelegate {
    fn new() -> Retained<Self> {
        // No ivars and no overridden `init`, so a plain `init` on the freshly
        // allocated instance dispatches up to `NSObject.init`. (A `super(this)`
        // init would require a `PartialInit` receiver via `set_ivars`, which
        // only exists for classes that declare ivars.)
        unsafe { msg_send![Self::alloc(), init] }
    }
}

/// Build an autoreleased `NSString` from a Rust `&str`.
unsafe fn ns_string(s: &str) -> *mut AnyObject {
    let cstr = std::ffi::CString::new(s).unwrap_or_default();
    msg_send![class!(NSString), stringWithUTF8String: cstr.as_ptr()]
}

/// Read the `"kind"` string out of a `UNNotificationResponse`'s `userInfo`
/// (response → notification → request → content → userInfo["kind"]). Returns an
/// empty string when any hop is nil or the key is absent — a legacy meeting
/// notification (delivered before this key existed) reads as `""`, which the
/// delegate treats as the meeting route.
unsafe fn response_kind(response: *mut AnyObject) -> String {
    if response.is_null() {
        return String::new();
    }
    let notification: *mut AnyObject = msg_send![response, notification];
    if notification.is_null() {
        return String::new();
    }
    let request: *mut AnyObject = msg_send![notification, request];
    if request.is_null() {
        return String::new();
    }
    let content: *mut AnyObject = msg_send![request, content];
    if content.is_null() {
        return String::new();
    }
    let user_info: *mut AnyObject = msg_send![content, userInfo];
    if user_info.is_null() {
        return String::new();
    }
    let value: *mut AnyObject = msg_send![user_info, objectForKey: ns_string("kind")];
    if value.is_null() {
        return String::new();
    }
    let utf8: *const std::os::raw::c_char = msg_send![value, UTF8String];
    if utf8.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
}

/// Where a body-click on a delivered notification should land, keyed by the
/// `kind` tag carried in `userInfo`. Pure so the routing contract is unit-
/// tested without a live `UNUserNotificationCenter`.
///
/// `"dm"` / `"share"` → `None` (open the default desktop-alt view, i.e. Inbox).
/// Everything else — including `"meeting"` and a legacy notification with no
/// `kind` (empty string) — → `Some("meetings")`, preserving the pre-existing
/// meeting-click behaviour.
fn click_route_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "dm" | "share" => None,
        _ => Some("meetings"),
    }
}

/// Build the `osascript` `display notification` script, escaping backslashes and
/// double-quotes so a title/body containing either can't break out of the
/// AppleScript string literal. Pure so the escaping is unit-tested.
fn osascript_notification_script(title: &str, body: &str) -> String {
    let osa_body = body.replace('\\', "\\\\").replace('"', "\\\"");
    let osa_title = title.replace('\\', "\\\\").replace('"', "\\\"");
    format!("display notification \"{osa_body}\" with title \"{osa_title}\"")
}

/// Monotonic-ish suffix so each `UNNotificationRequest` gets a unique
/// identifier (a reused identifier replaces the previous banner in place).
fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// `UNUserNotificationCenter` is only valid inside a real `.app` bundle; calling
/// `currentNotificationCenter` from a bare binary throws. Guard every entry.
fn is_bundled() -> bool {
    unsafe {
        let main: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
        if main.is_null() {
            return false;
        }
        let ident: *mut AnyObject = msg_send![main, bundleIdentifier];
        !ident.is_null()
    }
}

/// Install the notification-center delegate once, and stash the AppHandle.
/// Called from `main.rs` `.setup()` (macOS-gated). Safe to call repeatedly.
pub fn register_delegate(app: &AppHandle) {
    let _ = DELEGATE_APP.set(app.clone());
    if DELEGATE_REGISTERED.get().is_some() || !is_bundled() {
        return;
    }
    unsafe {
        let center: *mut AnyObject =
            msg_send![class!(UNUserNotificationCenter), currentNotificationCenter];
        if center.is_null() {
            return;
        }
        let delegate: Retained<NotificationDelegate> = NotificationDelegate::new();
        let _: () = msg_send![center, setDelegate: &*delegate];
        let _ = DELEGATE_REGISTERED.set(());
        // The center holds only a weak reference to its delegate, so we must
        // keep ours alive for the whole process. Leaking one object is the
        // intended lifetime here.
        std::mem::forget(delegate);
    }
}

/// Deliver a clickable meeting-detected banner. No-op (returns) off a bundle.
/// `window_id` / `platform` ride along in `userInfo` for the frontend handler
/// (warm-click path); the cold-click path opens the window from the delegate.
pub fn deliver_clickable(title: &str, body: &str, window_id: &str, platform: &str) {
    if !is_bundled() {
        return;
    }
    let fired = objc2::rc::autoreleasepool(|_pool| unsafe {
        // `new` = owned (+1); everything else here is autoreleased.
        let content: Retained<AnyObject> = msg_send![class!(UNMutableNotificationContent), new];
        let _: () = msg_send![&*content, setTitle: ns_string(title)];
        let _: () = msg_send![&*content, setBody: ns_string(body)];
        let sound: *mut AnyObject = msg_send![class!(UNNotificationSound), defaultSound];
        if !sound.is_null() {
            let _: () = msg_send![&*content, setSound: sound];
        }

        let user_info: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
        if !user_info.is_null() {
            let _: () = msg_send![user_info, setObject: ns_string("meeting"), forKey: ns_string("kind")];
            let _: () = msg_send![user_info, setObject: ns_string(window_id), forKey: ns_string("windowId")];
            let _: () =
                msg_send![user_info, setObject: ns_string(platform), forKey: ns_string("platform")];
            let _: () = msg_send![&*content, setUserInfo: user_info];
        }

        let identifier = ns_string(&format!("hq-meeting-{window_id}"));
        let trigger: *mut AnyObject = std::ptr::null_mut();
        let request: *mut AnyObject = msg_send![
            class!(UNNotificationRequest),
            requestWithIdentifier: identifier,
            content: &*content,
            trigger: trigger
        ];
        if request.is_null() {
            return false;
        }

        let center: *mut AnyObject =
            msg_send![class!(UNUserNotificationCenter), currentNotificationCenter];
        if center.is_null() {
            return false;
        }
        // `withCompletionHandler:` expects a block ("@?"); pass an empty one
        // rather than null so objc2's encoding check is satisfied.
        let completion = RcBlock::new(|_err: *mut AnyObject| {});
        let _: () =
            msg_send![center, addNotificationRequest: request, withCompletionHandler: &*completion];
        true
    });
    crate::util::logfile::log(
        "meetings",
        if fired {
            "UN clickable notification fired"
        } else {
            "UN clickable notification: setup failed"
        },
    );
}

/// Deliver a native DM / share notification the correct way for modern macOS.
///
/// The legacy `NSUserNotification` / `mac-notification-sys` deliver path is
/// silently denied for the whole process once anything touches
/// `UNUserNotificationCenter` — and this app always does at launch
/// (`register_delegate` above installs a UN delegate, and the Settings
/// permission probe reads UN status). That poisoning is why the old
/// `mac_notification_sys::send()` fallback in `dm_notify` / `share_notify`
/// produced no banner at all on Sonoma/Sequoia/Tahoe.
///
/// Delivery strategy, mirroring `meetings.rs`:
///   * When notification permission is **granted**, deliver through
///     `UNUserNotificationCenter` so the banner attributes to HQ, lands in
///     Notification Center, and is clickable (the delegate routes the click by
///     `kind`).
///   * Otherwise fall back to `osascript display notification`, which uses
///     NotificationCenter's scripting bridge and is not subject to the
///     per-process legacy/modern gate, so it still shows a banner.
///
/// `kind` must be `"dm"` or `"share"` — it rides along in `userInfo` so a click
/// opens the right desktop-alt surface. No-op-safe on every path.
pub fn deliver_message(title: &str, body: &str, kind: &str) {
    let granted = hq_platform::notifications::permission_state_without_app() == "granted";
    if granted && deliver_un_message(title, body, kind) {
        crate::util::logfile::log("notify", &format!("UN {kind} notification fired"));
        return;
    }
    deliver_osascript(title, body, kind);
}

/// Deliver a non-actionable UN banner tagged with `kind` in `userInfo`. Returns
/// `false` (so the caller can fall back to osascript) when unbundled or when any
/// Cocoa hop fails. Mirrors `deliver_clickable` minus the meeting-only payload.
fn deliver_un_message(title: &str, body: &str, kind: &str) -> bool {
    if !is_bundled() {
        return false;
    }
    objc2::rc::autoreleasepool(|_pool| unsafe {
        let content: Retained<AnyObject> = msg_send![class!(UNMutableNotificationContent), new];
        let _: () = msg_send![&*content, setTitle: ns_string(title)];
        let _: () = msg_send![&*content, setBody: ns_string(body)];
        let sound: *mut AnyObject = msg_send![class!(UNNotificationSound), defaultSound];
        if !sound.is_null() {
            let _: () = msg_send![&*content, setSound: sound];
        }

        let user_info: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
        if !user_info.is_null() {
            let _: () =
                msg_send![user_info, setObject: ns_string(kind), forKey: ns_string("kind")];
            let _: () = msg_send![&*content, setUserInfo: user_info];
        }

        let identifier = ns_string(&format!("hq-{kind}-{}", unique_suffix()));
        let trigger: *mut AnyObject = std::ptr::null_mut();
        let request: *mut AnyObject = msg_send![
            class!(UNNotificationRequest),
            requestWithIdentifier: identifier,
            content: &*content,
            trigger: trigger
        ];
        if request.is_null() {
            return false;
        }

        let center: *mut AnyObject =
            msg_send![class!(UNUserNotificationCenter), currentNotificationCenter];
        if center.is_null() {
            return false;
        }
        let completion = RcBlock::new(|_err: *mut AnyObject| {});
        let _: () =
            msg_send![center, addNotificationRequest: request, withCompletionHandler: &*completion];
        true
    })
}

/// Always-visible fallback via NotificationCenter's AppleScript bridge. Not
/// gated by the per-process legacy/modern notification split, so it shows even
/// when UN authorization is not granted. Quotes are escaped for the `-e` script.
fn deliver_osascript(title: &str, body: &str, kind: &str) {
    let script = osascript_notification_script(title, body);
    match std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
    {
        Ok(out) if out.status.success() => {
            crate::util::logfile::log("notify", &format!("osascript {kind} notification fired"));
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            crate::util::logfile::log(
                "notify",
                &format!("osascript {kind} notification non-zero exit ({}): {stderr}", out.status),
            );
        }
        Err(e) => {
            crate::util::logfile::log(
                "notify",
                &format!("osascript {kind} notification spawn failed: {e}"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{click_route_for_kind, osascript_notification_script};

    #[test]
    fn dm_and_share_clicks_open_the_default_inbox_view() {
        // DM / share notifications must NOT hijack the Meetings screen; they
        // open the default desktop-alt view (Inbox), where the message /
        // shared file lives.
        assert_eq!(click_route_for_kind("dm"), None);
        assert_eq!(click_route_for_kind("share"), None);
    }

    #[test]
    fn meeting_and_legacy_clicks_open_the_meetings_screen() {
        // Explicit meeting notifications and legacy notifications delivered
        // before the `kind` key existed (empty string) both land on Meetings —
        // preserving the pre-existing behaviour and the tray-badge decrement.
        assert_eq!(click_route_for_kind("meeting"), Some("meetings"));
        assert_eq!(click_route_for_kind(""), Some("meetings"));
        assert_eq!(click_route_for_kind("something-unexpected"), Some("meetings"));
    }

    #[test]
    fn osascript_script_escapes_quotes_and_backslashes() {
        // A body containing a double-quote or backslash must be escaped so it
        // can't terminate the AppleScript string literal early (or inject).
        let script = osascript_notification_script(
            r#"Ann "Q" O'Neil"#,
            r#"say "hi" \ done"#,
        );
        assert_eq!(
            script,
            r#"display notification "say \"hi\" \\ done" with title "Ann \"Q\" O'Neil""#
        );
    }

    #[test]
    fn osascript_script_passes_plain_text_through() {
        assert_eq!(
            osascript_notification_script("Corey Epstein", "Sent you a file"),
            r#"display notification "Sent you a file" with title "Corey Epstein""#
        );
    }
}
