// lib/workOrderSummaryAI.js
//
// Drafts a plain-language, whole-story summary of a work order — from
// how it started to how it was resolved — using the real activity log
// and chat thread already on the record. Confirmed directly: happens
// for every work order at closure (whether it goes through Ready for
// Review or closes directly), and separately, on-demand for old
// already-closed work orders that predate this feature via a
// "Generate Summary" button, plus a one-time backfill for all of them.
//
// Same principle as every other AI feature in FAM: this drafts a
// summary, the person reviews and can edit or regenerate it before
// it's saved as the permanent record — never saved without their
// review for a NEW closure. The one-time backfill is a deliberate,
// confirmed exception to "always reviewed by a person" — run in bulk,
// upfront, by request, not the standing behavior for new work orders.

export async function draftClosureSummary({ assetName, createdAt, notes, activityLog, chatLog }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("draftClosureSummary: ANTHROPIC_API_KEY is not set — skipping");
    return null;
  }

  const activityText = (activityLog || [])
    .map(e => `[${e.at || "unknown time"}] ${e.text || ""}`)
    .join("\n") || "(no activity log entries)";
  const chatText = (chatLog || [])
    .filter(e => e.text)
    .map(e => `[${e.at || "unknown time"}] ${e.by || "someone"}: ${e.text}`)
    .join("\n") || "(no chat messages)";

  const prompt = `Write a short, plain-language summary of this work order from beginning to end - what was reported, what was found, what was done to resolve it. This becomes the permanent written record on the work order.

Asset: ${assetName || "unknown asset"}
Opened: ${createdAt || "unknown date"}
Original report/notes: ${notes || "(none recorded)"}

Activity log:
${activityText}

Chat thread:
${chatText}

Write 2-4 sentences, plain prose, no headers or bullet points. State only what the log/chat/notes actually say - never invent details, dates, or outcomes that aren't in the record above. If the record is too thin to say much, write a short, honest summary reflecting that rather than padding it out.

Respond with ONLY the summary text - no preamble, no quotation marks, no "Here's a summary:".`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    return textBlock ? textBlock.text.trim() : null;
  } catch (err) {
    console.error("draftClosureSummary error:", err.message);
    return null;
  }
}
