// lib/emailTemplate.js
//
// The short, direct string used for SMS stays exactly as-is (160-char
// limit forces that, and nobody wants a long SMS). Email has room to be
// a real, personalized message instead of a raw data dump — this is
// what builds that HTML body.

export function buildFriendlyEmailHtml({ f, urgency, daysUntil, existingWoId, fromName }) {
  const name = f["Name"] || "Asset";
  const assetId = f["Asset ID"] || "";
  const location = f["Location"] || f["Building"] || "the building";
  const due = f["Next Service Due"] || "";
  const timing = daysUntil < 0
    ? `<strong>${Math.abs(daysUntil)} days overdue</strong>`
    : `due in <strong>${daysUntil} day${daysUntil === 1 ? "" : "s"}</strong>`;

  const greeting = existingWoId
    ? `This is a reminder that a previously reported issue is still open.`
    : `This is an automated notice from ${fromName || "your Facility Asset Management system"}.`;

  const urgencyColor = urgency === "OVERDUE" ? "#dc2626" : urgency === "URGENT" ? "#d97706" : "#1A3566";

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; color: #111827;">
    <div style="background:${urgencyColor}; color:#fff; padding: 18px 22px; border-radius: 10px 10px 0 0;">
      <div style="font-size: 12px; opacity: 0.85; letter-spacing: 0.5px; text-transform: uppercase;">${urgency}${existingWoId ? " · Reminder" : ""}</div>
      <div style="font-size: 18px; font-weight: 700; margin-top: 4px;">${name}</div>
    </div>
    <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px 22px; border-radius: 0 0 10px 10px;">
      <p style="font-size: 14px; line-height: 1.6; margin-top: 0;">Dear Team,</p>
      <p style="font-size: 14px; line-height: 1.6;">${greeting}</p>
      <p style="font-size: 14px; line-height: 1.6;">
        <strong>${name}</strong> (${assetId}) at <strong>${location}</strong> was due for service on <strong>${due}</strong> — ${timing}.
        ${existingWoId ? `This is tracked under Work Order <strong>${existingWoId}</strong>.` : "Please arrange servicing at your earliest convenience."}
      </p>
      <p style="font-size: 14px; line-height: 1.6; margin-bottom: 0;">Regards,<br>${fromName || "Facility Asset Management"}</p>
    </div>
    <div style="text-align: center; font-size: 11px; color: #9ca3af; margin-top: 14px;">
      Sent automatically by ${fromName || "GVC Facility Asset Manager"}
    </div>
  </div>`;
}
