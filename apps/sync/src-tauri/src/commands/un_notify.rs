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
//!     route as meetings. `userInfo` carries `kind`, an explicit `route` string
//!     (e.g. `inbox:dm:<uid>`), thread ids, and a JSON action payload so a
//!     body-click can open the named thread on a cold launch and dropdown
//!     actions can emit `notification:dm-action` / `notification:share-action`.
//!
//! This module is compiled empty off macOS (inner `#![cfg]`), mirroring the
//! `dm_mqtt` pattern of an unconditional `pub mod` declaration plus gated use.
#![cfg(target_os = "macos")]

use std::sync::OnceLock;

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{class, define_class, msg_send, AnyThread};
use tauri::{AppHandle, Emitter};

/// UN category ids. Each notification sets `categoryIdentifier` so macOS
/// shows the matching dropdown on the banner.
const CATEGORY_DM: &str = "hq-dm";
const CATEGORY_SHARE: &str = "hq-share";
/// Action ids must match the frontend `notification:dm-action` /
/// `notification:share-action` payloads (`copy` / `open` / `claude`).
const ACTION_COPY: &str = "copy";
const ACTION_OPEN: &str = "open";
const ACTION_CLAUDE: &str = "claude";
const ACTION_TITLE_COPY: &str = "Copy prompt";
const ACTION_TITLE_OPEN: &str = "Open details";
const ACTION_TITLE_CLAUDE: &str = "Open in Claude";
const UN_DEFAULT_ACTION: &str = "com.apple.UNNotificationDefaultActionIdentifier";
const UN_DISMISS_ACTION: &str = "com.apple.UNNotificationDismissActionIdentifier";
/// `UNNotificationActionOptionForeground` — bring the app forward.
const UN_ACTION_OPTION_FOREGROUND: usize = 1 << 2;
const EVENT_NOTIFICATION_DM_ACTION: &str = "notification:dm-action";
const EVENT_NOTIFICATION_SHARE_ACTION: &str = "notification:share-action";
const USER_INFO_STRING_MAX_CHARS: usize = 4000;

/// AppHandle captured at delegate registration so a *cold* click (no
/// desktop-alt window open, hence no frontend `notification:meeting-action`
/// listener) can still open the window straight from Rust.
static DELEGATE_APP: OnceLock<AppHandle> = OnceLock::new();
/// Guards against re-installing the delegate (the center keeps only a weak
/// reference, so we leak exactly one delegate for the process lifetime).
static DELEGATE_REGISTERED: OnceLock<()> = OnceLock::new();
/// Guards the "notifications are blocked" notice so a user whose permission is
/// denied is told once per process, not once per event. Remediation itself lives
/// in Settings > Notifications (permission row + System Settings deep link).
static BLOCKED_NOTICE_SENT: OnceLock<()> = OnceLock::new();

/// Event emitted (at most once per process) when the native surface is active
/// but macOS authorization is not granted. Payload is the tri-state permission
/// string. Settings > Notifications listens for it and re-reads the permission
/// row so its "Open System Settings" deep-link affordance appears without the
/// user reopening the screen.
pub const EVENT_PERMISSION_BLOCKED: &str = "notification:permission-blocked";

/// Tell the user once that OS banners are not authorized. Notifications are NOT
/// dropped in this state — `deliver_osascript` below still shows a banner via
/// NotificationCenter's scripting bridge, which is not subject to the UN
/// authorization gate — but the click-through and Notification Center entry are
/// lost, and the fix is a two-click trip to System Settings.
fn note_permission_blocked(state: &str) {
    if BLOCKED_NOTICE_SENT.set(()).is_err() {
        return;
    }
    crate::util::logfile::log(
        "notify",
        &format!(
            "system notifications not authorized (state={state}) — \
             falling back to osascript; remediation in Settings > Notifications"
        ),
    );
    if let Some(app) = DELEGATE_APP.get() {
        use tauri::Emitter;
        let _ = app.emit(EVENT_PERMISSION_BLOCKED, state);
    }
}

