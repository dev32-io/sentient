/* Browser-only visual simulation. No network, storage, real accounts, or authentication. */
const icon = name => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
const demoPeople = [
  ['Ada','amber'], ['Grace','sage'], ['Alex','terra'], ['Jamie','clay'],
  ['Morgan','sage'], ['Riley','amber'], ['Sam','clay'], ['Taylor','terra'],
  ['Charlie','amber'], ['Harper','sage'], ['Robin','terra'], ['Rowan','clay'],
  ['Alexandra Rose','sage'], ['Benjamin Alexander','amber']
].map(([name,tint], id) => ({id,name,tint}));
let count = 8;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const avatar = person => `<span class="avatar identity-${person.tint}" aria-hidden="true">${person.name[0].toLowerCase()}</span>`;
const connection = () => `<span class="connection"><i class="status-light" aria-hidden="true"></i>Home gateway</span>`;
class Arrival {
  constructor(root) {
    this.root=root; this.platform=root.dataset.platform; this.mobile=this.platform==='mobile'; this.person=null; this.query=''; this.digits=''; this.generation=0; this.mode='picker'; this.renderShell(); this.renderPicker();
    root.addEventListener('click',event=>this.handleClick(event));
    root.addEventListener('input',event=>this.handleInput(event));
    root.addEventListener('submit',event=>{event.preventDefault();this.submitPin();});
    root.addEventListener('keydown',event=>{
      if(event.key==='Escape') {
        if(this.root.querySelector('.local-sheet')) this.closeSheet();
        else if(this.mode==='pin') this.back();
      }
      const sheet=this.root.querySelector('.local-sheet');
      if(sheet && event.key==='Tab') {
        const items=[...sheet.querySelectorAll('button,input,select,[tabindex="0"]')];
        if(event.shiftKey && document.activeElement===items[0]) {event.preventDefault();items.at(-1).focus();}
        else if(!event.shiftKey && document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
      }
    });
  }
  renderShell() {
    this.root.innerHTML=`<header class="app-header"><span class="wordmark"><img src="assets/sentient-mark.svg" alt="">Sentient</span>${this.mobile?`<button class="icon-button" data-action="connection" aria-label="Connection settings">${icon('settings')}</button>`:connection()}</header>
      ${this.mobile?'':`<div class="web-body"><section class="welcome" aria-label="Welcome to Sentient"><div class="brand-object"><sentient-avatar state="idle" label="Sentient"></sentient-avatar></div><h2>A little less to do.<em>A little more home.</em></h2><p>Your family’s everyday,<br>with a little help from Sentient.</p><span class="welcome-signature">Here for the everyday.</span></section>`}
      <div class="auth-stage"><div class="stage-content"></div></div>${this.mobile?'':'</div>'}
      <footer class="app-footer">${this.mobile?connection():`<span>A familiar place for everyone.</span><button class="text-button" data-action="connection">${icon('settings')}Connection settings</button>`}</footer><div class="sr-only announcements" role="status" aria-live="polite" aria-atomic="true"></div>`;
    this.stage=this.root.querySelector('.stage-content');
  }
  announce(message) {this.root.querySelector('.announcements').textContent=message;}
  renderPicker(focusId, first=true) {
    this.mode='picker'; this.digits=''; this.person=null;
    this.stage.innerHTML=`${this.mobile?`<div class="mobile-welcome"><sentient-avatar state="idle" label="Sentient"></sentient-avatar><div><h2>Welcome home.</h2><p>A little help. A little more ease.</p></div></div>`:''}
      <div class="picker-heading"><h2 tabindex="-1">${this.mobile?'Who’s here?':'Welcome home.'}</h2><span class="people-count">${count} people</span></div>
      ${this.mobile?'':'<p class="picker-subtitle">Choose your name. Make yourself at home.</p>'}
      ${count>6?`<label class="search-field">${icon('search')}<span class="sr-only">Find your name</span><input type="search" placeholder="Find your name" autocomplete="off" spellcheck="false" data-search><button class="search-clear" data-action="clear" aria-label="Clear name search" hidden>${icon('close')}</button></label>`:''}
      <div class="people-list ${first?'first-arrival':''}" role="group" aria-label="Choose your profile"></div><p class="picker-help">${icon('lock')} Your pin comes next.</p>`;
    const search=this.stage.querySelector('[data-search]');
    if(search)search.value=this.query;
    this.renderPeople();
    if(focusId!==undefined) {
      const target=this.stage.querySelector(`[data-person="${focusId}"]`)||this.stage.querySelector('h2'); target?.focus({preventScroll:true});
    }
  }
  renderPeople() {
    const people=demoPeople.slice(0,count).filter(p=>p.name.toLowerCase().includes(this.query.trim().toLowerCase()));
    const list=this.stage.querySelector('.people-list');
    list.innerHTML=people.map((p,i)=>`<button class="person" data-person="${p.id}" style="--order:${Math.min(i,7)}" aria-label="Continue as ${p.name}">${avatar(p)}<span class="person-name">${p.name}</span>${icon('chevron')}</button>`).join('')||`<div class="empty"><p>No matching names.</p><p>Try a different spelling.</p><button class="text-button" data-action="clear">Clear search ${icon('arrow')}</button></div>`;
    this.stage.querySelector('.search-clear')?.toggleAttribute('hidden',!this.query);
    this.stage.querySelector('.people-count').textContent=this.query?`${people.length} of ${count}`:`${count} people`;
  }
  async transition(render, direction='forward') {
    const generation=++this.generation;
    this.root.dataset.direction=direction;
    this.stage.classList.remove('entering'); this.stage.classList.add('leaving'); this.stage.inert=true;
    if(!reducedMotion()) await new Promise(resolve=>setTimeout(resolve,140));
    if(generation!==this.generation)return;
    this.stage.classList.remove('leaving');this.stage.inert=false;render();this.stage.classList.add('entering');
  }
  select(id) {
    const person=demoPeople.find(p=>p.id===id); if(!person)return;
    const source=this.stage.querySelector(`[data-person="${id}"] .avatar`);
    const origin=source?.getBoundingClientRect();
    const flight=source?.cloneNode(true);
    this.transition(()=>{
      this.person=person;this.renderPin();
      if(reducedMotion() || !origin || !flight)return;
      const target=this.stage.querySelector('.pin-identity .avatar');
      const destination=target.getBoundingClientRect();const base=this.root.getBoundingClientRect();
      Object.assign(flight.style,{position:'absolute',zIndex:'5',pointerEvents:'none',left:`${origin.left-base.left}px`,top:`${origin.top-base.top}px`,width:`${origin.width}px`,height:`${origin.height}px`,transformOrigin:'top left'});
      this.root.append(flight);target.style.opacity='0';
      const animation=flight.animate([
        {transform:'translate(0,0) scale(1)',opacity:1},
        {transform:`translate(${destination.left-origin.left}px,${destination.top-origin.top}px) scale(${destination.width/origin.width})`,opacity:1}
      ],{duration:300,easing:'cubic-bezier(.22,.8,.24,1)',fill:'forwards'});
      animation.finished.then(()=>{flight.remove();target.style.opacity='';});
    });
  }
  renderPin() {
    this.mode='pin';this.digits='';this.busy=false;
    this.stage.innerHTML=`<form class="pin-view"><button class="text-button back-button" type="button" data-action="back">${icon('back')}Everyone</button>
      <div class="pin-identity">${avatar(this.person)}<div><h2 tabindex="-1">Hello, ${this.person.name}.</h2><p>Enter your four-digit pin.</p></div></div>
      <label class="pin-label" for="${this.platform}-pin">Your pin</label>
      <div class="pin-field"><div class="pin-dots" aria-hidden="true">${'<i></i>'.repeat(4)}</div><input id="${this.platform}-pin" type="password" inputmode="${this.mobile?'none':'numeric'}" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="Four-digit pin" aria-describedby="${this.platform}-pin-message" data-pin></div>
      <p id="${this.platform}-pin-message" class="pin-message" role="status">${this.mobile?'':'Use your keyboard. We’ll sign you in after four digits.'}</p>
      <div class="keypad" role="group" aria-label="Pin keypad">${[1,2,3,4,5,6,7,8,9].map(n=>`<button type="button" data-digit="${n}" aria-label="${n}">${n}</button>`).join('')}<span class="keypad-empty" aria-hidden="true"></span><button type="button" data-digit="0" aria-label="0">0</button><button type="button" data-action="delete" aria-label="Delete last digit">${icon('delete')}</button></div>
      ${this.mobile?'':`<button class="primary-button" type="submit" disabled data-submit>Enter your pin ${icon('arrow')}</button>`}
      <button class="text-button pin-help" type="button" data-action="help">Need help signing in?</button></form>`;
    (this.mobile?this.stage.querySelector('h2'):this.stage.querySelector('[data-pin]')).focus({preventScroll:true});
    this.announce(`Enter the four-digit pin for ${this.person.name}.`);
  }
  setDigits(value) {
    if(this.busy || this.mode!=='pin')return;
    this.digits=value.replace(/\D/g,'').slice(0,4);
    const field=this.stage.querySelector('[data-pin]');field.value=this.digits;
    this.stage.querySelectorAll('.pin-dots i').forEach((dot,i)=>dot.classList.toggle('filled',i<this.digits.length));
    const submit=this.stage.querySelector('[data-submit]');
    if(submit) {submit.disabled=this.digits.length!==4;submit.innerHTML=this.digits.length===4?`Sign in ${icon('arrow')}`:`Enter your pin ${icon('arrow')}`;}
    this.stage.querySelector('.pin-field').classList.remove('invalid');field.removeAttribute('aria-invalid');
    if(this.digits.length===4)this.submitPin();
  }
  async submitPin() {
    if(this.busy || this.mode!=='pin' || this.digits.length!==4)return;
    const correct=this.digits==='1234'; const generation=this.generation;
    this.busy=true;
    const field=this.stage.querySelector('[data-pin]');field.disabled=true;
    this.stage.querySelectorAll('[data-digit],[data-action="delete"]').forEach(b=>b.disabled=true);
    const message=this.stage.querySelector('.pin-message');message.classList.remove('error');message.textContent='Signing in…';
    const submit=this.stage.querySelector('[data-submit]');if(submit){submit.disabled=true;submit.textContent='Signing in…';}
    await new Promise(resolve=>setTimeout(resolve,650));
    if(generation!==this.generation || this.mode!=='pin')return;
    if(correct) {
      this.transition(()=>this.renderSuccess());
    } else {
      this.busy=false;field.disabled=false;this.stage.querySelectorAll('[data-digit],[data-action="delete"]').forEach(b=>b.disabled=false);
      this.setDigits('');message.classList.add('error');message.textContent='That pin didn’t match. Please try again.';
      field.setAttribute('aria-invalid','true');this.stage.querySelector('.pin-field').classList.add('invalid');
      if(!this.mobile)field.focus({preventScroll:true});
    }
  }
  renderSuccess() {
    this.mode='success';this.digits='';
    this.stage.innerHTML=`<div class="success-view"><span class="success-seal">${icon('check')}</span><h2 tabindex="-1">You’re home, ${this.person.name}.</h2><p>This is where your conversation begins.</p><p class="demo-disclaimer">Preview complete. No account was signed in.</p><button class="text-button" data-action="back">${icon('back')}Back to everyone</button></div>`;
    this.stage.querySelector('h2').focus({preventScroll:true});this.announce('Sign-in preview complete. No account was signed in.');
  }
  back() {const id=this.person?.id;this.transition(()=>this.renderPicker(id,false),'back');}
  openSheet(type) {
    if(this.root.querySelector('.local-sheet'))return;
    this.restoreFocus=document.activeElement;
    const connectionSheet=type==='connection';
    const sheet=document.createElement('div');sheet.className='local-sheet';
    sheet.innerHTML=`<section class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="${this.platform}-dialog-title"><button class="icon-button" data-action="close" aria-label="Close">${icon('close')}</button><h2 id="${this.platform}-dialog-title">${connectionSheet?'Your connection':'A little help.'}</h2><p>${connectionSheet?'Sentient connects to your home gateway. This preview uses a fictional household and makes no network requests.':'Forgotten your pin? Ask the person who manages your Sentient accounts to reset it.'}</p>${connectionSheet?`<div class="sheet-info">${icon('home')}<span>Home gateway<small>Preview only · Not a live connection</small></span></div>`:`<div class="sheet-info">${icon('lock')}<span>Exploring the preview?<small>Use the demo pin 1234.</small></span></div>`}<button class="primary-button" data-action="close">Got it ${icon('check')}</button></section>`;
    this.root.append(sheet);
    for(const child of this.root.children)if(child!==sheet){child.dataset.wasInert=String(child.inert);child.inert=true;}
    sheet.querySelector('button').focus({preventScroll:true});
  }
  closeSheet() {
    const sheet=this.root.querySelector('.local-sheet');if(!sheet)return;
    const finish=()=>{sheet.remove();for(const child of this.root.children){child.inert=child.dataset.wasInert==='true';delete child.dataset.wasInert;}if(this.restoreFocus?.isConnected)this.restoreFocus.focus({preventScroll:true});};
    if(reducedMotion())finish();else{const animation=sheet.animate([{opacity:1},{opacity:0}],{duration:150,easing:'ease'});animation.finished.then(finish);}
  }
  handleClick(event) {
    const button=event.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-person'))return this.select(Number(button.dataset.person));
    if(button.hasAttribute('data-digit'))return this.setDigits(this.digits+button.dataset.digit);
    const action=button.dataset.action;
    if(action==='back')this.back();
    if(action==='delete')this.setDigits(this.digits.slice(0,-1));
    if(action==='connection'||action==='help')this.openSheet(action);
    if(action==='close')this.closeSheet();
    if(action==='retry')this.reset();
    if(action==='clear'){this.query='';const input=this.stage.querySelector('[data-search]');if(input){input.value='';input.focus();}this.renderPeople();this.announce(`${count} people.`);}
  }
  handleInput(event) {
    if(event.target.matches('[data-search]')){this.query=event.target.value;this.stage.querySelector('.people-list').classList.remove('first-arrival');this.renderPeople();this.announce(`${this.stage.querySelectorAll('[data-person]').length} matching names.`);}
    if(event.target.matches('[data-pin]'))this.setDigits(event.target.value);
  }
  previewState(state) {
    if(state==='ready')return this.reset();
    ++this.generation;this.busy=false;this.mode=state;this.stage.inert=false;this.stage.className='stage-content entering';
    if(state==='loading')this.stage.innerHTML=`<div class="loading-view" role="status"><h2>Making room for everyone.</h2><p>Loading your profiles…</p><div class="skeleton-list" aria-hidden="true">${'<i><b></b><span></span></i>'.repeat(this.mobile?6:4)}</div></div>`;
    else this.stage.innerHTML=`<div class="recovery-view"><span class="recovery-icon">${icon(state==='empty'?'home':'wifi')}</span><h2 tabindex="-1">${state==='empty'?'A new beginning.':'Let’s reconnect.'}</h2><p>${state==='empty'?'There are no profiles to choose from yet. Ask your Sentient administrator to set up your account.':'We couldn’t reach your home gateway. Check your connection and try again.'}</p><button class="primary-button" data-action="retry">${state==='empty'?'Refresh profiles':'Try again'}${icon('refresh')}</button><button class="text-button" data-action="connection">Connection settings</button></div>`;
    this.announce(state==='loading'?'Loading profiles.':state==='empty'?'No profiles available.':'Cannot reach home gateway.');
  }
  reset() {++this.generation;this.query='';this.person=null;this.busy=false;this.root.querySelector('.local-sheet')?.remove();this.renderShell();this.renderPicker();}
}
const previews=[...document.querySelectorAll('.app')].map(root=>new Arrival(root));
document.querySelectorAll('.view-switch button').forEach(button=>button.addEventListener('click',()=>{
  document.body.dataset.view=button.dataset.view;
  document.querySelectorAll('.view-switch button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
}));
document.querySelector('#household-size').addEventListener('change',event=>{count=Number(event.target.value);previews.forEach(p=>p.reset());document.querySelector('#preview-state').value='ready';});
document.querySelector('#reset').addEventListener('click',()=>{previews.forEach(p=>p.reset());document.querySelector('#preview-state').value='ready';});
const footer=document.querySelector('.review-footer');
const stateControl=document.createElement('label');stateControl.className='state-control';stateControl.innerHTML='Preview state <select id="preview-state"><option value="ready">Ready</option><option value="loading">Loading</option><option value="offline">Connection issue</option><option value="empty">No profiles</option></select>';
footer.append(stateControl);
stateControl.querySelector('select').addEventListener('change',event=>previews.forEach(p=>p.previewState(event.target.value)));
