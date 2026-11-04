import { renderMarkdown, escapeHtml as esc } from './markdown.js';
import { icon, hydrateIcons } from './icons.js';
import { load, save, apiFetch, readEvents } from './store.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const mobile = window.matchMedia('(max-width: 900px)');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

const SUGGESTIONS = [
  'Explain quantum computing like I am 12',
  'Plan a 3-day budget trip to Jaipur',
  'Write a Python function to find prime numbers',
  'iPhone or Pixel for photography?',
];

const ENHANCE_SYSTEM =
  "You improve prompts written for AI assistants. Rewrite the user's prompt so it is clear, specific and well structured: " +
  'add useful context, constraints and the desired output format where it helps. Keep the original intent and language. ' +
  'Reply with the improved prompt only, with no preamble, quotes or explanation.';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  config: null,
  providers: new Map(),
  keys: load('keys', {}) || {},
  slots: load('slots', null),
  prefs: { theme: 'system', systemPrompt: '', sidebarHidden: false, hidden: [], ...load('prefs', {}) },
  chats: load('chats', []),
  currentId: load('current', null),
  liveModels: load('liveModels', {}) || {},
  focusSlot: null,
  running: new Map(),
  thinkingPref: new Map(),
  search: '',
  settingsTab: 'keys',
};

if (!Array.isArray(state.chats)) state.chats = [];
for (const chat of state.chats) {
  chat.turns = Array.isArray(chat.turns) ? chat.turns : [];
  for (const turn of chat.turns) {
    turn.responses = turn.responses || {};
    for (const r of Object.values(turn.responses)) {
      if (r.status === 'pending' || r.status === 'streaming') r.status = 'stopped';
    }
  }
}
if (!state.chats.some((c) => c.id === state.currentId)) state.currentId = null;

const provider = (id) => state.providers.get(id);
const currentChat = () => state.chats.find((c) => c.id === state.currentId) || null;
const isBusy = () => state.running.size > 0;
const isStreaming = (r) => r && (r.status === 'pending' || r.status === 'streaming');

function isReady(providerId) {
  const p = provider(providerId);
  if (!p) return false;
  if (p.local) return !!p.online;
  return p.serverKey || (state.config?.allowClientKeys && !!state.keys[providerId]);
}

function readySlots() {
  return state.slots.filter((s) => s.enabled && isReady(s.providerId));
}

function targetSlots() {
  if (state.focusSlot) {
    const slot = state.slots.find((s) => s.id === state.focusSlot);
    return slot && isReady(slot.providerId) ? [slot] : [];
  }
  return readySlots();
}

function slotLabel(slot) {
  const p = provider(slot.providerId);
  const twins = state.slots.filter((s) => s.providerId === slot.providerId).length > 1;
  return twins ? `${p.name} · ${shortModel(slot.model)}` : p.name;
}

const shortModel = (model) => String(model || '').split('/').pop().replace(/:free$/, '');

function avatar(p, size = '') {
  return `<span class="avatar${size ? ` ${size}` : ''}" style="background:${esc(p.color)}" aria-hidden="true">${esc(p.badge)}</span>`;
}

/** Separates <think>…</think> blocks some open models put inside the answer. */
function splitThink(text = '', reasoning = '') {
  const match = text.match(/^\s*<think>([\s\S]*?)(?:<\/think>\s*|$)/);
  if (!match) return { reasoning, text };
  return { reasoning: [reasoning, match[1].trim()].filter(Boolean).join('\n\n'), text: text.slice(match[0].length) };
}

