// lib/routing.js
//
// Maps a work order's System (and, as a fallback, its asset name) to
// one of the four roles the client actually uses day to day —
// Mechanical, Electrical, Admin, Property Manager — confirmed directly
// with the client, not the original finer-grained per-system routing
// draft. Deliberately simple and explicit: a work order that can't be
// confidently matched returns null rather than guessing wrong.

const SYSTEM_TO_ROLE = {
  "Fire Protection": "Mechanical",
  "HVAC": "Mechanical",
  "Plumbing": "Mechanical",
  "Vertical Transport": "Mechanical",
  "Parking System": "Mechanical",
  "Fire Detection": "Electrical",
  "Electrical": "Electrical",
  "CCTV & Access Control": "Electrical",
  "Controls": "Electrical",
  "Retail Tenant Interface": "Property Manager",
};

export function getAssignedRole(system, assetName) {
  if (system && SYSTEM_TO_ROLE[system]) return SYSTEM_TO_ROLE[system];

  // Fallback for anything without a matched System — keyword check
  // against the asset name for the common non-technical cases.
  const text = (assetName || "").toLowerCase();
  if (text.includes("furniture") || text.includes("desk") || text.includes("chair") || text.includes("fixture")) {
    return "Admin";
  }
  if (text.includes("tenant")) return "Property Manager";

  return null; // genuinely unmatched — leave unassigned rather than guess
}
