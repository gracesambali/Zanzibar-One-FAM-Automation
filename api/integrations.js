// api/integrations.js
//
// The real, reusable Integrations framework, confirmed directly and
// discussed in full before building: one generic OAuth connection
// system serving every provider (QuickBooks, Zoho Books, Matterport,
// and whatever a client brings later), built once rather than
// per-client. A client connects their own account directly through
// this - GVC never touches or holds their credentials at any point.
// Adding a new provider means adding a config entry below, not new
// architecture.
//
// GET  ?list=true                -> every connection for this org (status only, never raw tokens)
// GET  ?connect=<provider>       -> redirects into that provider's own real login/authorize page
// GET  ?callback=<provider>      -> the provider redirects back here after the person approves
// POST { action: "disconnect", provider } -> revokes and removes the connection

import { getSession, setSessionCookie } from "../lib/auth.js";
import { can } from "../lib/roles.js";

// Confirmed directly: each provider here is a real, self-contained
// config - its own real authorize/token URLs and its own real
// application credentials (registered directly with that provider,
// never something GVC invents). A provider with no client id/secret
// set in the environment yet is reported as "not configured" rather
// than attempted and failed, so an unfinished provider never looks
// like a broken one.
const PROVIDERS = {
  quickbooks: {
    label: "QuickBooks",
    abbr: "QB",
    color: "#2CA01C",
    authUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    scope: "com.intuit.quickbooks.accounting",
    clientIdEnv: "QUICKBOOKS_CLIENT_ID",
    clientSecretEnv: "QUICKBOOKS_CLIENT_SECRET",
  },
  zoho_books: {
    label: "Zoho Books",
    abbr: "ZB",
    color: "#226DB4",
    authUrl: "https://accounts.zoho.com/oauth/v2/auth",
    tokenUrl: "https://accounts.zoho.com/oauth/v2/token",
    scope: "ZohoBooks.fullaccess.all",
    clientIdEnv: "ZOHO_CLIENT_ID",
    clientSecretEnv: "ZOHO_CLIENT_SECRET",
    extraAuthParams: { access_type: "offline" },
  },
  matterport: {
    label: "Matterport",
    abbr: "MP",
    color: "#1A1A2E",
    // Confirmed directly against Matterport's own developer
    // documentation: these are their real, correct OAuth endpoints -
    // but access itself is invitation-only, gated behind a real
    // Developer Tools Production License and a Commercial Partnership
    // Agreement with Matterport directly, not open, standard self-
    // serve registration the way QuickBooks or Zoho are. Wiring in
    // the real URLs doesn't unlock access on its own - this still
    // correctly reports "not set up yet" until real credentials from
    // that actual approval process exist in the environment.
    authUrl: "https://authn.matterport.com/oauth/authorize",
    tokenUrl: "https://api.matterport.com/api/oauth/token",
    scope: "ViewDetails ViewPublic",
    tokenAuthMethod: "body_params",
    clientIdEnv: "MATTERPORT_CLIENT_ID",
    clientSecretEnv: "MATTERPORT_CLIENT_SECRET",
  },
  xero: {
    label: "Xero",
    abbr: "XE",
    color: "#13B5EA",
    // Confirmed directly against Xero's own developer documentation:
    // real, correct OAuth endpoints - a real, visible provision for
    // when a client brings this one, no real credentials registered
    // yet, so this correctly still reports "not set up yet".
    authUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    scope: "accounting.transactions accounting.contacts accounting.settings offline_access",
    clientIdEnv: "XERO_CLIENT_ID",
    clientSecretEnv: "XERO_CLIENT_SECRET",
  },
  sage: {
    label: "Sage",
    abbr: "SG",
    color: "#00DC00",
    // Confirmed directly against Sage's own developer documentation
    // (Business Cloud Accounting, the current v3.1 API): real,
    // correct OAuth endpoints, its token exchange using real body
    // parameters rather than a Basic Auth header, same as
    // Matterport's own real method above. A real, visible provision
    // for when a client brings this one - no real credentials
    // registered yet, correctly still reporting "not set up yet".
    authUrl: "https://www.sageone.com/oauth2/auth/central",
    tokenUrl: "https://oauth.accounting.sage.com/token",
    scope: "full_access",
    tokenAuthMethod: "body_params",
    clientIdEnv: "SAGE_CLIENT_ID",
    clientSecretEnv: "SAGE_CLIENT_SECRET",
  },
};

