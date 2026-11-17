import json, sys, time, os
sys.path.insert(0, "qa")
from cdp import CDP

def connect(reload=False):
    c = CDP()
    if reload:
        c.eval("location.reload()"); time.sleep(4)
        c = CDP()
    return c

def js(c, expr, await_promise=True):
    return c.eval(expr, await_promise=await_promise)

SET_VAL = """(el, v) => { const p = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(p, 'value').set.call(el, String(v)); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {bubbles: true})); }"""
