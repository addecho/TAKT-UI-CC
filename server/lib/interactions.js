'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class InteractionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Serialize the whole operation, including verification and the delayed Enter.
function createQueue() {
  const jobs = new Map();
  return (key, operation) => {
    const previous = jobs.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    jobs.set(key, current);
    const cleanup = () => { if (jobs.get(key) === current) jobs.delete(key); };
    current.then(cleanup, cleanup);
    return current;
  };
}

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

async function checkedPath(root, target) {
  if (!target || !inside(root, target)) throw new InteractionError(400, '路径不在所选节点的工作区内');
  const realRoot = await fs.realpath(root);
  let ancestor = path.resolve(target);
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!inside(realRoot, real)) throw new InteractionError(400, '符号链接指向工作区外，操作已拒绝');
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // A broken symlink must not be treated as a new, safe path.
      try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new InteractionError(400, '无效符号链接'); }
      catch (statErr) { if (statErr.code !== 'ENOENT') throw statErr; }
      if (ancestor === path.dirname(ancestor)) throw err;
      ancestor = path.dirname(ancestor);
    }
  }
  return path.resolve(target);
}

function fileName(raw) {
  const value = String(raw || '').trim();
  if (!value || value === '.' || value === '..' || /[\\/\x00-\x1f]/.test(value)) {
    throw new InteractionError(400, '无效的文件名或目录名');
  }
  return value;
}

const MAX_TREE_UPLOAD_BYTES = 10 * 1024 * 1024;
async function writeUpload(root, directory, name, base64, overwrite = false) {
  name = fileName(name);
  const content = String(base64 || '');
  if (content.length > Math.ceil(MAX_TREE_UPLOAD_BYTES / 3) * 4) throw new InteractionError(413, '文件树上传上限为 10 MB');
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64') !== content) throw new InteractionError(400, '文件编码无效');
  if (bytes.length > MAX_TREE_UPLOAD_BYTES) throw new InteractionError(413, '文件树上传上限为 10 MB；大文件请使用对话附件');
  const dir = await checkedPath(root, directory);
  const destination = await checkedPath(root, path.join(dir, name));
  await fs.mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.takt-upload-${crypto.randomUUID()}.part`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    if (overwrite) await fs.rename(temporary, destination);
    else await fs.link(temporary, destination); // exclusive commit; never replaces an existing file
  } catch (err) {
    if (err.code === 'EEXIST') throw new InteractionError(409, '同名文件已存在，确认后才能覆盖');
    throw err;
  } finally { await fs.rm(temporary, { force: true }); }
  return { path: destination, size: bytes.length };
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let failed = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!failed) reject(new InteractionError(413, '请求过大，请缩小文件后重试'));
        failed = true; chunks.length = 0;
      } else if (!failed) chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new InteractionError(400, 'JSON 请求无效')); }
    });
    req.on('aborted', () => reject(new InteractionError(400, '请求已中断')));
    req.on('error', reject);
  });
}

module.exports = { InteractionError, createQueue, inside, checkedPath, fileName, writeUpload, readJsonBody, MAX_TREE_UPLOAD_BYTES };
