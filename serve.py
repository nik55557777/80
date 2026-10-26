#!/usr/bin/env python3
"""
QwenWave — zero-config local server.

The DAW uses ES modules + AudioWorklet + getUserMedia, all of which require a
secure context. Serving over http://localhost satisfies that in every browser.

    python3 serve.py            # → http://localhost:8000
    python3 serve.py --port 9000
    python3 serve.py --host 0.0.0.0 --port 8000   # доступ с др. устройств (нужен https для микрофона)
"""
import argparse, http.server, socketserver, functools, os, sys, webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))

# Correct MIME types are required for ES modules and worklets.
EXT = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.map': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Keep caching off for dev; permissive CORS so LAN devices can load.
        # (No COEP: cross-origin isolation isn't needed and would complicate
        #  loading library assets; mic + AudioWorklet work over plain localhost.)
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return EXT.get(ext, super().guess_type(path))

    def log_message(self, fmt, *args):
        if not QUIET:
            sys.stderr.write("· %s\n" % (fmt % args))


QUIET = False


def main():
    global QUIET
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()
    QUIET = args.quiet

    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
    with socketserver.ThreadingTCPServer((args.host, args.port), handler) as httpd:
        print(f"QwenWave готов → {url}")
        print("  (остановка: Ctrl+C)")
        if args.host == '0.0.0.0':
            print("  доступ с др. устройств по вашему LAN-IP; для микрофона нужен https")
        if not args.no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nостановлено")


if __name__ == '__main__':
    main()
