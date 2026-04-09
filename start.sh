#!/bin/bash
cd "$(dirname "$0")"
echo "🔐 Starting CEE-LO auth server on port 4001..."
node auth-server.js &
AUTH_PID=$!
echo "   Auth PID: $AUTH_PID"
sleep 1
echo "🎲 Starting CEE-LO game server on port 4000..."
node server.js &
GAME_PID=$!
echo "   Game PID: $GAME_PID"
echo ""
echo "✅ Both servers running."
echo "   Game:       http://localhost:4000"
echo "   Back Office: http://localhost:4000/admin"
echo ""
trap "echo 'Shutting down...'; kill $AUTH_PID $GAME_PID 2>/dev/null" EXIT INT TERM
wait
