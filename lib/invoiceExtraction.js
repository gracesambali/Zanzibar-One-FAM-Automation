// lib/invoiceExtraction.js
//
// Reads an uploaded vendor quote/invoice PDF and extracts the total
// cost and VAT status automatically — the piece of the old Airtable
// AI field type that had no direct Postgres equivalent, rebuilt here
// as a real Claude API call. Non-fatal by design: if extraction fails
// for any reason (a bad scan, a network hiccup, a genuinely unreadable
// document), the upload itself still succeeds — this only fills in
// three optional fields, it never blocks the actual file from saving.

const EXTRACTION_PROMPT = `You are reading a vendor quote or invoice PDF for a facility maintenance company. Extract exactly three things and respond with ONLY a JSON object — no markdown formatting, no code fences, no explanation before or after:

{
  "totalCost": <the total amount due as a plain number, no currency symbols or commas, or null if you cannot find a clear total>,
  "vatStatus": <one of exactly these strings: "VAT Inclusive", "VAT Exclusive", "VAT Exempt", "Not specified">,
  "summary": <a single plain sentence, under 20 words, describing what this quote is for>
}

If the document shows VAT explicitly broken out, or states the price is VAT-inclusive or VAT-exclusive, use that. If VAT isn't mentioned at all, use "Not specified" rather than guessing.`;

export async function extractInvoiceData(base64Pdf) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("extractInvoiceData: ANTHROPIC_API_KEY is not set — skipping extraction");
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
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Pdf } },
            { type: "text", text: EXTRACTION_PROMPT },
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

    // Strip potential markdown fences defensively, even though the
    // prompt asks for none — models occasionally add them anyway.
    const cleaned = textBlock.text.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);

    return {
      totalCost: typeof parsed.totalCost === "number" ? parsed.totalCost : null,
      vatStatus: typeof parsed.vatStatus === "string" ? parsed.vatStatus : "Not specified",
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 300) : null,
    };
  } catch (err) {
    console.error("extractInvoiceData error:", err.message);
    return null;
  }
}