/** Answer for a column; falls back to answers from removed or imported columns of the same provider. */
function responseFor(turn, slot) {
  if (turn.responses[slot.id]) return turn.responses[slot.id];
  const live = new Set(state.slots.map((s) => s.id));
  for (const [key, r] of Object.entries(turn.responses)) {
    if (!live.has(key) && r.providerId === slot.providerId) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let saveTimer = 0;
function persistChats(immediately = false) {
  clearTimeout(saveTimer);
  const run = () => {
    if (!save('chats', state.chats)) {
      const sorted = [...state.chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      while (sorted.length > 1) {
        sorted.pop();
        if (save('chats', sorted)) {
          state.chats = state.chats.filter((c) => sorted.includes(c));
          toast('Browser storage was full, so your oldest chats were removed.', 'warn');
          renderHistory();
          break;
        }
      }
    }
    save('current', state.currentId);
  };
  if (immediately) run();
  else saveTimer = setTimeout(run, 400);
}

const saveSlots = () => save('slots', state.slots);
const savePrefs = () => save('prefs', state.prefs);
const saveKeys = () => save('keys', state.keys);

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function toast(message, type = 'info', action) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.run();
      el.remove();
    });
    el.append(button);
  }
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, action ? 6000 : 3500);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  if (button) {
    const original = button.innerHTML;
    button.innerHTML = button.hasAttribute('data-copy-code') ? 'Copied!' : icon('check');
    button.classList.add('copied');
    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('copied');
    }, 1400);
  }
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slugify = (s) => String(s || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chat';

function titleFrom(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? `${clean.slice(0, 46).trim()}…` : clean;
}

function autoGrow() {
  const area = $('#prompt');
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
}

// ---------------------------------------------------------------------------
// Theme & layout
// ---------------------------------------------------------------------------

function resolvedTheme() {
  if (state.prefs.theme === 'system') return systemDark.matches ? 'dark' : 'light';
  return state.prefs.theme;
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#09090d' : '#f6f6f9';
  $('#toggleTheme').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
}

function toggleSidebar(force) {
  const app = $('#app');
  if (mobile.matches) {
    app.classList.toggle('sidebar-open', force);
  } else {
    state.prefs.sidebarHidden = force === undefined ? !state.prefs.sidebarHidden : !force;
    app.classList.toggle('sidebar-hidden', state.prefs.sidebarHidden);
    savePrefs();
  }
}

const closeMobileSidebar = () => mobile.matches && $('#app').classList.remove('sidebar-open');

function setAppName(name, tagline) {
  for (const el of $$('[data-app-name]')) el.textContent = name;
  document.title = name;
  state.tagline = tagline;
}

// ---------------------------------------------------------------------------
// Config & model columns
// ---------------------------------------------------------------------------

async function loadConfig() {
  let config;
  try {
    const res = await apiFetch('/api/config');
    config = await res.json();
    if (!res.ok) throw new Error(config.error || `Server returned ${res.status}`);
  } catch (err) {
    $('#columns').innerHTML = `<div class="center-msg">${icon('alert')}<h2>Can't reach the server</h2><p>${esc(err.message)}</p><button class="btn" type="button" data-action="retry">${icon('refresh')} Try again</button></div>`;
    return false;
  }

  state.config = config;
  setAppName(config.appName, config.tagline);
  if (config.authRequired && !config.authorized) {
    openLock();
    return false;
  }
  state.providers = new Map(config.providers.map((p) => [p.id, p]));
  syncSlots();
  return true;
}

function newSlot(p) {
  const ready = isReady(p.id);
  return { id: uid(), providerId: p.id, model: p.models[0] || '', enabled: ready, auto: !ready };
}

function syncSlots() {
  const providers = [...state.providers.values()];
  if (!Array.isArray(state.slots) || !state.slots.length) {
    state.slots = providers.map(newSlot);
  } else {
    state.slots = state.slots.filter((s) => s && state.providers.has(s.providerId));
    for (const p of providers) {
      if (!state.slots.some((s) => s.providerId === p.id) && !state.prefs.hidden.includes(p.id)) state.slots.push(newSlot(p));
    }
    for (const slot of state.slots) {
      const p = provider(slot.providerId);
      if (slot.auto && isReady(p.id)) {
        slot.enabled = true;
        slot.auto = false;
      }
      if (!slot.model) slot.model = p.models[0] || '';
      if (p.local && p.online && p.models.length && !p.models.includes(slot.model)) slot.model = p.models[0];
    }
  }
  if (state.focusSlot && !state.slots.some((s) => s.id === state.focusSlot)) state.focusSlot = null;
  saveSlots();
}

function modelsFor(p) {
  const live = state.liveModels[p.id];
  return Array.isArray(live) && live.length ? [...new Set([...p.models, ...live])] : p.models;
}

async function loadLiveModels(providerId) {
  const p = provider(providerId);
  toast(`Loading ${p.name} models…`);
  try {
    const headers = state.keys[providerId] ? { 'x-provider-key': state.keys[providerId] } : {};
    const res = await apiFetch(`/api/models?provider=${encodeURIComponent(providerId)}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    state.liveModels[providerId] = data.models || [];
    save('liveModels', state.liveModels);
    toast(`Found ${data.models.length} ${p.name} models.`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshProviders() {
  if (await loadConfig()) renderAll();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderHistory();
  renderTopbar();
  renderColumns();
  renderComposer();
}

function dayGroup(ts) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= today) return 'Today';
  if (ts >= today - 864e5) return 'Yesterday';
  if (ts >= today - 7 * 864e5) return 'Previous 7 days';
  if (ts >= today - 30 * 864e5) return 'Previous 30 days';
  return new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function renderHistory() {
  const el = $('#history');
  const query = state.search.trim().toLowerCase();
  const chats = state.chats
    .filter((c) => !query || (c.title || '').toLowerCase().includes(query) || c.turns.some((t) => t.prompt.toLowerCase().includes(query)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (!chats.length) {
    el.innerHTML = `<p class="history-empty">${query ? 'No chats match your search.' : 'Your chats will appear here.'}</p>`;
    return;
  }

  let html = '';
  let group = '';
  for (const chat of chats) {
    const g = dayGroup(chat.updatedAt || chat.createdAt || 0);
    if (g !== group) {
      group = g;
      html += `<div class="hist-group">${esc(g)}</div>`;
    }
    html += `<div class="hist-item${chat.id === state.currentId ? ' active' : ''}" data-chat="${esc(chat.id)}" role="button" tabindex="0">
      ${icon('chat', 'hist-ico')}<span class="hist-title">${esc(chat.title || 'Untitled chat')}</span>
      <span class="hist-actions">
        <button class="icon-btn xs" type="button" data-action="rename" title="Rename" aria-label="Rename chat">${icon('edit')}</button>
        <button class="icon-btn xs" type="button" data-action="delete" title="Delete" aria-label="Delete chat">${icon('trash')}</button>
      </span>
    </div>`;
  }
  el.innerHTML = html;
}

function renderTopbar() {
  const chat = currentChat();
  $('#chatTitle').textContent = chat?.title || 'New chat';
  $('#exportChat').disabled = !chat?.turns.length;
}

function renderColumns() {
  const wrap = $('#columns');
  if (!state.config?.providers) return;

  const onboarding = !state.slots.some((s) => isReady(s.providerId));
  wrap.classList.toggle('onboarding', onboarding);
  if (onboarding) {
    wrap.classList.remove('focus');
    wrap.innerHTML = onboardingHtml();
    return;
  }

  const chat = currentChat();
  const slots = state.focusSlot ? state.slots.filter((s) => s.id === state.focusSlot) : state.slots;
  const scrollLeft = wrap.scrollLeft;
  wrap.classList.toggle('focus', !!state.focusSlot);
  wrap.innerHTML =
    slots.map((s) => columnHtml(s, chat)).join('') ||
    `<div class="center-msg">${icon('layers')}<h2>No models added</h2><button class="btn primary" type="button" data-action="open-models">${icon('plus')} Add a model</button></div>`;
  for (const body of $$('.col-body', wrap)) body.scrollTop = body.scrollHeight;
  wrap.scrollLeft = state.focusSlot ? 0 : scrollLeft;
}

function columnHtml(slot, chat) {
  const p = provider(slot.providerId);
  const ready = isReady(p.id);

  if (!slot.enabled) {
    return `<div class="column collapsed" data-slot="${esc(slot.id)}">
      <button class="collapsed-btn" type="button" data-action="enable" title="Turn on ${esc(slotLabel(slot))}">
        ${avatar(p, 'sm')}<span class="vname">${esc(slotLabel(slot))}</span>${ready ? '' : icon('key', 'muted-ico')}
      </button>
    </div>`;
  }

  const focused = state.focusSlot === slot.id;
  return `<article class="column" data-slot="${esc(slot.id)}" style="--brand:${esc(p.color)}">
    <header class="col-head">
      ${avatar(p)}
      <div class="col-title">
        <span class="col-name">${esc(p.name)}</span>
        ${ready ? modelSelectHtml(slot, p) : `<span class="col-sub">${esc(p.vendor)}</span>`}
      </div>
      <div class="col-actions">
        <button class="icon-btn sm" type="button" data-action="focus" title="${focused ? 'Show all models' : 'Focus on this model'}" aria-label="${focused ? 'Show all models' : 'Focus on this model'}">${icon(focused ? 'collapse' : 'expand')}</button>
        <label class="switch" title="Turn off"><input type="checkbox" checked data-action="toggle" aria-label="Turn off ${esc(p.name)}" /><span></span></label>
      </div>
    </header>
    <div class="col-body">${ready ? turnsHtml(slot, p, chat) : connectHtml(p)}</div>
  </article>`;
}

function modelSelectHtml(slot, p) {
  const options = [...new Set([slot.model, ...modelsFor(p)].filter(Boolean))];
  return `<select class="model-select" data-action="model" aria-label="${esc(p.name)} model">
    ${options.map((m) => `<option value="${esc(m)}"${m === slot.model ? ' selected' : ''}>${esc(m)}</option>`).join('')}
    <option disabled>──────────</option>
    <option value="__custom">Type a model ID…</option>
    ${p.local ? '<option value="__refresh">Refresh installed models</option>' : '<option value="__load">Load all models…</option>'}
  </select>`;
}

function connectHtml(p) {
  if (p.local) {
    const ollama = p.id === 'ollama';
    return `<div class="col-empty connect">${avatar(p, 'lg')}
      <b>${esc(p.name)} is not running</b>
      <small>${
        ollama
          ? 'Install Ollama, run <code>ollama pull llama3.2</code>, then check again. Everything stays on your computer, no internet needed.'
          : 'The server could not reach this endpoint.'
      }</small>
      ${ollama && p.keyUrl ? `<a class="btn" href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${icon('download')} Get Ollama</a>` : ''}
      <button class="btn ghost" type="button" data-action="recheck">${icon('refresh')} Check again</button>
    </div>`;
  }
  return `<div class="col-empty connect">${avatar(p, 'lg')}
    <b>Connect ${esc(p.name)}</b>
    <small>${esc(p.note)}</small>
    ${
      state.config.allowClientKeys
        ? `<button class="btn primary" type="button" data-action="add-key" data-provider="${esc(p.id)}">${icon('key')} Add API key</button>`
        : '<small>Ask the admin to add a key on the server.</small>'
    }
    ${p.keyUrl ? `<a class="link" href="${esc(p.keyUrl)}" target="_blank" rel="noopener">Get a key ${icon('external')}</a>` : ''}
  </div>`;
}

function onboardingHtml() {
  const featured = ['gemini', 'groq', 'openrouter', 'ollama'].map(provider).filter(Boolean);
  const others = [...state.providers.values()].filter((p) => !featured.includes(p));
  const allow = state.config.allowClientKeys;
  const card = (p) => `<div class="onboard-card">
    ${avatar(p)}
    <div>
      <b>${esc(p.name)}</b>${p.free ? '<span class="tag">Free</span>' : ''}
      <p>${esc(p.note)}</p>
      ${p.keyUrl ? `<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${p.local ? 'Download' : 'Get a key'} ${icon('external')}</a>` : ''}
    </div>
  </div>`;
  return `<div class="onboard">
    <img class="onboard-logo" src="/logo.svg" alt="" width="64" height="64" />
    <h2>Welcome to ${esc(state.config.appName)}</h2>
    <p>Ask one question and get answers from the world's best AI models, side by side. Connect at least one provider to begin. Several are free.</p>
    <div class="onboard-grid">${featured.map(card).join('')}</div>
    ${others.length ? `<p class="onboard-more">Also supported: ${others.map((p) => esc(p.name)).join(' · ')}</p>` : ''}
    ${
      allow
        ? `<button class="btn primary lg" type="button" data-action="add-key">${icon('key')} Add your API keys</button>`
        : '<p class="muted">Add API keys to the server (.env file) and reload.</p>'
    }
  </div>`;
}

function turnsHtml(slot, p, chat) {
  if (!chat || !chat.turns.length) {
    return `<div class="col-empty">${avatar(p, 'lg')}<b>${esc(p.name)}</b><span class="mono">${esc(slot.model || 'Pick a model')}</span><small>${esc(p.note || '')}</small></div>`;
  }
  return chat.turns
    .map(
      (turn) => `<div class="turn" data-turn="${esc(turn.id)}">
      <div class="user-msg">
        <div class="user-actions">
          <button class="icon-btn xs" type="button" data-action="edit-prompt" title="Edit and ask again" aria-label="Edit prompt">${icon('edit')}</button>
        </div>
        <div class="user-bubble">${esc(turn.prompt)}</div>
      </div>
      ${answerHtml(slot, turn)}
    </div>`,
    )
    .join('');
}

function answerHtml(slot, turn) {
  const key = `${turn.id}:${slot.id}`;
  const r = responseFor(turn, slot);
  if (!r) {
    return `<div class="answer skipped" data-answer="${esc(key)}"><span>This model was off for this message.</span> <button class="link-btn" type="button" data-action="ask-turn">Ask now</button></div>`;
  }
  const classes = ['answer'];
  if (isStreaming(r)) classes.push('streaming');
  if (r.error) classes.push('has-error');
  return `<div class="${classes.join(' ')}" data-answer="${esc(key)}">${answerInner(key, r)}</div>`;
}

function answerInner(key, r) {
  const { reasoning, text } = splitThink(r.text, r.reasoning);
  const streaming = isStreaming(r);
  let html = '';

  if (reasoning) {
    const thinkingNow = streaming && !text;
    const open = state.thinkingPref.has(key) ? state.thinkingPref.get(key) : thinkingNow;
    html += `<details class="thinking"${open ? ' open' : ''}>
      <summary>${icon('brain')}<span>${thinkingNow ? 'Thinking…' : 'Thought process'}</span>${icon('down', 'chev')}</summary>
      <div class="thinking-body">${renderMarkdown(reasoning)}</div>
    </details>`;
  }
  if (text) html += `<div class="md">${renderMarkdown(text, { sources: r.sources || [] })}</div>`;
  else if (streaming && !reasoning) html += '<div class="typing" aria-label="Thinking"><span></span><span></span><span></span></div>';

  if (r.notice) html += `<div class="notice">${icon('info')}<span>${esc(r.notice)}</span></div>`;
  if (r.error) html += `<div class="error-box">${icon('alert')}<div><b>Couldn't get an answer</b><p>${esc(r.error)}</p></div></div>`;
  if (r.status === 'stopped' && !text) html += '<p class="muted small">Stopped.</p>';

  const sources = (r.sources || []).filter((s) => s && /^https?:\/\//.test(s.url));
  if (sources.length) {
    html += `<div class="sources"><span class="sources-label">${icon('globe')} Sources</span>${sources
      .slice(0, 12)
      .map((s, i) => {
        let host = s.url;
        try {
          host = new URL(s.url).hostname.replace(/^www\./, '');
        } catch {
          // keep url
        }
        return `<a class="source" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title || s.url)}"><b>${i + 1}</b>${esc(s.title || host)}</a>`;
      })
      .join('')}</div>`;
  }

  if (!streaming) {
    const meta = [r.servedModel || r.model, r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '', r.usage?.output ? `${r.usage.output.toLocaleString()} tokens` : '']
      .filter(Boolean)
      .map(esc)
      .join(' · ');
    html += `<div class="answer-foot">
      <span class="meta">${meta}</span>
      <div class="answer-actions">
        ${text ? `<button class="icon-btn sm" type="button" data-action="copy" title="Copy answer" aria-label="Copy answer">${icon('copy')}</button>` : ''}
        <button class="icon-btn sm" type="button" data-action="regen" title="Regenerate" aria-label="Regenerate answer">${icon('refresh')}</button>
      </div>
    </div>`;
  }
  return html;
}

function renderComposer() {
  const busy = isBusy();
  const targets = state.config?.providers ? targetSlots() : [];
  const send = $('#sendBtn');
  send.classList.toggle('stop', busy);
  send.innerHTML = icon(busy ? 'stop' : 'send');
  send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  send.title = busy ? 'Stop (Esc)' : 'Send';
  send.disabled = !busy && !targets.length;
  $('#enhanceBtn').disabled = !targets.length;

  const hint = $('#composerHint');
  if (!state.config?.providers) hint.textContent = '';
  else if (!targets.length) {
    hint.textContent = state.slots.some((s) => isReady(s.providerId)) ? 'Turn on at least one model to start.' : 'Connect a model to start chatting.';
  } else if (state.focusSlot) {
    hint.textContent = `Replying to ${slotLabel(targets[0])} only · Enter to send · Shift+Enter for a new line`;
  } else {
    hint.textContent = `Asking ${targets.length} model${targets.length > 1 ? 's' : ''} at once · Enter to send · Shift+Enter for a new line`;
  }
  renderChips();
  renderSuggestions();
}

function renderChips() {
  const el = $('#modelChips');
  if (!state.config?.providers) {
    el.innerHTML = '';
    return;
  }
  const ready = state.slots.filter((s) => isReady(s.providerId));
  if (!ready.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    ready
      .map((slot) => {
        const p = provider(slot.providerId);
        return `<button type="button" class="chip${slot.enabled ? ' on' : ''}" data-slot="${esc(slot.id)}" aria-pressed="${slot.enabled}" title="${esc(slot.model)}">${avatar(p, 'xs')}${esc(slotLabel(slot))}</button>`;
      })
      .join('') + `<button type="button" class="chip add" data-action="open-models" title="Manage models" aria-label="Manage models">${icon('plus')}</button>`;
}

function renderSuggestions() {
  const chat = currentChat();
  const show = state.config?.providers && (!chat || !chat.turns.length) && targetSlots().length > 0;
  $('#suggestions').innerHTML = show
    ? SUGGESTIONS.map((s) => `<button type="button" class="suggestion" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')
    : '';
}

