"""User-level subtitle QA: exercise every mode + every style control through
the real UI (buttons, pickers, context menu) and verify the preview reacts
like a user would expect. Screenshots per mode for eyeballing."""
import sys, time, json
sys.path.insert(0, "qa")
from qa_common import connect, js

c = connect()
P, F = [], []

def check(name, ok, extra=""):
    (P if ok else F).append(name)
    print(("PASS " if ok else "FAIL ") + name, extra)

# ---------- setup: deterministic doc with one transcribed-style cue ----------
js(c, """(async()=>{const{useProject}=window.__qa;
await useProject.getState().openFromPath('C:/Users/nokturno/Documents/Creatora/Projects/QA flow 1794793478466.creatora');
const d=useProject.getState().doc;
const words=['This','is','a','test','line','of','text'].map((w,i)=>({word:w+(i<6?' ':''),startMs:1000+i*428,endMs:1000+(i+1)*428}));
const d0={...d,subtitles:[]};
const r1=window.__qa.engine.addCue(d0,{startMs:1000,endMs:4000,text:'This is a test line of text',words});
const d1={...r1.doc,subtitleStyle:{text:{color:'#FFFFFF',fontSizePx:48,fontFile:null,fontName:null,outlineColor:'#000000',outlineWidth:0,backgroundColor:null,backgroundPadPx:0,alignH:'center',alignV:'bottom',shadowColor:null,shadowX:0,shadowY:0,lineSpacingPx:0},highlightColor:'#FFFF00',mode:'none',marginVPx:40,marginHPx:30},subtitleStyles:[]};
useProject.getState().setDoc(d1);})()""")
time.sleep(0.6)
js(c, """(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Subtitles');b.click();})()""", await_promise=False)
time.sleep(0.8)

def seek(ms):
    js(c, f"window.__qa.useEditor.getState().setPlayhead({ms})", await_promise=False)
    time.sleep(0.35)

def mode_btn(label):
    # Match by title (hint) — preset tiles also contain mode names.
    HINT = {"Karaoke": "Word fill", "Pop": "One word", "Jumpy": "Word bounce", "Impact": "Slam in", "Static": "Plain text"}
    hint = HINT[label]
    js(c, f"""(()=>{{const b=[...document.querySelectorAll('button')].find(e=>e.title==='{hint}');b.click();}})()""", await_promise=False)
    time.sleep(0.4)

def substate():
    r = js(c, """(()=>{const s=document.querySelector('[data-subtitle]');
const w=[...document.querySelectorAll('[data-subword]')];
return JSON.stringify({has:!!s, text:s?s.textContent.trim():'', n:w.length,
  words:w.map(e=>({t:e.textContent,c:e.style.color,o:e.style.opacity,tr:e.style.transform,v:e.style.visibility,anim:e.style.animation})),
  font:s?getComputedStyle(s.querySelector('span')).fontFamily:'',
  bg:s?s.querySelector('span').style.background:'',
  stroke:s?s.querySelector('span').style.webkitTextStroke||s.querySelector('span').style.WebkitTextStroke:'',
  shadow:s?s.querySelector('span').style.textShadow:'',
  pad:s?s.querySelector('span').style.padding:'',
  color:s?s.querySelector('span').style.color:''});})()""")
    return json.loads(r)

# ---------- 1. Static: plain text, no word spans ----------
seek(2800)
s = substate()
check("static: cue shows full text", s["has"] and s["text"] == "This is a test line of text" and s["n"] == 0)
c.shot("sub_u_static")

# ---------- 2. Karaoke: all words, active highlighted, future dimmed ----------
mode_btn("Karaoke")
s = substate()
act = [w for w in s["words"] if w["c"] == "rgb(255, 255, 0)"]
future = [w for w in s["words"] if w["o"] == "0.55"]
check("karaoke: 7 word spans", s["n"] == 7, s["n"])
check("karaoke: active word highlighted", len(act) == 1 and act[0]["t"].strip() == "line", act)
check("karaoke: future words dimmed", len(future) == 2, len(future))
c.shot("sub_u_karaoke")

# ---------- 3. Pop: only the active word ----------
mode_btn("Pop")
s = substate()
check("pop: single word shown", s["n"] == 1 and s["words"][0]["t"].strip() == "line", s["words"])
c.shot("sub_u_pop")

# ---------- 4. Jumpy: all words, active scaled ----------
mode_btn("Jumpy")
s = substate()
scaled = [w for w in s["words"] if "1.3" in (w["tr"] or "")]
check("jump: all words visible", s["n"] == 7)
check("jump: active word bounces", len(scaled) == 1 and scaled[0]["t"].strip() == "line")
c.shot("sub_u_jump")

# ---------- 5. Impact: one word at a time, slamming in oversized ----------
mode_btn("Impact")
s = substate()
slam = [w for w in s["words"] if "sub-impact" in (w.get("anim") or "")]
check("impact: single word shown", s["n"] == 1 and s["words"][0]["t"].strip() == "line", s["words"])
check("impact: word slams in", len(slam) == 1, s["words"])
check("impact: active highlighted", s["n"] == 1 and "255, 255, 0" in s["words"][0]["c"], s["words"][0]["c"] if s["n"] else None)
c.shot("sub_u_impact")

