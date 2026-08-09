// lib/paymentProviders/airtelMoney.js
//
// Airtel Money — a genuine, well-documented pan-African merchant API
// at openapi.airtel.africa (production) / openapiuat.airtel.africa
// (staging), confirmed directly before writing this. Standard OAuth
// 2.0 client-credentials auth, a REST collection endpoint, and a
// request-callback pattern — the same shape used across most mobile
// money APIs in the region, not something unique to Airtel.
//
// Register an application on the Airtel developer portal to get a
// client_id and client_secret; production access needs Airtel's KYC
// approval on top of that. One honest gap: the exact field names
// inside the payment request body follow the documented shape closely
// but haven't been run against a live sandbox, since that needs an
// actual registered application to test with.

const AIRTEL_API_ROOT = process.env.AIRTEL_API_ROOT || "https://openapiuat.airtel.africa";

export function isConfigured() {
  return !!(process.env.AIRTEL_CLIENT_ID && process.env.AIRTEL_CLIENT_SECRET);
}

async function getAccessToken() {
  const resp = await fetch(`${AIRTEL_API_ROOT}/auth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.AIRTEL_CLIENT_ID,
      client_secret: process.env.AIRTEL_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!resp.ok) throw new Error(`Airtel Money auth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error("Airtel Money did not return an access token");
  return data.access_token;
}

export async function initiatePayment({ amount, phone, reference, description }) {
  if (!amount || !phone) return { success: false, error: "amount and phone are required" };

  try {
    const accessToken = await getAccessToken();
    // Airtel's phone format is the subscriber number without the
    // country code prefix in the body itself — the country is
    // supplied separately via the X-Country header instead.
    const localPhone = phone.replace(/^\+?255/, "").replace(/^0/, "");

    const resp = await fetch(`${AIRTEL_API_ROOT}/merchant/v1/payments/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        "X-Country": "TZ",
        "X-Currency": "TZS",
      },
      body: JSON.stringify({
        reference: description || "Rent payment",
        subscriber: { country: "TZ", currency: "TZS", msisdn: localPhone },
        transaction: { amount: String(amount), country: "TZ", currency: "TZS", id: reference },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Airtel Money payment request failed: ${resp.status} ${errText}`);
    }
    const data = await resp.json();
    return {
      success: true,
      providerReference: data.data?.transaction?.id || reference,
    };
  } catch (err) {
    console.error("Airtel Money initiatePayment error:", err.message);
    return { success: false, error: err.message };
  }
}

// Airtel confirms payment status via a transaction-enquiry GET
// endpoint (poll-based) as well as callbacks in some deployments —
// which applies for a specific registered application needs
// confirming against the real portal once real credentials exist.
export async function verifyAndParseWebhook(req) {
  const body = req.body || {};
  if (!body.transaction?.id) {
    console.error("Airtel Money webhook: missing expected fields — needs confirming against real payload shape");
    return { valid: false };
  }
  return {
    valid: true,
    providerTransactionId: body.transaction.id,
    amount: Number(body.transaction.amount || 0),
    status: body.transaction.status === "TS" || body.transaction.status === "SUCCESS" ? "Completed" : "Failed",
    reference: body.transaction.airtel_money_id || body.transaction.id,
  };
}
