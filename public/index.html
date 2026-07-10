<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GVC Facility Asset Manager — Live Alert Demo</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; background:#F0F2F6; color:#1A1A2E; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; }
  .card { background:#fff; border-radius:16px; max-width:480px; width:100%; padding:36px 32px; box-shadow:0 4px 24px rgba(0,0,0,.08); }
  .logo-row { display:flex; align-items:center; gap:12px; margin-bottom:6px; }
  .logo { width:42px; height:42px; border-radius:50%; background:#1A3566; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:700; font-size:12px; flex-shrink:0; }
  h1 { font-size:19px; color:#1A3566; }
  .sub { font-size:13px; color:#6B7280; margin-top:4px; margin-bottom:24px; }
  label { font-size:12px; font-weight:600; color:#1A3566; display:block; margin-bottom:6px; margin-top:16px; }
  input { width:100%; padding:11px 14px; border:1px solid #E2E6ED; border-radius:8px; font-size:14px; font-family:inherit; }
  button { width:100%; margin-top:22px; padding:14px; border:none; border-radius:10px; background:#1A3566; color:#fff; font-size:15px; font-weight:600; cursor:pointer; transition:transform .15s; }
  button:hover { transform:scale(1.02); }
  button:disabled { opacity:.6; cursor:wait; }
  .result { margin-top:20px; padding:16px; border-radius:10px; font-size:13.5px; line-height:1.6; display:none; }
  .result.show { display:block; }
  .result.success { background:#E8F8EF; color:#065F46; border:1px solid rgba(39,174,96,.2); }
  .result.error { background:#FDE8E6; color:#991B1B; border:1px solid rgba(231,76,60,.2); }
  .row { display:flex; justify-content:space-between; padding:4px 0; }
  .footer { text-align:center; font-size:11px; color:#9CA3AF; margin-top:24px; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo-row">
      <div class="logo">GVC</div>
      <h1>Facility Asset Manager</h1>
    </div>
    <div class="sub">Live Alert Demo — Zanzibar One Tower</div>

    <p style="font-size:13.5px; color:#374151; line-height:1.6;">
      This sends a real, live maintenance alert — one email and one SMS —
      to show exactly what happens the moment an asset needs attention.
    </p>

    <label for="key">Demo Access Key</label>
    <input id="key" type="password" placeholder="Enter the demo key" autocomplete="off">

    <button id="sendBtn" onclick="triggerDemo()">Send Live Test Alert</button>

    <div id="result" class="result"></div>

    <a href="/dashboard.html" style="display:block; text-align:center; margin-top:20px; font-size:13px; color:#1A3566; font-weight:600; text-decoration:none;">
      View Full Facility Asset Manager →
    </a>

    <div class="footer">Gracing Ventures · BIM Information Management · Tanzania</div>
  </div>

<script>
async function triggerDemo() {
  const key = document.getElementById('key').value.trim();
  const btn = document.getElementById('sendBtn');
  const result = document.getElementById('result');

  if (!key) {
    result.className = 'result error show';
    result.innerHTML = 'Please enter the demo access key first.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  result.className = 'result show';
  result.innerHTML = 'Sending live alert…';

  try {
    const resp = await fetch('/api/test-alert?key=' + encodeURIComponent(key));
    const data = await resp.json();

    if (resp.ok && data.success) {
      result.className = 'result success show';
      result.innerHTML = `
        <div class="row"><span>Email</span><strong>${data.email}</strong></div>
        <div class="row"><span>SMS</span><strong>${data.sms}</strong></div>
        <div style="margin-top:8px;">Check your inbox and phone now.</div>
      `;
    } else {
      result.className = 'result error show';
      result.innerHTML = data.error || 'Something went wrong. Check your access key.';
    }
  } catch (err) {
    result.className = 'result error show';
    result.innerHTML = 'Network error: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Live Test Alert';
  }
}
</script>
</body>
</html>
