import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let sharePoller = "";
let dmMqtt = "";
let authCommands = "";
let dmPoller = "";

beforeAll(async () => {
  [sharePoller, dmMqtt, authCommands, dmPoller] = await Promise.all(
    [
      "apps/sync/src-tauri/src/commands/share_notify.rs",
      "apps/sync/src-tauri/src/commands/dm_mqtt.rs",
      "apps/sync/src-tauri/src/commands/auth.rs",
      "apps/sync/src-tauri/src/commands/dm_notify.rs",
    ].map((path) => readFile(resolve(root, path), "utf8")),
  );
});

describe("desktop push fallback wiring", () => {
  it("uses fixed scheduler ticks instead of sleeping after requests", () => {
    expect(sharePoller).toMatch(/share_poll_interval\(\)/);
    expect(sharePoller).toMatch(/poll_ticker\.tick\(\)/);
    expect(sharePoller).not.toMatch(
      /sleep\(Duration::from_secs\(SHARE_POLL_INTERVAL_SECS\)\)/,
    );
  });

  it("coalesces overlapping share and DM wakes into a trailing poll", () => {
    const sharePollOnce = /pub async fn poll_once[\s\S]*?\n}/.exec(sharePoller)?.[0] ?? "";
    const dmPollOnce = /pub async fn poll_dm_once[\s\S]*?\n}/.exec(dmPoller)?.[0] ?? "";
    expect(sharePollOnce).toMatch(
      /SHARE_POLL_GATE[\s\S]*?\.run\(\|\| \{[\s\S]*?do_poll\(&app\)\.await/,
    );
    expect(dmPollOnce).toMatch(
      /DM_POLL_GATE[\s\S]*?\.run\(\|\| \{[\s\S]*?async move[\s\S]*?do_poll\(&app, &auth\)\.await/,
    );
  });

  it("waits for a granted notification subscription before pausing fallback", () => {
    expect(dmMqtt).toMatch(/subscribe_many\(filters\)/);
    const subackHandler =
      /Packet::SubAck\(suback\)[\s\S]*?awaiting_notification_suback = false;/.exec(dmMqtt)?.[0] ?? "";
    expect(subackHandler).toMatch(
      /all_realtime_subscriptions_granted\([\s\S]*?DM_PUSH_CONNECTED_GENERATION\.store\(auth_session_generation[\s\S]*?DM_MQTT_SUBSCRIBED/,
    );
  });

  it("invalidates and reconnects the receiver when sign-out changes accounts", () => {
    expect(authCommands).toMatch(/clear_notification_credentials\(&app\)\.await\?;\s*crate::commands::dm_mqtt::reset_dm_push_for_auth_session_change\(\);/);
    expect(dmMqtt).toMatch(/AUTH_SESSION_GENERATION\.fetch_add\(1/);
    expect(dmMqtt).toMatch(/DM_AUTH_SESSION_CHANGED\.notify_one\(\)/);
    expect(dmMqtt).toMatch(/_ = DM_AUTH_SESSION_CHANGED\.notified\(\) =>/);
  });
});
