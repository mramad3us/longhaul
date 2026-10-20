#!/usr/bin/env bash
# LONGHAUL — Launch game server and open browser
PORT=${1:-8090}
DIR="$(cd "$(dirname "$0")" && pwd)"

VERSION=$(sed -n "s/.*'\(.*\)'.*/\1/p" "$DIR/js/version.js")
echo "LONGHAUL v$VERSION — launching on http://localhost:$PORT"

# Kill any existing server on this port
lsof -ti:$PORT | xargs kill 2>/dev/null

# Start server. No caching: the game is plain ES modules, and a browser that
# keeps some old modules and fetches some new ones after an update fails to
# load at all (an import of an export the cached file doesn't have).
cd "$DIR"
python3 -c '
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a):
        pass
ThreadingHTTPServer(("", int(sys.argv[1])), NoCache).serve_forever()
' "$PORT" &>/dev/null &
SERVER_PID=$!

# Wait briefly for server to start, then open browser
sleep 0.5
open "http://localhost:$PORT"

echo "   Server PID: $SERVER_PID"
echo "   Press Ctrl+C to stop"

trap "kill $SERVER_PID 2>/dev/null; echo ''; echo 'Server stopped.'; exit 0" INT TERM
wait $SERVER_PID