# ---------- 6. Colors via pickers ----------
# text color → red
js(c, """(()=>{const inp=[...document.querySelectorAll('input[type=color]')][0];
const p=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');p.set.call(inp,'#ff0000');
inp.dispatchEvent(new Event('input',{bubbles:true}));})()""", await_promise=False)
time.sleep(0.4)
s = substate()
check("picker: text color applies", "255, 0, 0" in (s["color"] or ""), s["color"])

# ---------- 7. Outline ----------
js(c, """(()=>{const inp=[...document.querySelectorAll('input[type=number]')];
const o=inp[2];const p=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');p.set.call(o,'4');
o.dispatchEvent(new Event('input',{bubbles:true}));})()""", await_promise=False)
time.sleep(0.4)
s = substate()
check("outline: stroke appears", bool(s["stroke"]), s["stroke"])
c.shot("sub_u_outline")

# ---------- 8. BG box on → background + padding ----------
js(c, """(()=>{const cb=document.querySelectorAll('input[type=checkbox]')[0];cb.click();})()""", await_promise=False)
time.sleep(0.4)
s = substate()
check("box: background + padding on", bool(s["bg"]) and bool(s["pad"]), f'bg={s["bg"]} pad={s["pad"]}')

# ---------- 9. Shadow on → textShadow ----------
js(c, """(()=>{const cb=document.querySelectorAll('input[type=checkbox]')[1];cb.click();})()""", await_promise=False)
time.sleep(0.4)
s = substate()
check("shadow: textShadow applies", "rgb" in (s["shadow"] or ""), s["shadow"])
c.shot("sub_u_boxshadow")

# ---------- 10. Font: set via doc (dropdown needs brandKit fonts; verify span gets family) ----------
js(c, """(()=>{const{useProject}=window.__qa;const d=useProject.getState().doc;
useProject.getState().setDoc({...d,subtitleStyle:{...d.subtitleStyle,text:{...d.subtitleStyle.text,fontFile:'C:/Windows/Fonts/impact.ttf'}}});})()""", await_promise=False)
time.sleep(1.0)
s = substate()
check("font: family applied to span", "loaded-font" in (s["font"] or ""), s["font"])

# ---------- 11. Save style via real button (prompt stubbed) ----------
js(c, "window.prompt=()=>'My Neon'", await_promise=False)
js(c, """(()=>{const b=[...document.querySelectorAll('button')].find(e=>/Save style|Guardar estilo/.test(e.textContent));b.click();})()""", await_promise=False)
time.sleep(0.5)
r = js(c, """JSON.stringify((window.__qa.useProject.getState().doc.subtitleStyles||[]).map(s=>s.name))""")
check("save style: chip created", "My Neon" in json.loads(r), r)
r = js(c, """JSON.stringify([...document.querySelectorAll('button')].some(e=>e.textContent.includes('My Neon')))""")
check("save style: chip rendered", r == "true" or r is True)

# ---------- 12. Apply saved style chip → master style adopts it ----------
js(c, """(()=>{const{useProject}=window.__qa;const d=useProject.getState().doc;
// reset master to plain first so the change is observable
useProject.getState().setDoc({...d,subtitleStyle:{...d.subtitleStyle,text:{...d.subtitleStyle.text,color:'#FFFFFF',backgroundColor:null,shadowColor:null,outlineWidth:0}}});})()""", await_promise=False)
time.sleep(0.3)
js(c, """(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('My Neon'));b.click();})()""", await_promise=False)
time.sleep(0.4)
s = substate()
check("saved style: applies on click", "255, 0, 0" in (s["color"] or "") and bool(s["bg"]), f'{s["color"]} bg={s["bg"]}')

# ---------- 13. Timeline: per-cue style tints block ----------
js(c, """(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Timeline');b.click();})()""", await_promise=False)
time.sleep(0.8)
js(c, """(()=>{const{useProject,engine}=window.__qa;let d=useProject.getState().doc;
const s=d.subtitleStyles[0];d=engine.setCueStyle(d,d.subtitles[0].id,s.id);
useProject.getState().setDoc(d);})()""", await_promise=False)
time.sleep(0.4)
r = js(c, """(()=>{const el=document.querySelector('[data-sublane] [data-cue]');
return JSON.stringify({bc:getComputedStyle(el).borderColor});})()""")
check("lane: styled cue tints", "255, 0, 0" in json.loads(r)["bc"], r)
c.shot("sub_u_lane_tint")

# ---------- 14. Undo returns style change ----------
js(c, "window.__qa.useEditor.getState().undo()", await_promise=False)
time.sleep(0.3)
r = js(c, "window.__qa.useProject.getState().doc.subtitles[0].styleId")
check("undo reverts style assign", r in (None, "null"), r)

# ---------- cleanup ----------
js(c, """(()=>{const{useProject,engine}=window.__qa;let d=useProject.getState().doc;
for(const cue of [...d.subtitles])d=engine.removeCue(d,cue.id);
for(const s of[...(d.subtitleStyles||[])])d=engine.removeSubtitleStyle(d,s.id);
useProject.getState().setDoc(d);})()""", await_promise=False)

print(f"\n{len(P)} passed, {len(F)} failed")
if F:
    print("FAILED:", F); sys.exit(1)
