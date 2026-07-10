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

import crypto from "crypto";

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createSessionToken(username) {
  const payload = JSON.stringify({ u: username, exp: Date.now() + SESSION_DURATION_MS });
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
    return payload; // { u: username, exp: ... }
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

// Checks the incoming request for a valid session. Returns the
// decoded session payload if valid, or null if not logged in.
export function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies.gvc_session);
}
