// lib/auth.js
//
// Minimal but real authentication — signed session cookies, no external
// auth service needed. Sized for one (or a handful of) real accounts
// per client deployment, not a full multi-tenant user system.
//
// How it works: on successful login, we create a token containing the
// username and an expiry time, sign it with a secret only the server
// knows (SESSION_SECRET), and store it in an HttpOnly cookie the
// browser can't read via JavaScript. On every protected request, we
// re-verify that signature — if it doesn't match, or the token has
// expired, access is denied.
//
// Session behavior: 30 minutes of inactivity logs you out automatically
// — every real request refreshes the window, so active use never
// interrupts you. The cookie itself has no fixed expiry date (a true
// "session cookie"), so browsers discard it entirely when fully closed,
// not just when a tab is closed.

import crypto from "crypto";

const SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes of inactivity

export function createSessionToken(username, role) {
  const payload = JSON.stringify({ u: username, r: role || "engineer", exp: Date.now() + SESSION_DURATION_MS });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const signature = sign(payloadB64);
  return `${payloadB64}.${signature}`;
}

export function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payloadB64, signature] = token.split(".");
  const expectedSignature = sign(payloadB64);

  // Constant-time comparison — prevents timing attacks from revealing
  // the correct signature one byte at a time.
  const sigBuf = Buffer.from(signature || "");
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (payload.exp < Date.now()) return null; // expired
    return payload; // { u: username, r: role, exp: ... }
  } catch {
    return null;
  }
}

function sign(value) {
  const secret = process.env.SESSION_SECRET || "";
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach(pair => {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(rest.join("="));
  });
  return cookies;
}

// Checks the incoming request for either:
//   1. A valid session cookie (browser/dashboard login), OR
//   2. A valid API key in the Authorization header (external systems —
//      ERP/SAP integrations, which can't "log in" via a browser cookie).
// Returns the same shape either way: { u: <identity>, r: <role> }, so
// every existing endpoint that checks getSession() works unchanged
// regardless of which auth path was actually used.
export function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const cookieSession = verifySessionToken(cookies.gvc_session);
  if (cookieSession) return cookieSession;

  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const providedKey = authHeader.slice(7).trim();
    const realKey = process.env.API_INTEGRATION_KEY || "";
    if (realKey && providedKey.length === realKey.length) {
      const providedBuf = Buffer.from(providedKey);
      const realBuf = Buffer.from(realKey);
      if (crypto.timingSafeEqual(providedBuf, realBuf)) {
        return { u: "api-integration", r: process.env.API_INTEGRATION_ROLE || "engineer", isApiKey: true };
      }
    }
  }

  return null;
}

// Sets the session cookie — used at login, and re-called on every
// protected request to slide the 30-minute window forward. No
// Max-Age/Expires is set, which makes this a true browser "session
// cookie": most browsers discard it entirely when fully closed, not
// just when a tab closes. The 30-minute inactivity limit is enforced
// separately, by the exp timestamp inside the signed token itself.
export function setSessionCookie(res, username, role) {
  const token = createSessionToken(username, role);
  res.setHeader("Set-Cookie", [
    `gvc_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`
  ]);
}
