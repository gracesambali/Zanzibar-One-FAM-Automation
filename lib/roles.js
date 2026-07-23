// lib/roles.js
//
// Role -> permission matrix. Eight roles, each mapped to its own
// username/password pair in Vercel env vars, plus individual phone and
// email for per-person notifications. Nothing here is guessed at
// request time — every login resolves to exactly one role, and every
// protected endpoint checks against this table.
//
// Electrical Engineer and Mechanical Engineer carry IDENTICAL
// permissions on purpose — confirmed the split is for routing and
// notification only, not access control. Property Manager mirrors
// Admin for the same reason.

export const ROLES = {
  technician: {
    label: "Technician",
    viewDashboard: true,
    viewWorkOrders: true,
    requestProcurement: true,
    approveProcurement: false,
    fulfillProcurement: false,
    markReadyForReview: true,       // finishes work, sends it for sign-off — cannot close directly
    reviewWorkOrderClosure: false,  // cannot approve/reject the finished work
    enterWorkOrderCost: false,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: false,
    relocateAssets: false,
    viewFinanceReports: false,
    viewStaffPerformance: false,
    manageUsers: false,
  },
  electrical_engineer: {
    label: "Electrical Engineer",
    viewDashboard: true,
    viewWorkOrders: true,
    requestProcurement: true,
    approveProcurement: true,
    fulfillProcurement: false,      // approves, does not execute payment
    markReadyForReview: true,
    reviewWorkOrderClosure: true,   // one of the four routed roles that can sign off closure
    enterWorkOrderCost: true,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: true,
    relocateAssets: true,
    viewFinanceReports: false,
    viewStaffPerformance: false,
    manageUsers: false,
  },
  mechanical_engineer: {
    label: "Mechanical Engineer",
    viewDashboard: true,
    viewWorkOrders: true,
    requestProcurement: true,
    approveProcurement: true,
    fulfillProcurement: false,
    markReadyForReview: true,
    reviewWorkOrderClosure: true,
    enterWorkOrderCost: true,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: true,
    relocateAssets: true,
    viewFinanceReports: false,
    viewStaffPerformance: false,
    manageUsers: false,
  },
  admin: {
    label: "Admin",
    viewDashboard: true,
    viewWorkOrders: true,
    requestProcurement: true,
    approveProcurement: false,      // routes/requests, but does not approve cost
    fulfillProcurement: false,
    markReadyForReview: true,
    reviewWorkOrderClosure: true,   // one of the four routed roles that can sign off closure
    enterWorkOrderCost: false,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: false,
    relocateAssets: false,
    viewFinanceReports: false,
    viewStaffPerformance: false,
    manageUsers: false,
  },
  property_manager: {
    label: "Property Manager",
    // Full participant, same permissions as Admin — confirmed.
    viewDashboard: true,
    viewWorkOrders: true,
    requestProcurement: true,
    approveProcurement: false,
    fulfillProcurement: false,
    markReadyForReview: true,
    reviewWorkOrderClosure: true,
    enterWorkOrderCost: false,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: false,
    relocateAssets: false,
    viewFinanceReports: false,
    viewStaffPerformance: false,
    manageUsers: false,
  },
  procurement: {
    label: "Procurement",
    // Cannot approve or reject — only Engineer decides yes/no. Once
    // approved, Procurement executes the actual payment and marks it
    // fulfilled. That is its entire, distinct job.
    viewDashboard: true,
    viewWorkOrders: true,
    requestProcurement: false,
    approveProcurement: false,
    fulfillProcurement: true,
    markReadyForReview: false,
    reviewWorkOrderClosure: false,
    enterWorkOrderCost: false,
    viewAssetRegister: false,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: false,
    relocateAssets: false,
    viewFinanceReports: false,
    viewStaffPerformance: false,
    manageUsers: false,
  },
  stock_keeper: {
    label: "Stock Keeper",
    viewDashboard: true,
    viewWorkOrders: false,
    requestProcurement: false,
    approveProcurement: false,
    fulfillProcurement: false,
    markReadyForReview: false,
    reviewWorkOrderClosure: false,
    enterWorkOrderCost: false,
    viewAssetRegister: true,
    viewCostAndDepreciation: false,
    addOrDecommissionAssets: true,
    relocateAssets: true,
    viewFinanceReports: false,
    viewStaffPerformance: false,
    manageUsers: false,
  },
  business_owner: {
    label: "Business Owner",
    viewDashboard: true,
    viewWorkOrders: true,
    requestProcurement: true,
    approveProcurement: true,
    fulfillProcurement: true,
    markReadyForReview: true,
    reviewWorkOrderClosure: true,
    enterWorkOrderCost: true,
    viewAssetRegister: true,
    viewCostAndDepreciation: true,
    addOrDecommissionAssets: true,
    relocateAssets: true,
    viewFinanceReports: true,
    viewStaffPerformance: true,
    manageUsers: true,
  },
  system_admin: {
    label: "System Admin",
    viewDashboard: true,
    viewWorkOrders: true,
    requestProcurement: true,
    approveProcurement: true,
    fulfillProcurement: true,
    markReadyForReview: true,
    reviewWorkOrderClosure: true,
    enterWorkOrderCost: true,
    viewAssetRegister: true,
    viewCostAndDepreciation: true,
    addOrDecommissionAssets: true,
    relocateAssets: true,
    viewFinanceReports: true,
    viewStaffPerformance: true,
    manageUsers: true,
  },
};

export const ROUTED_ROLES = ["electrical_engineer", "mechanical_engineer", "admin", "property_manager"];

export function can(role, permission) {
  const r = ROLES[role];
  return !!(r && r[permission]);
}

export function isRoutedRole(role) {
  return ROUTED_ROLES.includes(role);
}
