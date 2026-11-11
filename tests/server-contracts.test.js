'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');
const { InteractionError, createQueue } = require('../server/lib/interactions');
const source = fs.readFileSync(path.join(__dirname, '../server/server.js'), 'utf8');
const mcp = fs.readFileSync(path.join(__dirname, '../mcp-server/server.js'), 'utf8');
function section(s, start, end) {
  const a = s.indexOf(start), b = s.indexOf(end, a + start.length);
  assert(a >= 0 && b > a); return s.slice(a, b);
}

test('chat view exports verified session and binding fields required for submission', async () => {
  const bound = { path: '', host: 'fixture', resolvedSessionId: 'S', bindingToken: 'binding',
    bindingSource: 'process-registry', bindingError: '', claudeRunning: true, stale: false };
  const c = vm.createContext({ sweepDocktermCaches() {}, resolveDocktermTarget: () => bound,
    refreshDocktermTab: async () => {}, docktermTranscripts: new Map() });
  vm.runInContext(section(source, 'async function fetchDocktermChatView(', 'async function fetchDocktermHistory('), c);
  const data = await c.fetchDocktermChatView({ tabId: 'W', sessionId: 'obsolete' });
  assert.equal(data.resolvedSessionId, 'S'); assert.equal(data.bindingToken, 'binding');
  assert.equal(data.bindingSource, 'process-registry'); assert.equal(data.tabId, 'W');
});

test('chat input rejects missing/stale bindings and exited Claude before SSH delivery', async () => {
  const bound = { host: 'fixture', tmuxSess: 'takt_W', stale: false, tmuxAlive: true,
    claudeRunning: true, resolvedSessionId: 'S', bindingToken: 'binding' };
  let calls = 0;
  const c = vm.createContext({ requireNode: () => ({ id: 'N', sshHost: 'fixture' }),
    readJsonBody: async req => req.body, resolveDocktermTarget: () => bound, queueInteraction: createQueue(),
    refreshDocktermTab: async () => {}, InteractionError, fs, path, __dirname: path.join(__dirname, '../server'), Buffer,
    DOCKTERM_SSH_OPTS: [], runCmd: async () => { calls++; return { stdout: '{"ok":true}', exitCode: 0 }; },
    sendJson: (res, status, data) => Object.assign(res, { status, ...data }) });
  const body = section(source, "    if (req.method === 'POST' && u.pathname === '/api/chat-input') {", '    // API: Bottom Status Bar')
    .replace("    if (req.method === 'POST' && u.pathname === '/api/chat-input') {", '{');
  vm.runInContext('async function input(req,res){' + body + '}', c);
  const request = { tabId: 'W', expectedSessionId: 'S', expectedBinding: 'binding', text: 'fixture' };
  for (const invalid of [{ ...request, expectedBinding: '' }, { ...request, expectedSessionId: 'other' }, { ...request, expectedBinding: 'old' }]) {
    await assert.rejects(c.input({ body: invalid }, {}), { status: 409 });
  }
  bound.claudeRunning = false;
  await assert.rejects(c.input({ body: request }, {}), { status: 409 });
  assert.equal(calls, 0);
  bound.claudeRunning = true;
  const result = {}; await c.input({ body: request }, result);
  assert.equal(result.ok, true); assert.equal(calls, 1);
});

test('overlapping MCP calls retain their own node and never borrow another node file', async () => {
  const context = new AsyncLocalStorage();
  const nodes = ['A', 'B'].map(id => ({ id, sshHost: id, remoteWorkDir: '/home/dev/work', localWorkDir: '/local/' + id }));
  const c = vm.createContext({ mcpNodeContext: context, loadConfiguredNodes: () => nodes,
    MAC_WORK_DIR: '/local/A', LINUX_WORK_DIR: '/root/work', LINUX_ALT_WORK_DIR: '/home/ubuntu/work',
    cfg: { TAKT_HOME: '/local', WORKSPACE_LINK_DIR: '' }, path, fs: { existsSync: () => true } });
  vm.runInContext(section(mcp, 'function getActiveNodeConfig(', 'function rewriteScriptPaths('), c);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const a = context.run('A', async () => { await gate; return c.resolveWorkPath('/home/dev/work/report.pdf'); });
  const b = context.run('B', async () => { release(); await Promise.resolve(); return c.resolveWorkPath('/home/dev/work/report.pdf'); });
  assert.deepEqual(await Promise.all([a, b]), ['/local/A/report.pdf', '/local/B/report.pdf']);
  assert.throws(() => context.run('unknown', () => c.resolveWorkPath('report.pdf')), /Unknown MCP node/);
});
