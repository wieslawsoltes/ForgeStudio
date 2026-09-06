#!/usr/bin/env python3
"""Serve Forge Studio locally with no third-party dependencies."""
import argparse
import functools
import http.server
from pathlib import Path

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.wgsl': 'text/plain', '.json': 'application/json'}
    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8080)
    args=parser.parse_args()
    if not 1 <= args.port <= 65535:parser.error('Port must be between 1 and 65535.')
    root=Path(__file__).resolve().parents[1]
    handler=functools.partial(Handler,directory=str(root))
    try:
        with http.server.ThreadingHTTPServer(('127.0.0.1',args.port),handler) as server:
            print(f'Forge Studio: http://localhost:{args.port}',flush=True)
            print('Press Ctrl+C to stop. This server is bound to your local machine.',flush=True)
            try:server.serve_forever()
            except KeyboardInterrupt:pass
    except OSError as error:
        parser.exit(1,f'Cannot start server: {error}. Try --port 8090.\n')

if __name__=='__main__':main()
