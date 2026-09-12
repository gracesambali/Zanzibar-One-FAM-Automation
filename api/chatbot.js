// api/chatbot.js
//
// In-app "ask a question about FAM" chatbot. Answers ONLY from
// docs/fam-reference.md (bundled into this function at deploy time) -
// never from general AI knowledge about CMMS software in general,
// since that would confidently describe features FAM doesn't
// actually have, or describe real ones incorrectly.
//
// If the reference doc doesn't cover something, the model is
// instructed to say so plainly using an exact, detectable phrase
// rather than guess. When that phrase appears, this endpoint attaches
// the org's own `admin`-role contact (real email + phone from the
// `users` table, never a fixed number) so the frontend can show real
// Email/Call buttons - the actual human escalation path, one level
// only. Whatever happens after that (admin emailing/calling GVC
// directly) is a manual process outside this endpoint entirely.
//
// ENV VARS REQUIRED:
//   ANTHROPIC_API_KEY - used server-side only, never exposed to the client

import { getSession, setSessionCookie } from "../lib/auth.js";
import fs from "fs";
import path from "path";

const CANNOT_ANSWER_PHRASE = "I'm not able to answer that from what I know about FAM.";
const MODEL = "claude-haiku-4-5-20251001";

let cachedReference = null;
function loadReferenceDoc() {
  // Cached per warm function instance - the file is bundled at deploy
  // time anyway, so re-reading it on every request buys nothing.
  if (cachedReference) return cachedReference;
  const filePath = path.join(process.cwd(), "docs", "fam-reference.md");
  cachedReference = fs.readFileSync(filePath, "utf8");
  return cachedReference;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r, session.org);

  const { message, history } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "A question is required." });
  }

  let referenceDoc;
  try {
    referenceDoc = loadReferenceDoc();
  } catch (err) {
    console.error("chatbot: could not load reference doc:", err.message);
    return res.status(500).json({ error: "Reference document unavailable." });
  }

  const systemPrompt = `You are the in-app help assistant for FAM (Facility Asset Manager), a facility/asset management platform.

Answer questions ONLY using the reference document below. It is the sole source of truth - never use general knowledge about CMMS/facility software, and never guess at how FAM works beyond what this document actually says.

If the document does not clearly answer the question, respond with EXACTLY this sentence and nothing else - no apology, no elaboration, no partial guess:
"${CANNOT_ANSWER_PHRASE}"

Keep answers short and direct - a sentence or two for simple questions, a short paragraph at most for anything more involved. This is a chat interface, not a document.

--- REFERENCE DOCUMENT ---
${referenceDoc}
--- END REFERENCE DOCUMENT ---`;

  // Keep a little real back-and-forth context, but bounded - this is a
  // quick-help widget, not a long-running conversation thread that
  // needs to be persisted anywhere.
  const priorTurns = Array.isArray(history) ? history.slice(-6) : [];
  const messages = [
    ...priorTurns
      .filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .map(t => ({ role: t.role, content: t.content })),
    { role: "user", content: message.trim() },
  ];

  let answer;
  try {
    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages,
      }),
    });
    const aiData = await aiResp.json();
    if (!aiResp.ok) {
      throw new Error(aiData.error?.message || "AI request failed");
    }
    answer = (aiData.content || []).map(b => b.text || "").join("").trim();
  } catch (err) {
    console.error("chatbot: AI call failed:", err.message);
    return res.status(500).json({ error: "Could not reach the assistant right now." });
  }

  const needsEscalation = !answer || answer.includes(CANNOT_ANSWER_PHRASE);
  let escalation = null;

  if (needsEscalation) {
    try {
      const { query: pgQuery } = await import("../lib/postgresClient.js");
      const result = await pgQuery(
        "select display_name, email, phone from users where organization_id = $1 and role = 'admin' and (active is distinct from false) limit 1",
        [session.org]
      );
      const admin = result.rows[0];
      if (admin) {
        escalation = { displayName: admin.display_name || "Admin", email: admin.email || null, phone: admin.phone || null };
      }
    } catch (err) {
      console.error("chatbot: admin lookup failed:", err.message);
      // Non-fatal - the person still gets a clear "I don't know" answer,
      // just without contact buttons attached.
    }
  }

  return res.status(200).json({
    answer: needsEscalation ? CANNOT_ANSWER_PHRASE : answer,
    needsEscalation,
    escalation,
  });
}
