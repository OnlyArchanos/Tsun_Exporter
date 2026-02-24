// popup.js — Tsun Exporter
'use strict';

const state = { manga: [], verified: [], searchQuery: '', isExtracting: false, isVerifying: false };
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

async function checkAndRedirect() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    
    if (!tab.url.includes('weebcentral.com/users')) {
      chrome.tabs.update(tab.id, { url: 'https://weebcentral.com/users/me/profiles' });
    }
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  checkAndRedirect();
  setupNav();
  setupExtract();
  setupList();
  setupExport();
  setupModal();
  updateTabInfo();
  renderList();
  updateBadges();
  chrome.runtime.onMessage.addListener(onBgMessage);
});

// ── State ──
async function loadState() {
  try {
    const d = await chrome.storage.local.get(['manga', 'verified']);
    if (d.manga) state.manga = d.manga;
    if (d.verified) state.verified = d.verified;
  } catch (e) {}
}

async function persist() {
  await chrome.storage.local.set({ manga: state.manga, verified: state.verified });
}

// ── Nav (sliding indicator) ──
function setupNav() {
  const tabs = [...$$('.nav-tab')];
  tabs.forEach((t, i) => t.addEventListener('click', () => {
    switchTab(t.dataset.tab);
    moveSlider(i, tabs.length);
  }));
}

function moveSlider(index, total) {
  const slider = $('nav-slider');
  const pct = (100 / total);
  slider.style.left = `${index * pct}%`;
  slider.style.width = `${pct}%`;
}

function switchTab(name) {
  $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'list') renderList();
}

// ── Feed ──
function feed(text, type = 'blue', targetId = 'activity-feed') {
  const el = $(targetId);
  if (!el) return;
  el.classList.add('show');
  const item = document.createElement('div');
  item.className = 'feed-item';
  item.innerHTML = `<div class="feed-dot ${type}"></div><span>${esc(text)}</span>`;
  el.appendChild(item);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 10) el.firstChild.remove();
}

function clearFeed(targetId = 'activity-feed') {
  const el = $(targetId);
  if (!el) return;
  el.innerHTML = '';
  el.classList.remove('show');
}

// ── Extract ──
function setupExtract() {
  $('btn-extract-tab').addEventListener('click', extractTab);
  $('btn-extract-url').addEventListener('click', extractUrl);
  $('profile-url').addEventListener('keydown', e => { if (e.key === 'Enter') extractUrl(); });
  $('btn-go-list').addEventListener('click', () => {
    switchTab('list');
    moveSlider(1, 3);
  });
}

async function updateTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('weebcentral.com/users')) {
      $('current-tab-url').textContent = tab.url.replace('https://weebcentral.com', '').slice(0, 40);
    } else {
      $('current-tab-url').textContent = 'Redirecting to profiles page...';
    }
  } catch (e) {}
}

async function extractTab() {
  if (state.isExtracting) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('weebcentral.com/users')) {
    chrome.tabs.update(tab.id, { url: 'https://weebcentral.com/users/me/profiles' });
    toast('Redirecting to WeebCentral...', 'info');
    return;
  }

  state.isExtracting = true;
  clearFeed();
  progress('Connecting...', 5);
  feed('Connecting to page...');

  try {
    let result;
    try { result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_MANGA' }); }
    catch (e) {
      feed('Injecting script...', 'amber');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await sleep(500);
      result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_MANGA' });
    }

    progress('Processing...', 50);
    if (result?.manga?.length > 0) {
      feed(`Found ${result.manga.length} manga`, 'green');
      await processManga(result.manga);
    } else {
      feed('Trying fallback...', 'amber');
      const bg = await msg({ type: 'SCRAPE_PROFILE', url: tab.url });
      if (bg.success && bg.manga.length > 0) {
        feed(`Found ${bg.manga.length} manga`, 'green');
        await processManga(bg.manga);
      } else throw new Error('No manga found');
    }
  } catch (err) {
    feed(err.message, 'red');
    toast(err.message, 'error');
    hideProgress();
  } finally { state.isExtracting = false; }
}

