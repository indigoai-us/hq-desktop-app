#!/usr/bin/env node
// Daily age check for the non-Indigo release smoke refresh token.
//
// Cognito refresh tokens for the desktop app client last 30 days. When the
// token expired on 2026-10-03, v0.10.383 failed the release smoke with a boot
// watchdog error that looked like an app regression. This check fails at day
// 25 so the token is re-minted before any release depends on it.
//
// GitHub does not expose a secret's age to workflows, so the mint time lives in
// the repository variable HQ_RELEASE_SMOKE_REFRESH_TOKEN_MINTED_AT, which the
// re-mint command in docs/RELEASE.md sets in the same step as the secret. A
// missing or unreadable mint time fails the check rather than passing it.

import { pathToFileURL } from "node:url";

import { SMOKE_TOKEN_SECRET, verifySmokeRefreshToken } from "./macos-artifact-smoke.mjs";

export const MINTED_AT_VARIABLE = "HQ_RELEASE_SMOKE_REFRESH_TOKEN_MINTED_AT";
export const TOKEN_LIFETIME_DAYS = 30;
export const REMINT_DUE_DAYS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/**
 * Classify the token by age. Returns { status, ageDays?, message } where
 * status is one of: ok, due, expired, missing, invalid. Only "ok" passes.
 */
export function classifyTokenAge(mintedAt, now = new Date()) {
  const raw = String(mintedAt ?? "").trim();
  if (!raw) {
    return {
      status: "missing",
      message: `${MINTED_AT_VARIABLE} is not set, so the age of ${SMOKE_TOKEN_SECRET} is unknown. Re-mint the token with the command in docs/RELEASE.md ("Non-Indigo release smoke"); it sets this variable.`,
    };
  }
  const minted = ISO_UTC.test(raw) ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(minted.getTime())) {
    return {
      status: "invalid",
      message: `${MINTED_AT_VARIABLE}=${JSON.stringify(raw)} is not a UTC ISO timestamp (YYYY-MM-DDTHH:MM:SSZ).`,
    };
  }
  const ageMs = now.getTime() - minted.getTime();
  if (ageMs < 0) {
    return {
      status: "invalid",
      message: `${MINTED_AT_VARIABLE}=${raw} is in the future.`,
    };
  }
  const ageDays = Math.floor((ageMs / DAY_MS) * 10) / 10;
  const expiresAt = new Date(minted.getTime() + TOKEN_LIFETIME_DAYS * DAY_MS).toISOString();
  if (ageMs >= TOKEN_LIFETIME_DAYS * DAY_MS) {
    return {
      status: "expired",
      ageDays,
      message: `${SMOKE_TOKEN_SECRET} was minted ${raw} (${ageDays} days ago) and expired at ${expiresAt}. Release smokes will fail until it is re-minted with the command in docs/RELEASE.md.`,
    };
  }
  if (ageMs >= REMINT_DUE_DAYS * DAY_MS) {
    return {
      status: "due",
      ageDays,
      message: `${SMOKE_TOKEN_SECRET} was minted ${raw} (${ageDays} days ago) and expires at ${expiresAt}. Re-mint it now with the command in docs/RELEASE.md, before the release smoke starts failing.`,
    };
  }
  return {
    status: "ok",
    ageDays,
    message: `${SMOKE_TOKEN_SECRET} is ${ageDays} days old; re-mint due at day ${REMINT_DUE_DAYS}, expires at ${expiresAt}.`,
  };
}

/**
 * Age check plus one live exchange, so a revoked token fails even when its
 * recorded age looks fine. Returns { ok, message }.
 */
export async function runAgeCheck({
  env = process.env,
  now = new Date(),
  verifyImpl = verifySmokeRefreshToken,
  warn = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const age = classifyTokenAge(env[MINTED_AT_VARIABLE], now);
  if (age.status !== "ok") return { ok: false, message: age.message };
  const token = String(env[SMOKE_TOKEN_SECRET] ?? "").trim();
  if (!token) {
    return { ok: false, message: `${SMOKE_TOKEN_SECRET} is not set.` };
  }
  try {
    await verifyImpl(token, { warn });
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
  return { ok: true, message: age.message };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await runAgeCheck();
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stdout.write(`::error::${result.message}\n`);
    process.exitCode = 1;
  }
}
