// api/login.js
//
// POST { username, password }                          -> log in
// POST { action: "logout" } / DELETE                    -> log out
// POST { action: "requestPasswordReset", username }     -> email a set/reset link
// POST { action: "confirmPasswordReset", token, newPassword } -> set the new password
//
// Real accounts now live in Airtable (Users table), with salted +
// hashed passwords — the actual source of truth going forward. The
// original fixed env-var credential pairs are kept as a TEMPORARY
// fallback so nobody already using the app gets locked out mid-
// migration; remove that block entirely once every real person has a
// Users record with a password set.
//
// Password reset lives in this same file rather than a new API file —
// deliberately, to stay within the Vercel Hobby plan's function limit.
// It's the same authentication concern as login/logout anyway.

import { setSessionCookie } from "../lib/auth.js";
import { ROLES } from "../lib/roles.js";
import {
  findUserByUsername,
  findUserByEmail,
  findUserByResetToken,
  updateUserFields,
  verifyPassword,
  hashPassword,
  generateResetToken,
} from "../lib/passwordAuth.js";

const RESET_TOKEN_TTL_MINUTES = 30;

export default async function handler(req, res) {
  // DELETE (or any non-POST) from /api/login = logout
  if (req.method === "DELETE" || (req.method === "POST" && req.body && req.body.action === "logout")) {
    res.setHeader("Set-Cookie", ["gvc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"]);
    return res.status(200).json({ success: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.body && req.body.action === "requestPasswordReset") {
    return handleRequestPasswordReset(req, res);
  }
  if (req.body && req.body.action === "confirmPasswordReset") {
    return handleConfirmPasswordReset(req, res);
  }

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  // Real accounts, checked first — Airtable Users table, hashed
  // passwords, salted per user.
  try {
    const user = await findUserByUsername(username);
    if (user) {
      const f = user.fields;
      if (!f["Password Hash"]) {
        return res.status(401).json({ error: "No password set yet for this account. Use \u201cSet / change password\u201d on the login page." });
      }
      if (!verifyPassword(password, f["Password Hash"], f["Password Salt"])) {
        return res.status(401).json({ error: "Incorrect username or password" });
      }
      const role = f["Role"];
      setSessionCookie(res, username, role);
      return res.status(200).json({ success: true, role, permissions: ROLES[role] });
    }
  } catch (err) {
    console.error("Airtable user lookup failed, falling back to legacy credentials:", err);
  }

  // --- TEMPORARY legacy fallback --------------------------------------
  // Eight role-based credential pairs, one per role in lib/roles.js.
  // Kept only until everyone has a real Users record with a password
  // set — delete this whole block once migration is complete.
  const validPairs = [
    { u: process.env.TECHNICIAN_USERNAME, p: process.env.TECHNICIAN_PASSWORD, role: "technician" },
    { u: process.env.ELECTRICAL_ENGINEER_USERNAME, p: process.env.ELECTRICAL_ENGINEER_PASSWORD, role: "electrical_engineer" },
    { u: process.env.MECHANICAL_ENGINEER_USERNAME, p: process.env.MECHANICAL_ENGINEER_PASSWORD, role: "mechanical_engineer" },
    { u: process.env.ADMIN_USERNAME, p: process.env.ADMIN_PASSWORD, role: "admin" },
    { u: process.env.PROPERTY_MANAGER_USERNAME, p: process.env.PROPERTY_MANAGER_PASSWORD, role: "property_manager" },
    { u: process.env.PROCUREMENT_USERNAME, p: process.env.PROCUREMENT_PASSWORD, role: "procurement" },
    { u: process.env.STOCK_KEEPER_USERNAME, p: process.env.STOCK_KEEPER_PASSWORD, role: "stock_keeper" },
    { u: process.env.BUSINESS_OWNER_USERNAME, p: process.env.BUSINESS_OWNER_PASSWORD, role: "business_owner" },
    { u: process.env.SYSTEM_ADMIN_USERNAME, p: process.env.SYSTEM_ADMIN_PASSWORD, role: "system_admin" },
  ].filter(pair => pair.u && pair.p);

  const matched = validPairs.find(pair => pair.u === username && pair.p === password);

  if (!matched) {
    return res.status(401).json({ error: "Incorrect username or password" });
  }

  setSessionCookie(res, username, matched.role);
  return res.status(200).json({ success: true, role: matched.role, permissions: ROLES[matched.role] });
  // --- end legacy fallback --------------------------------------------
}

// Step 1 of the set/reset flow. Deliberately generic in every response
// — never confirms or denies whether an account is registered, so this
// can't be used to probe for valid accounts. Covers both "I forgot my
// password" and "I'm a freshly migrated account with no password yet"
// with the same link.
//
// Accepts EITHER username or email — username takes priority when both
// are present. Email alone was the original design ("it's what someone
// locked out can actually still access"), but that breaks down whenever
// multiple accounts share one email address — exactly the case for
// Grace's own test accounts (TE/EE/ME/AD/PM/PR/BO/SA), which all point
// at the same inbox by design. Username uniquely identifies exactly one
// account no matter how many share an email, so it's the more reliable
// identifier whenever it's known — email stays supported as a fallback
// for a real person who genuinely doesn't remember their username.
async function handleRequestPasswordReset(req, res) {
  const { username, email } = req.body || {};
  const GENERIC = { success: true, message: "If that account is registered, a link to set your password has been sent to it." };
  if (!username && !email) return res.status(400).json({ error: "Username or email required" });

  try {
    const user = username ? await findUserByUsername(username) : await findUserByEmail(email);
    if (!user) {
      return res.status(200).json(GENERIC);
    }

    const token = generateResetToken();
    const expires = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();
    await updateUserFields(user.id, { "Reset Token": token, "Reset Token Expires": expires });
    await sendResetEmail(user.fields["Email"], user.fields["Display Name"] || user.fields["Username"], token);

    return res.status(200).json(GENERIC);
  } catch (err) {
    console.error("password reset request error:", err);
    return res.status(200).json(GENERIC); // don't leak internal errors through this endpoint either
  }
}

// Step 2 — the emailed link lands here with a token. Single-use:
// clearing the token fields on success means the same link can't be
// replayed.
async function handleConfirmPasswordReset(req, res) {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: "token and newPassword required" });
  if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  try {
    const user = await findUserByResetToken(token);
    if (!user) return res.status(400).json({ error: "This link is invalid or has already been used." });

    const expires = user.fields["Reset Token Expires"];
    if (!expires || new Date(expires).getTime() < Date.now()) {
      return res.status(400).json({ error: "This link has expired \u2014 request a new one." });
    }

    const { hash, salt } = hashPassword(newPassword);
    await updateUserFields(user.id, {
      "Password Hash": hash,
      "Password Salt": salt,
      "Reset Token": "",
      "Reset Token Expires": "",
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("password reset confirm error:", err);
    return res.status(500).json({ error: "Something went wrong \u2014 please try again." });
  }
}

async function sendResetEmail(email, displayName, token) {
  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const appUrl = process.env.APP_URL || "https://fam.gracingventures.com";
  const link = `${appUrl}/set-password.html?token=${token}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
      <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:18px;font-weight:700">Set Your Password</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0 0 16px;color:#1A1A2E;font-size:14px;line-height:1.6">Hi ${displayName}, click below to set a new password for your account. This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes and can only be used once.</p>
        <a href="${link}" style="display:inline-block;background:#1A3566;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Set Password</a>
        <p style="margin:16px 0 0;color:#9CA3AF;font-size:11.5px">If you didn't request this, you can ignore this email \u2014 your password won't change.</p>
      </div>
    </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: [email],
      subject: "Set your password \u2014 GVC Facility Asset Manager",
      html,
    }),
  }).catch(err => console.error("sendResetEmail error:", err));
}
