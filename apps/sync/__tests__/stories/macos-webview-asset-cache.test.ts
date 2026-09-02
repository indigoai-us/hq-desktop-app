import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const cache = readFileSync(
  root('src-tauri/src/webview_asset_cache.rs'),
  'utf8',
);
const main = readFileSync(root('src-tauri/src/main.rs'), 'utf8');
const banner = readFileSync(root('src-tauri/src/commands/banner.rs'), 'utf8');
const unNotify = readFileSync(
  root('src-tauri/src/commands/un_notify.rs'),
  'utf8',
);
const meetings = readFileSync(
  root('src-tauri/src/commands/meetings.rs'),
  'utf8',
);
const executableCache = cache
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('macOS custom-protocol frontend asset cache', () => {
  it('evicts only WebKit disk and memory cache data', () => {
    const referencedDataTypes = [
      ...executableCache.matchAll(/WKWebsiteDataType\w+/g),
    ].map(([name]) => name);
    expect([...new Set(referencedDataTypes)].sort()).toEqual([
      'WKWebsiteDataTypeDiskCache',
      'WKWebsiteDataTypeMemoryCache',
    ]);
    expect(executableCache.match(/addObject:/g)).toHaveLength(2);
    expect(cache).toContain(
      'removeDataOfTypes: cache_types',
    );

    for (const preservedType of [
      'WKWebsiteDataTypeLocalStorage',
      'WKWebsiteDataTypeSessionStorage',
      'WKWebsiteDataTypeCookies',
      'WKWebsiteDataTypeIndexedDBDatabases',
      'WKWebsiteDataTypeServiceWorkerRegistrations',
      'WKWebsiteDataTypeFetchCache',
      'allWebsiteDataTypes',
      'clear_all_browsing_data',
    ]) {
      expect(executableCache).not.toContain(preservedType);
    }
  });

  it('runs once per installed app version across launches before auxiliary webviews are built', () => {
    expect(main).toContain('#[cfg(target_os = "macos")]\nmod webview_asset_cache;');
    expect(cache).toContain('static EVICTED_VERSIONS');
    expect(cache).toContain(
      'const COMPLETED_VERSION_MARKER: &str = "frontend-asset-cache-version"',
    );
    expect(cache).toContain('read_completed_version(&marker_path)');
    expect(cache).toContain(
      'persist_completed_version(&pending.marker_path, &pending.version)',
    );
    expect(cache).toMatch(
      /EVICTED_VERSIONS[\s\S]*contains\(app_version\)[\s\S]*insert\(app_version\.to_owned\(\)\)/,
    );

    const eviction = main.indexOf(
      'webview_asset_cache::evict_frontend_asset_cache_once',
    );
    expect(eviction).toBeGreaterThanOrEqual(0);
    expect(main).toMatch(
      /webview_asset_cache::evict_frontend_asset_cache_once\(\s*app\.handle\(\),\s*env!\("APP_VERSION"\),\s*move \|\|/,
    );
  });

  it('reloads only hidden webviews and waits for post-arm page completion', () => {
    const completion = cache.indexOf('RcBlock::new');
    const completionEnd = cache.indexOf('\n        });', completion);
    const removal = cache.indexOf('removeDataOfTypes: cache_types');

    expect(completion).toBeGreaterThanOrEqual(0);
    expect(completionEnd).toBeGreaterThan(completion);
    expect(removal).toBeGreaterThan(completionEnd);

    const beforeCompletion = cache.slice(0, completion);
    const completionBody = cache.slice(completion, completionEnd);
    const afterCompletion = cache.slice(completionEnd);
    expect(beforeCompletion).not.toContain('.reload()');
    expect(completionBody).toContain('.reload()');
    expect(completionBody).toContain('window.is_visible()');
    expect(completionBody).toContain(
      'should_reload_after_eviction(visibility)',
    );
    expect(cache).not.toContain('crate::commands::widget::WINDOW_LABEL');
    expect(afterCompletion).not.toContain('.reload()');
    expect(completionBody).toContain('webview_windows()');
    expect(completionBody).toContain('run_on_main_thread');
    expect(completionBody).not.toContain('persist_completed_version(');
    expect(cache).toMatch(
      /pub fn handle_page_load[\s\S]*PageLoadEvent::Started[\s\S]*PageLoadEvent::Finished/,
    );
    expect(cache).toMatch(
      /observe_page_load[\s\S]*GateTransition::Complete[\s\S]*persist_completed_version/,
    );
  });

  it('gates tray, first-run reveal, shortcuts, and widget setup behind completed reloads', () => {
    expect(cache).toContain(
      "on_ready: impl FnOnce() + Send + 'static",
    );

    const eviction = main.indexOf(
      'webview_asset_cache::evict_frontend_asset_cache_once',
    );
    const callbackSurfaceSetup = main.indexOf(
      'setup_startup_surfaces(&startup_app, first_run)',
      eviction,
    );
    expect(eviction).toBeGreaterThanOrEqual(0);
    expect(callbackSurfaceSetup).toBeGreaterThan(eviction);
    expect(main).toContain('.on_page_load(|webview, payload|');
    expect(main).toContain('webview_asset_cache::handle_page_load(');
    expect(cache).toContain('ReloadEvent::Started');
    expect(cache).toContain('ReloadEvent::Finished');

    expect(main).toContain(
      '#[cfg(not(target_os = "macos"))]\n            setup_startup_surfaces(app.handle(), first_run)?;',
    );
  });

  it('has one bounded overall watchdog and makes late completion a no-op', () => {
    expect(cache).toMatch(
      /const STARTUP_GATE_TIMEOUT: Duration = Duration::from_secs\(\d+\)/,
    );
    expect(cache).toContain('tokio::time::sleep(STARTUP_GATE_TIMEOUT)');
    expect(cache).toContain('is_evicting(generation)');
    expect(cache).toContain('GateTransition::Stale');
    expect(cache).toContain('release_version(&pending.version)');
  });

  it('defers second-instance activation until the startup gate is terminal', () => {
    expect(cache).toContain('pub fn defer_activation_while_pending()');
    expect(cache).toContain('pub fn take_deferred_activation()');
    expect(main).toContain(
      'webview_asset_cache::defer_activation_while_pending()',
    );
    expect(main).toContain('webview_asset_cache::take_deferred_activation()');
  });

  it('holds notification producers and dynamic notification webviews behind readiness', () => {
    const producerSetup = main.indexOf('fn setup_notification_producers(');
    const startupSurfaceSetup = main.indexOf('fn setup_startup_surfaces(');
    expect(producerSetup).toBeGreaterThanOrEqual(0);
    expect(startupSurfaceSetup).toBeGreaterThan(producerSetup);

    const producerBody = main.slice(producerSetup, startupSurfaceSetup);
    expect(producerBody).toContain('updater::setup_update_checker(app);');
    expect(producerBody).toContain(
      'commands::share_notify::setup_share_notify_poller(app.clone());',
    );
    expect(producerBody).toContain(
      'commands::meetings::setup_unattributed_meeting_poller(app.clone());',
    );
    expect(producerBody).toContain(
      'commands::dm_mqtt::setup_dm_mqtt_receiver(app.clone());',
    );
    expect(producerBody).toContain('EVENT_SYNC_ALL_COMPLETE');

    const eviction = main.indexOf(
      'webview_asset_cache::evict_frontend_asset_cache_once',
    );
    const readyCallback = main.slice(
      main.indexOf('move || {', eviction),
      main.indexOf('\n                    },', eviction),
    );
    expect(readyCallback).toContain(
      'setup_notification_producers(&startup_app);',
    );
    expect(main).not.toContain(
      '#[cfg(not(target_os = "macos"))]\n            setup_notification_producers(app.handle());',
    );

    const versionGate = main.indexOf(
      'commands::version_gate::setup_version_gate(app.handle());',
    );
    const telemetrySetup = main.indexOf(
      'commands::telemetry::setup_daily_active_emit();',
      versionGate,
    );
    const heartbeatSetup = main.indexOf(
      'commands::telemetry::setup_version_heartbeat();',
      telemetrySetup,
    );
    expect(heartbeatSetup).toBeGreaterThan(telemetrySetup);
    const nonMacUpdater = main.indexOf(
      'updater::setup_update_checker(app.handle());',
      versionGate,
    );
    expect(nonMacUpdater).toBeGreaterThan(versionGate);
    expect(nonMacUpdater).toBeLessThan(telemetrySetup);

    const daemonSetup = main.indexOf(
      'commands::daemon::setup_daemon_supervisor(app.handle());',
    );
    const sessionsSetup = main.indexOf(
      'commands::sessions::setup_sessions_poller(app.handle().clone());',
      daemonSetup,
    );
    const nonMacPostDaemon = main.slice(daemonSetup, sessionsSetup);
    expect(nonMacPostDaemon).toContain(
      '#[cfg(not(target_os = "macos"))]',
    );
    expect(nonMacPostDaemon).toContain(
      'commands::share_notify::setup_share_notify_poller(app.handle().clone());',
    );
    expect(nonMacPostDaemon).toContain(
      'commands::dm_mqtt::setup_dm_mqtt_receiver(app.handle().clone());',
    );
    expect(nonMacPostDaemon).toContain('EVENT_SYNC_ALL_COMPLETE');

    const showBanner = banner.slice(
      banner.indexOf('pub async fn show_banner'),
      banner.indexOf('// US-003: widget owns', banner.indexOf('pub async fn show_banner')),
    );
    expect(showBanner).toContain(
      'crate::webview_asset_cache::wait_until_ready().await;',
    );

    const notificationResponse = unNotify.slice(
      unNotify.indexOf('fn did_receive('),
      unNotify.indexOf('\n        }\n    }', unNotify.indexOf('fn did_receive(')),
    );
    expect(notificationResponse).toMatch(
      /wait_until_ready\(\)\.await[\s\S]*open_desktop_alt_window_inner/,
    );
    expect(main).toContain(
      'commands::un_notify::register_delegate(app.handle());',
    );

    const meetingNotification = meetings.slice(
      meetings.indexOf('pub async fn meetings_notify_detected'),
      meetings.indexOf(
        '// 1. Top-level notifications pref.',
        meetings.indexOf('pub async fn meetings_notify_detected'),
      ),
    );
    expect(meetingNotification).toContain(
      'crate::webview_asset_cache::wait_until_ready().await;',
    );

    expect(cache).toMatch(
      /fn release_startup_gate[\s\S]*run_ready_callback\(callback\);[\s\S]*signal_startup_gate_ready\(\);/,
    );
    const productionCache = cache.slice(0, cache.indexOf('#[cfg(test)]'));
    expect(productionCache).not.toMatch(
      /signal_startup_gate_ready\(\);[\s\S]{0,180}run_ready_callback/,
    );
  });
});