async function extractUrl() {
  if (state.isExtracting) return;
  const url = $('profile-url').value.trim();

  if (!url) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('weebcentral.com')) {
      chrome.tabs.update(tab.id, { url: 'https://weebcentral.com/users/me/profiles' });
      toast('Opening WeebCentral...', 'info');
    } else {
      toast('Enter a profile URL', 'info');
    }
    return;
  }
  if (!url.includes('weebcentral.com')) { toast('Enter a valid URL', 'error'); return; }

  state.isExtracting = true;
  clearFeed();
  progress('Fetching...', 10);
  feed('Fetching profile...');

  try {
    const result = await msg({ type: 'SCRAPE_PROFILE', url });
    progress('Processing...', 55);
    if (result.success && result.manga.length > 0) {
      feed(`Found ${result.manga.length} manga`, 'green');
      await processManga(result.manga);
    } else throw new Error(result.error || 'No manga found');
  } catch (err) {
    feed(err.message, 'red');
    toast(err.message, 'error');
    hideProgress();
  } finally { state.isExtracting = false; }
}

async function processManga(manga) {
  progress('Saving...', 65);
  const existing = new Map(state.manga.map(m => [m.id, m]));
  let added = 0;
  manga.forEach(m => { if (!existing.has(m.id)) { existing.set(m.id, m); added++; } });
  state.manga = [...existing.values()];
  await persist();
  updateBadges();

  feed(`${state.manga.length} saved (${added} new)`, 'green');

  hideProgress();
  $('post-extract-actions').style.display = 'flex';
  toast('Done!', 'success');
}

// ── Progress ──
function progress(label, pct, prefix = 'extract') {
  $(`${prefix}-progress`).classList.add('show');
  $(`${prefix}-progress-label`).textContent = label;
  $(`${prefix}-progress-fill`).style.width = `${pct}%`;
  $(`${prefix}-progress-pct`).textContent = `${Math.round(pct)}%`;
}

function hideProgress(prefix = 'extract') {
  progress('Done', 100, prefix);
  setTimeout(() => { 
    $(`${prefix}-progress`)?.classList.remove('show'); 
    if ($(`${prefix}-progress-fill`)) $(`${prefix}-progress-fill`).style.width = '0%'; 
  }, 800);
}

// ── List ──
function setupList() {
  $('list-search').addEventListener('input', e => { state.searchQuery = e.target.value; renderList(); });
}

const SVG_BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
const SVG_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
const SVG_INBOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

function renderList() {
  const c = $('manga-list');
  const q = state.searchQuery.toLowerCase();
  const vMap = new Map(state.verified.map(v => [v.id, v]));
  let items = state.manga.map(m => ({ ...m, ...(vMap.get(m.id) || {}) }));
  if (q) items = items.filter(m => m.title.toLowerCase().includes(q));

  $('list-count').textContent = items.length;

  if (!items.length) {
    const isSearch = state.manga.length && q;
    c.innerHTML = `<div class="empty"><div class="empty-icon">${isSearch ? SVG_SEARCH : SVG_INBOX}</div><div class="empty-title">${isSearch ? 'No results' : 'No titles yet'}</div><div class="empty-desc">${isSearch ? 'Try a different search term.' : 'Extract from a WeebCentral profile to get started.'}</div></div>`;
    return;
  }

  c.innerHTML = '';
  items.forEach((item, i) => c.appendChild(mkItem(item, i)));
}

function mkItem(item, i) {
  const d = document.createElement('div');
  d.className = 'manga-item';
  d.style.animationDelay = `${i * 25}ms`;

  const thumb = item.thumbnail
    ? `<img class="manga-thumb" src="${esc(item.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">`
    : '';
  const ph = `<div class="manga-thumb-placeholder" ${item.thumbnail ? 'style="display:none"' : ''}>${SVG_BOOK}</div>`;

  d.innerHTML = `${thumb}${ph}<div class="manga-info"><div class="manga-title" title="${esc(item.title)}">${esc(item.title)}</div></div><div class="manga-actions"><div class="act-btn" title="Edit Match" data-action="edit" data-id="${esc(item.id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></div><div class="act-btn" title="Open" data-action="open" data-url="${esc(item.url || '')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></div><div class="act-btn danger" title="Remove" data-action="remove" data-id="${esc(item.id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div></div>`;

  d.addEventListener('click', e => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'open' && a.dataset.url) chrome.tabs.create({ url: a.dataset.url });
    if (a.dataset.action === 'edit') editMatch(a.dataset.id);
    if (a.dataset.action === 'remove') removeManga(a.dataset.id);
  });
  return d;
}

