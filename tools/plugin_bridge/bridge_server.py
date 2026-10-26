#!/usr/bin/env python3
"""
QwenWave — Native Plugin Bridge
===============================
Browsers cannot execute native plugin code (.dll / .vst3 / .component / .so).
This local process CAN. It loads a real plugin, streams audio between the
QwenWave web app (over WebSocket) and the native plugin, so the plugin runs
for real while the DAW stays in the browser.

    ┌──────────────┐   WebSocket    ┌───────────────────┐   native API   ┌────────┐
    │ QwenWave web │ ─────────────▶ │  bridge_server.py │ ─────────────▶ │ VST3/  │
    │ (qw-bridge)  │ ◀───────────── │  (this process)   │ ◀───────────── │ DLL    │
    └──────────────┘   float32 PCM  └───────────────────┘   pedalboard   └────────┘

Install deps:
    pip install pedalboard websockets numpy

Run:
    python3 bridge_server.py --vst3 "/path/to/YourPlugin.vst3" --port 9123
    python3 bridge_server.py --vst2 "/path/to/YourPlugin.dll"  --port 9123

Then in QwenWave: Plugins → "Как подключить VST/DLL" → ws://127.0.0.1:9123

Protocol (JSON control + binary audio frames):
  client → server  {"t":"hello","sampleRate":44100,"channels":2,"blockSize":128}
  client → server  {"t":"param","name":"Drive","value":0.7}
  client → server  binary frame: interleaved float32 PCM (blockSize*channels)
  server → client  {"t":"ready","params":[{"name":..,"min":..,"max":..,"value":..}]}
  server → client  binary frame: processed interleaved float32 PCM
"""
import argparse, asyncio, json, struct, sys

SAMPLE_RATE = 44100
CHANNELS = 2
BLOCK = 128

try:
    import numpy as np
except ImportError:
    np = None

_plugin = None
_params = []


def load_plugin(path, kind):
    """Load a native plugin via pedalboard (VST3 / VST2 / AU)."""
    global _plugin, _params
    try:
        from pedalboard import Pedalboard, load_plugin  # type: ignore
    except ImportError:
        print("[bridge] 'pedalboard' не установлен. Выполните: pip install pedalboard", file=sys.stderr)
        return None
    try:
        plug = load_plugin(path)
    except Exception as e:  # noqa: BLE001
        print(f"[bridge] Не удалось загрузить плагин {path}: {e}", file=sys.stderr)
        return None
    # enumerate automatable parameters
    info = []
    for name in dir(plug):
        if name.startswith('_'):
            continue
        try:
            val = getattr(plug, name)
        except Exception:  # noqa: BLE001
            continue
        if callable(val):
            continue
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            info.append({"name": name, "value": float(val), "min": 0.0, "max": 1.0})
    _plugin = plug
    _params = info
    print(f"[bridge] Загружен плагин: {getattr(plug, 'name', path)} · параметров: {len(info)}")
    return plug


async def handle(ws):
    """One client (the QwenWave qw-bridge worklet)."""
    print(f"[bridge] клиент подключился: {getattr(ws, 'remote_address', '?')}")
    await ws.send(json.dumps({
        "t": "ready",
        "plugin": getattr(_plugin, "name", None),
        "sampleRate": SAMPLE_RATE, "channels": CHANNELS, "blockSize": BLOCK,
        "params": _params,
        "hasPlugin": _plugin is not None,
    }))
    try:
        async for msg in ws:
            # --- control message
            if isinstance(msg, (str, bytes)) and not _is_pcm(msg):
                try:
                    data = json.loads(msg)
                except Exception:  # noqa: BLE001
                    continue
                if data.get("t") == "param" and _plugin is not None:
                    try:
                        setattr(_plugin, data["name"], float(data["value"]))
                    except Exception as e:  # noqa: BLE001
                        print("[bridge] set param failed", e)
                elif data.get("t") == "hello":
                    global SAMPLE_RATE, CHANNELS, BLOCK
                    SAMPLE_RATE = int(data.get("sampleRate", SAMPLE_RATE))
                    CHANNELS = int(data.get("channels", CHANNELS))
                    BLOCK = int(data.get("blockSize", BLOCK))
                continue

            # --- audio frame: interleaved float32 PCM
            if np is None or _plugin is None:
                # transparent passthrough so the track never goes silent
                await ws.send(msg)
                continue
            arr = np.frombuffer(msg, dtype=np.float32)
            n = arr.size // CHANNELS
            if n == 0:
                continue
            audio = arr[: n * CHANNELS].reshape(n, CHANNELS).T.copy()  # pedalboard wants [ch][sample]
            try:
                out = _plugin(audio, SAMPLE_RATE)
                out = np.asarray(out, dtype=np.float32)
                if out.ndim == 1:
                    out = np.stack([out] * CHANNELS)
                interleaved = np.ascontiguousarray(out.T.reshape(-1), dtype=np.float32)
                await ws.send(interleaved.tobytes())
            except Exception as e:  # noqa: BLE001
                print("[bridge] process failed", e)
                await ws.send(msg)
    except Exception as e:  # noqa: BLE001
        print("[bridge] connection closed:", e)


def _is_pcm(msg):
    """Heuristic: PCM frames are raw bytes whose length matches a block."""
    if isinstance(msg, str):
        return False
    return len(msg) % (4 * CHANNELS) == 0 and len(msg) > 16


async def main(host, port, vst_path, kind):
    if vst_path:
        load_plugin(vst_path, kind)
    else:
        print("[bridge] плагин не указан — работаю в режиме прозрачного пропускания "
              "(для теста протокола). Передайте --vst3/--vst2.", file=sys.stderr)
    try:
        import websockets  # type: ignore
    except ImportError:
        print("[bridge] 'websockets' не установлен. Выполните: pip install websockets", file=sys.stderr)
        sys.exit(1)
    async with websockets.serve(handle, host, port, max_size=None, ping_interval=20):
        print(f"[bridge] слушает ws://{host}:{port}  (в QwenWave укажите этот адрес)")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="QwenWave native plugin bridge")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9123)
    ap.add_argument("--vst3", help="path to a .vst3 plugin")
    ap.add_argument("--vst2", help="path to a .dll/.so VST2 plugin")
    ap.add_argument("--au", help="path to a macOS .component (AU)")
    args = ap.parse_args()
    path = args.vst3 or args.vst2 or args.au
    kind = "vst3" if args.vst3 else "vst2" if args.vst2 else "au"
    try:
        asyncio.run(main(args.host, args.port, path, kind))
    except KeyboardInterrupt:
        print("\n[bridge] остановлено")
