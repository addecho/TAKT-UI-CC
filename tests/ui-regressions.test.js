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
    getNodeInfo: () => ({ id: 'N', badge: 'AWS' }), toLocalMacPath: x => x,
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
    getNodeInfo: () => ({ id: 'N' }), toLocalMacPath: x => x,
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
