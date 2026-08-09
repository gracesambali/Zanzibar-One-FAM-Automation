// lib/paymentProviders/mixxByYas.js
//
// Mixx by Yas (formerly Tigo Pesa) — deliberately NOT built with a
// guessed API shape. Checked directly: unlike M-Pesa and Selcom, no
// clear, direct, publicly-documented merchant API was found for this
// one. Every real integration found goes through a third-party
// aggregator (ClickPesa, Unlimit, MalipoPay) rather than connecting
// to Yas directly — meaning a confident-looking direct integration
// here would very likely be wrong.
//
// This module exists so the shared interface has somewhere to plug
// into once this is actually confirmed — either a direct API Yas
// provides once you have a real merchant relationship with them, or
// (more likely, given what was found) routed through Selcom or
// another aggregator instead, which may make this file unnecessary
// rather than something to fill in.

export function isConfigured() {
  return false; // never true until this is genuinely confirmed and built
}

export async function initiatePayment() {
  return { success: false, error: "Mixx by Yas is not yet connected — its API needs confirming with a real merchant account before this can work." };
}

export async function verifyAndParseWebhook() {
  return { valid: false };
}
