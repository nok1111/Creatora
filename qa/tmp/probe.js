(() => {
  const stage = document.querySelector('video[data-clip-id]');
  let n = stage;
  while (n && !Object.keys(n).some(k => k.startsWith('__reactFiber'))) n = n.parentElement;
  const key = Object.keys(n).find(k => k.startsWith('__reactFiber'));
  let f = n[key], depth = 0;
  while (f && depth < 60) {
    if (f.type && f.type.name === 'Preview') break;
    f = f.return; depth++;
  }
  let h = f.memoizedState, i = 0, wrapped = 0;
  window.__dispLog = [];
  while (h && i < 60) {
    if (h.queue && typeof h.queue.dispatch === 'function') {
      const orig = h.queue.dispatch;
      const idx = i;
      h.queue.dispatch = (v) => {
        const st = new Error('x').stack || '';
        window.__dispLog.push([idx, typeof v === 'function' ? 'fn' : JSON.stringify(v).slice(0,40), st.split('\n').slice(1,7).join(' | ').slice(0,500)]);
        orig(v);
      };
      wrapped++;
    }
    h = h.next; i++;
  }
  return 'wrapped: ' + wrapped;
})()
