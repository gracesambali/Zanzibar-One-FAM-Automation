// lib/passwordAuth.js
//
// Real, database-backed authentication — replaces the fixed env-var
// credential pairs login.js used to check directly. Passwords now live
// in an Airtable "Users" table, salted and hashed with Node's built-in
// crypto.scrypt (no new dependency — this codebase deliberately avoids
// adding libraries where the platform already provides what's needed).
//
// "Set password" and "forgot password" are the same flow on purpose:
// a freshly migrated account with no password set yet, and an existing
// account that's been reset, both work by emailing a one-time link.
// There's no separate "first login" ceremony to build or maintain.

import crypto from "crypto";
import { listRecords, updateRecord } from "./airtableClient.js";

const USERS_TABLE = () => process.env.AIRTABLE_USERS_TABLE || "Users";

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
// case-sensitive match here was the actual cause of resets silently
// finding nothing and never sending an email, with no error anywhere
// to reveal why.
export async function findUserByUsername(username) {
  const escaped = String(username).replace(/"/g, '\\"');
  const data = await listRecords(USERS_TABLE(), {
    filterByFormula: `LOWER({Username}) = LOWER("${escaped}")`,
    maxRecords: 1,
  }).catch(() => null);
  return (data && data.records && data.records[0]) || null;
}

// Used by the password reset request step — matched case-insensitively
// since email addresses are commonly typed with inconsistent casing.
export async function findUserByEmail(email) {
  const escaped = String(email).replace(/"/g, '\\"');
  const data = await listRecords(USERS_TABLE(), {
    filterByFormula: `LOWER({Email}) = LOWER("${escaped}")`,
    maxRecords: 1,
  }).catch(() => null);
  return (data && data.records && data.records[0]) || null;
}

export async function findUserByResetToken(token) {
  const data = await listRecords(USERS_TABLE(), {
    filterByFormula: `{Reset Token} = "${String(token).replace(/"/g, '\\"')}"`,
    maxRecords: 1,
  }).catch(() => null);
  return (data && data.records && data.records[0]) || null;
}

export async function updateUserFields(recordId, fields) {
  return updateRecord(USERS_TABLE(), recordId, fields)
    .then(() => true)
    .catch(() => false);
}
