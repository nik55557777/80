import sys, json, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000"
errors = []
results = {}

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=[
        "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required","--enable-features=WebMIDI",
    ])
    page = browser.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type=="error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR: "+str(e)[:300]))
    page.goto(URL, wait_until="load", timeout=30000)
    page.wait_for_function("() => window.__qw && window.__qw.Store && window.__qw.Store.project && window.__qw.Library.ready", timeout=30000)
    # unlock audio (autoplay policy) with a synthetic gesture
    page.evaluate("() => window.__qw.Engine.resume()")
    page.wait_for_timeout(400)

    def run(name, js, timeout=60000):
        try:
            r = page.evaluate(js)
            results[name] = r
            print(f"✓ {name}: {json.dumps(r, ensure_ascii=False)[:220]}")
        except Exception as e:
            results[name] = {"__error__": str(e)[:300]}
            print(f"✗ {name}: {str(e)[:300]}")

    # 1) transport play → sources scheduled
    run("play", """async () => {
        const q = window.__qw;
        q.Transport.setLoop(0, 4, true);
        await q.Transport.play(0);
        await new Promise(r=>setTimeout(r, 700));
        const n = q.Transport.activeSources.length;
        const pos = q.Store.position;
        q.Transport.stop();
        return { activeSources: n, positionAfter: +pos.toFixed(2), playing: q.Store.playing };
    }""")

    # 2) MIDI note audition (synth voice)
    run("midi_voice", """async () => {
        const q = window.__qw;
        const t = q.Store.tracks.find(x=>x.type==='midi');
        const before = q.Engine.voices.get(t.id)?.size || 0;
        await q.Transport.previewNote(t, 60, 0.4, 0.8);
        await new Promise(r=>setTimeout(r, 60));
        const after = q.Engine.voices.get(t.id)?.size || 0;
        return { trackType: t.type, engine: t.instrument.engine, voicesBefore: before, voicesAfter: after };
    }""")

    # 3) offline render (the full export path)
    run("render", """async () => {
        const q = window.__qw;
        const { buffer, stats } = await q.Exporter.render({ normalize:false, tailSec:1.5 });
        return { dur:+buffer.duration.toFixed(2), ch:buffer.numberOfChannels, sr:buffer.sampleRate,
                 lufs:stats.lufs, peakDb:stats.peakDb, rmsDb:stats.rmsDb, finite:isFinite(stats.lufs) };
    }""", timeout=120000)

    # 4) WAV encode size sanity
    run("wav_encode", """async () => {
        const q = window.__qw;
        const { buffer } = await q.Exporter.render({ normalize:true, normalizeTo:-0.3, tailSec:1.0 });
        const mod = await import('/src/engine/exporter.js');
        const blob = mod.encodeWav(buffer, { bits:16, dither:true });
        return { bytes: blob.size, type: blob.type, peakDb: mod.measure(buffer).peakDb };
    }""", timeout=120000)

    # 5) pitch correction on a vowel sample
    run("pitch_correction", """async () => {
        const q = window.__qw;
        const s = q.Library.samples.find(x=>/Vowel_A/.test(x.name));
        const buf = await q.Library.getBuffer(s.id);
        const pc = await import('/src/engine/pitchcorrection.js');
        const frames = pc.smoothPitchTrack(pc.analysePitch(buf));
        const notes = pc.segmentNotes(frames, buf);
        const res = await pc.correctPitch(buf, { scale:'minor', root:0, strength:1, quantize:true });
        let peak=0; const d=res.buffer.getChannelData(0);
        for(let i=0;i<d.length;i+=7) peak=Math.max(peak,Math.abs(d[i]));
        return { srcDur:+buf.duration.toFixed(2), voiced:frames.filter(f=>f.voiced).length,
                 notes:notes.length, outDur:+res.buffer.duration.toFixed(2), outPeak:+peak.toFixed(3),
                 nan: [...d].some(x=>!isFinite(x)), cents:+res.correctionCents.toFixed(1) };
    }""", timeout=120000)

    # 6) plugin instantiate on a track (QW Tape Warmth)
    run("plugin_fx", """async () => {
        const q = window.__qw;
        const plg = q.PluginManager.runnable().find(p=>/Tape/.test(p.name));
        const t = q.Store.tracks[0];
        const n0 = t.fx.length;
        q.actions.addFx(t.id, plg.type);
        await new Promise(r=>setTimeout(r, 400));
        const g = q.Engine.graphs.get(t.id);
        const plugNode = g?.fxNodes?.find(f=>f.inst.type===plg.type);
        return { plugin:plg.name, type:plg.type, fxBefore:n0, fxAfter:t.fx.length,
                 nodeCreated: !!plugNode, loading: plugNode?.node?.loading };
    }""")

    # 7) add a built-in reverb (shared convolver) + play through it
    run("reverb_shared", """async () => {
        const q = window.__qw;
        const t = q.Store.tracks[0];
        q.actions.addFx(t.id, 'reverb');
        await new Promise(r=>setTimeout(r, 500));
        const convs = q.Engine._sharedConv.size;
        return { sharedConvolvers: convs, fx:t.fx.map(f=>f.type) };
    }""")

    # 8) save + reload project
    run("save_load", """async () => {
        const q = window.__qw;
        await q.actions.saveProject();
        const P = await import('/src/engine/persistence.js');
        const { ProjectStore } = await import('/src/engine/library.js');
        const list = await ProjectStore.list();
        const data = await ProjectStore.get(q.Store.project.id);
        return { saved: list.length, tracks: data?.tracks?.length, bpm: data?.bpm, name:data?.name };
    }""")

    # 9) master chain + mastering presets apply
    run("mastering", """async () => {
        const q = window.__qw;
        q.Store.project.master.mastering = { enabled:true, preset:'loud', amount:0.8 };
        q.Engine.applyMasterSettings();
        const g = q.Engine.masterGraph;
        return { hasLimiter: !!g.limiter, hasMultiband: !!g.mb, hasImager: !!g.img,
                 masterFxNodes: (g.fxNodes||[]).length, ceiling: q.Store.project.master.limiterCeilDb };
    }""")

    # 10) performance: add many tracks, measure layout time
    run("perf_many_tracks", """async () => {
        const q = window.__qw;
        const t0 = performance.now();
        const made = [];
        for (let i=0;i<40;i++){ made.push(q.actions.addTrack(i%2?'audio':'midi',{name:'Perf '+i})); }
        const tAdd = performance.now()-t0;
        // schedule playback across all
        q.Transport.setLoop(0,4,true); await q.Transport.play(0);
        await new Promise(r=>setTimeout(r,500));
        const src = q.Transport.activeSources.length;
        const voices = [...q.Engine.voices.values()].reduce((a,s)=>a+s.size,0);
        q.Transport.stop();
        return { tracksNow:q.Store.tracks.length, msToAdd40:+tAdd.toFixed(0), sourcesScheduled:src, activeVoices:voices };
    }""", timeout=60000)

    browser.close()

print("\n=== ERRORS (%d) ===" % len(errors))
for e in errors[:30]: print("  ✗", e[:260])
sys.exit(1 if errors else 0)