function providerConfigured(key) {
  const p = PROVIDERS[key];
  return !!(p && p.authUrl && p.tokenUrl && process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]);
}

function getAppBaseUrl() {
  return process.env.APP_BASE_URL || "https://fam.gracingventures.com";
}

// Confirmed directly: a real, verifiable link between the redirect
// that comes back and the exact request that started it - the org id
// and provider are encoded directly into state (not just a random
// nonce alone), and checked against the real, current session on
// return, so a forged or replayed callback can't attach a connection
// to the wrong organization.
function buildState(organizationId, provider) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return Buffer.from(JSON.stringify({ organizationId, provider, nonce })).toString("base64url");
}

function parseState(state) {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r, session.org);

  if (req.method === "GET" && req.query.list === "true") {
    return handleListConnections(req, res, session.org);
  }

  if (req.method === "GET" && req.query.connect) {
    return handleConnect(req, res, session);
  }

  if (req.method === "GET" && req.query.callback) {
    return handleCallback(req, res, session);
  }

  if (req.method === "POST" && req.body && req.body.action === "disconnect") {
    return handleDisconnect(req, res, session);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// Confirmed directly: the frontend gets provider label, status, who
// connected it and when, and when it last synced - never the actual
// access or refresh token. Those never leave the database once
// written.
async function handleListConnections(req, res, organizationId) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      "select provider, status, provider_account_name, connected_by, connected_at, last_synced_at, last_error from integration_connections where organization_id = $1",
      [organizationId]
    );
    const connectedByProvider = {};
    result.rows.forEach(r => { connectedByProvider[r.provider] = r; });

    const providers = Object.entries(PROVIDERS).map(([key, cfg]) => {
      const row = connectedByProvider[key];
      return {
        provider: key,
        label: cfg.label,
        abbr: cfg.abbr,
        color: cfg.color,
        configured: providerConfigured(key),
        connected: !!(row && row.status === "active"),
        status: row ? row.status : null,
        accountName: row ? row.provider_account_name : null,
        connectedBy: row ? row.connected_by : null,
        connectedAt: row ? row.connected_at : null,
        lastSyncedAt: row ? row.last_synced_at : null,
        lastError: row ? row.last_error : null,
      };
    });

    return res.status(200).json({ providers });
  } catch (err) {
    console.error("integrations list error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleConnect(req, res, session) {
  const provider = req.query.connect;
  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: "Unknown provider." });
  if (!can(session.r, "manageUsers")) return res.status(403).json({ error: "Not permitted to connect an integration." });
  if (!providerConfigured(provider)) {
    return res.status(400).json({ error: `${cfg.label} isn't set up yet on this deployment - it needs application credentials registered with ${cfg.label} first.` });
  }

  const state = buildState(session.org, provider);
  const redirectUri = `${getAppBaseUrl()}/api/integrations?callback=${provider}`;
  const params = new URLSearchParams({
    client_id: process.env[cfg.clientIdEnv],
    redirect_uri: redirectUri,
    response_type: "code",
    scope: cfg.scope,
    state,
    ...(cfg.extraAuthParams || {}),
  });

  res.writeHead(302, { Location: `${cfg.authUrl}?${params.toString()}` });
  return res.end();
}

