import { advancePosition, positionForScroll, scrollForPosition } from './playback.js';

const $ = (id) => document.getElementById(id);
const sample = `You have something worth saying.

Give it a little space. Find your rhythm. And let the words come to you.

This is your place to practice a presentation, record a video, or get comfortable with your next big idea.

Start by importing your script. A Word document, a PDF, a text file, or a little Markdown. You can also write or paste your words right here.

Set a pace that feels natural. Make the text a little bigger. Take a breath, look up, and press play.

There’s no rush to get it perfect. Pause whenever you need to. Start over as often as you like.

The best delivery sounds like you.

So settle in. Find your voice. And make this take your own.`;
let text = sample;
let words = [];
let rows = [];
let position = 0;
let speed = 140;
let fontSize = window.matchMedia('(max-width: 800px)').matches ? 32 : 48;
let playing = false;
let mirrored = false;
let lastFrame = null;
let animationFrame;
let targetScroll = 0;
let toastTimer;
let themeSignature = '';
let imported = false;
const stage = $('reading-window');
const prompter = $('prompter');

function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  if (document.fullscreenElement) prompter.append($('toast'));
  else document.body.append($('toast'));
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}

function time(seconds) {
  const value = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function updateProgress() {
  const fraction = words.length ? position / words.length : 0;
  $('progress').value = Math.round(fraction * 1000);
  $('progress').style.setProperty('--progress', `${fraction * 100}%`);
  $('elapsed').textContent = time(position / speed * 60);
  $('remaining').textContent = `−${time((words.length - position) / speed * 60)}`;
  $('duration').textContent = `${Math.max(1, Math.ceil(words.length / speed))} min read`;
}

function measure() {
  const cue = Math.round(stage.clientHeight * 0.26);
  prompter.style.setProperty('--cue-offset', `${cue}px`);
  prompter.style.setProperty('--bottom-padding', `${stage.clientHeight - cue}px`);
  const base = $('script').getBoundingClientRect().top;
  rows = [];
  words.forEach((word, index) => {
    const y = Math.round(word.getBoundingClientRect().top - base - cue);
    const previous = rows.at(-1);
    if (!previous || Math.abs(previous.y - y) > 2) rows.push({ y, start: index });
  });
  if (rows.length) {
    // Align the word box, rather than its font ascent, with the cue line.
    const origin = rows[0].y;
    rows.forEach((row) => { row.y -= origin; });
    const last = rows.at(-1);
    const lineHeight = parseFloat(getComputedStyle($('script')).lineHeight);
    rows.push({ y: last.y + lineHeight, start: words.length });
  }
  moveToPosition();
}

function moveToPosition() {
  if (rows.length < 2) return;
  targetScroll = scrollForPosition(rows, position);
  stage.scrollTop = targetScroll;
  targetScroll = stage.scrollTop;
  updateProgress();
}

function setPlaying(value) {
  cancelAnimationFrame(animationFrame);
  playing = value;
  lastFrame = null;
  prompter.classList.toggle('is-playing', playing);
  $('play-icon').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play-label').textContent = playing ? 'Pause reading' : position >= words.length ? 'Read again' : position > 0 ? 'Resume reading' : 'Start reading';
  $('status').textContent = playing ? 'READING IN PROGRESS' : position >= words.length ? 'THAT’S A WRAP' : position > 0 ? 'PAUSED · TAKE YOUR TIME' : 'READY WHEN YOU ARE';
  $('stage-hint').textContent = playing ? 'Find your rhythm. You’ve got this.' : position >= words.length ? 'A good take. Ready for another?' : position > 0 ? 'Your words will wait.' : 'Take a breath. Press play.';
  if (playing) {
    animationFrame = requestAnimationFrame(tick);
    acquireWakeLock();
  } else releaseWakeLock();
}

function togglePlaying() {
  if (imported) return;
  if (position >= words.length) { position = 0; moveToPosition(); }
  setPlaying(!playing);
}

function tick(timestamp) {
  if (!playing) return;
  if (lastFrame !== null) {
    position = advancePosition(position, words.length, speed, Math.min((timestamp - lastFrame) / 1000, 0.1));
    moveToPosition();
  }
  lastFrame = timestamp;
  if (position >= words.length) setPlaying(false);
  else animationFrame = requestAnimationFrame(tick);
}

function loadScript(value, title, isSample = false) {
  text = value.trim();
  const fragment = document.createDocumentFragment();
  for (const paragraph of text.split(/\n\s*\n/)) {
    const p = document.createElement('p');
    const tokens = paragraph.trim().split(/\s+/).filter(Boolean);
    tokens.forEach((token, index) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = token;
      p.append(span);
      if (index < tokens.length - 1) p.append(' ');
    });
    if (tokens.length) fragment.append(p);
  }
  $('script').replaceChildren(fragment);
  words = Array.from($('script').querySelectorAll('.word'));
  position = 0;
  $('script-title').textContent = title;
  $('sample-label').hidden = !isSample;
  $('word-count').textContent = `${words.length.toLocaleString()} words`;
  setPlaying(false);
  measure();
}

