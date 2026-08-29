// api/manage-users.js
//
// Two real, related concerns, confirmed directly as one piece of work
// rather than two: onboarding a brand new client without days of
// manual coding, and each client's own System Admin or Business
// Owner having a real way to add and remove their own staff.
//
// Creating a client is Master System-only - genuinely gated to a
// logged-in session that itself belongs to the Master System, not
// something any individual client can do. A brand new client starts
// with zero users, so its own System Admin/Business Owner couldn't
// possibly log in to add anyone - the first user has to be created in
// the same step as the client itself, by the Master System side.
//
// Adding/removing users is scoped to the caller's own organization
// only - a client's System Admin or Business Owner can manage their
// own client's staff, never another client's, even if they somehow
// knew another user's id.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { can } from "../lib/roles.js";

const MASTER_ORG_ID = "73ae9f3b-bbef-4f4a-b3df-3cca81c49063";
const VALID_ROLES = [
  "technician", "electrical_engineer", "mechanical_engineer", "admin",
  "property_manager", "procurement", "pharmacy", "stock_keeper",
  "business_owner", "system_admin",
];

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  setSessionCookie(res, session.u, session.r, session.org);

  if (req.method === "GET") {
    if (req.query.clients === "true") return handleListClients(req, res, session);
    return handleListUsers(req, res, session);
  }

  if (req.method === "POST") {
    const action = (req.body && req.body.action) || "addUser";
    if (action === "createClient") return handleCreateClient(req, res, session);
    if (action === "addUser") return handleAddUser(req, res, session);
    return res.status(400).json({ error: "Unknown action" });
  }

  if (req.method === "PATCH") {
    const action = (req.body && req.body.action) || "removeUser";
    if (action === "removeUser") return handleRemoveUser(req, res, session);
    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// ---------------------------------------------------------------------
// Master System-only: create a brand new client, with its first real
// user in the same step - the only way a client can ever be bootstrapped,
// since it starts with no users of its own to log in and add one.
// ---------------------------------------------------------------------

async function handleCreateClient(req, res, session) {
  if (session.org !== MASTER_ORG_ID) {
    return res.status(403).json({ error: "Only the Master System can create a new client." });
  }
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can create a new client." });
  }

  const { clientName, firstUser } = req.body || {};
  if (!clientName || !clientName.trim()) {
    return res.status(400).json({ error: "A real client name is required." });
  }
  const { username, email, displayName, role } = firstUser || {};
  if (!username || !username.trim()) {
    return res.status(400).json({ error: "The first user needs a real username." });
  }
  if (!email || !email.trim()) {
    return res.status(400).json({ error: "The first user needs a real email, so they can set their own password." });
  }
  if (!["business_owner", "system_admin"].includes(role)) {
    return res.status(400).json({ error: "The first user must be Business Owner or System Admin, so they can add everyone else." });
  }

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const { findUserByUsername, findUserByEmail } = await import("../lib/passwordAuth.js");

    const existingUsername = await findUserByUsername(username.trim());
    if (existingUsername) return res.status(400).json({ error: "That username is already taken." });
    const existingEmail = await findUserByEmail(email.trim());
    if (existingEmail) return res.status(400).json({ error: "That email is already in use." });

    const newOrg = await insert("organizations", { name: clientName.trim() });

    // No password set here - same, already-proven pattern used for
    // Gracing Ventures' own first account: the person sets their own
    // real password through the existing request-password-reset flow,
    // so a real password is never something this system handles
    // directly.
    const newUser = await insert("users", {
      username: username.trim(),
      email: email.trim(),
      display_name: displayName ? displayName.trim() : username.trim(),
      role,
      organization_id: newOrg.id,
    });

    return res.status(200).json({
      success: true,
      client: { id: newOrg.id, name: newOrg.name },
      firstUser: { id: newUser.id, username: newUser.username, role: newUser.role },
    });
  } catch (err) {
    console.error("handleCreateClient error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleListClients(req, res, session) {
  if (session.org !== MASTER_ORG_ID) {
    return res.status(403).json({ error: "Only the Master System can view the client list." });
  }
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can view the client list." });
  }

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select o.id, o.name, o.created_at, count(u.id) filter (where u.active) as active_user_count
       from organizations o
       left join users u on u.organization_id = o.id
       group by o.id, o.name, o.created_at
       order by o.created_at desc`
    );
    return res.status(200).json({
      clients: result.rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, activeUserCount: Number(r.active_user_count) })),
    });
  } catch (err) {
    console.error("handleListClients error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// Per-client user management - scoped to the caller's own organization
// only, confirmed directly: a client's System Admin or Business Owner
// manages their own client's staff, never another client's.
// ---------------------------------------------------------------------

async function handleListUsers(req, res, session) {
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can view the staff list." });
  }

  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select id, username, email, display_name, role, active
       from users
       where organization_id = $1
       order by active desc, coalesce(display_name, username) asc`,
      [session.org]
    );
    return res.status(200).json({
      users: result.rows.map(r => ({
        id: r.id, username: r.username, email: r.email || "",
        displayName: r.display_name || r.username, role: r.role, active: r.active,
      })),
    });
  } catch (err) {
    console.error("handleListUsers error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddUser(req, res, session) {
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can add a new user." });
  }

  const { username, email, displayName, role } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: "A real username is required." });
  if (!email || !email.trim()) return res.status(400).json({ error: "A real email is required, so they can set their own password." });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: "Choose a real role." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const { findUserByUsername, findUserByEmail } = await import("../lib/passwordAuth.js");

    const existingUsername = await findUserByUsername(username.trim());
    if (existingUsername) return res.status(400).json({ error: "That username is already taken." });
    const existingEmail = await findUserByEmail(email.trim());
    if (existingEmail) return res.status(400).json({ error: "That email is already in use." });

    const created = await insert("users", {
      username: username.trim(),
      email: email.trim(),
      display_name: displayName ? displayName.trim() : username.trim(),
      role,
      organization_id: session.org,
    });

    return res.status(200).json({ success: true, user: { id: created.id, username: created.username, role: created.role } });
  } catch (err) {
    console.error("handleAddUser error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleRemoveUser(req, res, session) {
  if (!can(session.r, "manageUsers")) {
    return res.status(403).json({ error: "Only System Admin or Business Owner can remove a user." });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const { update, getById } = await import("../lib/postgresClient.js");
    const target = await getById("users", userId).catch(() => null);
    if (!target || target.organization_id !== session.org) {
      return res.status(404).json({ error: "User not found." });
    }
    if (target.username === session.u) {
      return res.status(400).json({ error: "You can't remove your own account." });
    }

    const result = await update("users", userId, { active: false, deactivated_by: session.u }, session.org);
    if (!result) return res.status(404).json({ error: "User not found." });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleRemoveUser error:", err);
    return res.status(500).json({ error: err.message });
  }
}
