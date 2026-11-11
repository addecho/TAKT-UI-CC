'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { createQueue, checkedPath, writeUpload, inside, readJsonBody, fileName, MAX_TREE_UPLOAD_BYTES } = require('../server/lib/interactions');
const state = require('../server/public/interaction-state');

test('one pane serializes text + Enter; other panes can proceed; failures do not stall the queue', async () => {
  const queue = createQueue(), events = [];
  let unlock;
  const gate = new Promise(resolve => { unlock = resolve; });
  const first = queue('A', async () => { events.push('A:text1'); await gate; events.push('A:enter1'); });
  const second = queue('A', async () => { events.push('A:text2'); events.push('A:enter2'); });
  await queue('B', async () => { events.push('B'); });
  assert.deepEqual(events, ['A:text1', 'B']);
  unlock(); await Promise.all([first, second]);
  assert.deepEqual(events, ['A:text1', 'B', 'A:enter1', 'A:text2', 'A:enter2']);
  await assert.rejects(queue('A', async () => { throw new Error('offline'); }));
  assert.equal(await queue('A', async () => 42), 42);
});

test('session identity wins over tab ID, and same ID on another node is independent', () => {
  const tabs = new Map([['S', { tabId: 'S', sessionId: 'T', nodeId: 'A' }],
    ['window', { tabId: 'window', sessionId: 'S', nodeId: 'A' }],
    ['other', { tabId: 'other', sessionId: 'S', nodeId: 'B' }]]);
  assert.equal(state.sessionTabs(tabs, 'A', 'S')[0].tabId, 'window');
  assert.equal(state.sessionTabs(tabs, 'B', 'S')[0].tabId, 'other');
});

test('late file responses cannot take ownership of a newer project', () => {
  const requests = state.latestRequest(), a = requests.next(), b = requests.next();
  assert.equal(requests.current(b), true); assert.equal(requests.current(a), false);
});

test('failed send restores text AND attachments; subsequent input and new attachments survive', () => {
  const attachment = { id: 'a' }, newAttachment = { id: 'b' };
  const attempt = { revision: 2, text: 'original', attachments: [attachment] };
  const retry = state.restoreFailedAttempt('', [newAttachment], 2, attempt);
  assert.equal(retry.draft, 'original'); assert.deepEqual(retry.attachments, [attachment, newAttachment]);
  const newer = state.restoreFailedAttempt('new draft', [newAttachment], 3, attempt);
  assert.equal(newer.draft, 'new draft'); assert.deepEqual(newer.attachments, [newAttachment]);
  assert.equal(newer.restored, false);
});

test('worktree writes reject traversal, prefix siblings and symlinks (including broken links)', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'takt-path-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'work'), outside = path.join(tmp, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'link'));
  await fs.symlink(path.join(tmp, 'missing'), path.join(root, 'broken'));
  assert.equal(inside(root, root + '-other/file'), false);
  for (const target of [path.join(root, '..', 'outside/file'), path.join(root, 'link/file'), path.join(root, 'broken/file')]) {
    await assert.rejects(checkedPath(root, target));
  }
  await assert.rejects(writeUpload(root, path.join(root, 'link'), 'x', 'eA=='), { status: 400 });
  assert.deepEqual(await fs.readdir(outside), []);
  for (const name of ['..', '.', '../file', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => fileName(name));
});

test('same-name and concurrent uploads preserve originals; confirmed overwrite commits atomically', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'takt-upload-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upload = text => writeUpload(root, root, 'report.pdf', Buffer.from(text).toString('base64'));
  await upload('original');
  await assert.rejects(upload('replacement'), { status: 409 });
  assert.equal(await fs.readFile(path.join(root, 'report.pdf'), 'utf8'), 'original');
  await writeUpload(root, root, 'report.pdf', Buffer.from('confirmed').toString('base64'), true);
  assert.equal(await fs.readFile(path.join(root, 'report.pdf'), 'utf8'), 'confirmed');
  const results = await Promise.allSettled(['a', 'b'].map(x => writeUpload(root, root, 'new.txt', Buffer.from(x).toString('base64'))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await fs.readdir(root)).filter(x => x.endsWith('.part')).length, 0);
  await assert.rejects(writeUpload(root, root, 'x', 'invalid%%'), { status: 400 });
  await assert.rejects(writeUpload(root, root, 'large', Buffer.alloc(MAX_TREE_UPLOAD_BYTES + 1).toString('base64')), { status: 413 });
});

test('JSON parser preserves UTF-8 across chunks and rejects malformed/oversized bodies', async () => {
  const bytes = Buffer.from(JSON.stringify({ name: '报告' }));
  assert.deepEqual(await readJsonBody(Readable.from([bytes.subarray(0, 10), bytes.subarray(10)])), { name: '报告' });
  await assert.rejects(readJsonBody(Readable.from([Buffer.from('{bad')])), { status: 400 });
  await assert.rejects(readJsonBody(Readable.from([Buffer.alloc(9)]), 8), { status: 413 });
});
