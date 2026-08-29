// lib/staffDirectory.js
//
// Real, per-client staff contacts - confirmed directly as the actual
// fix for a real, serious problem: this used to be a fixed, global
// set of role-based credential pairs in env vars, with no concept of
// which client a person belonged to at all. A reminder meant for one
// client's property manager could reach a completely different
// client's, since there was only ever one shared list. Now backed by
// the real users table, which already carries both role and
// organization_id - every function below is scoped to a real
// organization, not global.

async function queryUsers(whereClause, params) {
  const { query } = await import("./postgresClient.js");
  const result = await query(
    `select username, email, phone, display_name, role, photo_url
     from users
     where active = true and ${whereClause}`,
    params
  );
  return result.rows.map(u => ({
    role: u.role,
    username: u.username,
    phone: u.phone || "",
    email: u.email || "",
    displayName: u.display_name || u.username,
    photoUrl: u.photo_url || "",
  }));
}

// Looks up a specific person's contact info by their login username —
// used to notify "the actual requester" rather than a fixed list.
// Confirmed directly: username is already genuinely unique across the
// entire users table (a real, database-enforced constraint, not just
// a convention), so this lookup is naturally unambiguous without
// needing an organization to disambiguate it.
export async function getContactForUsername(username) {
  if (!username) return null;
  const rows = await queryUsers("username = $1", [username]).catch(() => []);
  return rows[0] || null;
}

// Returns contact info for every currently-active person holding a
// given role within a specific client - used for the 24-hour
// escalation, rent notices, and finance reminders, each of which
// notifies whichever specific people are routed to that role for
// that client specifically, never another client's.
export async function getContactsForRole(role, organizationId) {
  if (!organizationId) return [];
  return queryUsers("role = $1 and organization_id = $2", [role, organizationId]).catch(() => []);
}

export async function getAllStaffDirectory(organizationId) {
  if (!organizationId) return [];
  return queryUsers("organization_id = $1", [organizationId]).catch(() => []);
}
