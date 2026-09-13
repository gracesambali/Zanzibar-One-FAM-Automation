// lib/duplicateReportAI.js
//
// Checks whether a newly reported issue is likely describing the same
// underlying problem as something already open. Confirmed directly:
// reporters describe symptoms and location, not asset IDs or exact
// wording, so matching is by real language similarity within a real,
// narrow candidate pool - not exact keyword matching, and never
// against the whole organization's history (same building/facility
// only, still Open, reported recently) to keep it cheap and avoid
// coincidental matches from unrelated locations.
//
// Same principle as every other AI feature in FAM: this SUGGESTS a
// possible match, never merges or blocks anything on its own. A
// live-created report shows this as a non-blocking warning the person
// can dismiss and submit anyway; a report with no one there to warn
// (the public no-login links) gets flagged on the record afterward
// for a real person to notice and judge.

const CANDIDATE_WINDOW_HOURS = 48;

export async function findLikelyDuplicate({ pgQuery, description, building, organizationId, excludeRecordId }) {
  if (!description || !description.trim() || !building) return null;

  // Cheap, real pre-filter first - only ever calls AI when there's
  // genuinely something to compare against, never on every report.
  const cutoff = new Date(Date.now() - CANDIDATE_WINDOW_HOURS * 3600000).toISOString();
  const params = [organizationId, building, cutoff];
  let query = `select id, wo_id, asset_name, notes, created from work_orders
     where organization_id = $1 and status = 'Open' and building = $2 and created >= $3`;
  if (excludeRecordId) {
    params.push(excludeRecordId);
    query += ` and id != $${params.length}`;
  }
  query += ` order by created desc limit 8`;

  const result = await pgQuery(query, params);
  if (result.rows.length === 0) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("findLikelyDuplicate: ANTHROPIC_API_KEY is not set — skipping");
    return null;
  }

  const candidateList = result.rows.map((r, i) => `${i + 1}. [${r.wo_id}] ${r.asset_name || "no asset"}: ${(r.notes || "").slice(0, 300)}`).join("\n");

  const prompt = `A new facility issue was just reported: "${description}"

Here are other real, currently open reports from the same building, reported in the last ${CANDIDATE_WINDOW_HOURS} hours:
${candidateList}

Is the new report very likely describing the SAME underlying problem as one of these (not just the same general topic - genuinely the same issue, e.g. both about the same AC unit not cooling, not just both about "AC" in general)?

Respond with ONLY a JSON object - no markdown, no explanation:

{
  "matchNumber": <the number (1-${result.rows.length}) of the one genuine likely match, or null if none of them are likely the same issue>,
  "reason": <one short plain sentence, under 20 words, or null>
}`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return null;
    const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    const matchIndex = Number(parsed.matchNumber) - 1;
    if (!Number.isInteger(matchIndex) || matchIndex < 0 || matchIndex >= result.rows.length) return null;

    const match = result.rows[matchIndex];
    return {
      woId: match.wo_id,
      recordId: match.id,
      assetName: match.asset_name || "",
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "",
    };
  } catch (err) {
    console.error("findLikelyDuplicate error (non-fatal):", err.message);
    return null;
  }
}
