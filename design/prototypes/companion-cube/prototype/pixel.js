// Browser references for small, pre-rasterized device graphics. No animation loop.
function cubeIcon(name,extra=''){
 const paths={mic:'<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',wifi:'<path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/>',offline:'<path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0M3 3l18 18"/>',speaker:'<path d="M3 9h4l5-4v14l-5-4H3zM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/>',phone:'<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',dots:'<path d="M3 10h3v3H3zm7 0h3v3h-3zm7 0h3v3h-3z" fill="currentColor" stroke="none"/>',retry:'<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>',plug:'<path d="M8 3v5m8-5v5M6 8h12v5l-4 4v4h-4v-4l-4-4z"/>',check:'<path d="m5 12 5 5L20 6"/>',scan:'<path d="M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5M7 12h10"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>'};
 return `<svg class="graphic ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.wifi}</svg>`;
}
function character(id='ready'){
 const pose=['listening','thinking','speaking','offline','low'].includes(id)?id:['service','recovery'].includes(id)?'offline':'ready';
 return `<img class="pixel-buddy" src="assets/cat-${pose}.svg" alt="" draggable="false">`;
}
window.cubeCharacter=character;
function battery(id){const low=id==='low',charge=id==='charging';return `<svg class="battery" viewBox="0 0 40 24" aria-hidden="true"><path d="M2 5h31v14H2zM36 9h3v6h-3z" fill="none" stroke="currentColor" stroke-width="2"/>${charge?'<path d="m20 6-8 8h6l-2 5 9-9h-7z" fill="currentColor"/>':`<path d="M6 8h5v8H6z${low?'':'M14 8h5v8h-5zM22 8h5v8h-5z'}" fill="currentColor"/>`}</svg>`}
function cubeMarkup(id,interactive=false){
 const s=states[id];
 const active=['listening','thinking','speaking'].includes(id);
 const status={ready:'wifi',setup:'scan',pairing:'phone',listening:'mic',thinking:'dots',speaking:'speaker',offline:'offline',service:'offline',recovery:'lock',volume:'speaker',low:'plug',charging:'wifi',sleep:'wifi'}[id];
 const bubble={ready:'mic',listening:'mic',thinking:'dots',speaking:'speaker',offline:'offline',service:'retry',recovery:'phone',pairing:'phone',volume:'speaker',low:'plug',charging:'mic',sleep:'mic'}[id];
 const hint={offline:'No Wi-Fi',service:'Can’t connect',recovery:'Open app',pairing:'Finish in app',low:'Charge soon'}[id]||'';
 const scene=id==='setup'?'<div class="cat-scene qr-scene"><img class="setup-code" src="assets/setup-preview.svg" alt="Preview setup code, not valid for enrollment"></div>':`<div class="cat-scene">${character(id)}<div class="cat-bubble ${id==='listening'?'capturing':''}" aria-hidden="true">${cubeIcon(bubble)}</div><div class="pixel-ground" aria-hidden="true"></div></div>`;
 const control=s.passive?'':`<button class="cat-touch" aria-label="${s.action||'Wake Cube'}" ${interactive?'':'tabindex="-1"'}></button>`;
 const foot=id==='setup'?`<div class="cat-caption">${cubeIcon('phone')}${cubeIcon('scan')}</div>`:id==='volume'?'<div class="volume-level" role="img" aria-label="Volume 60%"><i></i><i></i><i></i><i class="empty"></i><i class="empty"></i></div>':hint?`<p class="cube-hint">${hint}</p>`:'';
 return `<div class="case"><div class="viewport"><div class="screen ${id==='sleep'?'sleep':''} ${id==='setup'?'qr-screen':''}" data-state="${id}"><div class="safe"><div class="meta"><span class="status" role="img" aria-label="${s.meta||'Display asleep'}">${cubeIcon(status)}${id==='listening'?'<i class="record-dot"></i>':''}</span><span class="battery-state ${id==='low'?'low-battery':''}" role="img" aria-label="${id==='low'?'Battery low':id==='charging'?'Battery charging':'Battery mostly full'}">${battery(id)}</span></div>${scene}${foot}<span class="sr-only" role="status">${active?s.title:''}</span></div>${control}</div></div></div>`;
}
