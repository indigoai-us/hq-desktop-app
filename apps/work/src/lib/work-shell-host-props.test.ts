import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const hostProps = [
  {
    name: "invoke",
    declaration: "invoke: hostInvoke,",
    forwarding: "const nativeInvoke = hostInvoke ?? tauriInvoke;",
    desktopAppProp: "{adapter}",
  },
  {
    name: "listen",
    declaration: "listen: hostListen,",
    forwarding: "const nativeListen = hostListen ?? tauriListen;",
    desktopAppProp: "{self}",
  },
  {
    name: "wakes",
    declaration: "wakes: hostWakes,",
    forwarding: "const wakes = hostWakes ?? createChatWakeBus();",
    desktopAppProp: "{wakes}",
  },
  {
    name: "version",
    declaration: "version: hostVersion,",
    forwarding: "version={hostVersion ?? displayVersion(`v${workPackage.version}`)}",
    desktopAppProp: "version={hostVersion ?? displayVersion(`v${workPackage.version}`)}",
  },
  {
    name: "updateWakeSeq",
    declaration: "updateWakeSeq,",
    forwarding: "{updateWakeSeq}",
    desktopAppProp: "{updateWakeSeq}",
  },
  {
    name: "refreshAppVersion",
    declaration: "refreshAppVersion,",
    forwarding: "{refreshAppVersion}",
    desktopAppProp: "{refreshAppVersion}",
  },
  {
    name: "packagesEvents",
    declaration: "packagesEvents,",
    forwarding: "{packagesEvents}",
    desktopAppProp: "{packagesEvents}",
  },
  {
    name: "notificationWakeSeq",
    declaration: "notificationWakeSeq: hostNotificationWakeSeq,",
    forwarding: "hostNotificationWakeSeq ?? localNotificationWakeSeq",
    desktopAppProp: "{notificationWakeSeq}",
  },
  {
    name: "onOpenConsole",
    declaration: "onOpenConsole: hostOnOpenConsole,",
    forwarding: "onOpenConsole={hostOnOpenConsole ?? openUrl}",
    desktopAppProp: "onOpenConsole={hostOnOpenConsole ?? openUrl}",
  },
  {
    name: "onopenurl",
    declaration: "onopenurl: hostOpenUrl,",
    forwarding: "onopenurl={hostOpenUrl ?? openUrl}",
    desktopAppProp: "onopenurl={hostOpenUrl ?? openUrl}",
  },
  {
    name: "onembeddednavigationready",
    declaration: "onembeddednavigationready,",
    forwarding: "{onembeddednavigationready}",
    desktopAppProp: "{onembeddednavigationready}",
  },
  {
    name: "onactivethreadchange",
    declaration: "onactivethreadchange,",
    forwarding: "{onactivethreadchange}",
    desktopAppProp: "{onactivethreadchange}",
  },
] as const;

describe("WorkShell native host props", () => {
  it("keeps every explicit host prop wired through to DesktopApp", async () => {
    const source = await readFile(new URL("./WorkShell.svelte", import.meta.url), "utf8");
    const desktopApp = source.match(/<DesktopApp([\s\S]*?)\/>/)?.[1];

    expect(desktopApp, "WorkShell must render DesktopApp").toBeDefined();
    for (const hostProp of hostProps) {
      expect(
        source,
        `[${hostProp.name}] must stay declared in WorkShell's props destructure`,
      ).toContain(hostProp.declaration);
      expect(
        desktopApp,
        `[${hostProp.name}] must reach DesktopApp as ${hostProp.desktopAppProp}`,
      ).toContain(hostProp.desktopAppProp);
      expect(
        source,
        `[${hostProp.name}] must retain its host-to-shell forwarding seam`,
      ).toContain(hostProp.forwarding);
    }
  });
});
