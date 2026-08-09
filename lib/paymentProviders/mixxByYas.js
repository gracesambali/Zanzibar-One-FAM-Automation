// lib/paymentProviders/mixxByYas.js
//
// Mixx by Yas (formerly Tigo Pesa) — a real, direct Partner
// Integration API confirmed to exist (referenced consistently across
// independent developer packages and a specific "Tigo Partner
// Integration API Details" reference document), obtained by
// contacting Tigo/Yas Tech Support directly rather than a public
// self-serve developer portal. The confirmed credential set: an API
// Key, a Secret Key, a Merchant MSISDN, a Merchant PIN, an Account
// ID, and three distinct URLs (AccessToken, Payment, and Validate
// MFS) — all specific to the merchant account Yas provisions, not
// guessed here.
//
// One honest gap: the exact request/response field names inside the
// AccessToken and Payment calls follow the documented flow shape
// (get a token, then submit a payment referencing the merchant
// account) but haven't been run against a live sandbox — that needs
// the actual URLs and credentials Yas provides once a real merchant
// account exists, which vary in the exact endpoint paths by merchant
// account according to what was found.

export function isConfigured() {
  return !!(process.env.MIXX_API_KEY && process.env.MIXX_SECRET_KEY && process.env.MIXX_ACCOUNT_ID
    && process.env.MIXX_ACCESS_TOKEN_URL && process.env.MIXX_PAYMENT_URL);
}

async function getAccessToken() {
  const resp = await fetch(process.env.MIXX_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      apiKey: process.env.MIXX_API_KEY,
      apiSecret: process.env.MIXX_SECRET_KEY,
      grant_type: "client_credentials",
    }).toString(),
  });
  if (!resp.ok) throw new Error(`Mixx by Yas auth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error("Mixx by Yas did not return an access token");
  return data.access_token;
}

export async function initiatePayment({ amount, phone, reference, description }) {
  if (!amount || !phone) return { success: false, error: "amount and phone are required" };

  try {
    const accessToken = await getAccessToken();
    const resp = await fetch(process.env.MIXX_PAYMENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: process.env.MIXX_ACCOUNT_ID,
        merchantMsisdn: process.env.MIXX_MERCHANT_MSISDN,
        customerMsisdn: phone,
        amount: String(amount),
        currency: "TZS",
        referenceId: reference,
        remarks: description || "Rent payment",
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Mixx by Yas payment request failed: ${resp.status} ${errText}`);
    }
    const data = await resp.json();
    return {
      success: true,
      providerReference: data.transactionId || data.referenceId || reference,
    };
  } catch (err) {
    console.error("Mixx by Yas initiatePayment error:", err.message);
    return { success: false, error: err.message };
  }
}

// Confirmation for this API family is documented as a server-to-
// server callback to a URL registered with Yas at merchant setup time
// — the exact payload field names need confirming once that URL is
// actually registered and a real test payment has been run through
// it.
export async function verifyAndParseWebhook(req) {
  const body = req.body || {};
  if (!body.referenceId && !body.transactionId) {
    console.error("Mixx by Yas webhook: missing expected fields — needs confirming against real payload shape");
    return { valid: false };
  }
  return {
    valid: true,
    providerTransactionId: body.transactionId || body.referenceId,
    amount: Number(body.amount || 0),
    status: body.status === "SUCCESS" || body.resultCode === "0" ? "Completed" : "Failed",
    reference: body.referenceId,
  };
}