/// Ask macOS for notification authorization exactly once, the first time a
/// notification-worthy event reaches the native path.
///
/// System notifications are the default surface now, so a fresh install lands
/// here before macOS has ever asked. `UNUserNotificationCenter` only shows its
/// dialog while the status is `notDetermined`, and the only previous trigger was
/// the Settings "Enable" button — which is exactly the screen a user who wonders
/// "why don't I get notifications?" hasn't opened.
///
/// The request runs on a detached thread because
/// `requestAuthorizationWithOptions` blocks until the user dismisses the dialog
/// (up to 60s) and this runs inside the DM / share poll. THIS event therefore
/// takes the osascript fallback; from the next one on, the granted UN path is
/// used. The one-shot marker (`notify_authz`) means we never ask twice.
fn ensure_authorization_requested() {
    let state = hq_platform::notifications::permission_state_without_app();
    if state == "granted" {
        return;
    }
    if !hq_desktop_core::notify_authz::should_request_authorization(
        &state,
        hq_desktop_core::notify_authz::already_requested(),
    ) {
        // Denied (macOS will not re-show the dialog) or already asked once.
        note_permission_blocked(&state);
        return;
    }
    // Claim the one-shot BEFORE asking, so a second event arriving while the
    // dialog is up can't stack a second request.
    hq_desktop_core::notify_authz::mark_requested();
    crate::util::logfile::log(
        "notify",
        "requesting macOS notification authorization (one-time, system surface is the default)",
    );
    std::thread::spawn(|| {
        let after = hq_platform::notifications::request_permission();
        crate::util::logfile::log(
            "notify",
            &format!("macOS notification authorization request resolved: {after}"),
        );
        if after != "granted" {
            note_permission_blocked(&after);
        }
    });
}

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
        /// route carried in `userInfo`. Dropdown actions emit the existing
        /// frontend events. Arrives on the main thread.
        ///
        /// Routing:
        ///   * explicit `route` in `userInfo` always wins.
        ///   * `"meeting"` (or a legacy notification with no `kind` / no
        ///     route) → the Meetings screen, so the click surfaces the
        ///     detected meeting with its Record control.
        ///   * `"dm"` / `"share"` without `route` → rebuild from payload ids;
        ///     otherwise the plain Inbox.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: *mut AnyObject,
            response: *mut AnyObject,
            completion: &Block<dyn Fn()>,
        ) {
            let kind = unsafe { response_kind(response) };
            let action_identifier = unsafe { response_action_identifier(response) };
            let window_id = unsafe { response_user_info_string(response, "windowId") };
            let platform = unsafe { response_user_info_string(response, "platform") };
            let from_person_uid =
                unsafe { response_user_info_string(response, "fromPersonUid") };
            let channel_id = unsafe { response_user_info_string(response, "channelId") };
            let event_id = unsafe { response_user_info_string(response, "eventId") };
            let issuer_uid = unsafe { response_user_info_string(response, "issuerUid") };
            let explicit_route = unsafe { response_user_info_string(response, "route") };
            let payload_json = unsafe { response_user_info_string(response, "payload") };
            if let Some(app) = DELEGATE_APP.get() {
                let route = resolve_click_route(
                    &kind,
                    &explicit_route,
                    &from_person_uid,
                    &channel_id,
                    &event_id,
                    &issuer_uid,
                );
                let dropdown = dropdown_action_from_identifier(&action_identifier);
                let meeting_action = click_action_for_kind(&kind, &window_id);
                // Only meeting prompts carry a tray prompt badge to clear; DM /
                // share notifications do not touch it. Copy / Claude dropdowns
                // must not look like navigation, so they skip this too.
                if dropdown != Some(ACTION_COPY)
                    && dropdown != Some(ACTION_CLAUDE)
                    && route.as_deref() == Some("meetings")
                {
                    let pending = crate::tray::get_prompt_pending().saturating_sub(1);
                    crate::tray::set_prompt_badge(app, pending);
                }
                let dest = route_label_for_log(route.as_deref());
                crate::util::logfile::log(
                    "notify",
                    &format!(
                        "UN didReceive: kind={kind} dropdown={dropdown:?} dest={dest}"
                    ),
                );
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    // Keep the delegate registered during app launch so macOS
                    // does not drop a cold notification response, but defer the
                    // user-visible destination until bundled frontend cache
                    // eviction/reload has reached a terminal ready state.
                    crate::webview_asset_cache::wait_until_ready().await;

                    if let Some(action) = dropdown {
                        emit_dropdown_action(
                            &app,
                            &kind,
                            action,
                            &event_id,
                            &payload_json,
                        );
                        // Open details (and only that dropdown) still fronts
                        // the thread so a cold click cannot depend on the
                        // frontend listener being mounted yet.
                        if action == ACTION_OPEN {
                            if let Err(e) =
                                crate::commands::desktop_alt::open_desktop_alt_window_inner(
                                    app,
                                    route.as_deref(),
                                )
                                .await
                            {
                                crate::util::logfile::log(
                                    "notify",
                                    &format!("UN didReceive: open desktop-alt failed: {e}"),
                                );
                            }
                        }
                        return;
                    }

                    // Body-click: start recording the meeting the banner named.
                    // The hidden controller window's listener runs
                    // `start_recording`; the Meetings screen (opened below)
                    // then shows it live.
                    if let Some(action) = meeting_action {
                        let payload = crate::events::NotificationMeetingActionEvent {
                            action: action.to_string(),
                            window_id: window_id.clone(),
                            platform: platform.clone(),
                            meeting_id: None,
                        };
                        crate::util::logfile::log(
                            "notify",
                            &format!("UN didReceive: meeting click → {action}"),
                        );
                        if let Err(e) =
                            app.emit(crate::events::EVENT_NOTIFICATION_MEETING_ACTION, &payload)
                        {
                            crate::util::logfile::log(
                                "notify",
                                &format!("UN didReceive: emit notification:meeting-action failed: {e}"),
                            );
                        }
                    }

                    if let Err(e) = crate::commands::desktop_alt::open_desktop_alt_window_inner(
                        app,
                        route.as_deref(),
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
    unsafe { response_user_info_string(response, "kind") }
}

/// Read one string value out of a `UNNotificationResponse`'s `userInfo` by
/// key. Empty when any hop is nil or the key is absent.
unsafe fn response_user_info_string(response: *mut AnyObject, key: &str) -> String {
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
    let value: *mut AnyObject = msg_send![user_info, objectForKey: ns_string(key)];
    ns_to_string(value)
}

/// Read `actionIdentifier` off a `UNNotificationResponse`. Empty when the
/// response is nil. Body-clicks arrive as
/// `com.apple.UNNotificationDefaultActionIdentifier`.
unsafe fn response_action_identifier(response: *mut AnyObject) -> String {
    if response.is_null() {
        return String::new();
    }
    let value: *mut AnyObject = msg_send![response, actionIdentifier];
    ns_to_string(value)
}

unsafe fn ns_to_string(value: *mut AnyObject) -> String {
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
/// `"dm"` / `"share"` → `None` (thread route is built from payload ids via
/// [`click_destination_route`]). Everything else — including `"meeting"` and
/// a legacy notification with no `kind` (empty string) — → `Some("meetings")`,
/// preserving the pre-existing meeting-click behaviour.
fn click_route_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "dm" | "share" => None,
        _ => Some("meetings"),
    }
}

/// Thread ids posted on a DM / share notification so a body-click can name
/// the inbox route. Empty strings are omitted from `userInfo`.
///
/// `route` is the full desktop route written into `userInfo["route"]`
/// (e.g. `inbox:dm:<uid>`). Empty means "compute from the ids at deliver
/// time". `payload_json` is the JSON object dropdown actions re-emit as
/// `notification:dm-action` / `notification:share-action` `event`.
#[derive(Debug, Clone, Default)]
pub struct MessageUserInfo {
    pub from_person_uid: String,
    pub channel_id: String,
    pub event_id: String,
    pub issuer_uid: String,
    pub route: String,
    pub payload_json: String,
}

/// Inbox route for a DM / share body-click. Mirrors the TypeScript
/// `routeForNotificationPayload` helper: channel-origin wins, then DM peer,
/// then share issuer, then a bare Inbox.
fn thread_route_from_ids(
    from_person_uid: &str,
    channel_id: &str,
    event_id: &str,
    issuer_uid: &str,
) -> String {
    let channel = channel_id.trim();
    let event = event_id.trim();
    let from = from_person_uid.trim();
    let issuer = issuer_uid.trim();
    if !channel.is_empty() {
        return if event.is_empty() {
            format!("inbox:channel:{channel}")
        } else {
            format!("inbox:channel:{channel}:{event}")
        };
    }
    if !from.is_empty() {
        return format!("inbox:dm:{from}");
    }
    if !issuer.is_empty() {
        return format!("inbox:dm:{issuer}");
    }
    "inbox".to_string()
}

/// Full destination for a body-click: thread route for dm/share, Meetings
/// for everything else.
fn click_destination_route(
    kind: &str,
    from_person_uid: &str,
    channel_id: &str,
    event_id: &str,
    issuer_uid: &str,
) -> Option<String> {
    match kind {
        "dm" | "share" => Some(thread_route_from_ids(
            from_person_uid,
            channel_id,
            event_id,
            issuer_uid,
        )),
        _ => Some("meetings".to_string()),
    }
}

/// Route a click should open. An explicit `userInfo["route"]` always wins;
/// a missing / whitespace-only route falls back to today's kind+ids
/// behaviour ([`click_destination_route`]).
fn resolve_click_route(
    kind: &str,
    explicit_route: &str,
    from_person_uid: &str,
    channel_id: &str,
    event_id: &str,
    issuer_uid: &str,
) -> Option<String> {
    let explicit = explicit_route.trim();
    if !explicit.is_empty() {
        return Some(explicit.to_string());
    }
    click_destination_route(kind, from_person_uid, channel_id, event_id, issuer_uid)
}

/// Map a UN `actionIdentifier` onto the frontend action ids. Body-click
/// (default) and dismiss are not dropdown actions.
fn dropdown_action_from_identifier(identifier: &str) -> Option<&'static str> {
    match identifier {
        ACTION_COPY => Some(ACTION_COPY),
        ACTION_OPEN => Some(ACTION_OPEN),
        ACTION_CLAUDE => Some(ACTION_CLAUDE),
        UN_DEFAULT_ACTION | UN_DISMISS_ACTION | "" => None,
        _ => None,
    }
}

