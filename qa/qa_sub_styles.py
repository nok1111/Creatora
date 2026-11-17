import sys, time, json
sys.path.insert(0, "qa")
from qa_common import connect, js

c = connect()
P, F = [], []

def check(name, ok):
    (P if ok else F).append(name)
    print(("PASS " if ok else "FAIL ") + name)

# Open QA project, clear cues/saved styles.
js(c, """(async()=>{const{useProject}=window.__qa;
await useProject.getState().openFromPath('C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora');
useProject.getState().setDoc({...useProject.getState().doc, subtitles:[], subtitleStyles:[]});})()""")
# Ensure the bottom panel shows the timeline (the studio replaces it).
js(c, """(()=>{const b=[...document.querySelectorAll('button')].find(e=>/Timeline|Línea de tiempo|linea de tiempo/i.test(e.textContent));if(b)b.click();})()""", await_promise=False)
time.sleep(0.8)

# Seed two cues + one saved style (impact, magenta).
js(c, """(()=>{const{useProject,engine}=window.__qa;let d=useProject.getState().doc;
d=engine.addCue(d,{startMs:1000,endMs:3000,text:'cue one',words:[{word:'cue ',startMs:1000,endMs:2000},{word:'one',startMs:2000,endMs:3000}]}).doc;
d=engine.addCue(d,{startMs:4000,endMs:6000,text:'cue two',words:[]}).doc;
const r=engine.ensureSubtitleStyle(d,'Impact Mag',{text:{color:'#FF00FF',fontSizePx:60,fontFile:null,outlineColor:'#000',outlineWidth:3,backgroundColor:null,backgroundPadPx:0,alignH:'center',alignV:'bottom',shadowColor:null,shadowX:0,shadowY:0,lineSpacingPx:4},highlightColor:'#FFFF00',mode:'impact',marginVPx:40,marginHPx:30});
useProject.getState().setDoc(r.doc);
window.__sid=r.styleId;})()""", await_promise=False)
time.sleep(0.4)

# --- 1. Right-click cue → style items present (default + saved + presets).
r = js(c, """(()=>{const el=document.querySelector('[data-sublane] [data-cue]');const r=el.getBoundingClientRect();
return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()""")
xy = json.loads(r)
MENU = """JSON.stringify([...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim()))"""

def menu_items():
    for _ in range(20):
        m = js(c, MENU)
        if isinstance(m, str) and m != "[]":
            return json.loads(m)
        time.sleep(0.2)
    return []

def open_ctx():
    for _ in range(3):
        c.rclick(xy["x"], xy["y"])
        items = menu_items()
        if items:
            return items
    return []

items = open_ctx()
check("ctx: default style item", any("Default" in i or "defecto" in i.lower() for i in items))
check("ctx: saved style item", any("Impact Mag" in i for i in items))
check("ctx: preset items", any("Jumpy" in i for i in items) and any("Impact" in i for i in items))

# --- 2. Assign saved style from menu.
js(c, """(()=>{const it=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('Impact Mag'));it.click();})()""", await_promise=False)
time.sleep(0.4)
r = js(c, """(()=>{const d=window.__qa.useProject.getState().doc;const cue=d.subtitles.find(x=>x.text==='cue one');
return JSON.stringify({sid:cue.styleId===window.__sid});})()""")
check("ctx assigns styleId", json.loads(r)["sid"])
time.sleep(0.3)
r = js(c, """(()=>{const el=document.querySelector('[data-sublane] [data-cue]');
return JSON.stringify({bc:getComputedStyle(el).borderColor,bg:getComputedStyle(el).backgroundColor});})()""")
sty = json.loads(r)
check("block tints with style color", "255, 0, 255" in sty["bc"] or "255, 0, 255" in sty["bg"])

# --- 3. Assign preset via menu → materialized into registry.
open_ctx()
js(c, """(()=>{const it=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('Jumpy'));it.click();})()""", await_promise=False)
time.sleep(0.4)
r = js(c, """(()=>{const d=window.__qa.useProject.getState().doc;const cue=d.subtitles.find(x=>x.text==='cue one');
const s=(d.subtitleStyles||[]).find(x=>x.id===cue.styleId);
return JSON.stringify({name:s&&s.name,mode:s&&s.style.mode,n:(d.subtitleStyles||[]).length});})()""")
pr = json.loads(r)
check("preset materialized", pr["name"] == "Jumpy" and pr["mode"] == "jump" and pr["n"] == 2)

# --- 4. Default clears styleId.
open_ctx()
js(c, """(()=>{const it=[...document.querySelectorAll('[role=menuitem]')].find(e=>/Default|defecto/i.test(e.textContent));it.click();})()""", await_promise=False)
time.sleep(0.4)
r = js(c, "window.__qa.useProject.getState().doc.subtitles.find(x=>x.text==='cue one').styleId")
check("default clears styleId", r in (None, "null"))

# --- 5. Preview renders impact mode: seek into cue, check a word span transform.
js(c, """(()=>{const{useProject,engine}=window.__qa;let d=useProject.getState().doc;
const cue=d.subtitles.find(x=>x.text==='cue one');
d=engine.setCueStyle(d,cue.id,window.__sid);
useProject.getState().setDoc(d);
window.__qa.useEditor.getState().setPlayhead(1500);})()""", await_promise=False)
time.sleep(0.8)
r = js(c, """(()=>{const sub=document.querySelector('[data-subtitle]');
const words=[...document.querySelectorAll('[data-subword]')];
const transformed=words.some(w=>w.style.transform&&w.style.transform!=='none');
return JSON.stringify({hasSub:!!sub,n:words.length,transformed,color:sub?sub.querySelector('span').style.color:null});})()""")
pv = json.loads(r)
check("preview shows styled cue", pv["hasSub"] and pv["n"] == 2 and pv["transformed"] and "255, 0, 255" in (pv["color"] or ""))

# --- 6. Subtitles panel renders new controls (mode grid 5, color pickers, save style).
js(c, """(()=>{const t=[...document.querySelectorAll('button,[role=tab]')].find(e=>/Subtitle|Subt/i.test(e.textContent));if(t)t.click();})()""", await_promise=False)
time.sleep(0.8)
r = js(c, """(()=>{const btns=[...document.querySelectorAll('button')].map(e=>e.textContent.trim());
return JSON.stringify({jump:btns.some(b=>/Jumpy/.test(b)),imp:btns.some(b=>/Impact/.test(b)),
colors:document.querySelectorAll('input[type=color]').length,
save:btns.some(b=>/Save style|Guardar estilo/.test(b)),
saved:btns.some(b=>/Impact Mag/.test(b))});})()""")
pn = json.loads(r)
check("panel: jump+impact modes", pn["jump"] and pn["imp"])
check("panel: 3 color pickers", pn["colors"] >= 3)
check("panel: save style btn", pn["save"])
check("panel: saved style listed", pn["saved"])

# --- cleanup ---
js(c, """(()=>{const{useProject,engine}=window.__qa;let d=useProject.getState().doc;
for(const cue of [...d.subtitles])d=engine.removeCue(d,cue.id);
for(const s of[...(d.subtitleStyles||[])])d=engine.removeSubtitleStyle(d,s.id);
useProject.getState().setDoc(d);})()""", await_promise=False)

print(f"\\n{len(P)} passed, {len(F)} failed")
if F:
    print("FAILED:", F); sys.exit(1)
