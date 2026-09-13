// lib/workOrderUrgencyAI.js
//
// Assesses Critical / High urgency for a human-reported work order
// (email, portal, or staff-reported) — the gap flagged directly
// early on: sensor-triggered and scheduled-maintenance work orders
// already have their own real, rule-based starting urgency; a human
// report has no such signal at all, so it needs AI to interpret real
// language, not a borrowed rule.
//
// Only two values are ever assessed here — Critical or High. "Low"
// was retired entirely from the whole urgency scale, confirmed
// directly: High is now the floor everything starts at (nothing
// starts below it), and "Overdue" is reached purely through elapsed
// time (lib/workOrderState.js), never assigned here at creation.
//
// Real signals combined, not just the words in the report:
//   - The asset's own Criticality field, when the report is tied to
//     one — a calmly-worded report about a High-criticality asset
//     still weighs heavier than the wording alone suggests.
//   - The asset's system/category — life-safety systems (fire,
//     electrical, medical) weighted higher than cosmetic ones.
//   - The report's own language.
//   - Whether multiple systems were flagged in one report (already
//     computed elsewhere as multiIssueLikely) — touching more than one
//     system at once reads as more serious.
//   - This organization's own recent history of similar reports, when
//     available — not a generic industry rule, but this org's real
//     pattern of what actually got escalated.
//
// Same principle as every other AI feature in FAM: this SUGGESTS a
// urgency, never decides silently. The Leadership Reporter "always at
// least High" floor from the original design is now automatic — with
// Low retired, nothing this function can return is ever below High,
// so there's no separate floor-enforcement step left to apply.

export async function assessWorkOrderUrgency({ reportText, asset, multiIssueLikely, isLeadershipReporter, recentOrgHistory }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let urgency = "High"; // safe, non-dismissive default if AI is unavailable
  let reason = "AI assessment unavailable — defaulted to High for review.";

  if (apiKey) {
    try {
      const assetContext = asset
        ? `This report is tied to a specific real asset: "${asset.name}" (${asset.id}), Criticality: ${asset.criticality || "not set"}, System: ${asset.system || "not set"}.`
        : "This report is not tied to any specific asset.";
      const historyContext = recentOrgHistory && recentOrgHistory.length > 0
        ? `This organization's recent similar reports, for pattern reference only (not a rule to copy blindly):\n${recentOrgHistory.map(h => `- "${h.summary}" was assessed ${h.urgency}`).join("\n")}`
        : "No comparable recent history available for this organization yet.";

      const prompt = `You are assessing the real urgency of a facility maintenance issue reported by a person (not a scheduled maintenance date or sensor threshold — a human wrote this).

Report text:
"${reportText}"

${assetContext}
${multiIssueLikely ? "This report appears to touch more than one system at once." : "This report appears to be about one issue."}

${historyContext}

Respond with ONLY a JSON object — no markdown, no code fences, no explanation before or after:

{
  "urgency": <one of exactly: "Critical", "High">,
  "reason": <one short plain sentence explaining the assessment, under 20 words>
}

Guidance: Critical means a genuine safety risk, or something that stops normal operation of a High-criticality asset or life-safety system (fire, electrical, medical, structural). High means everything else — a real problem to address, but not an immediate safety risk. A calmly-worded report about a serious system is still Critical — don't rely on tone alone.`;

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
      if (textBlock) {
        const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
        const parsed = JSON.parse(cleaned);
        if (["Critical", "High"].includes(parsed.urgency)) {
          urgency = parsed.urgency;
          reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "";
        }
      }
    } catch (err) {
      console.error("assessWorkOrderUrgency error (non-fatal, defaulted to High):", err.message);
    }
  }

  return { urgency, reason, assessedBy: apiKey ? "ai" : "default" };
}
