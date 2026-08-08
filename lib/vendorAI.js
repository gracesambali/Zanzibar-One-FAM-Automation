// lib/vendorAI.js
//
// Two small, focused Claude calls, both non-fatal by design (return
// null/empty on any failure rather than throwing) — neither should
// ever block the actual thing the user is doing (adding a vendor,
// searching a list) just because an AI call had a bad day.

const SYSTEM_CATEGORIES = [
  "HVAC", "Fire Protection", "Electrical", "Vertical Transport", "Plumbing",
  "Controls", "CCTV & Access Control", "Parking System", "Retail Tenant Interface", "Fire Detection",
];

// Suggests ONE technical category from a vendor's plain-language
// supply description — quiet and optional, never required. Returns
// null if nothing fits well, rather than forcing a guess onto a
// vendor that genuinely doesn't belong to any of the ten (cleaning
// supplies, office furniture, etc.) — a wrong forced tag is worse
// than no tag at all.
export async function suggestVendorCategory(supplies) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `A facility management company is adding a vendor. Here is what the vendor supplies, in the person's own words:

"${supplies}"

Does this clearly belong to exactly one of these technical systems? ${SYSTEM_CATEGORIES.join(", ")}

Respond with ONLY the exact category name if there's a clear, confident match, or the word "none" if it doesn't clearly fit any of them (e.g. general supplies, office goods, cleaning, anything not tied to one specific building system). No punctuation, no explanation, just the category name or "none".`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 20,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return null;
    const answer = textBlock.text.trim();
    return SYSTEM_CATEGORIES.includes(answer) ? answer : null;
  } catch (err) {
    console.error("suggestVendorCategory error:", err.message);
    return null;
  }
}

// Semantic vendor search — deliberately NOT run on every keystroke
// (that would mean an API call per character typed, slow and
// needlessly expensive). This is meant to be triggered explicitly,
// after the fast, free, instant keyword search has already run
// client-side and either came up empty or the person wants a smarter
// pass. Sends the whole active vendor list in one call since a
// realistic list (hundreds, not thousands) comfortably fits in a
// single request — no separate embeddings pipeline needed at this
// scale. Returns an array of matching vendor ids, or an empty array
// on any failure — a failed smart search should feel like "no extra
// matches found," not an error interrupting the person's work.
export async function searchVendorsSemantic(searchQuery, vendors) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !searchQuery || !searchQuery.trim() || !vendors || vendors.length === 0) return [];

  const vendorList = vendors.map(v => `${v.id}: ${v.name}${v.supplies ? " — " + v.supplies : ""}`).join("\n");
  const prompt = `A Procurement person is searching a vendor list for: "${searchQuery.trim()}"

Here is the full vendor list (id: name — what they supply):
${vendorList}

Which vendors could reasonably match what the person is looking for, even if the wording is completely different (e.g. "aircon guy" should match a vendor described as "climate control servicing")? Respond with ONLY a JSON array of matching vendor ids, most relevant first, nothing else — no markdown, no explanation. If nothing plausibly matches, respond with an empty array: []`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return [];
    const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : [];
  } catch (err) {
    console.error("searchVendorsSemantic error:", err.message);
    return [];
  }
}
