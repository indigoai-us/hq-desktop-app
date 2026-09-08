//! Feature-only native harness. Production bootstrap is never entered.
use std::borrow::Cow;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::utils::config::{Config, WindowConfig};

const PAGE: &[u8] = include_bytes!("meet_native.html");
struct ProbeAssets;
impl<R: tauri::Runtime> tauri::Assets<R> for ProbeAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match key.as_ref() {
            "/index.html" => Some(Cow::Borrowed(PAGE)),
            _ => None,
        }
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::once((
            Cow::Borrowed("/index.html"),
            Cow::Borrowed(PAGE),
        )))
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
fn isolate_config(config: &mut Config) {
    config.identifier = "ai.indigo.hq-meet-native-test".into();
    config.product_name = Some("HQ Meet Native Test".into());
    config.plugins.0.clear();
    config.build.dev_url = None;
    config.app.security.capabilities.clear();
    config.app.windows = vec![WindowConfig {
        label: "meet-native".into(),
        title: "HQ Meet Native Test".into(),
        width: 1280.0,
        height: 800.0,
        visible: true,
        ..Default::default()
    }];
}
pub fn run() {
    let mut context = tauri::generate_context!(assets = ProbeAssets, capabilities = []);
    isolate_config(context.config_mut());
    // Deliberately no production IPC handler, updater, auth, sync, telemetry,
    // autostart, single-instance forwarding, tray, or background detectors.
    tauri::Builder::default()
        .plugin(tauri_plugin_wdio_webdriver::init_with_port(4445))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("meet-native-navigation")
                .on_navigation(|_, url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost"))
                })
                .build(),
        )
        .run(context)
        .expect("isolated native Meet harness failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_configuration_is_replaced_before_window_creation() {
        let mut config: Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(!config.plugins.0.is_empty());
        isolate_config(&mut config);
        assert!(config.plugins.0.is_empty());
        assert!(config.build.dev_url.is_none());
        assert!(config.app.security.capabilities.is_empty());
        assert_eq!(config.identifier, "ai.indigo.hq-meet-native-test");
        assert_eq!(config.app.windows.len(), 1);
        assert_eq!(config.app.windows[0].label, "meet-native");
        assert!(config.app.windows[0].visible);
    }
    #[test]
    fn asset_provider_cannot_serve_production_frontend() {
        let assets: Box<dyn tauri::Assets<tauri::Wry>> = Box::new(ProbeAssets);
        assert!(assets.get(&AssetKey::from("index.html")).is_some());
        for path in ["desktop-alt.html", "assets/index.js", "recovery.html"] {
            assert!(assets.get(&AssetKey::from(path)).is_none());
        }
        assert_eq!(assets.iter().count(), 1);
    }
}