fn category_id_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "dm" => Some(CATEGORY_DM),
        "share" => Some(CATEGORY_SHARE),
        _ => None,
    }
}

/// Log a destination class, never the route string itself (ids live in it).
fn route_label_for_log(route: Option<&str>) -> &'static str {
    match route {
        Some("meetings") => "meetings",
        Some("inbox") => "inbox",
        Some(r) if r.starts_with("inbox:dm:") => "inbox-dm",
        Some(r) if r.starts_with("inbox:channel:") => "inbox-channel",
        Some(_) => "custom",
        None => "none",
    }
}

/// Truncate with `chars()`, never a byte slice. UN `userInfo` and log
/// helpers must not panic on a multibyte boundary.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

fn truncate_json_strings(value: &mut serde_json::Value, max_chars: usize) {
    match value {
        serde_json::Value::String(s) => {
            if s.chars().count() > max_chars {
                *s = truncate_chars(s, max_chars);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                truncate_json_strings(item, max_chars);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                truncate_json_strings(item, max_chars);
            }
        }
        _ => {}
    }
}

/// Serialize a DM / share event for `userInfo["payload"]`, truncating long
/// strings so a prompt cannot blow the notification plist.
pub fn encode_action_payload<T: serde::Serialize>(value: &T) -> String {
    let mut json = match serde_json::to_value(value) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    truncate_json_strings(&mut json, USER_INFO_STRING_MAX_CHARS);
    serde_json::to_string(&json).unwrap_or_default()
}

