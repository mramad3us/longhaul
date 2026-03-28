#!/usr/bin/env bash
# LONGHAUL — Launch game server and open browser
PORT=${1:-8090}
DIR="$(cd "$(dirname "$0")" && pwd)"

VERSION=$(sed -n "s/.*'\(.*\)'.*/\1/p" "$DIR/js/version.js")
echo "LONGHAUL v$VERSION — launching on http://localhost:$PORT"

# Kill any existing server on this port
lsof -ti:$PORT | xargs kill 2>/dev/null

# Start server
cd "$DIR"
python3 -m http.server "$PORT" &>/dev/null &
SERVER_PID=$!

# Wait briefly for server to start, then open browser
sleep 0.5
open "http://localhost:$PORT"

echo "   Server PID: $SERVER_PID"
echo "   Press Ctrl+C to stop"

trap "kill $SERVER_PID 2>/dev/null; echo ''; echo 'Server stopped.'; exit 0" INT TERM
wait $SERVER_PID
