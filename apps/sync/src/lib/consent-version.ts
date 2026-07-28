/**
 * The telemetry consent version the desktop client displays.
 *
 * This mirrors the server-side constant `TELEMETRY_CONSENT_VERSION` in hq-pro
 * (`src/vault-service/consent/consent-version.ts`). It is the single place the
 * desktop app declares which wording it showed a person when they answered.
 *
 * BUMPING THIS RE-ASKS EVERYONE. Increment it only when the prompt wording or
 * the list of collected/not-collected data changes. Every existing consent
 * record recorded against a lower version becomes stale (see the "Staleness"
 * section of the cross-repo contract), which is what causes each person to be
 * asked again. Keep it in agreement with the hq-pro constant.
 */
export const TELEMETRY_CONSENT_VERSION = 1;
