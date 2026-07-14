// api/checklist.js
//
// GET /api/checklist?class=Pump
// Returns the maintenance checklist structure for a given asset class.
// See lib/checklists.js — content is intentionally empty until each
// class's real standard is sourced and confirmed, not guessed.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { getChecklist } from "../lib/checklists.js";

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  const className = req.query.class;
  if (!className) {
    return res.status(400).json({ error: "class required" });
  }

  const checklist = getChecklist(className);
  return res.status(200).json({ class: className, ...checklist });
}
