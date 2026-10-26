/**
 * QwenWave — entry point.
 * Guards for the browser features the studio needs (secure context for mic +
 * AudioWorklet, IndexedDB, WebAssembly) and then boots the app shell.
 */

(function capabilityCheck() {
  const problems = [];
  const ua = navigator.userAgent;
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  const safariVer = isSafari ? +(ua.match(/Version\/(\d+\.\d+)/)?.[1] || 0) : 99;

  if (!window.AudioContext && !window.webkitAudioContext) problems.push('Web Audio API не поддерживается этим браузером.');
  if (isSafari && safariVer < 16.4) problems.push('Safari ниже 16.4: AudioWorklet может быть недоступен — обновите браузер или используйте Chrome/Firefox.');
  if (!window.indexedDB) problems.push('IndexedDB недоступен — проекты и сэмплы не смогут сохраняться.');
  if (!window.MediaRecorder) problems.push('MediaRecorder недоступен — запись с микрофона не будет работать.');
  if (!window.isSecureContext) {
    problems.push('Страница открыта не в защищённом контексте. Для записи с микрофона и AudioWorklet нужен https:// или http://localhost. ' +
      'Запустите: python3 serve.py  →  http://localhost:8000');
  }
  if (problems.length) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;background:#3a1a20;color:#ffd7dc;' +
      'border-bottom:1px solid #6b2b34;padding:10px 16px;font:12.5px/1.5 system-ui;white-space:pre-line';
    box.textContent = '⚠ ' + problems.join('\n⚠ ');
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'float:right;background:none;border:none;color:#ffd7dc;font-size:15px;cursor:pointer';
    close.onclick = () => box.remove();
    box.prepend(close);
    (document.body || document.documentElement).append(box);
    console.warn('[QwenWave] capability issues:', problems);
  }
})();

window.addEventListener('error', (e) => {
  console.error('[QwenWave] runtime error', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[QwenWave] unhandled rejection', e.reason);
});

// warn before losing unsaved work
window.addEventListener('beforeunload', (e) => {
  try {
    const { Store } = window.__qw || {};
    if (Store?.dirty) { e.preventDefault(); e.returnValue = ''; }
  } catch {}
});

const { boot } = await import('./ui/app.js');
boot().catch((err) => {
  console.error('boot failed', err);
  const s = document.getElementById('splash-status');
  if (s) {
    s.textContent = 'Ошибка запуска: ' + (err?.message || err);
    s.style.color = '#ff5d6c';
  }
});
