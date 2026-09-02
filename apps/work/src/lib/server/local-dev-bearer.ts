/**
 * DEV-ONLY: when HQ_LOCAL_MESH=1 and there is no cookie token, reuse the
 * machine Cognito idToken so the development token bridge can call hq-pro.
 * Never used in a production build (import.meta.env.DEV is false there).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export function localDevBearer(opts: {
  cookieToken?: string | null;
  dev: boolean;
  meshFlag: string | undefined;
}): string | null {
  const cookie = (opts.cookieToken ?? "").trim();
  if (cookie) return cookie;
  if (!opts.dev || opts.meshFlag !== "1") return null;
  try {
    const raw = readFileSync(
      join(homedir(), ".hq", "cognito-tokens.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { idToken?: unknown };
    const token =
      typeof parsed.idToken === "string" ? parsed.idToken.trim() : "";
    return token || null;
  } catch {
    return null;
  }
}
