const cards = document.querySelector('#cards');
const announce = text => { document.querySelector('#announcement').textContent = text; };
const dialog = document.querySelector('#dialog');
const samples = [
  ['Today · 8:30 am', 'Your morning summary is ready. A quiet start, with everything in one place.'],
  ['Yesterday · 6:00 pm', 'Your weekly meal ideas are ready. Pick up the conversation whenever you like.'],
  ['Yesterday · 8:30 am', 'Scheduled conversation interrupted.']
];
let pendingConfirm;
const edit = document.querySelector('#edit');
function editMode(enabled) {
  edit.setAttribute('aria-pressed', String(enabled));
  edit.textContent = enabled ? 'Done' : 'Edit';
}
function showDialog(title, copy, confirm) {
  document.querySelector('#dialog-title').textContent = title;
  document.querySelector('#dialog-copy').textContent = copy;
  document.querySelector('#dialog-confirm').hidden = !confirm;
  document.querySelector('#dialog-cancel').textContent = confirm ? 'Cancel' : 'Close';
  pendingConfirm = confirm;
  dialog.showModal();
}
document.querySelector('#dialog-cancel').onclick = () => dialog.close();
document.querySelector('#dialog-confirm').onclick = () => { dialog.close(); pendingConfirm?.(); };
function updateEmpty() {
  const empty = !cards.children.length;
  document.querySelector('.empty').hidden = !empty;
  document.querySelector('#clear-all').disabled = empty;
  edit.disabled = empty;
  if (empty) editMode(false);
}
function settle(row, distance) {
  row.dataset.offset = distance;
  row.style.setProperty('--offset', `${-distance}px`);
  row.classList.remove('armed', 'dragging');
  row.querySelector('.clear-key span').textContent = 'Clear';
  row.querySelector('.clear-key').inert = distance === 0;

}
function reveal(row) {
  if (!row) return;
  editMode(false);
  cards.querySelectorAll('.card-slot').forEach(other => settle(other, other === row ? 114 : 0));
  announce('Clear revealed. Tap Clear, or swipe farther left to dismiss.');
}
function clearCard(row) {
  if (row.classList.contains('removing')) return;
  const hadFocus = row.contains(document.activeElement);
  const next = row.nextElementSibling || row.previousElementSibling;
  row.classList.add('removing');
  row.inert = true;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    row.remove();
    updateEmpty();
    if (hadFocus) (next?.querySelector('.card-open') || document.querySelector('#reset')).focus();
    announce('Card cleared. Chat and schedule kept.');
  }, reduced ? 0 : 250);
}
function reset() {
  cards.replaceChildren();
  editMode(false);
  samples.forEach(([time, preview], index) => {
    const row = document.createElement('article');
    row.className = 'card-slot';
    row.innerHTML = `<div class="well"><button class="clear-key" id="clear-${index}" aria-label="Clear notification ${index + 1}" inert><svg aria-hidden="true"><use href="#close"/></svg><span>Clear</span></button></div><div class="card-face"><button class="card-open" aria-describedby="swipe-hint" aria-label="${preview} ${time}. Opens chat"><span class="meta">${time}</span><span class="preview">${preview}</span></button></div>`;
    cards.append(row);
    settle(row, 0);
    let gesture;
    let suppressClick = false;
    const face = row.querySelector('.card-face');
    row.querySelector('.clear-key').onclick = () => clearCard(row);
    row.querySelector('.card-open').onclick = () => {
      if (Number(row.dataset.offset)) { settle(row, 0); return; }
      showDialog('Open conversation', 'In the app, this opens the linked chat, then clears the card after successful navigation. This study stays in the inbox.');
    };
    face.addEventListener('click', event => {
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
    }, true);
    face.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      gesture = { x: event.clientX, y: event.clientY, initial: Number(row.dataset.offset), distance: Number(row.dataset.offset), locked: false };
    });
    face.addEventListener('pointermove', event => {
      if (!gesture) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.locked) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { gesture = null; return; }
        if (Math.abs(dx) < 8) return;
        gesture.locked = true;
        editMode(false);
        face.setPointerCapture(event.pointerId);
        cards.querySelectorAll('.card-slot').forEach(other => { if (other !== row) settle(other, 0); });
        row.classList.add('dragging');
      }
      gesture.distance = Math.max(0, Math.min(row.clientWidth, gesture.initial - dx));
      row.style.setProperty('--offset', `${-gesture.distance}px`);
      const armed = gesture.distance >= row.clientWidth * .42;
      row.classList.toggle('armed', armed);
      row.querySelector('.clear-key span').textContent = armed ? 'Release to clear' : 'Clear';
      suppressClick = true;
    });
    face.addEventListener('pointerup', () => {
      if (!gesture) return;
      if (gesture.locked) {
        if (gesture.distance >= row.clientWidth * .42) clearCard(row);
        else settle(row, gesture.distance >= 48 ? 114 : 0);
      }
      gesture = null;
    });
    face.addEventListener('pointercancel', () => { if (gesture) settle(row, gesture.initial); gesture = null; });
    row.addEventListener('keydown', event => {
      if (event.key === 'Escape') { settle(row, 0); row.querySelector('.card-open').focus(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); reveal(row); row.querySelector('.clear-key').focus(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); settle(row, 0); row.querySelector('.card-open').focus(); }
    });
  });
  updateEmpty();
  announce('Demo ready. Swipe left on any card.');
}
edit.onclick = () => {
  const enabled = edit.getAttribute('aria-pressed') !== 'true';
  editMode(enabled);
  cards.querySelectorAll('.card-slot').forEach(row => settle(row, enabled ? 114 : 0));
  announce(enabled ? 'Clear actions revealed. Chats and schedules stay.' : 'Clear actions closed.');
};
document.querySelector('#reset').onclick = reset;
document.querySelector('#reveal').onclick = () => reveal(cards.querySelector('.card-slot'));
document.querySelector('#back-button').onclick = () => showDialog('Inbox preview', 'Back returns to the previous screen in the app. This prototype focuses on notification cards.');
document.querySelector('#clear-all').onclick = () => showDialog('Clear all messages?', 'This removes cards from this inbox. Chats, messages and schedules are preserved.', () => {
  cards.replaceChildren(); updateEmpty(); document.querySelector('#reset').focus(); announce('All cards cleared. Chats and schedules kept.');
});
reset();
