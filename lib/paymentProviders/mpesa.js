// lib/paymentProviders/mpesa.js
//
// M-Pesa Tanzania (Vodacom) — via the M-Pesa Africa OpenAPI
// (openapiportal.m-pesa.com), the same platform used across Tanzania,
// Ghana, Lesotho, and DRC. Deliberately NOT Kenya's Safaricom Daraja
// API — confirmed directly these are genuinely different systems
// before writing any of this, rather than assuming they're
// interchangeable because both are called "M-Pesa".
//
// The real flow, confirmed against public documentation: encrypt the
// Application Key using the public key M-Pesa provides, exchange the
// encrypted key for a short-lived Session Key, then use that Session
// Key to authorize a C2B (Customer to Business) transaction request —
// which triggers a USSD prompt on the customer's phone.
//
// One honest gap: the exact JSON field names for the session and C2B
// request bodies need confirming against the real developer portal
// once real credentials exist — this implementation follows the
// documented flow SHAPE correctly, but hasn't been tested against a
// live sandbox, since that requires an actual registered application.

import crypto from "crypto";

const MPESA_API_ROOT = process.env.MPESA_API_ROOT || "https://openapi.m-pesa.com/sandbox/ipg/v2/vodacomTZN";

export function isConfigured() {
  return !!(process.env.MPESA_API_KEY && process.env.MPESA_PUBLIC_KEY && process.env.MPESA_SERVICE_PROVIDER_CODE);
}

// Encrypts the Application Key with M-Pesa's provided public key —
// required before every session request. Uses Node's built-in
// crypto, no new dependency. The exact padding scheme (PKCS1 vs OAEP)
// needs confirming against the real portal; PKCS1 is used here as the
// documented convention for this API family, but flagged for
// confirmation before ever running against a live sandbox.
function encryptApplicationKey(publicKeyPem) {
  return crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(process.env.MPESA_API_KEY)
  ).toString("base64");
}

async function getSessionKey() {
  const encryptedKey = encryptApplicationKey(process.env.MPESA_PUBLIC_KEY);
  const resp = await fetch(`${MPESA_API_ROOT}/getSession/`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${encryptedKey}`,
      Origin: "*",
    },
  });
  if (!resp.ok) throw new Error(`M-Pesa getSession failed: ${resp.status}`);
  const data = await resp.json();
  // output_SessionID is the documented field name for this API family.
  if (!data.output_SessionID) throw new Error("M-Pesa did not return a session ID");
  return data.output_SessionID;
}

export async function initiatePayment({ amount, phone, reference, description }) {
  if (!amount || !phone) return { success: false, error: "amount and phone are required" };

  try {
    const sessionKey = await getSessionKey();
    const resp = await fetch(`${MPESA_API_ROOT}/c2bPayment/singleStage/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionKey}`,
        "Content-Type": "application/json",
        Origin: "*",
      },
      body: JSON.stringify({
        input_Amount: String(amount),
        input_Country: "TZN",
        input_Currency: "TZS",
        input_CustomerMSISDN: phone,
        input_ServiceProviderCode: process.env.MPESA_SERVICE_PROVIDER_CODE,
        input_TransactionReference: reference,
        input_ThirdPartyConversationID: reference,
        input_PurchasedItemsDesc: description || "Rent payment",
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`M-Pesa C2B request failed: ${resp.status} ${errText}`);
    }
    const data = await resp.json();
    return {
      success: true,
      providerReference: data.output_TransactionID || data.output_ConversationID || reference,
    };
  } catch (err) {
    console.error("M-Pesa initiatePayment error:", err.message);
    return { success: false, error: err.message };
  }
}

// M-Pesa's OpenAPI confirms transactions via a synchronous response
// to the C2B request itself in some deployments, and via a separate
// result-notification callback in others — which one applies needs
// confirming against the real portal for the specific registered
// application. This function is a placeholder matching the shared
// interface shape until that's confirmed.
export async function verifyAndParseWebhook(req) {
  console.error("mpesa.verifyAndParseWebhook: not yet confirmed against real M-Pesa documentation");
  return { valid: false };
}
