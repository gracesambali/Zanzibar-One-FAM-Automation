// lib/requisitionAI.js
//
// Fills out the New Requisition form from either a plain-language
// description ("need 20L diesel for the generator at Zenaultra Tower,
// Building B") or a photograph of a paper requisition slip — two
// different inputs, same output shape, both feeding the same real
// form fields createOneRequisition() already expects. Same principle
// as everywhere else: this fills the form for the person to review,
// it never submits a requisition on its own.

const REQUISITION_FIELD_SCHEMA = `Respond with ONLY a JSON object — no markdown, no code fences, no explanation before or after:

{
  "itemDescription": <what's needed, as a short clear phrase>,
  "quantityRequested": <a plain number, or null if not mentioned>,
  "unitOfMeasure": <e.g. "pcs", "litres", "boxes" — or null if not mentioned>,
  "facility": <the facility name if one of the real facilities below is clearly meant, otherwise null>,
  "building": <the building name if one of the real buildings below is clearly meant, otherwise null>,
  "requestingDepartment": <department name if mentioned, otherwise null>,
  "isAsset": <true only if this will become a real standalone asset once it arrives, not a consumable or a one-off service — false if unclear>,
  "notes": <any other relevant detail mentioned that doesn't fit the fields above, or null>
}

Only set facility/building to one of the real names below if the text clearly means that one — never invent a name that isn't in this real list, and use null rather than guessing when it's ambiguous.`;

function buildFacilityContext(facilitiesData) {
  return (facilitiesData || []).map(f => `${f.name}: buildings — ${(f.buildings || []).join(", ") || "none listed"}`).join("\n");
}

function parseRequisitionResponse(rawText, facilitiesData) {
  const cleaned = rawText.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  const parsed = JSON.parse(cleaned);

  const realFacilityNames = new Set((facilitiesData || []).map(f => f.name));
  const realBuildingNames = new Set((facilitiesData || []).flatMap(f => f.buildings || []));

  return {
    itemDescription: typeof parsed.itemDescription === "string" ? parsed.itemDescription.slice(0, 300) : "",
    quantityRequested: typeof parsed.quantityRequested === "number" ? parsed.quantityRequested : null,
    unitOfMeasure: typeof parsed.unitOfMeasure === "string" ? parsed.unitOfMeasure.slice(0, 50) : null,
    facility: realFacilityNames.has(parsed.facility) ? parsed.facility : null,
    building: realBuildingNames.has(parsed.building) ? parsed.building : null,
    requestingDepartment: typeof parsed.requestingDepartment === "string" ? parsed.requestingDepartment.slice(0, 100) : null,
    isAsset: parsed.isAsset === true,
    notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 500) : null,
  };
}

export async function fillRequisitionFromText(description, facilitiesData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("fillRequisitionFromText: ANTHROPIC_API_KEY is not set"); return null; }

  const prompt = `A facility management team member typed this description of something they need ordered:

"${description}"

Real facilities and buildings at this company:
${buildFacilityContext(facilitiesData)}

${REQUISITION_FIELD_SCHEMA}`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return null;
    return parseRequisitionResponse(textBlock.text, facilitiesData);
  } catch (err) {
    console.error("fillRequisitionFromText error:", err.message);
    return null;
  }
}

export async function fillRequisitionFromPhoto(imageBase64, contentType, facilitiesData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("fillRequisitionFromPhoto: ANTHROPIC_API_KEY is not set"); return null; }

  const prompt = `This is a photo of a paper requisition slip from a facility management team.

Real facilities and buildings at this company:
${buildFacilityContext(facilitiesData)}

Read what's written on the slip and extract the same information a typed request would give.

${REQUISITION_FIELD_SCHEMA}`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: contentType, data: imageBase64 } },
          { type: "text", text: prompt },
        ] }],
      }),
    });
    if (!resp.ok) throw new Error(`Claude API returned ${resp.status}`);
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return null;
    return parseRequisitionResponse(textBlock.text, facilitiesData);
  } catch (err) {
    console.error("fillRequisitionFromPhoto error:", err.message);
    return null;
  }
}