fn parse_action_payload(payload_json: &str) -> serde_json::Value {
    let trimmed = payload_json.trim();
    if trimmed.is_empty() {
        return serde_json::json!({});
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::json!({}))
}

fn emit_dropdown_action(
    app: &AppHandle,
    kind: &str,
    action: &str,
    event_id: &str,
    payload_json: &str,
) {
    let event = parse_action_payload(payload_json);
    let result = match kind {
        "share" => {
            let payload = serde_json::json!({
                "action": action,
                "eventId": event_id,
                "event": event,
            });
            app.emit_to("main", EVENT_NOTIFICATION_SHARE_ACTION, &payload)
        }
        "dm" => {
            let payload = serde_json::json!({
                "action": action,
                "event": event,
            });
            app.emit_to("main", EVENT_NOTIFICATION_DM_ACTION, &payload)
        }
        _ => return,
    };
    if let Err(e) = result {
        crate::util::logfile::log(
            "notify",
            &format!("UN didReceive: emit {kind} action failed: {e}"),
        );
    }
}

/// What a body-click should *do* beyond navigating, keyed by `kind`.
///
/// A "Meeting detected" banner is the prompt to record that meeting, so
/// clicking it must start the recording for the meeting it names — landing
/// on the Meetings screen with a Record button still to press is a dead
/// end (field report 2026-09-18: "the link just went to the HQ Desktop
/// meetings — it should join the actual meeting"). The renderer's
/// `notification:meeting-action` listener runs `start_recording(windowId)`
/// for `"record"`. DM / share clicks carry no action.
///
/// Requires a window id: a legacy banner with no `windowId` in `userInfo`
/// has nothing to record and just navigates.
fn click_action_for_kind(kind: &str, window_id: &str) -> Option<&'static str> {
    match (click_route_for_kind(kind), window_id.is_empty()) {
        (Some("meetings"), false) => Some("record"),
        _ => None,
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
        register_action_categories(center);
        let _ = DELEGATE_REGISTERED.set(());
        // The center holds only a weak reference to its delegate, so we must
        // keep ours alive for the whole process. Leaking one object is the
        // intended lifetime here.
        std::mem::forget(delegate);
    }
}

