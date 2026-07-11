// api/login.js
//
// Checks the submitted username/password against TWO fixed pairs set
// in environment variables — enough for today's testing (e.g. one for
// the engineer, one for a technician), without needing a real user
// database yet. On success, sets a signed, HttpOnly session cookie.
//
// This is intentionally simple for now. When you're ready for real
// clients to manage their own team (add/remove people without editing
// environment variables), that's a genuine upgrade — a real Users
// table with proper password hashing — worth building deliberately
// when it's actually needed, not before.

import { setSessionCookie } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const validPairs = [
    { u: process.env.ENGINEER_USERNAME, p: process.env.ENGINEER_PASSWORD },
    { u: process.env.TECHNICIAN_USERNAME, p: process.env.TECHNICIAN_PASSWORD },
  ].filter(pair => pair.u && pair.p); // ignore any pair that isn't actually configured

  const matched = validPairs.find(pair => pair.u === username && pair.p === password);

  if (!matched) {
    return res.status(401).json({ error: "Incorrect username or password" });
  }

  setSessionCookie(res, username);
  return res.status(200).json({ success: true });
}
