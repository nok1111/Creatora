from qa_common import *
c = connect(reload=True)
media = os.path.abspath("qa/media").replace("\\", "/")
files = [f"{media}/{n}.mp4" for n in ["clipA","clipB","clipC","clipPortrait","clip4k"]]
r = js(c, f"""(async () => {{
  const q = window.__qa; const id = await q.api.importMedia({json.dumps(files)});
  const fin = await q.jobs.awaitJob(id);
  const assets = await q.api.listAssets();
  return {{status: fin.status, result: fin.result, err: fin.error, assets: assets.map(a => ({{id:a.id,name:a.name,w:a.width,h:a.height,d:a.durationMs,audio:a.audioCodec,path:a.filePath,status:a.status,proxy:a.proxyPath}}))}};
}})()""")
print(json.dumps(r, indent=1)[:3000])
