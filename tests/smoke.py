import sys, json, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000"
errors, warnings = [], []

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=[
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
    ])
    page = browser.new_page()
    page.on("console", lambda m: (errors if m.type=="error" else warnings if m.type=="warning" else []).append(m.text) if m.type in ("error","warning") else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR: " + (str(e)[:400])))
    page.on("requestfailed", lambda r: errors.append("REQFAIL: "+r.url+" "+str(r.failure)) if "favicon" not in r.url else None)

    print("→ goto", URL)
    page.goto(URL, wait_until="load", timeout=30000)
    try:
        page.wait_for_function("() => window.__qw && window.__qw.Store && window.__qw.Store.project", timeout=30000)
        print("✓ booted (__qw present)")
    except Exception as e:
        print("✗ boot timeout:", str(e)[:200])

    state = page.evaluate("""() => {
        const q = window.__qw || {};
        return {
            tracks: q.Store?.project?.tracks?.length || 0,
            trackNames: q.Store?.project?.tracks?.map(t=>t.name) || [],
            fxCounts: q.Store?.project?.tracks?.map(t=>t.fx?.length||0) || [],
            samples: q.Library?.samples?.length || 0,
            workletReady: q.Engine?.workletReady ?? null,
            workletFailed: q.Engine?.workletFailed ?? null,
            sampleRate: q.Engine?.sampleRate || null,
            ctxState: q.Engine?.ctx?.state || null,
            plugins: q.PluginManager?.list?.().map(p=>({n:p.name,r:p.runnable,k:p.kind})) || [],
            bpm: q.Store?.project?.bpm,
            clips: q.Store?.project?.tracks?.reduce((a,t)=>a+t.clips.length,0) || 0,
        };
    }""")
    print("STATE:", json.dumps(state, indent=1, ensure_ascii=False))
    browser.close()

print("\n=== ERRORS (%d) ===" % len(errors))
for e in errors[:40]: print("  ✗", e[:300])
print("\n=== WARNINGS (%d) ===" % len(warnings))
for e in warnings[:15]: print("  !", e[:200])
sys.exit(1 if errors else 0)
