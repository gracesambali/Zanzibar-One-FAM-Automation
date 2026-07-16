// lib/emailTemplate.js
//
// The short, direct string used for SMS stays exactly as-is (160-char
// limit forces that, and nobody wants a long SMS). Email has room to be
// a real, personalized message instead of a raw data dump — this is
// what builds that HTML body.
export function buildFriendlyEmailHtml({ f, urgency, daysUntil, existingWoId, fromName, technicalPersonnelName }) {
  const recipient = technicalPersonnelName || "Technical Team";
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
      <p style="font-size: 14px; line-height: 1.6; margin-top: 0;">Dear ${recipient},</p>
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

// Lightweight wrapper for paths that only have a flat message string
// (no structured asset fields available) - e.g. demo-trigger.js's
// simple test-alert mode. Still gives the same "Dear Team... Regards..."
// card format instead of a bare, unformatted paragraph.
export function buildGenericAlertEmailHtml({ title, message, technicalPersonnelName, fromName, color }) {
  const recipient = technicalPersonnelName || "Technical Team";
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; color: #111827;">
    <div style="background:${color || "#1A3566"}; color:#fff; padding: 18px 22px; border-radius: 10px 10px 0 0;">
      <div style="font-size: 12px; opacity: 0.85; letter-spacing: 0.5px; text-transform: uppercase;">${title || "Alert"}</div>
    </div>
    <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px 22px; border-radius: 0 0 10px 10px;">
      <p style="font-size: 14px; line-height: 1.6; margin-top: 0;">Dear ${recipient},</p>
      <p style="font-size: 14px; line-height: 1.6;">${message}</p>
      <p style="font-size: 14px; line-height: 1.6; margin-bottom: 0;">Regards,<br>${fromName || "Facility Asset Management"}</p>
    </div>
    <div style="text-align: center; font-size: 11px; color: #9ca3af; margin-top: 14px;">
      Sent automatically by ${fromName || "GVC Facility Asset Manager"}
    </div>
  </div>`;
}

// Work order status-change email — same visual style, covers "In Progress"
// and "Completed" transitions (Opened is already covered by the
// breakdown/maintenance alert sent at creation time in the other files,
// so this deliberately does not duplicate that one).
export function buildWorkOrderEmailHtml({ status, woId, assetName, location, notes, closedBy, technicalPersonnelName, fromName }) {
  const recipient = technicalPersonnelName || "Technical Team";
  const isCompleted = status === "Completed";
  const headerColor = isCompleted ? "#16a34a" : "#1A3566";
  const headerLabel = isCompleted ? "Work Order Completed" : "Work Order In Progress";

  const bodyLine = isCompleted
    ? `Work order <strong>${woId}</strong> for <strong>${assetName}</strong> at <strong>${location}</strong> has been closed.`
    : `Work order <strong>${woId}</strong> for <strong>${assetName}</strong> at <strong>${location}</strong> is now in progress.`;

  const detailLabel = isCompleted ? "Summary of work performed" : "Status update";
  const closedByLine = isCompleted && closedBy ? `<br><strong>Closed by:</strong> ${closedBy}` : "";

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; color: #111827;">
    <div style="background:${headerColor}; color:#fff; padding: 18px 22px; border-radius: 10px 10px 0 0;">
      <div style="font-size: 12px; opacity: 0.85; letter-spacing: 0.5px; text-transform: uppercase;">${headerLabel}</div>
      <div style="font-size: 18px; font-weight: 700; margin-top: 4px;">${assetName}</div>
    </div>
    <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px 22px; border-radius: 0 0 10px 10px;">
      <p style="font-size: 14px; line-height: 1.6; margin-top: 0;">Dear ${recipient},</p>
      <p style="font-size: 14px; line-height: 1.6;">${bodyLine}</p>
      <p style="font-size: 14px; line-height: 1.6;">
        <strong>${detailLabel}:</strong> ${notes || "—"}${closedByLine}
      </p>
      <p style="font-size: 14px; line-height: 1.6; margin-bottom: 0;">Regards,<br>${fromName || "Facility Asset Management"}</p>
    </div>
    <div style="text-align: center; font-size: 11px; color: #9ca3af; margin-top: 14px;">
      Sent automatically by ${fromName || "GVC Facility Asset Manager"}
    </div>
  </div>`;
}

// Breakdown report email — same visual style as buildFriendlyEmailHtml above,
// built for staff-reported breakdowns instead of scheduled maintenance alerts.
export function buildBreakdownEmailHtml({ reporterName, reporterRole, location, description, fromName, woId, technicalPersonnelName }) {
  const recipient = technicalPersonnelName || "Technical Team";
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Dar_es_Salaam" });
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Dar_es_Salaam" });

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; color: #111827;">
    <div style="background:#dc2626; color:#fff; padding: 18px 22px; border-radius: 10px 10px 0 0;">
      <div style="font-size: 12px; opacity: 0.85; letter-spacing: 0.5px; text-transform: uppercase;">Breakdown Reported</div>
      <div style="font-size: 18px; font-weight: 700; margin-top: 4px;">${location}</div>
    </div>
    <div style="border: 1px solid #e5e7eb; border-top: none; padding: 20px 22px; border-radius: 0 0 10px 10px;">
      <p style="font-size: 14px; line-height: 1.6; margin-top: 0;">Dear ${recipient},</p>
      <p style="font-size: 14px; line-height: 1.6;">
        A breakdown has been reported for <strong>${location}</strong> on ${dateStr} at ${timeStr}.
      </p>
      <p style="font-size: 14px; line-height: 1.6;">
        <strong>Issue reported:</strong> ${description}<br>
        <strong>Reported by:</strong> ${reporterName}${reporterRole ? ` (${reporterRole})` : ""}
        ${woId ? `<br><strong>Work Order:</strong> ${woId}` : ""}
      </p>
      <p style="font-size: 14px; line-height: 1.6; margin-bottom: 0;">Regards,<br>${fromName || "Facility Asset Management"}</p>
    </div>
    <div style="text-align: center; font-size: 11px; color: #9ca3af; margin-top: 14px;">
      Sent automatically by ${fromName || "GVC Facility Asset Manager"}
    </div>
  </div>`;
}
