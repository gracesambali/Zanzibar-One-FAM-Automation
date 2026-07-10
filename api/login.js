// api/login.js
//
// Checks the submitted username/password against the credentials set
// in this deployment's environment variables. On success, sets a
// signed, HttpOnly session cookie — the browser can't read or tamper
// with it via JavaScript, and the server verifies its signature on
// every protected request afterward.

import { createSessionToken } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const validUsername = process.env.ENGINEER_USERNAME;
  const validPassword = process.env.ENGINEER_PASSWORD;

  if (!validUsername || !validPassword) {
    return res.status(500).json({ error: "Login is not configured for this deployment yet" });
  }

  if (username !== validUsername || password !== validPassword) {
    return res.status(401).json({ error: "Incorrect username or password" });
  }

  const token = createSessionToken(username);

  res.setHeader("Set-Cookie", [
    `gvc_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 60 * 60}`
  ]);

  return res.status(200).json({ success: true });
}
