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
  let h = f.memoizedState, i = 0;
  const out = [];
  while (h && i < 80) {
    const ms = h.memoizedState;
    let v = typeof ms;
    if (typeof ms === 'boolean' || typeof ms === 'number' || typeof ms === 'string') v = ms;
    else if (ms === null) v = 'null';
    else if (typeof ms === 'object' && ms && ms.current !== undefined) v = 'ref';
    out.push([i, v, !!h.queue]);
    h = h.next; i++;
  }
  return JSON.stringify(out);
})()
