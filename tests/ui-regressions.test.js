'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = fs.readFileSync(require('node:path').join(__dirname, '../server/public/index.html'), 'utf8');
const TaktInteractions = require('../server/public/interaction-state');
const noop = () => {};
function section(start, end) {
  const a = ui.indexOf(start), b = ui.indexOf(end, a + start.length);
  assert(a >= 0 && b > a); return ui.slice(a, b);
}

test('every inline browser script parses', () => {
  for (const m of ui.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (m[1].trim()) new Function(m[1]);
});

test('actual file loader discards an earlier response after switching projects', async () => {
  const pending = [], elements = new Map();
  const c = vm.createContext({ TaktInteractions, AbortController, currentFilesCwd: '', currentFilesNodeId: 'N',
    filesSig: '', filesPending: false, currentFileTree: [], selectedFilePath: '', previewAbortCtrl: null,
    getNodeInfo: () => ({ id: 'N', badge: 'AWS' }), toLocalPath: x => x,
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    fetch: url => new Promise(resolve => pending.push({ url, resolve })), filesUserBusy: () => false,
    renderFileTree: noop, ensureFilesLive: noop, console });
  vm.runInContext(section('      const filesRequests =', '      // ---- Live file tree'), c);
  const a = c.loadSessionFiles('/work/A', 'N'), b = c.loadSessionFiles('/work/B', 'N');
  pending[1].resolve({ ok: true, json: async () => ({ ok: true, items: [{ name: 'B.txt' }] }) }); await b;
  pending[0].resolve({ ok: true, json: async () => ({ ok: true, items: [{ name: 'A.txt' }] }) }); await a;
  assert.equal(c.currentFileTree[0].name, 'B.txt'); assert.equal(c.currentFilesCwd, '/work/B');
});

test('actual list refresh never activates a duplicate session or steals focus', async () => {
  const tabs = new Map([['window-A', { tabId: 'window-A', nodeId: 'N', sessionId: 'S' }],
    ['window-B', { tabId: 'window-B', nodeId: 'N', sessionId: 'T' }]]);
  const c = vm.createContext({ TaktInteractions, tabs, activeTabId: 'window-B', getNodeInfo: id => ({ id }),
    fetch: async () => ({ json: async () => ({ folders: [], openTabs: [{ tabId: 'duplicate', sessionId: 'S', nodeId: 'N' }] }) }),
    applyTagPayload: noop, foldersData: [], visibleProjectKeys: new Set(), initialVisibilityResolved: true,
    renderProjectTree: noop, console });
  vm.runInContext('function activateTerminalTab(id){activeTabId=id}', c);
  vm.runInContext(section('      function findSessionTab(', '      function ensureWebTerminalConnected('), c);
  vm.runInContext(section('      async function loadProjectTree(', '      let showEmptyFolders'), c);
  await c.loadProjectTree(); assert.equal(c.activeTabId, 'window-B');
  c.openOrSwitchTerminalTab({ tabId: 'S', sessionId: 'S', nodeId: 'N' });
  assert.equal(c.activeTabId, 'window-A');
});

test('cancelled file requests are normal and do not produce console errors', async () => {
  const errors = [], elements = new Map();
  const c = vm.createContext({ TaktInteractions, AbortController, currentFilesCwd: '', currentFilesNodeId: 'N',
    filesSig: '', filesPending: false, currentFileTree: [], selectedFilePath: '', previewAbortCtrl: null,
    getNodeInfo: () => ({ id: 'N' }), toLocalPath: x => x,
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    fetch: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
    renderFileTree: noop, console: { error: message => errors.push(message) } });
  vm.runInContext(section('      const filesRequests =', '      // ---- Live file tree'), c);
  await c.loadSessionFiles('/work/A', 'N'); assert.deepEqual(errors, []);
});

test('an idle history window uses its resolved conversation title', () => {
  const t = { tabId: 'W', nodeId: 'N', sessionId: 'S', title: 'stale title' };
  const chat = { epoch: 'epoch', ver: 1, pending: [], resolvedSessionId: 'S', status: 'idle' };
  const c = vm.createContext({ ensureChatState: () => chat, activeChatTab: () => null,
    foldersData: [{ nodeId: 'N', sessions: [{ id: 'S', title: 'Actual history' }] }],
    cleanSessionTitle: x => x, renderTabBar: noop, claudeLaunchCommand: () => '',
    mergeDocktermMessages: () => ({ added: [], updated: [] }) });
  vm.runInContext(section('      function applyDocktermData(', '      async function pollDockterm('), c);
  c.applyDocktermData(t, { tabId: 'W', epoch: 'epoch', resolvedSessionId: 'S', claudeRunning: false, jsonlPath: '/fixture/S.jsonl' });
  assert.equal(t.title, 'Actual history');
});

test('deleting a sidebar conversation never closes a tab by confusing its ID with a session ID', async () => {
  const closed = [];
  const c = vm.createContext({ tabs: new Map([['S', { sessionId: 'T' }]]), sess: { id: 'S', title: 'test' },
    folder: { nodeId: 'N' }, confirm: () => true, e: { stopPropagation: noop },
    closeTerminalTab: async id => closed.push(id), fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    loadProjectTree: noop });
  const body = section('                if (!confirm(`从列表隐藏会话', '\n              });');
  await vm.runInContext('(async()=>{' + body + '})()', c); assert.deepEqual(closed, []);
});

async function failedSend(newDraft) {
  const tab = { tabId: 'W' }, chat = { status: 'idle', loaded: true, claudeRunning: true, bindingToken: 'binding', pending: [] };
  const attachment = { id: 'a', status: 'done', remotePath: '/work/.takt/uploads/file.pdf', name: 'file.pdf' };
  let resolveSend;
  const c = vm.createContext({ TaktInteractions, activeChatTab: () => tab, ensureChatState: () => chat,
    dtSubmitting: false, dtInput: { value: 'original' }, dtAttachments: new Map([['W', [attachment]]]),
    dtDrafts: new Map(), dtHistory: new Map(), dtHistCursor: new Map(), DT_ATTACH_LABEL: 'Attachment: ',
    dtSlashMenu: { classList: { remove: noop } }, DOCKTERM_PICKER_SLASH_RE: /^\/model$/,
    dtSuggestBtn: { addEventListener: noop },
    dtPinned: false, renderDocktermAttachments: noop, autoGrowDocktermComposer: noop, updateDocktermSendState: noop,
    renderDocktermPending: noop, renderDocktermChrome: noop, requestAnimationFrame: noop, scrollDocktermToBottom: noop,
    sendDocktermRawInput: () => new Promise(resolve => { resolveSend = resolve; }), showToast: noop, generateUUID: () => 'attempt' });
  vm.runInContext('function dtAttachList(t){return dtAttachments.get(t.tabId)||[]}', c);
  vm.runInContext(section('      const dtDraftRevision =', "      dtInput.addEventListener('input'"), c);
  const sending = c.submitDocktermComposerPrompt();
  // A second submit during the first transaction must not enqueue another operation.
  await c.submitDocktermComposerPrompt(); assert.equal(chat.pending.length, 1);
  if (newDraft) {
    c.dtInput.value = 'new draft'; c.dtDrafts.set('W', 'new draft');
    vm.runInContext("dtDraftRevision.set('W',1)", c);
  }
  resolveSend({ ok: false, delivered: false, error: 'offline' }); await sending;
  return { c, chat, attachment };
}

test('actual failed send restores attachment together with the original text', async () => {
  const { c, attachment } = await failedSend(false);
  assert.equal(c.dtInput.value, 'original'); assert.equal(c.dtAttachments.get('W')[0], attachment);
});

test('actual late failure preserves a newer draft and keeps the complete old attempt recoverable', async () => {
  const { c, chat, attachment } = await failedSend(true);
  assert.equal(c.dtInput.value, 'new draft'); assert.equal(chat.pending[0].attempt.attachments[0], attachment);
  assert.equal(chat.sending, false);
});

function pendingPoll({ pending, messages, status = 'idle', stale = false }) {
  const t = { tabId: 'W', nodeId: 'N', sessionId: 'S' };
  const chat = { epoch: 'epoch', ver: 1, pending, messages, resolvedSessionId: 'S', status: 'idle' };
  const c = vm.createContext({ TaktInteractions, DT_PENDING_WAIT_MS: 30000,
    ensureChatState: () => chat, activeChatTab: () => null,
    renderTabBar: noop, claudeLaunchCommand: () => '',
    mergeDocktermMessages: () => ({ added: [], updated: [] }) });
  vm.runInContext(section('      function applyDocktermData(', '      async function pollDockterm('), c);
  c.applyDocktermData(t, { tabId: 'W', epoch: 'epoch', resolvedSessionId: 'S', status, stale, claudeRunning: true });
  return chat;
}

test('long attachment paste already received during send is acknowledged from existing rows', () => {
  const text = '再过一下这两个文件 没问题打算定稿了\n\n[附件] /work/a.docx\n[附件] /work/b.docx';
  const at = Date.now();
  const chat = pendingPoll({ pending: [{ text, at, inflight: true, knownUserIds: ['old'] }],
    messages: [{ id: 'new', role: 'user', ts: at + 500, text: '\n<pasted_content id="9bd2">\n' + text + '\n</pasted_content id="9bd2">\n' }] });
  assert.equal(chat.pending.length, 0);
});

test('idle delay becomes unconfirmed without claiming delivery failure; busy or stale stays waiting', () => {
  const old = () => ({ text: 'not observed', at: Date.now() - 60000 });
  const chat = pendingPoll({ pending: [old()], messages: [] });
  assert.equal(chat.pending[0].failed, undefined); assert.equal(chat.pending[0].unconfirmed, true);
  for (const mode of [{ status: 'working' }, { stale: true }]) {
    assert.equal(pendingPoll({ pending: [old()], messages: [], ...mode }).pending[0].unconfirmed, undefined);
  }
});

test('same text in older history or with another attachment cannot acknowledge a new attempt', () => {
  const at = Date.now(), text = 'review\n[附件] /work/a.docx';
  const pending = [{ text, at, knownUserIds: ['known'] }];
  const messages = [
    { id: 'known', role: 'user', ts: at, text },
    { id: 'older', role: 'user', ts: at - 10000, text },
    { id: 'other', role: 'user', ts: at, text: 'review\n[附件] /work/b.docx' }
  ];
  assert.equal(pendingPoll({ pending, messages }).pending.length, 1);
  // A single transcript record cannot acknowledge two identical attempts.
  assert.equal(TaktInteractions.reconcilePending([{ text, at }, { text, at }],
    [{ id: 'new', role: 'user', ts: at, text }]).length, 1);
});

function liveCardFixture() {
  const el = () => ({ hidden: false, textContent: '', open: false });
  const c = vm.createContext({ dtLiveEl: el(), dtLiveText: el(), dtLiveTail: el(), dtLiveDetails: el() });
  vm.runInContext(section('      let dtLiveContext =', '      function renderDocktermChrome('), c);
  return c;
}
test('execution card exposes current duration; previous conversation stays in collapsed diagnostics', () => {
  const c = liveCardFixture();
  const tail = 'old reply\n✻ Baked for 1m 46s · done 2:18 AM\nRead file\n✻ Actioning… (6s · ↓ 102 tokens)';
  c.renderDocktermLive({ tabId: 'A', sessionId: 'S', chat: { status: 'working', tail } });
  assert.equal(c.dtLiveText.textContent, 'Claude 正在执行 · 6s');
  assert.equal(c.dtLiveDetails.open, false); assert.equal(c.dtLiveTail.textContent, tail);
  assert.equal(c.dtLiveEl.hidden, false);
});
test('terminal details stay open during polling but close on turns, tabs, sessions, and idle', () => {
  const c = liveCardFixture(), t = { tabId: 'A', sessionId: 'S', chat: { status: 'working', tail: 'terminal', messages: [{ role: 'user', id: 'U' }] } };
  c.renderDocktermLive(t); c.dtLiveDetails.open = true; c.renderDocktermLive(t);
  assert.equal(c.dtLiveDetails.open, true);
  for (const change of [() => { t.chat.messages.push({ role: 'user', id: 'next' }); },
    () => { t.tabId = 'B'; }, () => { t.chat.resolvedSessionId = 'T'; }, () => { t.chat.epoch = 'reset'; }]) {
    c.dtLiveDetails.open = true; change(); c.renderDocktermLive(t); assert.equal(c.dtLiveDetails.open, false);
  }
  t.chat.status = 'idle'; c.dtLiveDetails.open = true; c.renderDocktermLive(t);
  assert.equal(c.dtLiveEl.hidden, true); assert.equal(c.dtLiveDetails.open, false); assert.equal(c.dtLiveTail.textContent, '');
});
test('missing spinner never borrows historical completion time; stale status does not claim live execution', () => {
  const c = liveCardFixture(), t = { tabId: 'A', chat: { status: 'working', tail: '✻ Baked for 1m 46s · done 2:18 AM' } };
  c.renderDocktermLive(t); assert.equal(c.dtLiveText.textContent, 'Claude 正在执行…');
  t.chat.stale = true; c.renderDocktermLive(t); assert.equal(c.dtLiveText.textContent, '连接暂不可用 · 执行状态待确认');
  t.chat.tail = ''; c.renderDocktermLive(t); assert.equal(c.dtLiveDetails.hidden, true);
});

function suggestionFixture() {
  const t = { tabId: 'A', chat: { suggestion: 'show the summary', status: 'idle', claudeRunning: true, pending: [] } };
  const atts = [], classes = new Map(), events = [];
  const c = vm.createContext({ activeChatTab: () => t, dtAttachList: () => atts,
    dtInput: { value: '', offsetTop: 0, placeholder: '', focus: noop, setSelectionRange: noop, dispatchEvent: e => events.push(e.type) },
    dtComposerBox: { classList: { toggle: (name, value) => classes.set(name, value) } },
    dtSuggestBtn: { hidden: true, style: {} }, DT_PLACEHOLDER: 'Write a message', Event: class { constructor(type) { this.type = type; } } });
  vm.runInContext(section('      function docktermSuggestion(', '      function insertIntoDocktermComposer('), c);
  return { c, t, atts, events };
}
test('next-step suggestion is a placeholder; accepting fills draft without submitting', () => {
  const { c, events } = suggestionFixture(); c.updateDocktermSuggestion();
  assert.equal(c.dtInput.value, ''); assert.equal(c.dtInput.placeholder, 'show the summary'); assert.equal(c.dtSuggestBtn.hidden, false);
  assert.equal(c.acceptDocktermSuggestion(), true); assert.equal(c.dtInput.value, 'show the summary'); assert.deepEqual(events, ['input']);
  c.updateDocktermSuggestion(); assert.equal(c.dtSuggestBtn.hidden, true);
});
test('suggestions preserve typed text and attachments and stay hidden during sending, stale or other sessions', () => {
  const { c, t, atts } = suggestionFixture();
  c.dtInput.value = 'my draft'; c.updateDocktermSuggestion(); assert.equal(c.dtSuggestBtn.hidden, true);
  assert.equal(c.acceptDocktermSuggestion(), false); assert.equal(c.dtInput.value, 'my draft'); c.dtInput.value = '';
  atts.push({ name: 'report.pdf' }); c.updateDocktermSuggestion(); assert.equal(c.dtSuggestBtn.hidden, true); assert.equal(c.acceptDocktermSuggestion(), false); atts.pop();
  for (const change of [{ stale: true }, { sending: true }, { bindingError: 'changed session' }, { claudeRunning: false }, { status: 'working' }, { pending: [{ text: 'inflight' }] }, { suggestionHoldUntil: Date.now() + 60000 }]) {
    const old = { ...t.chat }; Object.assign(t.chat, change); assert.equal(c.docktermSuggestion(t), ''); t.chat = old;
  }
  assert.equal(c.docktermSuggestion({ chat: { ...t.chat, suggestion: '' } }), '');
});
