// lib/passwordAuth.js
//
// Real, database-backed authentication — replaces the fixed env-var
// credential pairs login.js used to check directly. Passwords live in
// the Postgres "users" table, salted and hashed with Node's built-in
// crypto.scrypt (no new dependency — this codebase deliberately avoids
// adding libraries where the platform already provides what's needed).
//
// "Set password" and "forgot password" are the same flow on purpose:
// a freshly migrated account with no password set yet, and an existing
// account that's been reset, both work by emailing a one-time link.
// There's no separate "first login" ceremony to build or maintain.

import crypto from "crypto";
import { query, update } from "./postgresClient.js";

// scrypt with a random 16-byte salt per user — deliberately slow and
// memory-hard, the standard defense against brute-forcing a leaked
// hash. Never store or log the plain password anywhere, ever.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

// Timing-safe comparison — a plain === on hash strings would leak
// timing information about how many characters matched, which is
// exactly the kind of thing that turns into a real attack over enough
// requests.
export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  try {
    const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function generateResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Case-insensitive, matching findUserByEmail's approach — someone
// typing "pr" instead of "PR" should still find the account. An exact,
// case-sensitive match here was the actual original cause of resets
// silently finding nothing and never sending an email, with no error
// anywhere to reveal why — preserved as case-insensitive here too.
export async function findUserByUsername(username) {
  const result = await query("select * from users where lower(username) = lower($1) limit 1", [String(username)])
    .catch(() => null);
  return (result && result.rows[0]) || null;
}

// Used by the password reset request step — matched case-insensitively
// since email addresses are commonly typed with inconsistent casing.
export async function findUserByEmail(email) {
  const result = await query("select * from users where lower(email) = lower($1) limit 1", [String(email)])
    .catch(() => null);
  return (result && result.rows[0]) || null;
}

export async function findUserByResetToken(token) {
  const result = await query("select * from users where reset_token = $1 limit 1", [String(token)])
    .catch(() => null);
  return (result && result.rows[0]) || null;
}

// Takes plain Postgres column names directly (password_hash,
// password_salt, reset_token, reset_token_expires) — no Airtable-
// style translation layer, since login.js (the only caller) is
// converted in this same change and there's no separate frontend
// contract depending on the old field names.
export async function updateUserFields(userId, fields) {
  return update("users", userId, fields)
    .then(() => true)
    .catch(() => false);
}
