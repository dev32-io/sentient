/* Cross-platform Sentient avatar component. Canonical SVG assets own all artwork and internal motion. */
(() => {
  if (customElements.get('sentient-avatar')) return;

  const SCRIPT_BASE = document.currentScript?.src ? new URL('.', document.currentScript.src) : new URL('./sentient-design/avatars/', document.baseURI);
  const asset = (name) => new URL(name, SCRIPT_BASE).href;
  const STATES = Object.freeze({
    idle: asset('sentient-mark.svg'),
    thinking: asset('sentient-avatar-thinking.svg'),
    responding: asset('sentient-avatar-responding.svg')
  });
  const LABELS = Object.freeze({
    idle: 'Sentient is idle',
    thinking: 'Sentient is thinking',
    responding: 'Sentient is responding'
  });

  class SentientAvatar extends HTMLElement {
    static get observedAttributes() { return ['state', 'from', 'label']; }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._rendered = false;
    }

    connectedCallback() {
      if (!this.hasAttribute('state')) this.setAttribute('state', 'idle');
      this.render();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (!this.isConnected || oldValue === newValue || this._updatingState) return;
      if (!this._rendered) return this.render();
      if (name === 'state') this.transitionTo(newValue, oldValue);
      if (name === 'label') this.syncAccessibility();
    }

    get state() { return this.validState(this.getAttribute('state')); }
    set state(value) { this.transitionTo(value); }

    validState(value) { return Object.hasOwn(STATES, value) ? value : 'idle'; }
    asset(state) { return STATES[this.validState(state)]; }

    render() {
      const state = this.state;
      const from = this.validState(this.getAttribute('from') || state);
      this.shadowRoot.innerHTML = `
        <style>
          :host{position:relative;display:block;inline-size:var(--sentient-avatar-size,100%);block-size:var(--sentient-avatar-size,100%);overflow:visible;isolation:isolate}
          img{position:absolute;inset:0;display:block;inline-size:100%;block-size:100%;object-fit:contain;pointer-events:none;filter:none}
          .from{opacity:0}.to{opacity:1}
          :host([data-changing]) .from{animation:avatar-out 250ms ease both}
          :host([data-changing]) .to{animation:avatar-in 250ms ease both}
          :host([state="responding"][data-changing]) .to{animation-duration:250ms}
          @keyframes avatar-out{0%{opacity:1;transform:scale(1)}55%{opacity:.44;transform:scale(.94)}100%{opacity:0;transform:scale(.88)}}
          @keyframes avatar-in{0%{opacity:0;transform:scale(.78) rotate(-5deg)}48%{opacity:.74;transform:scale(1.06) rotate(1deg)}100%{opacity:1;transform:scale(1) rotate(0)}}
          @media(prefers-reduced-motion:reduce){.from{display:none!important;animation:none!important}.to{opacity:1!important;animation:none!important;transform:none!important}}
        </style>
        <img class="from" src="${this.asset(from)}" alt="">
        <img class="to" src="${this.asset(state)}" alt="">
      `;
      this._rendered = true;
      this.syncAccessibility();
      if (from !== state) this.animate();
    }

    transitionTo(nextState, fromState) {
      const next = this.validState(nextState);
      const current = this.validState(fromState || this.state);
      if (!this._rendered) {
        this.setAttribute('state', next);
        return;
      }
      const fromImage = this.shadowRoot.querySelector('.from');
      const toImage = this.shadowRoot.querySelector('.to');
      if (!fromImage || !toImage) return;
      if (next === current && toImage.getAttribute('src') === this.asset(next)) return;
      fromImage.src = toImage.getAttribute('src');
      toImage.src = this.asset(next);
      if (this.getAttribute('state') !== next) {
        this._updatingState = true;
        this.setAttribute('state', next);
        this._updatingState = false;
      }
      this.setAttribute('from', current);
      this.syncAccessibility();
      this.animate();
      this.dispatchEvent(new CustomEvent('statechange', { detail: { from: current, state: next }, bubbles: true }));
    }

    interrupt() { this.transitionTo('idle'); }

    animate() {
      this.removeAttribute('data-changing');
      void this.offsetWidth;
      this.setAttribute('data-changing', '');
    }

    syncAccessibility() {
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', this.getAttribute('label') || LABELS[this.state]);
    }
  }

  SentientAvatar.states = STATES;
  customElements.define('sentient-avatar', SentientAvatar);
})();
