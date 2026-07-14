// lib/roles.js
//
// Role -> permission matrix, as discussed and confirmed. Six roles,
// each mapped to its own username/password pair in Vercel env vars
// (see .env.example). Nothing here is guessed at request time — every
// login resolves to exactly one role, and every protected endpoint
// checks against this table.

export const ROLES = {
  technician: {
    label: "Technician",
    viewDashboard: true,
    viewWorkOrders: true,
    closeOwnWorkOrders: true,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: false,
    relocateAssets: false,
    viewFinanceReports: false,
    manageUsers: false,
  },
  engineer: {
    label: "Engineer",
    viewDashboard: true,
    viewWorkOrders: true,
    closeOwnWorkOrders: true,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: true,
    relocateAssets: true,
    viewFinanceReports: false,
    manageUsers: false,
  },
  stock_keeper: {
    label: "Stock Keeper",
    viewDashboard: true,
    viewWorkOrders: false,
    closeOwnWorkOrders: false,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: true, // add/relocate only, not decommission — enforced in UI
    relocateAssets: true,
    viewFinanceReports: false,
    manageUsers: false,
  },
  office_admin: {
    label: "Office Admin",
    viewDashboard: true,
    viewWorkOrders: true, // view only, enforced in UI
    closeOwnWorkOrders: false,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: false,
    relocateAssets: false,
    viewFinanceReports: false,
    manageUsers: false,
  },
  business_owner: {
    label: "Business Owner",
    viewDashboard: true,
    viewWorkOrders: true,
    closeOwnWorkOrders: true,
    viewAssetRegister: true,
    viewCostAndDepreciation: true,
    addOrDecommissionAssets: true,
    relocateAssets: true,
    viewFinanceReports: true,
    manageUsers: true,
  },
  system_admin: {
    label: "System Admin",
    viewDashboard: true,
    viewWorkOrders: true,
    closeOwnWorkOrders: true,
    viewAssetRegister: true,
    viewCostAndDepreciation: true,
    addOrDecommissionAssets: true,
    relocateAssets: true,
    viewFinanceReports: true,
    manageUsers: true,
  },
};

export function can(role, permission) {
  const r = ROLES[role];
  return !!(r && r[permission]);
}
