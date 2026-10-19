import { failure, ok, type AdapterResult, type BotPersonalAppsApi } from "./adapter.js";

/**
 * Local test bridge for personal apps. Only wired when a build sets
 * VITE_HQ_PERSONAL_APPS_BRIDGE; release builds never do. It stands in for the
 * HQ server routes until they exist.
 */
export function personalAppsBridgeUrl(): string | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_HQ_PERSONAL_APPS_BRIDGE?.trim();
  return url && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) ? url : null;
}

export function createPersonalAppsBridge(baseUrl: string, fetcher: typeof fetch = fetch): BotPersonalAppsApi {
  const bot = (uid: string) => `${baseUrl}/api/bots/${encodeURIComponent(uid)}`;
  async function request<T>(url: string, init?: RequestInit): Promise<AdapterResult<T>> {
    try {
      const response = await fetcher(url, { ...init, headers: { "Content-Type": "application/json" } });
      const body = (await response.json().catch(() => ({}))) as T & { error?: string };
      if (!response.ok) return { ...failure(String(response.status), body?.error), status: response.status };
      return ok(body);
    } catch (error) {
      return failure("network", error instanceof Error ? error.message : "Bridge unreachable");
    }
  }
  return {
    list: (uid) => request(`${bot(uid)}/apps`),
    catalog: (uid) => request(`${bot(uid)}/catalog`),
    add: (uid, input) => request(`${bot(uid)}/apps`, { method: "POST", body: JSON.stringify(input) }),
    remove: (uid, name) => request(`${bot(uid)}/apps/${encodeURIComponent(name)}`, { method: "DELETE" }),
    startSignIn: (uid, name) => request(`${bot(uid)}/apps/${encodeURIComponent(name)}/sign-in`, { method: "POST", body: "{}" }),
    signInStatus: (uid, flowId) => request(`${bot(uid)}/sign-in/${encodeURIComponent(flowId)}`),
  };
}
