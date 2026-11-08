// Boots the CQA component into every element with [data-cqa] (or #cqa-root).
// Configuration, first match wins:
//   1. data-* attributes on the root element: data-api-base, data-group, data-dialog
//   2. window.CQA_CONFIG = { apiBase, group, dialog } set by the host page
//   3. query string: ?group=…&dialog=… or Dynamics 365's ?data=group%3DDEV%26dialog%3D… (custom parameter of a web resource)
// apiBase is the CQA server address ('' = same origin). A host on another origin needs CORS on the server.
import { createArchiveApi, filterDialogs } from './cqa-api.js';

function queryConfig() {
  const params = new URLSearchParams(location.search);
  const extra = new URLSearchParams(params.get('data') || '');
  const pick = key => params.get(key) || extra.get(key) || '';
  return { apiBase: pick('apiBase'), group: pick('group'), dialog: pick('dialog') };
}

export function mountCqa(root, options = {}) {
  const global = window.CQA_CONFIG || {}, query = queryConfig(), data = root.dataset || {};
  const config = {
    apiBase: data.apiBase ?? options.apiBase ?? global.apiBase ?? query.apiBase ?? '',
    group: data.group || options.group || global.group || query.group || '',
    dialog: data.dialog || options.dialog || global.dialog || query.dialog || '',
  };
  const request = createArchiveApi({
    base: config.apiBase,
    onProgress: job => {
      const node = root.querySelector('.toast');
      if (node) node.textContent = (job.currentConversationId ? 'Проверяется ' + job.currentConversationId : 'Диалог в очереди') + '. Результат сохраняется на сервере.';
    },
  });
  return window.CQA.mount(root, { request, filterDialogs, group: config.group, dialog: config.dialog });
}

function start() {
  const roots = document.querySelectorAll('[data-cqa], #cqa-root');
  window.cqaWorkbench = [...new Set(roots)].map(root => mountCqa(root))[0];
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
