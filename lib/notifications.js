// lib/notifications.js
//
// One shared way to notify a client's staff by phone, used wherever
// automated alerts go out. Each client (organization) has picked a
// preferred channel — WhatsApp or SMS — via organizations.
// notification_channel. WhatsApp is tried first when that's the
// preference; if it genuinely fails for a given number (not opted in,
// invalid number, template rejected), that one number automatically
// falls back to SMS rather than the person silently never being
// notified. Confirmed directly and agreed: organization-level choice,
// not per-person, with a real fallback, not a strict either/or.
//
// Both channels go through the same Beem account already used for
// SMS today (Beem is itself a WhatsApp Business Solution Provider) —
// same API_KEY/SECRET_KEY, one more product enabled on the same
// account, not a second vendor relationship.
//
// Real, confirmed request shapes (not guessed):
// SMS:      POST https://apisms.beem.africa/v1/send
// WhatsApp: POST https://apichatcore.beem.africa/v1/chatapi (Beem's
//           Moja conversational API)
//
// A genuine open item, flagged rather than silently assumed: WhatsApp
// Business rules require either the recipient having messaged first
// within the last 24 hours, or a Meta-approved message template for
// the first business-initiated message. Whether Beem's Moja "text"
// message_type already handles that compliance step behind the
// scenes, or whether a separate "template" message_type and a
// registered template name are needed instead, can only be confirmed
// once WhatsApp is actually live on the account and a real send is
// attempted — that setup step (registering the WhatsApp Business
// number, submitting a template to Meta for approval if needed)
// happens in Beem's own dashboard, not in this codebase.

function beemAuthHeader() {
  return "Basic " + Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
}

export async function sendSmsBeem(phones, text) {
  if (!phones || phones.length === 0) return { success: true, sent: [] };
  const resp = await fetch("https://apisms.beem.africa/v1/send", {
    method: "POST",
    headers: { Authorization: beemAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      source_addr: process.env.BEEM_SENDER_ID || "INFO",
      schedule_time: "",
      encoding: 0,
      message: text.slice(0, 320),
      recipients: phones.map((phone, i) => ({ recipient_id: i + 1, dest_addr: phone })),
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error("SMS send error:", errText);
    return { success: false, sent: [], failed: phones, error: errText };
  }
  return { success: true, sent: phones };
}

export async function sendWhatsAppBeem(phones, text) {
  if (!phones || phones.length === 0) return { success: true, sent: [], failed: [] };
  const fromNumber = process.env.BEEM_WHATSAPP_FROM;
  if (!fromNumber) {
    console.error("sendWhatsAppBeem: BEEM_WHATSAPP_FROM is not set — cannot send WhatsApp");
    return { success: false, sent: [], failed: phones, error: "BEEM_WHATSAPP_FROM not configured" };
  }

  // One request per recipient — Beem's Moja API is a conversational,
  // one-to-one endpoint (from/to/channel/text), not a bulk-recipients
  // shape like the SMS API above. Each number's success/failure is
  // tracked independently, since a failure for one number (never
  // opted in, invalid) shouldn't affect whether the others go through.
  const sent = [];
  const failed = [];
  await Promise.all(phones.map(async (phone) => {
    try {
      const resp = await fetch("https://apichatcore.beem.africa/v1/chatapi", {
        method: "POST",
        headers: { Authorization: beemAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromNumber,
          to: phone,
          channel: "whatsapp",
          message_type: "text",
          text: text.slice(0, 1000),
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(`WhatsApp send error for ${phone}:`, errText);
        failed.push(phone);
      } else {
        sent.push(phone);
      }
    } catch (err) {
      console.error(`WhatsApp send exception for ${phone}:`, err.message);
      failed.push(phone);
    }
  }));

  return { success: failed.length === 0, sent, failed };
}

// The one function everything else should call — looks up this org's
// real preference, sends accordingly, and silently falls back to SMS
// for any number WhatsApp genuinely failed on, rather than that
// person just never being notified.
export async function sendViaOrgPreferredChannel(organizationId, phones, text) {
  if (!phones || phones.length === 0) return;

  try {
    const { getById } = await import("./postgresClient.js");
    const org = await getById("organizations", organizationId).catch(() => null);
    const channel = org?.notification_channel || "sms";

    if (channel === "whatsapp") {
      const waResult = await sendWhatsAppBeem(phones, text);
      if (waResult.failed && waResult.failed.length > 0) {
        await sendSmsBeem(waResult.failed, text);
      }
    } else {
      await sendSmsBeem(phones, text);
    }
  } catch (err) {
    // Never let a notification-channel lookup failure block the SMS
    // safety net entirely — fall back to SMS directly rather than
    // sending nothing at all.
    console.error("sendViaOrgPreferredChannel error (falling back to SMS):", err.message);
    await sendSmsBeem(phones, text).catch(() => {});
  }
}
