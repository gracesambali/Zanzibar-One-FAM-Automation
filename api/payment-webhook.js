// api/payment-webhook.js
//
// Where each payment provider calls back once a tenant's payment
// actually completes (or fails). Never trusts the incoming body
// directly — verifyAndParseWebhook (provider-specific) confirms the
// callback genuinely came from that provider before anything here
// updates a real payment record.
//
// Provider identified via ?provider=selcom (etc.) in the callback URL
// — each provider gets registered with its own specific URL when the
// real merchant account is set up.

import { verifyAndParseWebhook } from "../lib/paymentProviders/index.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const providerId = req.query.provider;
  if (!providerId) return res.status(400).json({ error: "provider is required" });

  try {
    const result = await verifyAndParseWebhook(providerId, req);
    if (!result.valid) {
      console.error(`payment-webhook: invalid or unverifiable callback from ${providerId}`);
      // 200, not an error status — most providers retry aggressively
      // on non-2xx responses. Once genuinely invalid, retrying it
      // won't become valid; just acknowledge receipt and stop there.
      return res.status(200).json({ received: true, processed: false });
    }

    const { getByColumn, update } = await import("../lib/postgresClient.js");

    // Matches on provider_transaction_id first (the id the provider
    // itself returned when the payment was initiated), falling back
    // to the reference this app generated, since different providers
    // may echo back one or the other in their callback.
    let payment = await getByColumn("unit_payments", "provider_transaction_id", result.providerTransactionId).catch(() => null);
    if (!payment && result.reference) {
      payment = await getByColumn("unit_payments", "payment_reference", result.reference).catch(() => null);
    }
    if (!payment) {
      console.error(`payment-webhook: no matching pending payment found for ${providerId} transaction ${result.providerTransactionId}`);
      return res.status(200).json({ received: true, processed: false });
    }

    await update("unit_payments", payment.id, { provider_status: result.status })
      .catch(err => console.error("payment-webhook: could not update payment status:", err.message));

    return res.status(200).json({ received: true, processed: true });
  } catch (err) {
    console.error(`payment-webhook (${providerId}) error:`, err);
    return res.status(200).json({ received: true, processed: false });
  }
}