async function removeManga(id) {
  state.manga = state.manga.filter(m => m.id !== id);
  state.verified = state.verified.filter(m => m.id !== id);
  await persist();
  updateBadges(); renderList();
  toast('Removed', 'info');
}

async function editMatch(id) {
  const item = state.manga.find(m => m.id === id);
  if (!item) return;

  const url = window.prompt(`Enter MangaUpdates URL for "${item.title}":\n(Leave empty to clear match)`);
  if (url === null) return; // cancelled

  let matchData = null;
  if (url.trim()) {
    const muMatch = url.match(/series\/([^/]+)(?:\/([^/]+))?/);
    if (!muMatch) {
      toast('Invalid MangaUpdates URL', 'error');
      return;
    }
    matchData = {
      id: parseInt(muMatch[1], 36),
      title: item.title,
      url: url.trim(),
    };
  }

  // Save to background custom match
  await msg({ type: 'SAVE_CUSTOM_MATCH', title: item.title, match: matchData });
  
  // Directly update local verified mapping to instantly reflect the change
  const existingV = state.verified.find(v => v.id === id);
  if (existingV) {
    existingV.muMatch = matchData;
    existingV.confidence = matchData ? 1.0 : 0;
  } else {
    state.verified.push({ id: item.id, title: item.title, muMatch: matchData, confidence: matchData ? 1.0 : 0 });
  }

  await persist();
  toast(matchData ? 'Match updated' : 'Match cleared', 'success');
  renderList();
}

// ── Export ──
function setupExport() {
  $$('.export-option[data-format]').forEach(c => {
    c.addEventListener('click', async () => {
      if (c.dataset.format === 'clipboard') { await copyTitles(); return; }
      await doExport(c.dataset.format);
    });
  });
  $('btn-clear-all').addEventListener('click', () => {
    showModal('Reset All Data', 'This will delete all extracted manga and cached data. This cannot be undone.', async () => {
      state.manga = []; state.verified = [];
      await persist();
      try { await msg({ type: 'CLEAR_CACHE' }); } catch(e) {}
      updateBadges(); renderList(); clearFeed();
      $('post-extract-actions').style.display = 'none';
      toast('Cleared', 'info');
    }, true);
  });
  
  $('btn-export-abort').addEventListener('click', async () => {
    $('btn-export-abort').classList.add('hidden');
    $('btn-export-abort').textContent = 'Aborting...';
    await msg({ type: 'ABORT_EXPORT' });
  });
}

