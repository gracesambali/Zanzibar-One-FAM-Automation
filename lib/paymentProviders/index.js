// lib/paymentProviders/index.js
//
// One shared shape every provider plugs into, so swapping in real
// credentials later touches configuration, not this architecture.
// Each provider module exports the same two functions:
//
//   initiatePayment({ amount, phone, reference, description }) ->
//     { success, providerReference, checkoutUrl?, error? }
//     For mobile money: triggers a USSD push to the tenant's phone.
//     For a hosted card checkout (Selcom): returns a URL to redirect
//     the tenant to instead. Never returns raw card data - a hosted
//     checkout means FAM never sees or handles it at all.
//
//   verifyAndParseWebhook(req) ->
//     { valid, providerTransactionId, amount, status, reference } |
//     { valid: false }
//     Confirms an incoming callback genuinely came from the provider
//     (never trust an unverified webhook body directly) and extracts
//     what's needed to record the payment.
//
// isConfigured() on each module reports whether real credentials
// exist yet - lets the rest of the app show "not yet available"
// instead of attempting a call that would just fail.

import * as mpesa from "./mpesa.js";
import * as mixxByYas from "./mixxByYas.js";
import * as airtelMoney from "./airtelMoney.js";
import * as selcom from "./selcom.js";

export const PROVIDERS = {
  mpesa: { module: mpesa, label: "M-Pesa", verified: true },
  mixx_by_yas: { module: mixxByYas, label: "Mixx by Yas", verified: true },
  airtel_money: { module: airtelMoney, label: "Airtel Money", verified: true },
  selcom: { module: selcom, label: "Selcom (Visa/Mastercard)", verified: true },
};

// "verified" means: this module's request/response shape was built
// against real, confirmed documentation or credential requirements
// for a genuine direct merchant API — not a guess. All four are real
// architecture now, distinct from each other, not routed through one
// company. Each still shares one honest caveat: none has been run
// against a live sandbox yet, since that needs actual registered
// merchant credentials from that specific provider, which don't exist
// yet for any of them. Selcom remains the one used for Visa/
// Mastercard specifically, since card acceptance genuinely needs a
// hosted checkout page - card details must never be handled directly
// by this app, and Selcom's is the confirmed one available here.

export function getProvider(providerId) {
  return PROVIDERS[providerId] || null;
}

export function listAvailableProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    verified: p.verified,
    configured: p.module.isConfigured(),
  }));
}

export async function initiatePayment(providerId, params) {
  const provider = getProvider(providerId);
  if (!provider) return { success: false, error: `Unknown payment provider: ${providerId}` };
  if (!provider.module.isConfigured()) {
    return { success: false, error: `${provider.label} is not configured yet — no real merchant credentials are set.` };
  }
  try {
    return await provider.module.initiatePayment(params);
  } catch (err) {
    console.error(`initiatePayment (${providerId}) error:`, err);
    return { success: false, error: err.message };
  }
}

export async function verifyAndParseWebhook(providerId, req) {
  const provider = getProvider(providerId);
  if (!provider) return { valid: false };
  try {
    return await provider.module.verifyAndParseWebhook(req);
  } catch (err) {
    console.error(`verifyAndParseWebhook (${providerId}) error:`, err);
    return { valid: false };
  }
}