function changeSpeed(value) {
  speed = Math.max(40, Math.min(300, Math.round(Number(value) / 5) * 5));
  $('speed').value = speed;
  $('speed-value').value = speed;
  updateProgress();
  saveSettings();
}

function changeSize(delta) {
  fontSize = Math.max(24, Math.min(80, fontSize + delta));
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
  $('size-value').value = `${fontSize} px`;
  $('smaller').disabled = fontSize <= 24;
  $('larger').disabled = fontSize >= 80;
  measure();
  saveSettings();
}

function toggleMirror() {
  mirrored = !mirrored;
  $('script').classList.toggle('mirrored', mirrored);
  $('mirror').setAttribute('aria-pressed', String(mirrored));
  saveSettings();
}

function saveSettings() {
  try { localStorage.setItem('omarchy-prompter-settings', JSON.stringify({ speed, fontSize, mirrored })); } catch { /* Private mode may block storage. */ }
}

async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await prompter.requestFullscreen();
  } catch { notify('Fullscreen is unavailable in this browser. Try maximizing the window.'); }
}

document.addEventListener('fullscreenchange', () => {
  const full = Boolean(document.fullscreenElement);
  $('fullscreen').setAttribute('aria-label', full ? 'Leave fullscreen' : 'Enter fullscreen');
  $('fullscreen').title = full ? 'Leave fullscreen (F)' : 'Fullscreen (F)';
  if (!full) document.body.append($('toast'));
  measure();
});

let wakeLock;
let wakeLockRequest;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || wakeLockRequest) return;
  try {
    wakeLockRequest = navigator.wakeLock.request('screen');
    const acquired = await wakeLockRequest;
    if (playing) {
      wakeLock = acquired;
      acquired.addEventListener('release', () => {
        if (wakeLock === acquired) wakeLock = undefined;
      }, { once: true });
    } else await acquired.release();
  } catch { /* Optional enhancement. */ }
  finally { wakeLockRequest = undefined; }
}
function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = undefined; }
document.addEventListener('visibilitychange', () => { if (document.hidden && playing) setPlaying(false); });

