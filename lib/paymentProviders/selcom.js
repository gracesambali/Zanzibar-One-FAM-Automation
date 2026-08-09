// lib/paymentProviders/selcom.js
//
// Selcom — a real, confirmed Tanzanian payment aggregator, checked
// directly before writing this. Genuinely covers more ground than
// just mobile money: their checkout API (marketed as "Selcom Lipa" /
// "Pay by Link") supports M-Pesa, Airtel Money, and Tigo Pesa/Mixx by
// Yas USSD push, PLUS Visa, Mastercard, Amex, and UnionPay through
// their own hosted checkout page — meaning card payments never touch
// FAM directly, exactly the safe architecture this needed. This is
// the one provider here that can genuinely stand in for several
// channels at once if the direct integrations with the others never
// materialize.
//
// Requires three credentials from Selcom support: a vendor ID, an API
// key, and a secret key. The exact request-signing scheme (Selcom
// signs requests using the secret key, the precise algorithm needs
// confirming against the real developer docs once real credentials
// exist) is implemented here as HMAC-SHA256 over the request body —
// the documented convention for this API family, flagged for
// confirmation before ever running against a live sandbox.

import crypto from "crypto";

const SELCOM_API_ROOT = process.env.SELCOM_API_ROOT || "https://apigw.selcommobile.com/v1";

export function isConfigured() {
  return !!(process.env.SELCOM_VENDOR_ID && process.env.SELCOM_API_KEY && process.env.SELCOM_API_SECRET);
}

function signRequest(payload) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", process.env.SELCOM_API_SECRET).update(body).digest("base64");
  return { body, signature };
}

// method: "mobile" triggers a USSD push to the given phone (covering
// M-Pesa, Airtel Money, and Mixx by Yas all through Selcom's own
// network connections). method: "card" instead returns a checkout URL
// to redirect the tenant to — Selcom's own hosted page, never FAM's.
export async function initiatePayment({ amount, phone, reference, description, method = "mobile" }) {
  if (!amount) return { success: false, error: "amount is required" };
  if (method === "mobile" && !phone) return { success: false, error: "phone is required for mobile money" };

  try {
    const payload = {
      vendor: process.env.SELCOM_VENDOR_ID,
      order_id: reference,
      buyer_phone: phone || undefined,
      amount: String(amount),
      currency: "TZS",
      payment_methods: method === "card" ? "CARD-VISA,CARD-MASTER" : "ALL",
      no_of_items: 1,
      redirect_url: method === "card" ? process.env.SELCOM_REDIRECT_URL : undefined,
    };
    const { body, signature } = signRequest(payload);

    const resp = await fetch(`${SELCOM_API_ROOT}/checkout/create-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `SELCOM ${process.env.SELCOM_API_KEY}`,
        "Digest-Method": "HS256",
        Digest: signature,
      },
      body,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Selcom checkout request failed: ${resp.status} ${errText}`);
    }
    const data = await resp.json();
    return {
      success: true,
      providerReference: data.data?.[0]?.order_id || reference,
      checkoutUrl: method === "card" ? data.data?.[0]?.payment_gateway_url : undefined,
    };
  } catch (err) {
    console.error("Selcom initiatePayment error:", err.message);
    return { success: false, error: err.message };
  }
}

// Selcom's webhook posts a payment confirmation to a registered URL,
// authenticated with a bearer token shared by Selcom in advance
// (confirmed from their own webhook documentation) — not the same
// secret used for signing outbound requests. Exact field names for
// amount/status/reference in the callback body need confirming
// against the real docs once a real webhook has actually been
// received once in the sandbox.
export async function verifyAndParseWebhook(req) {
  const authHeader = req.headers?.authorization || "";
  const expectedToken = process.env.SELCOM_WEBHOOK_TOKEN;
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    console.error("Selcom webhook: missing or invalid bearer token");
    return { valid: false };
  }

  const body = req.body || {};
  if (!body.order_id || !body.amount) {
    console.error("Selcom webhook: missing expected fields — needs confirming against real payload shape");
    return { valid: false };
  }

  return {
    valid: true,
    providerTransactionId: body.transid || body.reference || body.order_id,
    amount: Number(body.amount),
    status: body.result === "SUCCESS" || body.payment_status === "COMPLETED" ? "Completed" : "Failed",
    reference: body.order_id,
  };
}
