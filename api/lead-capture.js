// api/lead-capture.js
//
// Captures an email from the landing page's checklist offer — the
// lighter, middle-of-funnel option for cold ad traffic that isn't
// ready for a direct WhatsApp conversation yet. Called cross-origin
// from grace.gracingventures.com, so this explicitly allows that
// origin rather than relying on same-origin defaults, unlike every
// other endpoint in this app which is only ever called from
// fam.gracingventures.com itself.
//
// Sends a real-time email notification via Resend (the same service
// already configured and working for every other notification in
// this app) and stores the lead for a running list — the actual
// checklist document isn't auto-sent by this endpoint; that's still
// a manual follow-up for now, deliberately not assumed to be
// automated without being asked for.

const ALLOWED_ORIGIN = "https://grace.gracingventures.com";

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "A valid email address is required" });
  }
  const cleanEmail = email.trim().toLowerCase();

  try {
    const { insert } = await import("../lib/postgresClient.js");
    await insert("leads", { email: cleanEmail, source: "facility-risk-checklist" });
  } catch (err) {
    console.error("lead-capture: could not store lead:", err.message);
    // Non-fatal — a lead that fails to save should still trigger the
    // notification email if at all possible, rather than losing the
    // lead entirely over a database hiccup.
  }

  try {
    const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
        to: [process.env.ALERT_FROM_EMAIL],
        subject: `New lead: Facility Risk Checklist — ${cleanEmail}`,
        html: `<p>New checklist request from the landing page.</p><p><strong>Email:</strong> ${cleanEmail}</p><p>Follow up with the checklist directly — this isn't sent automatically yet.</p>`,
      }),
    });
  } catch (err) {
    console.error("lead-capture: could not send notification email:", err.message);
    // Still return success to the visitor — their email was captured
    // even if the notification email itself failed; a stored lead is
    // recoverable, but the visitor shouldn't see an error over
    // something entirely on the notification side.
  }

  return res.status(200).json({ success: true });
}
