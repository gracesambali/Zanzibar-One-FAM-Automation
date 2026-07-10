// api/logout.js
//
// Clears the session cookie by setting it to expire immediately.

export default async function handler(req, res) {
  res.setHeader("Set-Cookie", [
    "gvc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
  ]);
  return res.status(200).json({ success: true });
}
