// pages/index.js
//
// Next.js requires at least one page under /pages (or /app) to build at
// all - without this, `next build` fails outright, even though the real
// UI lives entirely in /public (login.html, dashboard.html, etc.) as
// static files. This is a minimal placeholder only, not a real page -
// it does no data fetching and queries nothing. It just redirects to
// the real login page.

export default function Home() {
  if (typeof window !== "undefined") {
    window.location.href = "/login.html";
  }
  return null;
}
