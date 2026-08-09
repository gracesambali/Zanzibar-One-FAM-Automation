// lib/paymentProviders/airtelMoney.js
//
// Airtel Money Tanzania — same honest situation as Mixx by Yas. No
// clear, direct, publicly-documented merchant API was confirmed for
// direct integration; real integrations found go through an
// aggregator instead. This module exists so the shared interface has
// somewhere to plug into once this is genuinely confirmed, rather
// than shipping a guessed API shape that might be quietly wrong.

export function isConfigured() {
  return false; // never true until this is genuinely confirmed and built
}

export async function initiatePayment() {
  return { success: false, error: "Airtel Money is not yet connected — its API needs confirming with a real merchant account before this can work." };
}

export async function verifyAndParseWebhook() {
  return { valid: false };
}
