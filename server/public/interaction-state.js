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
  return { sessionTabs, latestRequest, restoreFailedAttempt };
});
