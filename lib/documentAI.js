// lib/documentAI.js
//
// When someone uploads a document (a contract, certificate, manual —
// anything), suggests which real assets it should be linked to, or
// whether it looks like a facility-wide template. Same principle as
// every other AI feature in FAM: suggest, never decide — the person
// always sees checkboxes and confirms before any link is actually
// created.
//
// Two-tier matching, confirmed directly: try a SPECIFIC match first —
// an asset ID, model number, or serial number the document itself
// actually names, checked against the real Asset Register, not a
// guess. Only when nothing specific is found does this fall back to a
// broader category/system-level suggestion (e.g. "this looks like it's
// about generators in general") — clearly labeled as a rough guess,
// never presented with the same confidence as a real match. Category
// matching alone, with no fallback tier, would suggest every asset in
// a category even when a specific contract only covers some of them.

export async function suggestDocumentLinks(fileBase64, contentType, filename, assets, statedIntent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("suggestDocumentLinks: ANTHROPIC_API_KEY is not set — skipping suggestion");
    return null;
  }

  // A compact, real list of what actually exists — Claude matches
  // against this, it never invents an asset id that isn't real.
  const assetList = assets.map(a => `${a.id}: ${a.name} — system: ${a.system || "—"}, model: ${a.model || "—"}, manufacturer: ${a.manufacturer || "—"}`).join("\n");
  const realSystems = [...new Set(assets.map(a => a.system).filter(Boolean))];

  // Confirmed directly: what the person typing the upload actually
  // said they want it for is a real, additional signal - weighed
  // alongside the document's own content, never overriding what the
  // document itself actually says if the two genuinely conflict.
  const intentContext = statedIntent && statedIntent.trim()
    ? `The person uploading this said what they want it for: "${statedIntent.trim()}"\n\nUse this as a real signal alongside the document's own content - if they named a specific asset or said "all X", weigh that seriously, but don't override what the document itself clearly says if the two genuinely conflict.`
    : "The person uploading this didn't say what it's for - go entirely from the document's own content.";

  const prompt = `You are reading an uploaded document for a facility management company, deciding which of the company's real assets it should be linked to.

${intentContext}

Here is the company's real Asset Register (id: name — system, model, manufacturer):
${assetList}

Real systems in use at this company: ${realSystems.join(", ")}

Read the document and respond with ONLY a JSON object — no markdown, no code fences, no explanation before or after:

{
  "documentTypeGuess": <one of exactly: "Contract", "Compliance Certificate", "Warranty", "Manual", "Other">,
  "matchType": <one of exactly: "specific", "category", "none">,
  "specificAssetIds": <array of real asset ids from the list above that the document EXPLICITLY names by asset id, serial number, or an unambiguous model+manufacturer match — empty array if none>,
  "categorySystem": <if matchType is "category", the one real system name from the list above this document seems to be about in general (e.g. it mentions "generators" without naming which ones) — otherwise null>,
  "reason": <one short plain sentence explaining the match, under 20 words>
}

Rules: matchType is "specific" only when specificAssetIds is non-empty. matchType is "category" when the document is clearly about one real system in general but names no specific asset. matchType is "none" when you genuinely cannot tell what real asset or system this relates to. Never invent an asset id that isn't in the list above.`;

  const contentBlock = contentType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
    : { type: "image", source: { type: "base64", media_type: contentType, data: fileBase64 } };

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 600,
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
      }),
    });
    if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return null;
    const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);

    const realAssetIds = new Set(assets.map(a => a.id));
    const specificAssetIds = Array.isArray(parsed.specificAssetIds)
      ? parsed.specificAssetIds.filter(id => realAssetIds.has(id))
      : [];

    return {
      documentTypeGuess: ["Contract", "Compliance Certificate", "Warranty", "Manual", "Other"].includes(parsed.documentTypeGuess) ? parsed.documentTypeGuess : "Other",
      matchType: specificAssetIds.length > 0 ? "specific" : (parsed.matchType === "category" && realSystems.includes(parsed.categorySystem) ? "category" : "none"),
      specificAssetIds,
      categorySystem: realSystems.includes(parsed.categorySystem) ? parsed.categorySystem : null,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "",
    };
  } catch (err) {
    console.error("suggestDocumentLinks error:", err.message);
    return null;
  }
}

// Extracts the real, readable text content of an uploaded document —
// used specifically for chatbot knowledge documents, so the chatbot
// can answer questions from what the document actually says without
// re-reading the raw file on every question asked. Non-fatal by
// design: a failed extraction still lets the document upload and
// attach successfully, it just won't contribute to chatbot answers
// until re-uploaded or fixed.
export async function extractDocumentText(fileBase64, contentType) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("extractDocumentText: ANTHROPIC_API_KEY is not set — skipping extraction");
    return null;
  }

  const contentBlock = contentType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
    : { type: "image", source: { type: "base64", media_type: contentType, data: fileBase64 } };

  const prompt = `Extract the full, real text content of this document, as plain text. Preserve the actual structure (headings, lists, steps) using plain text formatting only - no markdown symbols, no commentary before or after, no summarizing or shortening what it actually says. Just the real content, as text.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
      }),
    });
    if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    return textBlock ? textBlock.text.trim() : null;
  } catch (err) {
    console.error("extractDocumentText error:", err.message);
    return null;
  }
}
