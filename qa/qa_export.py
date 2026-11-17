from qa_common import *
import time, subprocess, threading, re
c = connect()
out = os.path.abspath("qa/out/export_full.mp4").replace("\\","/")
peak = {"ffmpeg":0}
stop = False
def sample():
    while not stop:
        o = subprocess.run(["tasklist","/FI","IMAGENAME eq ffmpeg.exe","/FO","CSV","/NH"],capture_output=True,text=True).stdout
        for line in o.splitlines():
            m = re.findall(r'"([^"]*)"', line)
            if len(m) >= 5 and m[0].lower()=="ffmpeg.exe":
                kb = int(re.sub(r"[^0-9]","",m[4]) or 0); peak["ffmpeg"] = max(peak["ffmpeg"], kb)
        time.sleep(0.25)
th = threading.Thread(target=sample); th.start()
t0 = time.time()
r = js(c, f"""(async()=>{{ const q=window.__qa; const P=q.useProject.getState(); await P.save();
  const id = await q.api.exportProject(P.filePath, {json.dumps(out)}, undefined, null); const f = await q.jobs.awaitJob(id); return f; }})()""")
dt = time.time()-t0; stop=True; th.join()
print(r["status"], r.get("error"), f"{dt:.1f}s", f"peak ffmpeg RSS {peak['ffmpeg']/1024:.0f} MB")
