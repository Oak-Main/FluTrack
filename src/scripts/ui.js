// ===========================================================================
// UI chrome — explicit system/light/dark control, mobile nav, service worker.
// Progressive enhancement remains intact when this module does not run.
// ===========================================================================

const root = document.documentElement;
const STORAGE_KEY = 'flutrack-theme';

function selectedPreference() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  } catch (e) {
    return root.getAttribute('data-theme') || 'system';
  }
}

function syncThemeControl(preference) {
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
  });
}

function applyTheme(preference) {
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  try { localStorage.setItem(STORAGE_KEY, preference); } catch (e) { /* storage may be blocked */ }
  syncThemeControl(preference);
}

function initTheme() {
  const control = document.getElementById('theme-toggle');
  if (!control) return;
  syncThemeControl(selectedPreference());
  control.addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-choice]');
    if (button) applyTheme(button.dataset.themeChoice);
  });
}

function initNav() {
  const toggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('primary-nav');
  if (!toggle || !nav) return;
  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) nav.querySelector('a[href]')?.focus();
  };
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  document.addEventListener('click', (event) => {
    if (nav.classList.contains('is-open') && !nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
  });
  nav.addEventListener('click', (event) => { if (event.target.closest('a')) setOpen(false); });
}

function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
}

initTheme();
initNav();
initServiceWorker();
