import json
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"])
    pg = b.new_page()
    pg.on("pageerror", lambda e: print("PAGEERR", str(e)[:150]))
    pg.goto("http://localhost:8000", wait_until="load")
    pg.wait_for_function("()=>window.__qw&&window.__qw.Library.ready", timeout=30000)
    pg.evaluate("()=>window.__qw.Engine.resume()"); pg.wait_for_timeout(300)
    r = pg.evaluate("""async () => {
      const q = window.__qw;
      const out = {};
      const types = ['reverb','delay','saturator','gate','deesser','compressor','eq8','verbAlgo','chorus','multiband','imager','limiter','pitch','phaser','flanger'];
      for (const ty of types) {
        // build a minimal one-track project in-memory and render it offline
        const saved = JSON.parse(JSON.stringify({tracks:q.Store.tracks, master:q.Store.project.master}));
        try {
          const t = q.Store.tracks.find(x=>x.clips.some(c=>c.type==='audio')) || q.Store.tracks[0];
          // isolate: mute all but t, set t.fx to single instance
          q.Store.tracks.forEach(x=>x.muted = (x!==t));
          const inst = { id:'fx_'+ty, type:ty, params:q.__fxDefaults(ty), bypassed:false };
          t.fx = [inst];
          const { buffer } = await q.Exporter.render({ normalize:false, tailSec:0.3, trimTail:false });
          const d = buffer.getChannelData(0);
          let nan=0, first=-1, peak=0;
          for (let i=0;i<d.length;i++){ if(!isFinite(d[i])){nan++; if(first<0)first=i;} else peak=Math.max(peak,Math.abs(d[i])); }
          out[ty] = { nan, firstNaNsec: first<0?null:+(first/44100).toFixed(3), peak:+peak.toFixed(3) };
        } catch(e){ out[ty]={error:String(e).slice(0,100)}; }
        finally { q.Store.tracks = saved.tracks; q.Store.project.master = saved.master; q.Engine.graphs.forEach((g,id)=>q.Engine.disposeTrack(id)); q.Store.tracks.forEach(x=>q.Engine.applyTrackState(x)); q.Engine.applyMasterSettings(); }
      }
      return out;
    }""")
    # expose fxDefaults
    print(json.dumps(r, indent=0))
    b.close()