// --- streaming updates (only the changed answer is re-rendered) -------------

const pendingAnswers = new Set();
let flushTimer = 0;

function scheduleAnswer(chatId, turnId, slotId) {
  if (chatId !== state.currentId) return;
  pendingAnswers.add(`${turnId}:${slotId}`);
  if (!flushTimer) flushTimer = setTimeout(flushAnswers, 40);
}

function flushAnswers() {
  flushTimer = 0;
  const chat = currentChat();
  for (const key of pendingAnswers) {
    const [turnId, slotId] = key.split(':');
    const el = document.querySelector(`[data-answer="${CSS.escape(key)}"]`);
    const turn = chat?.turns.find((t) => t.id === turnId);
    const slot = state.slots.find((s) => s.id === slotId);
    if (!el || !turn || !slot) continue;
    const body = el.closest('.col-body');
    const stick = body && body.scrollHeight - body.scrollTop - body.clientHeight < 140;
    el.outerHTML = answerHtml(slot, turn);
    if (stick) body.scrollTop = body.scrollHeight;
  }
  pendingAnswers.clear();
}

// ---------------------------------------------------------------------------
// Chatting
// ---------------------------------------------------------------------------

function buildHistory(chat, turn, slot) {
  const messages = [];
  for (const t of chat.turns) {
    if (t === turn) break;
    messages.push({ role: 'user', content: t.prompt });
    const r = responseFor(t, slot);
    const text = r && !r.error ? splitThink(r.text).text.trim() : '';
    if (text) messages.push({ role: 'assistant', content: text });
  }
  messages.push({ role: 'user', content: turn.prompt });
  return messages.slice(-40);
}

