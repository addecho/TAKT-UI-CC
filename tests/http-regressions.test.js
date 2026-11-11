'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

test('isolated HTTP server: upload conflicts, node ownership, archive and browser contracts', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'takt-http-test-'));
  const root = path.join(home, 'data');
  await fs.mkdir(root);
  const nodes = ['A', 'B'].map(id => ({ id, name: id, badge: id, localWorkAlias: 'work' + id,
    localWorkDir: path.join(root, 'work' + id), remoteWorkDir: '/work', sshHost: '', enabled: false }));
  await fs.writeFile(path.join(root, 'nodes.json'), JSON.stringify({ nodes }));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['server/server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOME: home, TAKT_HOME: root, TAKT_PORT: String(port), TAKT_MANAGED_SERVICES: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await fs.rm(home, { force: true, recursive: true });
  });
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 80 && child.exitCode === null; i++) {
    try { if ((await fetch(base + '/')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, output);
  const post = async (url, body, method = 'POST') => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await fetch(base + '/interaction-state.js')).status, 200);
  const file = { nodeId: 'A', cwd: '/work', targetDirPath: '/work', fileName: 'report.txt', contentBase64: Buffer.from('报告').toString('base64') };
  assert.equal((await post('/api/files/upload', file)).status, 200);
  assert.equal((await post('/api/files/upload', file)).status, 409);
  assert.equal((await post('/api/files/upload', { ...file, overwrite: true })).status, 200);
  const tree = await (await fetch(base + '/api/files?cwd=/work&nodeId=A')).json();
  assert.equal(tree.items[0].remotePath, '/work/report.txt'); assert.equal(tree.items[0].nodeId, 'A');
  assert.equal((await post('/api/files/upload', { ...file, targetDirPath: nodes[1].localWorkDir })).status, 400);
  assert.equal((await post('/api/files/upload', { ...file, nodeId: 'missing' })).status, 400);
  const outside = path.join(home, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(nodes[0].localWorkDir, 'escape'));
  assert.equal((await post('/api/files/upload', { ...file, targetDirPath: '/work/escape' })).status, 400);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal((await post('/api/files/mkdir', { nodeId: 'A', cwd: '/work', name: '..' })).status, 400);
  assert.equal((await post('/api/file-reference', { nodeId: 'A', cwd: '/work', path: '/work/report.txt' })).status, 409);
  assert.equal((await post('/api/chat-input', { nodeId: 'A', tabId: 'fixture', text: 'never execute' })).status, 409);
  for (const nodeId of ['A', 'B']) await post('/api/sessions/register', { id: 'same-session', nodeId, cwd: '/work', title: nodeId });
  await post('/api/sessions/rename', { id: 'same-session', nodeId: 'A', title: 'renamed A' });
  const deleted = await fetch(base + '/api/sessions?nodeId=A&id=same-session', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const db = new DatabaseSync(path.join(root, 'takt-workbench.sqlite'));
  const rows = db.prepare('SELECT node_id, title, deleted FROM sessions WHERE id = ? ORDER BY node_id').all('same-session'); db.close();
  assert.equal(rows[0].title, 'renamed A'); assert.equal(rows[0].deleted, 1);
  assert.equal(rows[1].title, 'B'); assert.equal(rows[1].deleted, 0);
  const badJson = await fetch(base + '/api/tags', { method: 'POST', body: '{bad' }); assert.equal(badJson.status, 400);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/tree', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(base + '/api/tags', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
});
