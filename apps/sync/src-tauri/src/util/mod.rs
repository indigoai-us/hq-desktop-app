// Foundation modules were extracted to the `hq-desktop-core` crate (Phase 4) and
// are re-exported here so existing `crate::util::X` call sites stay unchanged.
// The former app couplings are now injected at startup in `main.rs`:
//   - client_info: `set_client_version(env!("APP_VERSION"))`
//   - feature_gate: `set_email_claim_fetcher(..)` wired to Cognito
pub use hq_desktop_core::{
    client_info, feature_gate, hq_resolver, ignore, logfile, paths, release_channel,
};

// The meetings/recording ledgers moved out to the hq-plugin-meetings crate, but keep
// their `crate::util::X` call sites working by re-exporting from their new home.
pub use hq_plugin_meetings::{meeting_ledger, recordings_ledger};

// Journal remains as an app-local facade; test_support stays app-local.
pub mod journal;

// Portable `\\?\` strip used by Copy path, Explorer Reveal, and HQ-path persist.
pub mod win32_path;

// TLS transport builder for the MQTT-over-WSS connections (dm_mqtt, outpost).
// App-local because it's specific to this app's rumqttc usage.
pub mod mqtt_tls;

// Forwards a WebView2 automation host's browser switches into every window this
// process creates. Windows-only: wry only reads `additionalBrowserArgs` on the
// WebView2 backend, and no other platform severs the environment-variable
// channel the way WebView2 does.
#[cfg(target_os = "windows")]
pub mod webview2_automation;

// Raise the main / popover webview above the system browser after OAuth and
// when tray activation would otherwise toggle-hide a buried-but-visible window.
pub mod window_focus;

#[cfg(test)]
pub(crate) mod test_support;