async function runSlot(chat, turn, slot) {
  const key = `${turn.id}:${slot.id}`;
  state.running.get(key)?.abort();

  const r = {
    providerId: slot.providerId,
    model: slot.model,
    text: '',
    reasoning: '',
    sources: [],
    status: 'pending',
  };
  turn.responses[slot.id] = r;
  const controller = new AbortController();
  state.running.set(key, controller);
  state.thinkingPref.delete(key);
  renderComposer();
  scheduleAnswer(chat.id, turn.id, slot.id);

  const started = performance.now();
  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: slot.providerId,
        model: slot.model,
        messages: buildHistory(chat, turn, slot),
        system: state.prefs.systemPrompt || undefined,
        apiKey: state.keys[slot.providerId] || undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.code === 'auth') openLock();
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    r.status = 'streaming';
    for await (const event of readEvents(res.body)) {
      switch (event.type) {
        case 'text':
          r.text += event.text;
          break;
        case 'reasoning':
          r.reasoning += event.text;
          break;
        case 'sources':
          r.sources = event.items;
          break;
        case 'usage':
          r.usage = event.usage;
          break;
        case 'model':
          r.servedModel = event.model;
          break;
        case 'notice':
          r.notice = event.text;
          break;
        case 'error':
          throw new Error(event.message);
        default:
          break;
      }
      scheduleAnswer(chat.id, turn.id, slot.id);
    }
    r.status = 'done';
  } catch (err) {
    if (controller.signal.aborted) r.status = 'stopped';
    else {
      r.status = 'error';
      r.error = err.message || String(err);
    }
  } finally {
    r.ms = Math.round(performance.now() - started);
    if (state.running.get(key) === controller) state.running.delete(key);
    chat.updatedAt = Date.now();
    scheduleAnswer(chat.id, turn.id, slot.id);
    renderComposer();
    persistChats();
  }
}