/// Register the DM / share dropdown categories (`Copy prompt`, `Open
/// details`, `Open in Claude`). Idempotent at the OS level — setting the
/// same set replaces the previous one.
unsafe fn register_action_categories(center: *mut AnyObject) {
    if center.is_null() {
        return;
    }
    let copy = un_action(ACTION_COPY, ACTION_TITLE_COPY, false);
    let open = un_action(ACTION_OPEN, ACTION_TITLE_OPEN, true);
    let claude = un_action(ACTION_CLAUDE, ACTION_TITLE_CLAUDE, true);
    if copy.is_null() || open.is_null() || claude.is_null() {
        crate::util::logfile::log("notify", "UN action categories: action alloc failed");
        return;
    }

    let dm_actions: *mut AnyObject = msg_send![class!(NSMutableArray), array];
    let share_actions: *mut AnyObject = msg_send![class!(NSMutableArray), array];
    if dm_actions.is_null() || share_actions.is_null() {
        return;
    }
    let _: () = msg_send![dm_actions, addObject: copy];
    let _: () = msg_send![dm_actions, addObject: open];
    let _: () = msg_send![share_actions, addObject: copy];
    let _: () = msg_send![share_actions, addObject: open];
    let _: () = msg_send![share_actions, addObject: claude];

    let empty: *mut AnyObject = msg_send![class!(NSArray), array];
    let dm_cat: *mut AnyObject = msg_send![
        class!(UNNotificationCategory),
        categoryWithIdentifier: ns_string(CATEGORY_DM),
        actions: dm_actions,
        intentIdentifiers: empty,
        options: 0usize
    ];
    let share_cat: *mut AnyObject = msg_send![
        class!(UNNotificationCategory),
        categoryWithIdentifier: ns_string(CATEGORY_SHARE),
        actions: share_actions,
        intentIdentifiers: empty,
        options: 0usize
    ];
    if dm_cat.is_null() || share_cat.is_null() {
        crate::util::logfile::log("notify", "UN action categories: category alloc failed");
        return;
    }

    let set: *mut AnyObject = msg_send![class!(NSMutableSet), set];
    if set.is_null() {
        return;
    }
    let _: () = msg_send![set, addObject: dm_cat];
    let _: () = msg_send![set, addObject: share_cat];
    let _: () = msg_send![center, setNotificationCategories: set];
    crate::util::logfile::log("notify", "UN action categories registered (hq-dm, hq-share)");
}

