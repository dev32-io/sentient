const ITMS = (base: string): string =>
  `itms-services://?action=download-manifest&amp;url=${base}/download/ios/manifest.plist`;

/** Standalone, pre-auth, mobile-first download/install page. Version is filled
 *  client-side from /download/manifest.json so this string stays data-free. */
export function renderDownloadPage(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Get Sentient</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0f1115;color:#f3f5f8;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  main{width:100%;max-width:420px;text-align:center}
  h1{font-size:1.6rem;margin:0 0 4px}
  p.sub{color:#9aa3af;margin:0 0 28px}
  a.btn{display:flex;align-items:center;justify-content:center;min-height:52px;margin:12px 0;
    border-radius:14px;text-decoration:none;font-weight:600;font-size:1.05rem}
  a.android{background:#3ddc84;color:#08130c}
  a.ios{background:#0a84ff;color:#fff}
  .note{color:#9aa3af;font-size:.85rem;margin-top:6px}
  .ver{color:#6b7280;font-size:.8rem;margin-top:28px}
</style></head><body><main>
  <h1>Get Sentient</h1>
  <p class="sub">Install the family assistant app.</p>
  <a class="btn android" href="${base}/download/android/latest.apk">Download for Android (APK)</a>
  <a class="btn ios" href="${ITMS(base)}">Install on iPhone</a>
  <p class="note">iPhone install works on registered devices only (ad-hoc provisioning).</p>
  <p class="ver" id="ver"></p>
  <script>
    fetch("/download/manifest.json").then(function(r){return r.json()}).then(function(m){
      var a=m&&m.android,i=m&&m.ios;
      document.getElementById("ver").textContent=
        "Android "+(a?a.versionName:"?")+" · iOS "+(i?i.shortVersion:"?");
    }).catch(function(){});
  </script>
</main></body></html>`;
}