function sendPrompt(raw) {
  const text = String(raw || '').trim();
  if (!text || isBusy()) return;
  const targets = targetSlots();
  if (!targets.length) {
    toast('Turn on at least one connected model first.', 'warn');
    return;
  }

  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: titleFrom(text), createdAt: Date.now(), updatedAt: Date.now(), turns: [] };
    state.chats.push(chat);
    state.currentId = chat.id;
  }
  const turn = { id: uid(), prompt: text, at: Date.now(), responses: {} };
  for (const slot of targets) {
    turn.responses[slot.id] = { providerId: slot.providerId, model: slot.model, text: '', reasoning: '', sources: [], status: 'pending' };
  }
  chat.turns.push(turn);
  chat.updatedAt = Date.now();

  $('#prompt').value = '';
  autoGrow();
  persistChats(true);
  renderAll();
  for (const slot of targets) runSlot(chat, turn, slot);
}

function stopAll() {
  for (const controller of state.running.values()) controller.abort();
}

function abortChat(chat) {
  for (const turn of chat.turns) {
    for (const [key, controller] of state.running) if (key.startsWith(`${turn.id}:`)) controller.abort();
  }
}

async function enhancePrompt() {
  const area = $('#prompt');
  const draft = area.value.trim();
  if (!draft) {
    toast('Type a prompt first, then tap ✨ to improve it.');
    area.focus();
    return;
  }
  const slot = targetSlots()[0];
  if (!slot) return;
  const button = $('#enhanceBtn');
  button.disabled = true;
  button.classList.add('busy');

  let output = '';
  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: slot.providerId,
        model: slot.model,
        system: ENHANCE_SYSTEM,
        messages: [{ role: 'user', content: `Improve this prompt:\n\n"""\n${draft}\n"""` }],
        apiKey: state.keys[slot.providerId] || undefined,
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not improve the prompt.');
    for await (const event of readEvents(res.body)) {
      if (event.type === 'text') output += event.text;
      if (event.type === 'error') throw new Error(event.message);
    }
    output = splitThink(output).text.trim().replace(/^"""\s*|\s*"""$/g, '').replace(/^["“]|["”]$/g, '').trim();
    if (!output) throw new Error('The model returned an empty prompt.');
    area.value = output;
    autoGrow();
    area.focus();
    toast(`Prompt improved by ${slotLabel(slot)}.`, 'ok', {
      label: 'Undo',
      run: () => {
        area.value = draft;
        autoGrow();
      },
    });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.classList.remove('busy');
    renderComposer();
  }
}

function setupVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = $('#micBtn');
  if (!Recognition) {
    button.hidden = true;
    return;
  }
  let recognition = null;
  button.addEventListener('click', () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    const area = $('#prompt');
    const base = area.value.trim();
    recognition.onresult = (event) => {
      const transcript = [...event.results].map((result) => result[0].transcript).join('');
      area.value = base ? `${base} ${transcript}` : transcript;
      autoGrow();
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        toast(event.error === 'not-allowed' ? 'Microphone permission was denied.' : `Voice input error: ${event.error}`, 'error');
      }
    };
    recognition.onend = () => {
      recognition = null;
      button.classList.remove('recording');
      area.focus();
    };
    recognition.start();
    button.classList.add('recording');
  });
}

// ---------------------------------------------------------------------------
// Chats: select, rename, delete, export, import
// ---------------------------------------------------------------------------

function newChat() {
  state.currentId = null;
  state.focusSlot = null;
  persistChats(true);
  renderAll();
  closeMobileSidebar();
  $('#prompt').focus();
}

function selectChat(id) {
  state.currentId = id;
  persistChats(true);
  renderAll();
  closeMobileSidebar();
}

function renameChat(id) {
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  const title = window.prompt('Rename chat', chat.title);
  if (title && title.trim()) {
    chat.title = title.trim().slice(0, 120);
    persistChats(true);
    renderHistory();
    renderTopbar();
  }
}

function deleteChat(id) {
  const chat = state.chats.find((c) => c.id === id);
  if (!chat || !window.confirm(`Delete "${chat.title}"? This can't be undone.`)) return;
  abortChat(chat);
  state.chats = state.chats.filter((c) => c !== chat);
  if (state.currentId === id) state.currentId = null;
  persistChats(true);
  renderAll();
}

function exportChat() {
  const chat = currentChat();
  if (!chat?.turns.length) return;
  let md = `# ${chat.title}\n\n`;
  for (const turn of chat.turns) {
    md += `## You\n\n${turn.prompt}\n\n`;
    for (const r of Object.values(turn.responses)) {
      const name = provider(r.providerId)?.name || r.providerId;
      const text = splitThink(r.text).text.trim();
      md += `### ${name} (${r.servedModel || r.model})\n\n${text || (r.error ? `_Error: ${r.error}_` : '_No answer_')}\n\n`;
    }
    md += '---\n\n';
  }
  download(`${slugify(chat.title)}.md`, md, 'text/markdown');
}

