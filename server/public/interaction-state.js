(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaktInteractions = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function sessionTabs(tabs, nodeId, sessionId) {
    return Array.from(tabs.values()).filter(t => t.nodeId === nodeId &&
      (t.chat?.resolvedSessionId || t.sessionId) === sessionId);
  }
  function latestRequest() {
    let revision = 0;
    return { next: () => ++revision, current: ticket => ticket === revision };
  }
  function restoreFailedAttempt(draft, attachments, revision, attempt) {
    if (revision !== attempt.revision || draft !== '') return { draft, attachments, restored: false };
    return { draft: attempt.text, attachments: [...attempt.attachments, ...attachments.filter(a => !attempt.attachments.includes(a))], restored: true };
  }
  // Claude Code wraps long bracketed pastes in standalone pasted_content tags.
  // Keep attachment paths and all message content in the comparison.
  function messageIdentity(text) {
    return String(text || '').replace(/^[ \t]*<\/?pasted_content(?:[ \t]+id=(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*>[ \t]*$/gm, '')
      .replace(/\s+/g, ' ').trim();
  }
  function reconcilePending(pending, messages) {
    const used = new Set();
    const users = (messages || []).filter(m => m.role === 'user');
    return pending.filter(p => {
      const key = messageIdentity(p.text);
      const hit = key && users.find(m => !used.has(m.id) &&
        !(p.knownUserIds || []).includes(m.id) && Number(m.ts) >= p.at - 2000 &&
        messageIdentity(m.text) === key);
      if (!hit) return true;
      used.add(hit.id);
      return false;
    });
  }
  return { sessionTabs, latestRequest, restoreFailedAttempt, messageIdentity, reconcilePending };
});
