// lib/floorPlanRoomDetection.js
//
// Phase 5, confirmed directly and discussed in full before building:
// reads a floor's own, real, uploaded drawing and attempts to match
// what it finds to the same, already-real rooms/zones already
// defined in Level View for that floor - the real source of truth for
// what rooms actually exist stays Level View, never the AI's own
// guess. Every detection is written as unconfirmed; nothing here is
// ever used for automatic placement until a real person reviews it.
// Same real, non-fatal pattern already proven in
// lib/invoiceExtraction.js: if this fails for any reason, the upload
// itself still succeeds, and the floor is simply left in its own
// real "not yet analyzed" state rather than a broken one.

const DETECTION_PROMPT_TEMPLATE = (roomNames) => `You are reading a facility floor plan drawing. The real, already-defined rooms on this floor are:
${roomNames.map(r => `- ${r}`).join("\n")}

Identify each distinct room or zone region you can actually see drawn on this image. For each one, respond with:
- A bounding box as percentages of the image's own width and height (0-100), covering that region
- Whatever label or text you can actually read on the drawing for that region, if any
- Which of the real room names above it most likely corresponds to, or null if you genuinely can't tell

Respond with ONLY a JSON array — no markdown formatting, no code fences, no explanation before or after:
[
  { "xMin": <number>, "yMin": <number>, "xMax": <number>, "yMax": <number>, "detectedLabel": <string or null>, "matchedRoom": <one of the exact real room names above, or null> }
]

If you can't confidently identify any real, distinct regions at all, respond with an empty array: []`;

export async function detectFloorPlanRooms(base64Image, mediaType, roomNames) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("detectFloorPlanRooms: ANTHROPIC_API_KEY is not set — skipping detection");
    return null;
  }
  if (!roomNames || roomNames.length === 0) {
    // Confirmed directly: nothing real to match against yet - Level
    // View needs its own rooms defined first, before this can mean
    // anything. Not an error, just genuinely nothing to do yet.
    return [];
  }

  const SUPPORTED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!SUPPORTED_TYPES.includes(mediaType)) {
    console.error(`detectFloorPlanRooms: unsupported image type ${mediaType} — skipping detection`);
    return null;
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
            { type: "text", text: DETECTION_PROMPT_TEMPLATE(roomNames) },
          ],
        }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Claude API returned ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) throw new Error("No text content in Claude response");

    const cleaned = textBlock.text.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Expected a JSON array, got something else");

    // Confirmed directly: only real, sane, in-bounds regions are kept
    // - a malformed or out-of-range box from a real model hiccup is
    // dropped rather than stored and silently offered to a reviewer
    // as if it were a real, trustworthy detection.
    return parsed
      .filter(r =>
        typeof r.xMin === "number" && typeof r.yMin === "number" &&
        typeof r.xMax === "number" && typeof r.yMax === "number" &&
        r.xMin >= 0 && r.yMin >= 0 && r.xMax <= 100 && r.yMax <= 100 &&
        r.xMax > r.xMin && r.yMax > r.yMin
      )
      .map(r => ({
        xMin: r.xMin, yMin: r.yMin, xMax: r.xMax, yMax: r.yMax,
        detectedLabel: typeof r.detectedLabel === "string" ? r.detectedLabel.slice(0, 200) : null,
        matchedRoom: (typeof r.matchedRoom === "string" && roomNames.includes(r.matchedRoom)) ? r.matchedRoom : null,
      }));
  } catch (err) {
    console.error("detectFloorPlanRooms error:", err.message);
    return null;
  }
}
