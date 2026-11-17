(async () => {
  const stage = document.querySelector('video[data-clip-id]');
  let n = stage;
  while (n && !Object.keys(n).some(k => k.startsWith('__reactFiber'))) n = n.parentElement;
  const key = Object.keys(n).find(k => k.startsWith('__reactFiber'));
  let f = n[key], depth = 0;
  while (f && depth < 60) {
    if (f.type && f.type.name === 'Preview') break;
    f = f.return; depth++;
  }
  let h = f.memoizedState, i = 0, target = null;
  while (h && i < 80) {
    if (h.queue && typeof h.queue.dispatch === 'function' && h.memoizedState === false) { target = h; break; }
    h = h.next; i++;
  }
  if (!target) return 'no false-boolean useState';
  window.__glokCalls = [];
  const orig = target.queue.dispatch;
  target.queue.dispatch = (v) => { window.__glokCalls.push([JSON.stringify(v), (new Error()).stack?.split('\n').slice(2,8).join(' | ').slice(0,400)]); orig(v); };
  target.queue.dispatch(true);
  await new Promise(r => setTimeout(r, 400));
  const { filterGL } = await import('/src/lib/fx/gl-filter.ts');
  const g = filterGL();
  const cv = document.querySelector('video[data-clip-id]')?.parentElement?.querySelector('canvas');
  return JSON.stringify({
    restored: true, gl: !!g.gl, lost: g.lost,
    cv: cv ? cv.width + 'x' + cv.height : 'none',
    calls: window.__glokCalls
  });
})()