function sanitizeResponses(responses) {
  const out = {};
  for (const [key, r] of Object.entries(responses && typeof responses === 'object' ? responses : {})) {
    if (!r || typeof r !== 'object') continue;
    out[String(key)] = {
      providerId: String(r.providerId || ''),
      model: String(r.model || ''),
      servedModel: r.servedModel ? String(r.servedModel) : undefined,
      text: String(r.text || ''),
      reasoning: String(r.reasoning || ''),
      sources: Array.isArray(r.sources)
        ? r.sources.filter((s) => s && /^https?:\/\//.test(s.url)).map((s) => ({ url: String(s.url), title: s.title ? String(s.title) : '' }))
        : [],
      status: r.error ? 'error' : 'done',
      error: r.error ? String(r.error) : undefined,
      ms: Number(r.ms) || 0,
    };
  }
  return out;
}

async function importChats(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data?.chats;
    if (!Array.isArray(list)) throw new Error("That file doesn't look like a chats export.");
    let added = 0;
    for (const c of list) {
      if (!c || typeof c.id !== 'string' || !Array.isArray(c.turns) || state.chats.some((x) => x.id === c.id)) continue;
      state.chats.push({
        id: c.id,
        title: String(c.title || 'Imported chat').slice(0, 120),
        createdAt: Number(c.createdAt) || Date.now(),
        updatedAt: Number(c.updatedAt) || Date.now(),
        turns: c.turns
          .filter((t) => t && typeof t.prompt === 'string')
          .map((t) => ({ id: String(t.id || uid()), prompt: t.prompt, at: Number(t.at) || Date.now(), responses: sanitizeResponses(t.responses) })),
      });
      added++;
    }
    persistChats(true);
    renderAll();
    toast(`Imported ${added} chat${added === 1 ? '' : 's'}.`, 'ok');
  } catch (err) {
    toast(err.message || 'Import failed.', 'error');
  }
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

const settings = $('#settingsDialog');

function openSettings(tab = state.settingsTab, focusProvider) {
  if (!state.config?.providers) return;
  state.settingsTab = tab;
  renderSettings();
  if (!settings.open) settings.showModal();
  if (focusProvider) setTimeout(() => $(`[data-key-input="${CSS.escape(focusProvider)}"]`, settings)?.focus(), 60);
}

function pill(kind, label) {
  return `<span class="pill ${kind}">${esc(label)}</span>`;
}

function keysTabHtml() {
  const allow = state.config.allowClientKeys;
  const rows = [...state.providers.values()]
    .map((p) => {
      let status;
      if (p.local) status = p.online ? pill('ok', 'Running') : pill('off', 'Not running');
      else if (state.keys[p.id]) status = pill('ok', 'Your key');
      else if (p.serverKey) status = pill('ok', 'Server key');
      else status = pill('off', 'Not connected');

      let control = '';
      if (p.local) {
        control =
          p.id === 'ollama'
            ? '<p class="hint small">No key needed. Install Ollama and run <code>ollama pull llama3.2</code>. Models run on your own machine, fully offline.</p>'
            : '<p class="hint small">Configured on the server.</p>';
      } else if (allow) {
        control = `<div class="key-input">
          <input type="password" autocomplete="off" spellcheck="false" data-key-input="${esc(p.id)}" value="${esc(state.keys[p.id] || '')}"
            placeholder="${p.serverKey ? 'Using the server key. Paste one to override.' : 'Paste your API key'}" aria-label="${esc(p.name)} API key" />
          <button class="icon-btn sm" type="button" data-reveal title="Show or hide" aria-label="Show or hide key">${icon('eye')}</button>
          <button class="btn sm" type="button" data-test-key="${esc(p.id)}">Test</button>
        </div>`;
      }

      return `<div class="key-row">
        <div class="key-head">
          ${avatar(p)}
          <div class="key-meta">
            <b>${esc(p.name)}</b>
            <small>${esc(p.vendor)}${p.free ? ' · <span class="free">Free tier</span>' : ''}${
              p.keyUrl ? ` · <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${p.local ? 'Download' : 'Get a key'} ${icon('external')}</a>` : ''
            }</small>
          </div>
          ${status}
        </div>
        ${control}
      </div>`;
    })
    .join('');

  return `<p class="hint">${
    allow
      ? `${icon('lock')} Keys you paste here are saved only in this browser and are sent to your own server only when you chat. Keys set on the server are never shown.`
      : 'API keys are managed on the server. Ask the admin to add more providers.'
  }</p><div class="key-list">${rows}</div>`;
}

function modelsTabHtml() {
  const rows = state.slots
    .map((slot, index) => {
      const p = provider(slot.providerId);
      const ready = isReady(p.id);
      return `<div class="slot-row" data-slot="${esc(slot.id)}">
        <label class="switch"><input type="checkbox" data-slot-toggle ${slot.enabled ? 'checked' : ''} aria-label="Turn ${esc(p.name)} on or off" /><span></span></label>
        ${avatar(p)}
        <div class="slot-meta"><b>${esc(slotLabel(slot))}</b><small>${ready ? esc(slot.model) : p.local ? 'Not running' : 'Needs an API key'}</small></div>
        <div class="slot-actions">
          <button class="icon-btn sm" type="button" data-slot-move="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move up">${icon('up')}</button>
          <button class="icon-btn sm" type="button" data-slot-move="1" ${index === state.slots.length - 1 ? 'disabled' : ''} aria-label="Move down">${icon('down')}</button>
          <button class="icon-btn sm" type="button" data-slot-remove aria-label="Remove column">${icon('trash')}</button>
        </div>
      </div>`;
    })
    .join('');
  const options = [...state.providers.values()].map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.vendor)})</option>`).join('');
  return `<p class="hint">Choose which AIs answer and in what order. Add the same provider twice to compare two of its models side by side.</p>
    <div class="slot-list">${rows}</div>
    <div class="add-slot">
      <select id="addSlotProvider" aria-label="Provider">${options}</select>
      <button class="btn" type="button" id="addSlotBtn">${icon('plus')} Add column</button>
    </div>`;
}

function generalTabHtml() {
  const themes = [
    ['system', 'System', 'monitor'],
    ['dark', 'Dark', 'moon'],
    ['light', 'Light', 'sun'],
  ];
  return `<div class="field">
      <span class="field-label">Theme</span>
      <div class="segmented">${themes
        .map(([value, label, ic]) => `<button type="button" class="${state.prefs.theme === value ? 'active' : ''}" data-theme-choice="${value}">${icon(ic)}${label}</button>`)
        .join('')}</div>
    </div>
    <div class="field">
      <label class="field-label" for="sysPrompt">Custom instructions</label>
      <textarea id="sysPrompt" rows="4" placeholder="Example: Keep answers short. Use Indian Rupees for prices.">${esc(state.prefs.systemPrompt)}</textarea>
      <small class="hint">Sent to every model with every message.</small>
    </div>
    <div class="field">
      <span class="field-label">Your data</span>
      <div class="btn-row">
        <button class="btn" type="button" id="exportAll">${icon('download')} Export chats</button>
        <button class="btn" type="button" id="importAll">${icon('upload')} Import chats</button>
        <button class="btn danger" type="button" id="clearAll">${icon('trash')} Delete all chats</button>
      </div>
      <small class="hint">Chats and keys are stored only in this browser. Nothing is kept on the server.</small>
    </div>`;
}

function renderSettings() {
  for (const tab of $$('.tab', settings)) {
    const active = tab.dataset.tab === state.settingsTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active);
  }
  const body = $('#settingsBody');
  const foot = $('#settingsFoot');
  if (state.settingsTab === 'keys') {
    body.innerHTML = keysTabHtml();
    foot.innerHTML = state.config.allowClientKeys
      ? '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="saveKeys">Save keys</button>'
      : '<button class="btn primary" type="button" data-close>Close</button>';
  } else if (state.settingsTab === 'models') {
    body.innerHTML = modelsTabHtml();
    foot.innerHTML = '<button class="btn primary" type="button" data-close>Done</button>';
  } else {
    body.innerHTML = generalTabHtml();
    foot.innerHTML = '<button class="btn primary" type="button" data-close>Done</button>';
  }
}

function saveKeysFromForm() {
  const before = new Set([...state.providers.keys()].filter(isReady));
  for (const input of $$('[data-key-input]', settings)) {
    const value = input.value.trim();
    if (value) state.keys[input.dataset.keyInput] = value;
    else delete state.keys[input.dataset.keyInput];
  }
  saveKeys();
  for (const slot of state.slots) {
    if (!before.has(slot.providerId) && isReady(slot.providerId)) {
      slot.enabled = true;
      slot.auto = false;
    }
  }
  saveSlots();
  settings.close();
  toast('API keys saved.', 'ok');
}

async function testKey(providerId, button) {
  const input = $(`[data-key-input="${CSS.escape(providerId)}"]`, settings);
  const key = input?.value.trim();
  const p = provider(providerId);
  if (!key && !p.serverKey) {
    toast('Paste a key first.', 'warn');
    return;
  }
  button.disabled = true;
  button.innerHTML = '<span class="spinner sm"></span>';
  try {
    const res = await apiFetch(`/api/models?provider=${encodeURIComponent(providerId)}&verify=1`, {
      headers: key ? { 'x-provider-key': key } : {},
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    button.innerHTML = `${icon('check')} OK`;
    button.classList.add('ok');
    toast(`${p.name} key works.`, 'ok');
  } catch (err) {
    button.textContent = 'Test';
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function moveSlot(slot, delta) {
  const index = state.slots.indexOf(slot);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.slots.length) return;
  state.slots.splice(index, 1);
  state.slots.splice(target, 0, slot);
  saveSlots();
  renderSettings();
}

function removeSlot(slot) {
  state.slots = state.slots.filter((s) => s !== slot);
  if (!state.slots.some((s) => s.providerId === slot.providerId) && !state.prefs.hidden.includes(slot.providerId)) {
    state.prefs.hidden.push(slot.providerId);
    savePrefs();
  }
  if (state.focusSlot === slot.id) state.focusSlot = null;
  saveSlots();
  renderSettings();
}

function addSlot(providerId) {
  const p = provider(providerId);
  if (!p) return;
  const slot = newSlot(p);
  slot.enabled = true;
  slot.auto = false;
  state.slots.push(slot);
  state.prefs.hidden = state.prefs.hidden.filter((id) => id !== providerId);
  savePrefs();
  saveSlots();
  renderSettings();
}

let promptTimer = 0;

settings.addEventListener('click', (event) => {
  if (event.target === settings) return settings.close();
  const target = event.target.closest('button');
  if (!target) return;

  if (target.dataset.tab) {
    state.settingsTab = target.dataset.tab;
    return renderSettings();
  }
  if (target.hasAttribute('data-close')) return settings.close();
  if (target.id === 'saveKeys') return saveKeysFromForm();
  if (target.hasAttribute('data-reveal')) {
    const input = target.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
    return;
  }
  if (target.dataset.testKey) return testKey(target.dataset.testKey, target);

  const row = target.closest('[data-slot]');
  const slot = row && state.slots.find((s) => s.id === row.dataset.slot);
  if (slot && target.dataset.slotMove) return moveSlot(slot, Number(target.dataset.slotMove));
  if (slot && target.hasAttribute('data-slot-remove')) return removeSlot(slot);
  if (target.id === 'addSlotBtn') return addSlot($('#addSlotProvider').value);

  if (target.dataset.themeChoice) {
    state.prefs.theme = target.dataset.themeChoice;
    savePrefs();
    applyTheme();
    return renderSettings();
  }
  if (target.id === 'exportAll') {
    return download(`chats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ chats: state.chats }, null, 2), 'application/json');
  }
  if (target.id === 'importAll') return $('#importFile').click();
  if (target.id === 'clearAll') {
    if (!state.chats.length || !window.confirm('Delete all chats? This cannot be undone.')) return;
    stopAll();
    state.chats = [];
    state.currentId = null;
    persistChats(true);
    toast('All chats deleted.', 'ok');
  }
});

