/**
 * QwenWave — global drag & drop payload bus.
 * Uses a plain object (not DataTransfer) so drags work with custom payloads
 * across the arranger, mixer, piano roll and browser.
 */
export const Drag = {
  payload: null,
  start(payload, ev) {
    this.payload = payload;
    try {
      ev?.dataTransfer?.setData('text/plain', payload.kind || 'qw');
      if (ev && ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove';
    } catch {}
    document.body.classList.add('dragging-global');
  },
  end() { this.payload = null; document.body.classList.remove('dragging-global'); },
  is(kind) { return this.payload?.kind === kind; },
  get() { return this.payload; },
};

/** Attach drop handling to an element. */
export function droppable(el, kinds, onDrop) {
  const list = Array.isArray(kinds) ? kinds : [kinds];
  el.addEventListener('dragover', (e) => {
    if (!Drag.payload || !list.includes(Drag.payload.kind)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-target');
    if (!Drag.payload || !list.includes(Drag.payload.kind)) return;
    e.preventDefault(); e.stopPropagation();
    onDrop(Drag.payload, e);
    Drag.end();
  });
  return el;
}

window.addEventListener('dragend', () => Drag.end());
window.addEventListener('drop', () => Drag.end());