async function refreshTheme() {
  try {
    const response = await fetch('/api/theme', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const theme = await response.json();
    const signature = JSON.stringify(theme);
    if (signature === themeSignature) return;
    themeSignature = signature;
    for (const key of ['background', 'foreground', 'accent']) {
      if (/^#[\da-f]{6}$/i.test(theme[key])) document.documentElement.style.setProperty(`--${key}`, theme[key]);
    }
    document.documentElement.style.colorScheme = theme.mode === 'light' ? 'light' : 'dark';
    $('theme-name').textContent = theme.connected ? theme.name : `${theme.name} · fallback`;
    $('theme-indicator').title = theme.connected ? 'Following your Omarchy theme automatically' : 'Omarchy theme not found. Using the built-in Tokyo Night palette.';
    document.querySelector('meta[name="theme-color"]').content = theme.background;
  } catch {
    $('theme-name').textContent = 'Theme connection lost';
    $('theme-indicator').title = 'Check that the local server is still running.';
    themeSignature = '';
  }
}

async function importFile(file) {
  if (!file || imported) return;
  setPlaying(false);
  if (file.size > 10 * 1024 * 1024) return notify('Choose a file smaller than 10 MB.');
  imported = true;
  $('import').disabled = true;
  $('edit').disabled = true;
  $('play').disabled = true;
  $('import').querySelector('span').textContent = 'Importing…';
  try {
    const response = await fetch(`/api/import?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The script could not be imported.');
    loadScript(result.text, file.name.replace(/\.[^.]+$/, ''));
    notify(`“${file.name}” is ready. Find your pace and press play.`);
  } catch (error) {
    // Fetch failures use different wording in Chromium, Firefox, and WebKit.
    notify(error instanceof TypeError ? 'The local server is unavailable. Start it again and retry.' : error.message);
  } finally {
    imported = false;
    $('import').disabled = false;
    $('edit').disabled = false;
    $('play').disabled = false;
    $('import').querySelector('span').textContent = 'Import script';
    $('file-input').value = '';
  }
}

$('play').addEventListener('click', togglePlaying);
$('reset').addEventListener('click', () => { setPlaying(false); position = 0; moveToPosition(); setPlaying(false); });
$('speed').addEventListener('input', (event) => changeSpeed(event.target.value));
$('smaller').addEventListener('click', () => changeSize(-4));
$('larger').addEventListener('click', () => changeSize(4));
$('mirror').addEventListener('click', toggleMirror);
$('fullscreen').addEventListener('click', fullscreen);
$('progress').addEventListener('input', (event) => {
  setPlaying(false);
  position = Number(event.target.value) / 1000 * words.length;
  moveToPosition();
  setPlaying(false);
});
$('import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => importFile(event.target.files[0]));
$('edit').addEventListener('click', () => {
  setPlaying(false);
  $('title-input').value = $('script-title').textContent;
  $('script-input').value = text;
  $('editor-dialog').showModal();
});
$('close-editor').addEventListener('click', () => $('editor-dialog').close());
$('editor-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('script-input').value.trim();
  if (!value) { $('script-input').setCustomValidity('Write a few words to start your script.'); $('script-input').reportValidity(); return; }
  loadScript(value, $('title-input').value.trim() || 'Untitled script');
  $('editor-dialog').close();
});
$('script-input').addEventListener('input', () => $('script-input').setCustomValidity(''));
$('shortcuts').addEventListener('click', () => { setPlaying(false); $('shortcuts-dialog').showModal(); });
$('close-shortcuts').addEventListener('click', () => $('shortcuts-dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });

stage.addEventListener('wheel', () => { if (playing) setPlaying(false); }, { passive: true });
stage.addEventListener('touchstart', () => { if (playing) setPlaying(false); }, { passive: true });
stage.addEventListener('scroll', () => {
  if (Math.abs(stage.scrollTop - targetScroll) < 1 || rows.length < 2) return;
  if (playing) setPlaying(false);
  position = positionForScroll(rows, stage.scrollTop);
  targetScroll = stage.scrollTop;
  updateProgress();
  setPlaying(false);
});

let dragDepth = 0;
document.addEventListener('dragenter', (event) => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepth++; prompter.classList.add('dragging'); });
document.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', (event) => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; prompter.classList.remove('dragging'); } });
document.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; prompter.classList.remove('dragging'); importFile(event.dataTransfer.files[0]); });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && playing) setPlaying(false);
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.matches('input,textarea,select,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if (event.target.closest('button') && (event.code === 'Space' || event.key === 'Enter')) return;
  const actions = { Space: togglePlaying, ArrowUp: () => changeSpeed(speed + 5), ArrowDown: () => changeSpeed(speed - 5), KeyR: () => $('reset').click(), KeyM: toggleMirror, KeyF: fullscreen };
  if (actions[event.code]) { event.preventDefault(); if (!event.repeat || event.code.startsWith('Arrow')) actions[event.code](); }
});

try {
  const saved = JSON.parse(localStorage.getItem('omarchy-prompter-settings') || '{}');
  if (Number.isFinite(saved.speed)) speed = saved.speed;
  if (Number.isFinite(saved.fontSize)) fontSize = Math.max(24, Math.min(80, saved.fontSize));
  if (saved.mirrored === true) toggleMirror();
} catch { /* Settings are optional; scripts are never stored. */ }
loadScript(sample, 'The opening take', true);
changeSpeed(speed);
changeSize(0);
new ResizeObserver(() => measure()).observe(stage);
refreshTheme();
setInterval(refreshTheme, 1500);
