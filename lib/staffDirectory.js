// lib/staffDirectory.js
//
// Maps a logged-in username back to their individual phone and email,
// so notifications can reach "whoever actually requested this" instead
// of a single shared distribution list. Each role's credentials and
// contact info live together in env vars, same pattern as login.js —
// no new database needed for eight people.
//
// Every role is optional. A role with no username/password configured
// is simply skipped — same behavior as login.js already has.

const ROLE_ENV_PREFIXES = {
  technician: "TECHNICIAN",
  electrical_engineer: "ELECTRICAL_ENGINEER",
  mechanical_engineer: "MECHANICAL_ENGINEER",
  admin: "ADMIN",
  property_manager: "PROPERTY_MANAGER",
  procurement: "PROCUREMENT",
  stock_keeper: "STOCK_KEEPER",
  business_owner: "BUSINESS_OWNER",
  system_admin: "SYSTEM_ADMIN",
};

function buildDirectory() {
  const entries = [];
  for (const [role, prefix] of Object.entries(ROLE_ENV_PREFIXES)) {
    const username = process.env[`${prefix}_USERNAME`];
    if (!username) continue; // role not configured — skip, same as login.js
    entries.push({
      role,
      username,
      phone: process.env[`${prefix}_PHONE`] || "",
      email: process.env[`${prefix}_EMAIL`] || "",
    });
  }
  return entries;
}

// Looks up a specific person's contact info by their login username —
// used to notify "the actual requester" rather than a fixed list.
export function getContactForUsername(username) {
  if (!username) return null;
  const directory = buildDirectory();
  return directory.find(e => e.username === username) || null;
}

// Returns contact info for every currently-configured person holding a
// given role — used for the 24-hour escalation, which notifies
// whichever specific person is that work order's routed role.
export function getContactsForRole(role) {
  return buildDirectory().filter(e => e.role === role);
}

export function getAllStaffDirectory() {
  return buildDirectory();
}
