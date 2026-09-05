#!/usr/bin/env node
// Post a message to an HQ DM channel (default #hq-dev) from CI.
//
// Transport is the HQ DM API, not Slack:
//   1. mint a Cognito token for the announcer identity
//   2. GET  /v1/notify/channels          -> resolve the channel name to its id
//   3. POST /v1/notify/channels/{id}/messages  { body }
//
// FAIL-SOFT BY DESIGN. A release must never go red because an announcement
// could not be posted. Every failure here — missing secret, expired token,
// channel not found, API error — prints a clear line and exits 0.
//
// Credentials, in order of preference (see the PR body / policy for how to
// provision them):
//   HQ_DM_ANNOUNCE_USERNAME + HQ_DM_ANNOUNCE_SECRET  machine creds, do not expire
//   HQ_DM_ANNOUNCE_REFRESH_TOKEN                     Cognito refresh token
//
// Usage:
//   hq-dm-announce.mjs --channel hq-dev --body "text"
//   hq-dm-announce.mjs --channel hq-dev --body-file message.txt
//   hq-dm-announce.mjs ... --dry-run     print the message, mint nothing

const API_BASE =
  process.env.HQ_VAULT_API_URL || process.env.HQ_API_URL || "https://hqapi.hq.computer";
const REGION = process.env.HQ_COGNITO_REGION || process.env.AWS_REGION || "us-east-1";
const CLIENT_ID = process.env.HQ_COGNITO_CLIENT_ID || "7acei2c8v870enheptb1j5foln";
const COGNITO_DOMAIN = process.env.HQ_COGNITO_DOMAIN || "vault-indigo-hq-prod";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[name] = next;
      i += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

function skip(reason) {
  console.log(`HQ DM announcement skipped: ${reason}`);
  process.exit(0);
}

async function mintWithMachineCreds(username, secret) {
  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: process.env.HQ_DM_ANNOUNCE_CLIENT_ID || CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: secret },
    }),
  });
  if (!res.ok) throw new Error(`Cognito InitiateAuth failed with HTTP ${res.status}`);
  const json = await res.json();
  const result = json.AuthenticationResult;
  if (!result) throw new Error("Cognito InitiateAuth returned no AuthenticationResult");
  return { idToken: result.IdToken, accessToken: result.AccessToken };
}

async function mintWithRefreshToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(
    `https://${COGNITO_DOMAIN}.auth.${REGION}.amazoncognito.com/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) throw new Error(`Cognito token refresh failed with HTTP ${res.status}`);
  const json = await res.json();
  if (!json.id_token && !json.access_token) throw new Error("Cognito token refresh returned no token");
  return { idToken: json.id_token, accessToken: json.access_token };
}

async function mintTokens() {
  const username = process.env.HQ_DM_ANNOUNCE_USERNAME;
  const secret = process.env.HQ_DM_ANNOUNCE_SECRET;
  if (username && secret) return mintWithMachineCreds(username, secret);

  const refreshToken = process.env.HQ_DM_ANNOUNCE_REFRESH_TOKEN;
  if (refreshToken) return mintWithRefreshToken(refreshToken);

  return null;
}

async function api(token, path, init = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
}

async function resolveChannelId(token, name) {
  const wanted = String(name).replace(/^#/, "").toLowerCase();
  let cursor;
  const matches = [];
  do {
    const res = await api(
      token,
      `/v1/notify/channels${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (!res.ok) throw new Error(`Listing channels failed with HTTP ${res.status}`);
    const json = await res.json();
    for (const channel of json.channels || []) {
      const candidate = String(channel.slug || channel.name || "").toLowerCase();
      if (candidate === wanted) matches.push(channel);
    }
    cursor = json.nextCursor;
  } while (cursor);

  if (matches.length === 0) throw new Error(`No channel named #${wanted} is visible to this identity`);
  // Channel names are only unique per scope. Prefer a company channel, which is
  // what #hq-dev is, so a same-named personal channel cannot win.
  const preferred = matches.find((c) => c.scope === "company") || matches[0];
  return preferred.channelId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const channel = args.channel && args.channel !== true ? String(args.channel) : "hq-dev";

  let body = args.body && args.body !== true ? String(args.body) : "";
  if (!body && args["body-file"] && args["body-file"] !== true) {
    const { readFileSync } = await import("node:fs");
    body = readFileSync(String(args["body-file"]), "utf8");
  }
  body = body.trim();
  if (!body) skip("no message body was provided");

  if (args["dry-run"]) {
    console.log(`--- would post to #${channel} ---`);
    console.log(body);
    console.log("--- end ---");
    return;
  }

  let tokens;
  try {
    tokens = await mintTokens();
  } catch (err) {
    skip(`could not mint a token for the announcer identity (${err.message})`);
  }
  if (!tokens) {
    skip(
      "no announcer credentials are configured on this repository. " +
        "Set HQ_DM_ANNOUNCE_USERNAME + HQ_DM_ANNOUNCE_SECRET (preferred) or " +
        "HQ_DM_ANNOUNCE_REFRESH_TOKEN as Actions secrets to turn announcements on.",
    );
  }

  // Either token type is accepted by the API authorizer; identity resolution
  // differs between them, so try the id token first and fall back once.
  const candidates = [tokens.idToken, tokens.accessToken].filter(Boolean);
  let lastError = "no usable token";
  for (const token of candidates) {
    try {
      const channelId = await resolveChannelId(token, channel);
      const res = await api(token, `/v1/notify/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      if (res.ok) {
        console.log(`Posted the release announcement to #${channel.replace(/^#/, "")}.`);
        return;
      }
      lastError = `posting failed with HTTP ${res.status}`;
      if (res.status !== 401 && res.status !== 403 && res.status !== 404) break;
    } catch (err) {
      lastError = err.message;
    }
  }
  skip(lastError);
}

main().catch((err) => skip(err?.message ?? String(err)));
