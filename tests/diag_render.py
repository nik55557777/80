import json
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"])
    pg = b.new_page()
    errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto("http://localhost:8000", wait_until="load")
    pg.wait_for_function("()=>window.__qw&&window.__qw.Library.ready", timeout=30000)
    pg.evaluate("()=>window.__qw.Engine.resume()"); pg.wait_for_timeout(300)

    r = pg.evaluate("""async () => {
      const q = window.__qw;
      const out = {};
      // helper: render and report first NaN + stats
      async function probe(label, mutate) {
        // deep clone state manipulation then restore
        const savedFx = q.Store.tracks.map(t=>t.fx.map(f=>({...f})));
        const savedMaster = JSON.parse(JSON.stringify(q.Store.project.master));
        const savedMute = q.Store.tracks.map(t=>t.muted);
        try {
          mutate();
          const { buffer } = await q.Exporter.render({ normalize:false, tailSec:0.5, trimTail:false });
          const d = buffer.getChannelData(0);
          let firstNaN=-1, nanCount=0, peak=0;
          for (let i=0;i<d.length;i++){ if(!isFinite(d[i])){ if(firstNaN<0)firstNaN=i; nanCount++; } else peak=Math.max(peak,Math.abs(d[i])); }
          out[label] = { dur:+buffer.duration.toFixed(2), firstNaN, firstNaNsec:+(firstNaN/44100).toFixed(3), nanCount, peak:+peak.toFixed(3) };
        } catch(e){ out[label]={error:String(e).slice(0,120)}; }
        finally {
          q.Store.tracks.forEach((t,i)=>{ t.fx=savedFx[i]; t.muted=savedMute[i]; });
          q.Store.project.master = savedMaster;
          q.Engine.applyMasterSettings();
        }
      }
      await probe('full', ()=>{});
      await probe('no_mastering', ()=>{ q.Store.project.master.mastering.enabled=false; q.Engine.applyMasterSettings(); });
      await probe('no_track_fx', ()=>{ q.Store.tracks.forEach(t=>t.fx=[]); });
      await probe('audio_only', ()=>{ q.Store.tracks.forEach(t=>{ if(t.type==='midi') t.muted=true; }); });
      await probe('midi_only', ()=>{ q.Store.tracks.forEach(t=>{ if(t.type==='audio') t.muted=true; }); });
      await probe('no_fx_no_master', ()=>{ q.Store.tracks.forEach(t=>t.fx=[]); q.Store.project.master.mastering.enabled=false; q.Engine.applyMasterSettings(); });
      return out;
    }""")
    print(json.dumps(r, indent=1))
    print("pageerrors:", errs[:5])
    b.close()
