// itms-services requires an ABSOLUTE https URL; built from the configured
// public base. `&amp;` is the correct HTML-attribute encoding of the `&`.
const ITMS = (base: string): string =>
  `itms-services://?action=download-manifest&amp;url=${base}/download/ios/manifest.plist`;

// Google Fonts the webui already uses (Fraunces display + DM Sans ui + mono).
const FONTS_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com"/>' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous"/>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' +
  "family=Fraunces:opsz,wght@9..144,400;9..144,500&family=DM+Sans:wght@400;500;600;700" +
  '&family=JetBrains+Mono:wght@400;500&display=swap"/>';

// Sentient design tokens (mirrors gateway/webui/src/styles/tokens/*). Inlined
// because this page is standalone HTML served pre-auth, not part of the SPA.
const STYLE = `
  :root{
    --color-bg:#2B2621; --color-bg-elev:#332D28; --color-paper:#39322C;
    --color-line:#4A4138; --color-line-soft:#3E362F;
    --color-ink:#F2E8D6; --color-ink-3:#9E907E; --color-ink-4:#706456;
    --color-accent:#F2A06A; --color-accent-50:#402C22; --color-sage:#B9C8A6;
    --font-display:"Fraunces","Cormorant Garamond",Georgia,serif;
    --font-ui:"DM Sans","Inter",system-ui,-apple-system,sans-serif;
    --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;min-height:100vh;min-height:100dvh}
  body{
    background:
      radial-gradient(1000px 500px at 10% -10%, color-mix(in oklab,var(--color-accent) 10%,transparent), transparent 60%),
      radial-gradient(800px 500px at 110% 0%, color-mix(in oklab,var(--color-sage) 9%,transparent), transparent 60%),
      var(--color-bg);
    color:var(--color-ink); font-family:var(--font-ui); font-size:15px; line-height:1.55;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
    display:flex; align-items:center; justify-content:center; padding:24px;
  }
  .card{
    width:100%; max-width:400px; text-align:center;
    background:var(--color-paper); border:1px solid var(--color-line-soft); border-radius:26px;
    padding:44px 32px 36px;
    box-shadow:0 1px 2px rgba(0,0,0,.25), 0 18px 50px -16px rgba(0,0,0,.5);
  }
  .brand{ font-family:var(--font-display); font-weight:500; font-size:32px; letter-spacing:.2px; margin:0 0 6px; }
  .sub{ color:var(--color-ink-3); font-size:14px; margin:0 0 28px; }
  .btn{
    display:flex; align-items:center; justify-content:center; gap:8px;
    width:100%; min-height:52px; margin:10px 0; padding:0 18px;
    border-radius:999px; text-decoration:none; font-family:var(--font-ui); font-weight:600; font-size:15px;
    transition:transform .15s ease, background .15s ease, border-color .15s ease;
  }
  .btn:hover{ transform:translateY(-1px); }
  .btn--android{ background:var(--color-ink); color:var(--color-paper); }
  .btn--android:hover{ background:color-mix(in oklab,var(--color-ink) 88%,var(--color-accent)); }
  .btn--ios{ background:var(--color-accent-50); color:var(--color-accent); border:1px solid color-mix(in oklab,var(--color-accent) 25%,transparent); }
  .btn--ios:hover{ background:color-mix(in oklab,var(--color-accent) 16%,var(--color-bg-elev)); border-color:color-mix(in oklab,var(--color-accent) 40%,transparent); }
  .note{ color:var(--color-ink-4); font-size:12.5px; line-height:1.5; margin:10px 0 0; }
  .rule{ height:1px; background:var(--color-line-soft); border:0; margin:26px 0 0; }
  .ver{ color:var(--color-ink-4); font-family:var(--font-mono); font-size:11px; letter-spacing:.02em; margin:18px 0 0; }
`;

/** Standalone, pre-auth, mobile-first download/install page in the Sentient
 *  design language (warm paper card, Fraunces wordmark, terra accent). Version
 *  is filled client-side from /download/manifest.json so this string stays
 *  data-free. The Android link is host-relative (works on any serving host);
 *  the iOS itms link must be absolute. */
export function renderDownloadPage(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#2B2621">
<title>Get Sentient</title>
${FONTS_LINK}
<style>${STYLE}</style></head><body>
<main class="card">
  <h1 class="brand">Sentient</h1>
  <p class="sub">Install the family assistant on your phone.</p>
  <a class="btn btn--android" href="/download/android/latest.apk">Download for Android</a>
  <a class="btn btn--ios" href="${ITMS(base)}">Install on iPhone</a>
  <p class="note">iPhone install works on registered devices only (ad-hoc provisioning).</p>
  <hr class="rule">
  <p class="ver" id="ver"></p>
</main>
<script>
  fetch("/download/manifest.json").then(function(r){return r.json()}).then(function(m){
    var a=m&&m.android,i=m&&m.ios;
    document.getElementById("ver").textContent=
      "Android "+(a?a.versionName:"?")+"  ·  iOS "+(i?i.shortVersion:"?");
  }).catch(function(){});
</script>
</body></html>`;
}
