// lib/workOrderUrgencyAI.js
//
// Assesses Critical / High / Low urgency for a human-reported work
// order (email, portal, or staff-reported) — the gap flagged directly
// early on: sensor-triggered and scheduled-maintenance work orders
// already have a real, date-based urgency signal (OVERDUE/UPCOMING);
// a human report has no due date at all, so it needs its own scale
// and its own real signals, not a borrowed one.
//
// Real signals combined, not just the words in the report:
//   - The asset's own Criticality field (High/Low), when the report is
//     tied to one — a calmly-worded report about a High-criticality
//     asset still weighs heavier than the wording alone suggests.
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
// urgency. The one exception, confirmed directly and treated as a real
// hard floor rather than a suggestion: a report from a flagged
// Leadership Reporter (business_owner, or anyone with
// is_leadership_reporter set — directors, chiefs, etc.) always lands
// at High or above, regardless of what the AI concludes from the text
// alone. That floor is enforced here, after the AI call, so no caller
// can accidentally forget to apply it.

export async function assessWorkOrderUrgency({ reportText, asset, multiIssueLikely, isLeadershipReporter, recentOrgHistory }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let urgency = "High"; // safe, non-dismissive default if AI is unavailable — never silently downgrade to Low without a real assessment
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
  "urgency": <one of exactly: "Critical", "High", "Low">,
  "reason": <one short plain sentence explaining the assessment, under 20 words>
}

Guidance: Critical means a genuine safety risk or something that stops normal operation of a High-criticality asset or life-safety system (fire, electrical, medical, structural). High means a real problem that should be addressed soon but isn't an immediate safety risk. Low means routine, cosmetic, or minor. A calmly-worded report about a serious system is still Critical or High — don't rely on tone alone.`;

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
        if (["Critical", "High", "Low"].includes(parsed.urgency)) {
          urgency = parsed.urgency;
          reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "";
        }
      }
    } catch (err) {
      console.error("assessWorkOrderUrgency error (non-fatal, defaulted to High):", err.message);
    }
  }

  // The real hard floor, confirmed directly: a Leadership Reporter's
  // report always lands at High or above, no matter what the text
  // says. This raises Low to High; it never lowers a Critical
  // assessment the content itself already earned.
  let leadershipFloorApplied = false;
  if (isLeadershipReporter && urgency === "Low") {
    urgency = "High";
    leadershipFloorApplied = true;
  }

  return { urgency, reason, leadershipFloorApplied, assessedBy: apiKey ? "ai" : "default" };
}