settings.addEventListener('change', (event) => {
  if (event.target.matches('[data-slot-toggle]')) {
    const slot = state.slots.find((s) => s.id === event.target.closest('[data-slot]').dataset.slot);
    if (!slot) return;
    slot.enabled = event.target.checked;
    slot.auto = false;
    saveSlots();
  }
});

settings.addEventListener('input', (event) => {
  if (event.target.id === 'sysPrompt') {
    clearTimeout(promptTimer);
    promptTimer = setTimeout(() => {
      state.prefs.systemPrompt = event.target.value.trim();
      savePrefs();
    }, 300);
  }
});

settings.addEventListener('close', () => {
  const area = $('#sysPrompt');
  if (area) {
    state.prefs.systemPrompt = area.value.trim();
    savePrefs();
  }
  if (state.focusSlot && !state.slots.some((s) => s.id === state.focusSlot)) state.focusSlot = null;
  if (state.config?.providers) renderAll();
});

$('#importFile').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) importChats(file);
  event.target.value = '';
});

// ---------------------------------------------------------------------------
// Password lock
// ---------------------------------------------------------------------------

const lock = $('#lockDialog');

function openLock() {
  $('#columns').innerHTML = '';
  if (!lock.open) lock.showModal();
  setTimeout(() => $('#lockInput').focus(), 60);
}

