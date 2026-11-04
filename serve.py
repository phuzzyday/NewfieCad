"""Serve NewfieCad locally and open it in the browser. Works on Windows, Linux and macOS.

Usage: python serve.py [port]
"""

import functools
import http.server
import os
import sys
import threading
import webbrowser


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
    }

    # Always revalidate, so edited files are picked up on reload.
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(args[0]) if args else 8765
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    url = f"http://127.0.0.1:{port}/"
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        # Already running (started earlier): just open it again.
        print(f"NewfieCad is already running at {url}", flush=True)
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return
    print(f"NewfieCad is running at {url}  (press Ctrl+C to stop)", flush=True)
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