async function doExport(format) {
  if (!state.manga.length) { toast('Extract first', 'error'); return; }
  
  const buttons = $$('.export-option[data-format]');
  buttons.forEach(b => b.style.pointerEvents = 'none');
  const abortBtn = $('btn-export-abort');
  
  if (format === 'mangaupdates') {
    if (state.verified.length !== state.manga.length) {
      clearFeed('export-feed');
      progress('Verifying with MangaUpdates...', 0, 'export');
      feed('Verifying titles...', 'blue', 'export-feed');
      abortBtn.textContent = 'Abort';
      abortBtn.classList.remove('hidden');
      state.isVerifying = true;

      try {
        const result = await msg({ type: 'VERIFY_MANGAUPDATES', titles: state.manga });
        if (result.success) {
          state.verified = result.results;
          await persist();
          const matched = result.results.filter(m => m.muMatch && m.confidence >= 0.7).length;
          feed(`${matched}/${result.results.length} verified`, 'green', 'export-feed');
          updateBadges();
        } else {
          feed('Verification failed', 'red', 'export-feed');
          buttons.forEach(b => b.style.pointerEvents = 'auto');
          return;
        }
      } catch (err) {
        if (err.message?.includes('aborted')) {
          feed('Verification aborted', 'amber', 'export-feed');
          hideProgress('export');
        } else {
          feed('Verify error', 'red', 'export-feed');
        }
        buttons.forEach(b => b.style.pointerEvents = 'auto');
        abortBtn.classList.add('hidden');
        return;
      } finally {
        state.isVerifying = false;
        abortBtn.classList.add('hidden');
      }
    }
  }

  const vMap = new Map(state.verified.map(v => [v.id, v]));
  const data = state.manga.map(m => ({ ...m, ...(vMap.get(m.id) || {}) }));

  if (format === 'mal') {
    clearFeed('export-feed');
    progress('Preparing generation...', 0, 'export');
    feed('Starting MAL export...', 'blue', 'export-feed');
    abortBtn.textContent = 'Abort';
    abortBtn.classList.remove('hidden');
  }

  try {
    const r = await msg({ type: 'EXPORT_DATA', data, format });
    if (r.success) {
      toast(`Exported ${r.count || data.length} titles`, 'success');
      if (format === 'mal') {
        feed('XML Generated!', 'green', 'export-feed');
        hideProgress('export');
        setTimeout(() => clearFeed('export-feed'), 3000);
      } else if (format === 'mangaupdates') {
        feed('TXT Generated!', 'green', 'export-feed');
        hideProgress('export');
        setTimeout(() => clearFeed('export-feed'), 3000);
      }
    }
    else throw new Error(r.error);
  } catch (e) { 
    const msgErr = e.message || 'Export failed';
    const isAbort = msgErr.includes('aborted');
    
    toast(isAbort ? 'Aborted' : msgErr, isAbort ? 'info' : 'error'); 
    if (format === 'mal') {
      feed(isAbort ? 'Export aborted' : msgErr, isAbort ? 'amber' : 'red', 'export-feed');
      hideProgress('export');
    }
  } finally {
    buttons.forEach(b => b.style.pointerEvents = 'auto');
    abortBtn.classList.add('hidden');
  }
}

async function copyTitles() {
  if (!state.manga.length) { toast('No manga to copy', 'error'); return; }
  try {
    await navigator.clipboard.writeText(state.manga.map(m => m.title).join('\n'));
    toast(`Copied ${state.manga.length} titles`, 'success');
  } catch (e) { toast('Clipboard failed', 'error'); }
}

// ── Badges ──
function updateBadges() {
  const n = state.manga.length;
  $('manga-count-badge').textContent = n;
  const b = $('list-badge');
  if (n > 0) { b.textContent = n; b.classList.remove('hidden'); } else b.classList.add('hidden');
}

// ── Toast ──
function toast(m, type = 'info') {
  const icons = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icons[type] || icons.info}<span>${esc(m)}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2500);
}

// ── Modal ──
function setupModal() {
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', e => { if (e.target === $('modal-backdrop')) closeModal(); });
}
function showModal(title, body, onConfirm, isDanger = false) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = body;
  $('modal-confirm').textContent = isDanger ? 'Delete' : 'Confirm';
  $('modal-backdrop').classList.add('show');
  const handler = async () => { $('modal-confirm').removeEventListener('click', handler); closeModal(); if (onConfirm) await onConfirm(); };
  $('modal-confirm').addEventListener('click', handler);
}
function closeModal() { $('modal-backdrop').classList.remove('show'); }

// ── Background messages ──
function onBgMessage(m) {
  if (m.type === 'VERIFY_PROGRESS') {
    const pct = Math.round((m.current / m.total) * 100);
    progress(`Verifying ${m.current}/${m.total}...`, pct, 'export');
    if (m.current === m.total || m.current % 10 === 0) {
      feed(`Verified ${m.current}/${m.total}`, 'blue', 'export-feed');
    }
  } else if (m.type === 'MAL_EXPORT_PROGRESS') {
    const pct = Math.round((m.current / m.total) * 100);
    progress(`Processing ${m.current}/${m.total}...`, pct, 'export');
    // We intentionally removed the feed() item per user request
    // so it doesn't spam the activity list for every single series
  }
}

// ── Util ──
function msg(m) { return new Promise((r, x) => chrome.runtime.sendMessage(m, res => chrome.runtime.lastError ? x(new Error(chrome.runtime.lastError.message)) : r(res))); }
function esc(s) { return !s ? '' : s.toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
