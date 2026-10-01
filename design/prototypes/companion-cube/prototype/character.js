// Reviewable motion draft. Timers affect sprite frames only, never device state.
const catMotions={
 ready:{label:'Ready',frames:[['ready',0],['blink',900],['ready',1020]],still:'ready',note:'Open eyes, neutral muzzle. One 120 ms blink after entry, then still. No idle loop.'},
 listening:{label:'Listening',frames:[['listening',0]],still:'listening',note:'Ears up and paw raised immediately on capture. Hold this pose until release; no pulse.'},
 thinking:{label:'Thinking',frames:[['ready',0],['thinking',180]],still:'thinking',note:'Look aside once after 180 ms, then still. Three-dot status appears immediately; no scanning loop.'},
 speaking:{label:'Speaking',frames:[['speaking',0],['ready',500]],period:1000,still:'speaking',note:'Open / closed mouth, 500 ms each, only while reply audio plays. Two frame changes per second; not lip-sync.'},
 offline:{label:'Unavailable',frames:[['offline',0]],still:'offline',note:'Lower tail, quiet eyes. Static. Used for network or account attention; status icon explains the cause.'},
 low:{label:'Low battery',frames:[['low',0]],still:'low',note:'Resting pose, static. Same sprite may be reused from unavailable; battery icon carries meaning. Active voice pose takes priority.'},
 sleep:{label:'Display asleep',frames:[],still:null,note:'No character rendered. Display off. First touch wakes only; ready pose appears without recording.'}
};
const motionSlots={};
let catMotionEnabled=true,characterState='ready';
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
function stopCatMotion(slot){(motionSlots[slot]||[]).forEach(clearTimeout);motionSlots[slot]=[]}
function catMotionFor(state){if(['pairing','volume'].includes(state))return {...catMotions.ready,frames:[['ready',0]]};return catMotions[state]||catMotions[['service','recovery'].includes(state)?'offline':'ready']}
function animateCat(slot,container,state){
 stopCatMotion(slot);
 const node=typeof container==='string'?document.querySelector(container):container;
 const image=node?.querySelector('.pixel-buddy');
 const motion=catMotionFor(state);
 if(!image||!motion.still)return;
 const paint=frame=>{if(image.isConnected)image.src=`assets/cat-${frame}.svg`};
 if(!catMotionEnabled||reducedMotion.matches||document.hidden){paint(motion.still);return}
 function cycle(){
  motionSlots[slot]=[];
  for(const [frame,time] of motion.frames){if(time===0)paint(frame);else motionSlots[slot].push(setTimeout(()=>paint(frame),time))}
  if(motion.period)motionSlots[slot].push(setTimeout(cycle,motion.period));
 }
 cycle();
}
window.animateCat=animateCat;
function frameRail(m){return m.frames.length?m.frames.map(([frame,time])=>`<figure><img src="assets/cat-${frame}.svg" alt="${frame} frame"><figcaption>${time} ms</figcaption><code>${frame}</code></figure>`).join(''):'<div class="off-frame">Display off</div>'}
function renderCharacterPreview(){const m=catMotions[characterState]||catMotions.ready;document.querySelector('#character-stage').innerHTML=`<div class="character-isolate">${m.still?`<img class="pixel-buddy" src="assets/cat-${m.still}.svg" alt="${m.label} cat">`:'<span>Display off</span>'}</div><h3>${m.label}</h3><p>${m.note}</p>`;animateCat('character','#character-stage',characterState)}
document.querySelector('#character-cards').innerHTML=Object.entries(catMotions).map(([id,m])=>`<article class="character-card" id="character-${id}"><div class="character-card-title"><h3>${m.label}</h3><span>${m.period?'2 frames / second':m.frames.length>1?'Once on entry':'No animation'}</span></div><div class="frame-rail">${frameRail(m)}</div><p>${m.note}</p></article>`).join('');
document.querySelector('#replay-character').addEventListener('click',renderCharacterPreview);
window.setCharacterReview=(state='ready',motion=true)=>{characterState=state;catMotionEnabled=motion;renderCharacterPreview();const live=document.querySelector('#live .screen');if(live)animateCat('cube','#live',live.dataset.state)};
function settleMotion(){Object.keys(motionSlots).forEach(stopCatMotion);renderCharacterPreview();const live=document.querySelector('#live .screen');if(live)animateCat('cube','#live',live.dataset.state)}
reducedMotion.addEventListener('change',settleMotion);
document.addEventListener('visibilitychange',settleMotion);
renderCharacterPreview();
