// lib/qrcode.js
//
// Generates a QR code IMAGE URL for a given asset — no library or API
// key needed, uses the free goqr.me image API, which just renders a PNG
// from a URL you give it. Each QR code encodes a link straight to that
// asset's PUBLIC quick-view page (see api/asset-quickview.js) — not the
// login-protected dashboard, since the whole point is anyone can scan
// it with a phone camera and see basic info immediately, no login.
//
// The quick-view page intentionally excludes cost/depreciation — same
// sensitivity rule as the rest of the system (finance data stays behind
// login, condition/location/status does not).

export function getQrCodeImageUrl(assetId, baseUrl) {
  const targetUrl = `${baseUrl}/asset.html?id=${encodeURIComponent(assetId)}`;
  const size = "300x300";
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}&data=${encodeURIComponent(targetUrl)}`;
}