unsafe fn un_action(id: &str, title: &str, foreground: bool) -> *mut AnyObject {
    let options = if foreground {
        UN_ACTION_OPTION_FOREGROUND
    } else {
        0usize
    };
    msg_send![
        class!(UNNotificationAction),
        actionWithIdentifier: ns_string(id),
        title: ns_string(title),
        options: options
    ]
}

/// Deliver a clickable meeting-detected banner. No-op (returns) off a bundle.
/// `window_id` / `platform` ride along in `userInfo` for the frontend handler
/// (warm-click path); the cold-click path opens the window from the delegate.
pub fn deliver_clickable(title: &str, body: &str, window_id: &str, platform: &str) {
    if !is_bundled() {
        return;
    }
    ensure_authorization_requested();
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
/// opens the right desktop-alt surface. Thread ids in `info` name the inbox
/// route; `info.route` (or a route computed from those ids) is written as
/// `userInfo["route"]` so a cold click does not have to rebuild it. No-op-safe
/// on every path.
pub fn deliver_message(title: &str, body: &str, kind: &str, info: &MessageUserInfo) {
    ensure_authorization_requested();
    let granted = hq_platform::notifications::permission_state_without_app() == "granted";
    if granted && deliver_un_message(title, body, kind, info) {
        crate::util::logfile::log("notify", &format!("UN {kind} notification fired"));
        return;
    }
    deliver_osascript(title, body, kind);
}

fn set_user_info_string(user_info: *mut AnyObject, key: &str, value: &str) {
    let trimmed = value.trim();
    if user_info.is_null() || trimmed.is_empty() {
        return;
    }
    unsafe {
        let _: () = msg_send![user_info, setObject: ns_string(trimmed), forKey: ns_string(key)];
    }
}

/// Deliver a non-actionable UN banner tagged with `kind` plus thread ids in
/// `userInfo`. Returns `false` (so the caller can fall back to osascript) when
/// unbundled or when any Cocoa hop fails. Mirrors `deliver_clickable` minus
/// the meeting-only payload.
fn deliver_un_message(title: &str, body: &str, kind: &str, info: &MessageUserInfo) -> bool {
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
            set_user_info_string(user_info, "fromPersonUid", &info.from_person_uid);
            set_user_info_string(user_info, "channelId", &info.channel_id);
            set_user_info_string(user_info, "eventId", &info.event_id);
            set_user_info_string(user_info, "issuerUid", &info.issuer_uid);
            let route = resolve_click_route(
                kind,
                &info.route,
                &info.from_person_uid,
                &info.channel_id,
                &info.event_id,
                &info.issuer_uid,
            )
            .unwrap_or_else(|| "inbox".to_string());
            set_user_info_string(user_info, "route", &route);
            set_user_info_string(user_info, "payload", &info.payload_json);
            let _: () = msg_send![&*content, setUserInfo: user_info];
        }
        if let Some(category) = category_id_for_kind(kind) {
            let _: () = msg_send![&*content, setCategoryIdentifier: ns_string(category)];
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
    use super::{
        category_id_for_kind, click_action_for_kind, click_destination_route, click_route_for_kind,
        dropdown_action_from_identifier, encode_action_payload, osascript_notification_script,
        resolve_click_route, route_label_for_log, thread_route_from_ids, truncate_chars,
        ACTION_CLAUDE, ACTION_COPY, ACTION_OPEN, ACTION_TITLE_CLAUDE, ACTION_TITLE_COPY,
        ACTION_TITLE_OPEN, CATEGORY_DM, CATEGORY_SHARE, UN_DEFAULT_ACTION, UN_DISMISS_ACTION,
        USER_INFO_STRING_MAX_CHARS,
    };

    #[test]
    fn meeting_click_records_the_named_meeting() {
        // A "Meeting detected" banner is the record prompt: clicking it must
        // start recording that window, not just land on the Meetings screen.
        assert_eq!(click_action_for_kind("meeting", "WIN-1"), Some("record"));
        // An empty kind still routes to Meetings, so with a window id present
        // it records too — the action follows the route, not the tag.
        assert_eq!(click_action_for_kind("", "WIN-1"), Some("record"));
    }

    #[test]
    fn meeting_click_without_a_window_only_navigates() {
        assert_eq!(click_action_for_kind("meeting", ""), None);
    }

    #[test]
    fn dm_and_share_clicks_carry_no_action() {
        assert_eq!(click_action_for_kind("dm", "WIN-1"), None);
        assert_eq!(click_action_for_kind("share", "WIN-1"), None);
    }

    #[test]
    fn dm_and_share_clicks_do_not_hijack_meetings() {
        // DM / share notifications must NOT hijack the Meetings screen; their
        // destination is built from payload ids (see click_destination_route).
        assert_eq!(click_route_for_kind("dm"), None);
        assert_eq!(click_route_for_kind("share"), None);
    }

    #[test]
    fn dm_click_opens_the_named_dm_thread() {
        assert_eq!(
            click_destination_route("dm", "prs_ada", "", "evt_1", ""),
            Some("inbox:dm:prs_ada".to_string())
        );
    }

    #[test]
    fn channel_origin_click_opens_the_named_channel_message() {
        assert_eq!(
            click_destination_route("dm", "prs_ada", "chn_eng", "evt_root", ""),
            Some("inbox:channel:chn_eng:evt_root".to_string())
        );
    }

    #[test]
    fn share_click_opens_the_issuer_dm_thread() {
        assert_eq!(
            click_destination_route("share", "", "", "evt_share", "prs_izzy"),
            Some("inbox:dm:prs_izzy".to_string())
        );
    }

    #[test]
    fn dm_and_share_clicks_without_ids_fall_back_to_inbox() {
        assert_eq!(
            click_destination_route("dm", "", "", "", ""),
            Some("inbox".to_string())
        );
        assert_eq!(
            click_destination_route("share", "  ", "", "", ""),
            Some("inbox".to_string())
        );
        assert_eq!(thread_route_from_ids("", "", "", ""), "inbox");
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

    #[test]
    fn explicit_route_in_user_info_wins_over_kind_and_ids() {
        assert_eq!(
            resolve_click_route("dm", "inbox:dm:prs_explicit", "prs_ada", "", "evt_1", ""),
            Some("inbox:dm:prs_explicit".to_string())
        );
        // Even a meeting-kind banner honours an explicit route — the
        // precedence contract is "route key wins", not "kind wins".
        assert_eq!(
            resolve_click_route("meeting", "inbox:dm:prs_x", "", "", "", ""),
            Some("inbox:dm:prs_x".to_string())
        );
        assert_eq!(
            resolve_click_route(
                "share",
                "  inbox:channel:chn_eng:evt_root  ",
                "",
                "",
                "evt_share",
                "prs_izzy",
            ),
            Some("inbox:channel:chn_eng:evt_root".to_string())
        );
    }

    #[test]
    fn missing_route_falls_back_to_kind_and_ids() {
        assert_eq!(
            resolve_click_route("dm", "", "prs_ada", "", "evt_1", ""),
            Some("inbox:dm:prs_ada".to_string())
        );
        assert_eq!(
            resolve_click_route("share", "   ", "", "", "evt_share", "prs_izzy"),
            Some("inbox:dm:prs_izzy".to_string())
        );
        assert_eq!(
            resolve_click_route("meeting", "", "", "", "", ""),
            Some("meetings".to_string())
        );
        assert_eq!(
            resolve_click_route("", "", "", "", "", ""),
            Some("meetings".to_string())
        );
    }

    #[test]
    fn dropdown_action_ids_match_the_frontend_handlers() {
        assert_eq!(dropdown_action_from_identifier("copy"), Some(ACTION_COPY));
        assert_eq!(dropdown_action_from_identifier("open"), Some(ACTION_OPEN));
        assert_eq!(
            dropdown_action_from_identifier("claude"),
            Some(ACTION_CLAUDE)
        );
        assert_eq!(dropdown_action_from_identifier(UN_DEFAULT_ACTION), None);
        assert_eq!(dropdown_action_from_identifier(UN_DISMISS_ACTION), None);
        assert_eq!(dropdown_action_from_identifier(""), None);
        assert_eq!(dropdown_action_from_identifier("Copy prompt"), None);
        assert_eq!(ACTION_TITLE_COPY, "Copy prompt");
        assert_eq!(ACTION_TITLE_OPEN, "Open details");
        assert_eq!(ACTION_TITLE_CLAUDE, "Open in Claude");
    }

    #[test]
    fn dm_and_share_kinds_register_dropdown_categories() {
        assert_eq!(category_id_for_kind("dm"), Some(CATEGORY_DM));
        assert_eq!(category_id_for_kind("share"), Some(CATEGORY_SHARE));
        assert_eq!(category_id_for_kind("meeting"), None);
        assert_eq!(category_id_for_kind(""), None);
    }

    #[test]
    fn route_logs_name_the_class_not_the_ids() {
        assert_eq!(route_label_for_log(Some("inbox:dm:prs_ada")), "inbox-dm");
        assert_eq!(
            route_label_for_log(Some("inbox:channel:chn_eng:evt_1")),
            "inbox-channel"
        );
        assert_eq!(route_label_for_log(Some("meetings")), "meetings");
        assert_eq!(route_label_for_log(None), "none");
    }

    #[test]
    fn truncate_chars_does_not_byte_slice_multibyte_text() {
        // "é" is two bytes; a byte slice at 1 would panic. chars() keeps the
        // first character intact.
        let s = "ééé";
        assert_eq!(truncate_chars(s, 1), "é");
        assert_eq!(truncate_chars(s, 2), "éé");
        assert_eq!(truncate_chars("abc", 8), "abc");
    }

    #[test]
    fn encode_action_payload_truncates_long_strings_with_chars() {
        let long: String = "é".repeat(USER_INFO_STRING_MAX_CHARS + 8);
        let json = encode_action_payload(&serde_json::json!({
            "prompt": long,
            "paths": ["a/b"]
        }));
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let prompt = parsed["prompt"].as_str().unwrap();
        assert_eq!(prompt.chars().count(), USER_INFO_STRING_MAX_CHARS);
        assert_eq!(parsed["paths"][0], "a/b");
    }
}
