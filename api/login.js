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

import { setSessionCookie, getSession } from "../lib/auth.js";
import { ROLES, can } from "../lib/roles.js";
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

// Shared by every real action on Client Management - a real,
// attributed entry for every client onboarded, staff account added,
// edited, or removed. Failure here is deliberately non-fatal - the
// real action (creating the account, etc.) has already succeeded by
// the time this is called, and a missing log entry shouldn't undo it.
async function logStaffActivity(organizationId, action, details, performedBy) {
  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("staff_activity_log", { organization_id: organizationId, action, details, performed_by: performedBy });
  } catch (err) {
    console.error("logStaffActivity failed (non-fatal):", err.message);
  }
}

export default async function handler(req, res) {
  // DELETE (or any non-POST) from /api/login = logout
  if (req.method === "DELETE" || (req.method === "POST" && req.body && req.body.action === "logout")) {
    res.setHeader("Set-Cookie", ["gvc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"]);
    return res.status(200).json({ success: true });
  }

  // Confirmed directly: genuinely public, no session at all - the
  // login page itself needs this before anyone has logged in, to show
  // the real organization's name rather than a raw slug or nothing.
  if (req.method === "GET" && req.query.resolveOrgSlug === "true") {
    return handleResolveOrgSlug(req, res);
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
  if (req.body && req.body.action === "listStaffAccounts") {
    return handleListStaffAccounts(req, res);
  }
  if (req.body && req.body.action === "createStaffAccount") {
    return handleCreateStaffAccount(req, res);
  }
  if (req.body && req.body.action === "editStaffAccount") {
    return handleEditStaffAccount(req, res);
  }
  if (req.body && req.body.action === "deactivateStaffAccount") {
    return handleDeactivateStaffAccount(req, res);
  }
  if (req.body && req.body.action === "listStaffActivityLog") {
    return handleListStaffActivityLog(req, res);
  }
  if (req.body && req.body.action === "createClient") {
    return handleCreateClient(req, res);
  }
  if (req.body && req.body.action === "listClients") {
    return handleListClients(req, res);
  }

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  // Real accounts, checked first — Postgres users table, hashed
  // passwords, salted per user.
  try {
    const user = await findUserByUsername(username);
    if (user) {
      if (user.active === false) {
        return res.status(401).json({ error: "This account has been deactivated." });
      }
      if (!user.password_hash) {
        return res.status(401).json({ error: "No password set yet for this account. Use \u201cSet / change password\u201d on the login page." });
      }
      if (!verifyPassword(password, user.password_hash, user.password_salt)) {
        return res.status(401).json({ error: "Incorrect username or password" });
      }
      const role = user.role;
      setSessionCookie(res, username, role, user.organization_id);
      return res.status(200).json({ success: true, role, permissions: ROLES[role] });
    }
  } catch (err) {
    console.error("Database user lookup failed, falling back to legacy credentials:", err);
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

  // Confirmed directly: every legacy env-var login here is existing
  // Master System staff, not a Gracing Ventures (or any future
  // client's) account - defaults to the Master System's own org id.
  setSessionCookie(res, username, matched.role, "73ae9f3b-bbef-4f4a-b3df-3cca81c49063");
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
// The real fix for what today actually was — creating a new account
// used to mean raw SQL followed by fighting the email-reset flow just
// to get a first working password. This sets it directly, right here,
// no email step involved at all for a brand-new account. Reset-by-
// email still exists and stays exactly as it is, for someone who
// genuinely forgets their password later — this only replaces the
// painful first-time setup a new person shouldn't have to go through.
async function handleCreateStaffAccount(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can create staff accounts." });
  }

  const { username, email, displayName, role, password } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: "A username is required." });
  if (!role || !ROLES[role]) return res.status(400).json({ error: "A real, known role is required." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const { hash, salt } = hashPassword(password);
    await insert("users", {
      username: username.trim(), email: email || null, display_name: displayName || username.trim(),
      role, password_hash: hash, password_salt: salt, organization_id: session.org,
    });
    await logStaffActivity(session.org, "Staff Added", `${username.trim()} (${ROLES[role]?.label || role})`, session.u);
    return res.status(200).json({ success: true });
  } catch (err) {
    const message = /unique/i.test(err.message) ? `Username "${username.trim()}" already exists.` : err.message;
    console.error("createStaffAccount error:", err);
    return res.status(500).json({ error: message });
  }
}

// Every real account, for the admin screen — never the password hash
// or salt, which have no reason to ever leave the server at all.
async function handleListStaffAccounts(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can view staff accounts." });
  }

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      "select username, email, phone, display_name, role, password_hash, active from users where organization_id = $1 order by active desc, coalesce(display_name, username) asc",
      [session.org]
    );
    return res.status(200).json({
      accounts: result.rows.map(u => ({
        username: u.username, email: u.email, phone: u.phone, displayName: u.display_name,
        role: u.role, hasPassword: !!u.password_hash, active: u.active,
      })),
    });
  } catch (err) {
    console.error("listStaffAccounts error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// A real soft-delete, matching the same pattern already proven for
// assets and sensors - past activity (edit_log entries, work orders
// they created) stays attributable, and this can be undone if it was
// a mistake. Genuinely rejected at login, not just hidden from this
// list - see the active check in the main login flow above.
async function handleDeactivateStaffAccount(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can remove a staff account." });
  }

  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });
  if (username === session.u) {
    return res.status(400).json({ error: "You can't remove your own account." });
  }

  try {
    const target = await findUserByUsername(username);
    // Confirmed directly: scoped to the caller's own organization
    // only - a client's System Admin or Business Owner can remove
    // their own client's staff, never another client's.
    if (!target || target.organization_id !== session.org) {
      return res.status(404).json({ error: "Account not found." });
    }

    const { update } = await import("../lib/postgresClient.js");
    await update("users", target.id, { active: false, deactivated_by: session.u });
    await logStaffActivity(session.org, "Staff Removed", `${target.username} (${ROLES[target.role]?.label || target.role})`, session.u);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deactivateStaffAccount error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Real edit, not just create-or-remove - display name, email, phone,
// and role can all change after the account exists. Username stays
// fixed, since it's the login identifier; password changes still go
// through the existing reset flow, not this one.
async function handleEditStaffAccount(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can edit a staff account." });
  }

  const { username, displayName, email, phone, role } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });
  if (role && !ROLES[role]) return res.status(400).json({ error: "A real, known role is required." });

  try {
    const target = await findUserByUsername(username);
    // Confirmed directly: same real ownership check as removing a
    // staff account - a client's own admin can only edit their own
    // client's staff, never another client's.
    if (!target || target.organization_id !== session.org) {
      return res.status(404).json({ error: "Account not found." });
    }

    const fields = {};
    const changes = [];
    if (displayName !== undefined && displayName.trim() !== (target.display_name || "")) {
      fields.display_name = displayName.trim(); changes.push(`name: "${target.display_name || ""}" → "${displayName.trim()}"`);
    }
    if (email !== undefined && (email || null) !== (target.email || null)) {
      fields.email = email || null; changes.push(`email: "${target.email || "—"}" → "${email || "—"}"`);
    }
    if (phone !== undefined && (phone || null) !== (target.phone || null)) {
      fields.phone = phone || null; changes.push(`phone: "${target.phone || "—"}" → "${phone || "—"}"`);
    }
    if (role !== undefined && role !== target.role) {
      fields.role = role; changes.push(`role: "${ROLES[target.role]?.label || target.role}" → "${ROLES[role]?.label || role}"`);
    }

    if (Object.keys(fields).length === 0) {
      return res.status(200).json({ success: true, message: "No changes to save." });
    }

    const { update } = await import("../lib/postgresClient.js");
    const result = await update("users", target.id, fields, session.org);
    if (!result) return res.status(404).json({ error: "Account not found." });

    await logStaffActivity(session.org, "Staff Edited", `${target.username} — ${changes.join(", ")}`, session.u);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editStaffAccount error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// A real, attributed record of every client-management action taken
// for this organization - shown beneath the staff table itself.
async function handleListStaffActivityLog(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can view this activity log." });
  }

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      "select action, details, performed_by, created_at from staff_activity_log where organization_id = $1 order by created_at desc limit 50",
      [session.org]
    );
    return res.status(200).json({
      entries: result.rows.map(r => ({ action: r.action, details: r.details || "", performedBy: r.performed_by || "", createdAt: r.created_at })),
    });
  } catch (err) {
    console.error("listStaffActivityLog error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Master System-only - genuinely gated to a session that itself
// belongs to the Master System's own org, not something any
// individual client can do. A brand new client starts with zero
// users, so its own staff couldn't possibly log in to add anyone -
// the first user is created in the very same step as the client
// itself. Matches the same "set a real password directly, no email
// step" pattern already established for createStaffAccount above -
// confirmed as the right approach, not the separate reset-flow
// pattern used for Gracing Ventures' own bootstrap.
const MASTER_ORG_ID = "73ae9f3b-bbef-4f4a-b3df-3cca81c49063";

async function handleResolveOrgSlug(req, res) {
  const slug = req.query.slug;
  try {
    const { getByColumn, getById } = await import("../lib/postgresClient.js");
    // No slug at all resolves to the Master System itself - the
    // real, existing default for a bare login with no client
    // identified in the URL.
    const org = slug && slug !== "master"
      ? await getByColumn("organizations", "slug", slug).catch(() => null)
      : await getById("organizations", MASTER_ORG_ID).catch(() => null);
    if (!org) return res.status(404).json({ error: "Unknown organization." });
    return res.status(200).json({ name: org.name });
  } catch (err) {
    console.error("resolveOrgSlug error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleCreateClient(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  if (session.org !== MASTER_ORG_ID) {
    return res.status(403).json({ error: "Only the Master System can create a new client." });
  }
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can create a new client." });
  }

  const { clientName, username, email, displayName, role, password } = req.body || {};
  if (!clientName || !clientName.trim()) return res.status(400).json({ error: "A real client name is required." });
  if (!username || !username.trim()) return res.status(400).json({ error: "The first user needs a real username." });
  if (!["business_owner", "system_admin"].includes(role)) {
    return res.status(400).json({ error: "The first user must be Business Owner or System Admin, so they can add everyone else." });
  }
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const { insert, getByColumn } = await import("../lib/postgresClient.js");

    // A real, readable slug derived from the client name, not the raw
    // uuid - confirmed directly as the point of this, so the login
    // link itself is something worth handing to a real person. Falls
    // back to appending a number on a genuine collision (two clients
    // with the same or very similar name).
    let baseSlug = clientName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "client";
    let slug = baseSlug;
    let suffix = 2;
    while (await getByColumn("organizations", "slug", slug).catch(() => null)) {
      slug = `${baseSlug}${suffix}`;
      suffix++;
    }

    const newOrg = await insert("organizations", { name: clientName.trim(), slug });
    const { hash, salt } = hashPassword(password);
    const newUser = await insert("users", {
      username: username.trim(), email: email || null, display_name: displayName || username.trim(),
      role, password_hash: hash, password_salt: salt, organization_id: newOrg.id,
    });
    await logStaffActivity(MASTER_ORG_ID, "Client Onboarded", `${newOrg.name} — first user: ${username.trim()} (${ROLES[role]?.label || role})`, session.u);
    await logStaffActivity(newOrg.id, "Client Onboarded", `Account created by the Master System`, session.u);
    return res.status(200).json({
      success: true,
      client: { id: newOrg.id, name: newOrg.name, slug: newOrg.slug },
      firstUser: { username: newUser.username, role: newUser.role },
    });
  } catch (err) {
    const message = /unique/i.test(err.message) ? `Username "${username.trim()}" already exists.` : err.message;
    console.error("createClient error:", err);
    return res.status(500).json({ error: message });
  }
}

async function handleListClients(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in." });
  if (session.org !== MASTER_ORG_ID) {
    return res.status(403).json({ error: "Only the Master System can view the client list." });
  }
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can view the client list." });
  }

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select o.id, o.name, o.slug, o.created_at, count(u.id) filter (where u.active) as active_user_count
       from organizations o
       left join users u on u.organization_id = o.id
       group by o.id, o.name, o.slug, o.created_at
       order by o.created_at desc`
    );
    return res.status(200).json({
      clients: result.rows.map(r => ({ id: r.id, name: r.name, slug: r.slug, createdAt: r.created_at, activeUserCount: Number(r.active_user_count) })),
    });
  } catch (err) {
    console.error("listClients error:", err);
    return res.status(500).json({ error: err.message });
  }
}

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
    await updateUserFields(user.id, { reset_token: token, reset_token_expires: expires });
    await sendResetEmail(user.email, user.display_name || user.username, token);

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

    const expires = user.reset_token_expires;
    if (!expires || new Date(expires).getTime() < Date.now()) {
      return res.status(400).json({ error: "This link has expired \u2014 request a new one." });
    }

    const { hash, salt } = hashPassword(newPassword);
    await updateUserFields(user.id, {
      password_hash: hash,
      password_salt: salt,
      // null, not an empty string — findUserByResetToken's query
      // relies on SQL's "NULL never equals anything" behavior so a
      // cleared token can never accidentally match a lookup again.
      reset_token: null,
      reset_token_expires: null,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("password reset confirm error:", err);
    return res.status(500).json({ error: "Something went wrong \u2014 please try again." });
  }
}

async function sendResetEmail(email, displayName, token) {
  const fromName = process.env.ALERT_FROM_NAME || "Facility Asset Management System";
  const appUrl = process.env.APP_URL || "https://fam.gracingventures.com";
  const link = `${appUrl}/set-password?token=${token}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
      <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:18px;font-weight:700">Set Your Password</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0 0 12px;color:#1A1A2E;font-size:14px;line-height:1.6">Dear ${displayName},</p>
        <p style="margin:0 0 16px;color:#1A1A2E;font-size:14px;line-height:1.6">Click below to set a new password for your account. This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes and can only be used once.</p>
        <a href="${link}" style="display:inline-block;background:#1A3566;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Set Password</a>
        <p style="margin:16px 0 0;color:#9CA3AF;font-size:11.5px">If you didn't request this, you can ignore this email \u2014 your password won't change.</p>
      </div>
    </div>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: [email],
      subject: "Set your password \u2014 GVC Facility Asset Manager",
      html,
    }),
  }).catch(err => {
    console.error("sendResetEmail network error:", err);
    return null;
  });

  // fetch() only rejects on a true network failure — a bad API key,
  // an unverified sending domain, or a rate limit all come back as a
  // normal (non-2xx) response, which the .catch() above would never
  // see. Without this check, that whole category of failure is
  // completely silent: the person gets told "success" and never
  // receives anything, with no error anywhere to find.
  if (resp && !resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error("sendResetEmail failed:", resp.status, body);
  }
}