lock.addEventListener('cancel', (event) => event.preventDefault());

$('#lockForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  save('password', $('#lockInput').value);
  const ok = await loadConfig();
  if (ok) {
    lock.close();
    $('#lockError').hidden = true;
    $('#lockInput').value = '';
    renderAll();
  } else if (state.config?.authRequired) {
    $('#lockError').hidden = false;
    $('#lockForm').classList.remove('shake');
    void $('#lockForm').offsetWidth;
    $('#lockForm').classList.add('shake');
  }
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function slotFromEvent(target) {
  const col = target.closest('[data-slot]');
  return col ? state.slots.find((s) => s.id === col.dataset.slot) : null;
}

function bindEvents() {
  $('#newChat').addEventListener('click', newChat);
  $('#menuBtn').addEventListener('click', () => toggleSidebar());
  $('#sidebarClose').addEventListener('click', () => toggleSidebar(false));
  $('#scrim').addEventListener('click', () => toggleSidebar(false));
  $('#openSettings').addEventListener('click', () => openSettings('keys'));
  $('#manageModels').addEventListener('click', () => openSettings('models'));
  $('#exportChat').addEventListener('click', exportChat);
  $('#enhanceBtn').addEventListener('click', enhancePrompt);
  $('#chatTitle').addEventListener('click', () => state.currentId && renameChat(state.currentId));
  $('#toggleTheme').addEventListener('click', () => {
    state.prefs.theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
    savePrefs();
    applyTheme();
  });

  $('#searchChats').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderHistory();
  });

  const history = $('#history');
  history.addEventListener('click', (event) => {
    const item = event.target.closest('[data-chat]');
    if (!item) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'rename') return renameChat(item.dataset.chat);
    if (action === 'delete') return deleteChat(item.dataset.chat);
    selectChat(item.dataset.chat);
  });
  history.addEventListener('keydown', (event) => {
    const item = event.target.closest('[data-chat]');
    if (item && event.target === item && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      selectChat(item.dataset.chat);
    }
  });

  const columns = $('#columns');
  columns.addEventListener('click', (event) => {
    const copyCode = event.target.closest('[data-copy-code]');
    if (copyCode) return copyText(copyCode.closest('.code-block').querySelector('code').textContent, copyCode);

    const summary = event.target.closest('.thinking > summary');
    if (summary) {
      const key = summary.closest('[data-answer]')?.dataset.answer;
      if (key) state.thinkingPref.set(key, !summary.parentElement.open);
      return;
    }

    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const slot = slotFromEvent(button);
    const chat = currentChat();
    const answerKey = button.closest('[data-answer]')?.dataset.answer;
    const turnId = answerKey?.split(':')[0] || button.closest('[data-turn]')?.dataset.turn;
    const turn = chat?.turns.find((t) => t.id === turnId);

    switch (action) {
      case 'retry':
        return boot();
      case 'add-key':
        return openSettings('keys', button.dataset.provider);
      case 'open-models':
        return openSettings('models');
      case 'recheck':
        return refreshProviders();
      case 'enable':
        if (!slot) return;
        slot.enabled = true;
        slot.auto = false;
        saveSlots();
        renderColumns();
        return renderComposer();
      case 'focus':
        if (!slot) return;
        state.focusSlot = state.focusSlot === slot.id ? null : slot.id;
        renderColumns();
        return renderComposer();
      case 'copy': {
        const r = turn && slot && responseFor(turn, slot);
        if (r) copyText(splitThink(r.text).text.trim(), button);
        return;
      }
      case 'regen':
      case 'ask-turn':
        if (chat && turn && slot && isReady(slot.providerId)) runSlot(chat, turn, slot);
        return;
      case 'edit-prompt':
        if (!turn) return;
        $('#prompt').value = turn.prompt;
        autoGrow();
        $('#prompt').focus();
        return;
      default:
    }
  });

  columns.addEventListener('change', async (event) => {
    const slot = slotFromEvent(event.target);
    if (!slot) return;
    if (event.target.matches('[data-action="toggle"]')) {
      slot.enabled = event.target.checked;
      slot.auto = false;
      if (!slot.enabled && state.focusSlot === slot.id) state.focusSlot = null;
      saveSlots();
      renderColumns();
      renderComposer();
      return;
    }
    if (event.target.matches('[data-action="model"]')) {
      const value = event.target.value;
      if (value === '__custom') {
        const id = window.prompt('Type the exact model ID from the provider (for example gpt-5 or llama3.2):', slot.model);
        if (id && id.trim()) slot.model = id.trim();
      } else if (value === '__load') {
        event.target.value = slot.model;
        await loadLiveModels(slot.providerId);
      } else if (value === '__refresh') {
        event.target.value = slot.model;
        await refreshProviders();
        return;
      } else {
        slot.model = value;
      }
      saveSlots();
      renderColumns();
      renderComposer();
    }
  });

  $('#modelChips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.action === 'open-models') return openSettings('models');
    const slot = state.slots.find((s) => s.id === chip.dataset.slot);
    if (!slot) return;
    slot.enabled = !slot.enabled;
    slot.auto = false;
    if (!slot.enabled && state.focusSlot === slot.id) state.focusSlot = null;
    saveSlots();
    renderColumns();
    renderComposer();
  });

  $('#suggestions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-suggest]');
    if (button) sendPrompt(button.dataset.suggest);
  });

  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    if (isBusy()) stopAll();
    else sendPrompt($('#prompt').value);
  });

  const area = $('#prompt');
  area.addEventListener('input', autoGrow);
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !mobile.matches) {
      event.preventDefault();
      if (!isBusy()) sendPrompt(area.value);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isBusy() && !settings.open && !lock.open) stopAll();
  });

  systemDark.addEventListener('change', () => state.prefs.theme === 'system' && applyTheme());
  mobile.addEventListener('change', () => $('#app').classList.remove('sidebar-open'));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function boot() {
  const ok = await loadConfig();
  if (ok) renderAll();
  else renderComposer();
  return ok;
}

hydrateIcons();
applyTheme();
$('#app').classList.toggle('sidebar-hidden', !!state.prefs.sidebarHidden && !mobile.matches);
bindEvents();
setupVoice();
renderHistory();
renderTopbar();
boot();