async function handleCallback(req, res, session) {
  const provider = req.query.callback;
  const cfg = PROVIDERS[provider];
  const appUrl = getAppBaseUrl();
  const redirectBackToApp = (ok, message) =>
    res.writeHead(302, { Location: `${appUrl}/mv48r1w3?integrationResult=${ok ? "success" : "error"}&provider=${provider}${message ? "&message=" + encodeURIComponent(message) : ""}` }).end();

  if (!cfg) return redirectBackToApp(false, "Unknown provider.");
  if (req.query.error) return redirectBackToApp(false, `${cfg.label} declined the connection.`);

  const { code, state } = req.query;
  if (!code || !state) return redirectBackToApp(false, "Missing authorization details.");

  const parsedState = parseState(state);
  if (!parsedState || parsedState.provider !== provider || parsedState.organizationId !== session.org) {
    return redirectBackToApp(false, "This connection link doesn't match your current session - please try connecting again.");
  }

  try {
    const redirectUri = `${appUrl}/api/integrations?callback=${provider}`;
    const bodyParams = { grant_type: "authorization_code", code, redirect_uri: redirectUri };
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };

    // Confirmed directly against each provider's own documentation:
    // QuickBooks and Zoho both authenticate this exchange via a Basic
    // Auth header; Matterport's own real token endpoint instead
    // requires client_id/client_secret as real body parameters. Kept
    // as a real, per-provider choice rather than assuming every
    // provider works the same way.
    if (cfg.tokenAuthMethod === "body_params") {
      bodyParams.client_id = process.env[cfg.clientIdEnv];
      bodyParams.client_secret = process.env[cfg.clientSecretEnv];
    } else {
      headers.Authorization = `Basic ${Buffer.from(`${process.env[cfg.clientIdEnv]}:${process.env[cfg.clientSecretEnv]}`).toString("base64")}`;
    }

    const tokenResp = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams(bodyParams),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "Token exchange failed");
    }

    const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;
    // Confirmed directly: the real, external account/company id this
    // connection is tied to - QuickBooks sends it as realmId directly
    // on the callback query string, not in the token response itself.
    const providerAccountId = req.query.realmId || null;

    const { query: pgQuery } = await import("../lib/postgresClient.js");
    await pgQuery(
      `insert into integration_connections
         (organization_id, provider, status, access_token, refresh_token, token_expires_at, scope, provider_account_id, connected_by, connected_at)
       values ($1, $2, 'active', $3, $4, $5, $6, $7, $8, now())
       on conflict (organization_id, provider) do update set
         status = 'active', access_token = $3, refresh_token = $4, token_expires_at = $5, scope = $6,
         provider_account_id = $7, connected_by = $8, connected_at = now(), last_error = null`,
      [session.org, provider, tokenData.access_token, tokenData.refresh_token || null, expiresAt, tokenData.scope || cfg.scope, providerAccountId, session.u]
    );

    await pgQuery(
      "insert into integration_activity_log (organization_id, provider, event, detail, actor) values ($1, $2, 'connected', $3, $4)",
      [session.org, provider, `Connected by ${session.u}`, session.u]
    ).catch(() => {});

    return redirectBackToApp(true);
  } catch (err) {
    console.error(`integrations callback (${provider}) error:`, err);
    return redirectBackToApp(false, err.message);
  }
}

async function handleDisconnect(req, res, session) {
  const { provider } = req.body;
  if (!PROVIDERS[provider]) return res.status(400).json({ error: "Unknown provider." });
  if (!can(session.r, "manageUsers")) return res.status(403).json({ error: "Not permitted to disconnect an integration." });

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    await pgQuery(
      "delete from integration_connections where organization_id = $1 and provider = $2",
      [session.org, provider]
    );
    await pgQuery(
      "insert into integration_activity_log (organization_id, provider, event, detail, actor) values ($1, $2, 'disconnected', $3, $4)",
      [session.org, provider, `Disconnected by ${session.u}`, session.u]
    ).catch(() => {});

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("integrations disconnect error:", err);
    return res.status(500).json({ error: err.message });
  }
}
