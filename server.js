const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─── Room store ────────────────────────────────────────────────────────────────
const rooms = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code, tries = 0;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    tries++;
  } while (rooms.has(code) && tries < 200);
  return code;
}

function roll3() {
  return [
    Math.ceil(Math.random() * 6),
    Math.ceil(Math.random() * 6),
    Math.ceil(Math.random() * 6),
  ];
}

/**
 * Evaluate 3 dice according to classic Cee-lo rules.
 * Returns { type, score, label, emoji }
 *
 * Score hierarchy (higher = better):
 *   1000        = 4-5-6
 *   101–106     = trips (101 = 1-1-1 … 106 = 6-6-6)
 *   1–6         = point (pair + odd die; score = odd die value)
 *   -1          = 1-2-3
 *   -2          = bust (3 rolls, no valid combo)
 *   null        = no combo yet (can re-roll)
 */
function evaluate(dice) {
  const d = [...dice].sort((a, b) => a - b);
  const [a, b, c] = d;

  if (a === 4 && b === 5 && c === 6)
    return { type: '456', score: 1000, label: '4-5-6!  Instant Win!', emoji: '🎉' };

  if (a === 1 && b === 2 && c === 3)
    return { type: '123', score: -1, label: '1-2-3!  Instant Loss', emoji: '💀' };

  if (a === b && b === c)
    return { type: 'trips', score: 100 + a, label: `Trips ${a}!  (${a}-${a}-${a})`, emoji: '🔥', value: a };

  // pair + point
  if (a === b) return { type: 'point', score: c, label: `Point  ${c}`, emoji: '🎯', value: c };
  if (b === c) return { type: 'point', score: a, label: `Point  ${a}`, emoji: '🎯', value: a };
  if (a === c) return { type: 'point', score: b, label: `Point  ${b}`, emoji: '🎯', value: b };

  return { type: 'none', score: null, label: 'No combo — re-roll!', emoji: '🎲' };
}

function makePlayer(id, name, isHost) {
  return { id, name, isHost, rolls: [], result: null, rollCount: 0, done: false, finalScore: null };
}

function serialize(room) {
  return {
    code: room.code,
    state: room.state,
    round: room.round,
    currentTurnIndex: room.currentTurnIndex,
    winner: room.winner,
    isTie: room.isTie,
    roundHistory: room.roundHistory,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      rolls: p.rolls,
      result: p.result,
      rollCount: p.rollCount,
      done: p.done,
      finalScore: p.finalScore,
    })),
  };
}

function broadcast(room) {
  io.to(room.code).emit('room_state', serialize(room));
}

// ─── Game logic ────────────────────────────────────────────────────────────────
function startRound(room) {
  room.state = 'rolling';
  room.round++;
  room.winner = null;
  room.isTie = false;
  room.currentTurnIndex = 0;
  room.players.forEach(p => {
    p.rolls = [];
    p.result = null;
    p.rollCount = 0;
    p.done = false;
    p.finalScore = null;
  });
  broadcast(room);
}

function advanceTurn(room) {
  let next = room.currentTurnIndex + 1;
  while (next < room.players.length && room.players[next].done) next++;
  if (next >= room.players.length) {
    endRound(room);
  } else {
    room.currentTurnIndex = next;
  }
}

function endRound(room) {
  room.state = 'results';

  let maxScore = -Infinity;
  room.players.forEach(p => { if (p.finalScore > maxScore) maxScore = p.finalScore; });

  const winners = room.players.filter(p => p.finalScore === maxScore);
  room.isTie = winners.length > 1;
  room.winner = room.isTie
    ? winners.map(w => w.name).join(' & ')
    : (winners[0]?.name ?? '—');

  room.roundHistory.push({
    round: room.round,
    winner: room.winner,
    isTie: room.isTie,
    summary: room.players.map(p => ({
      name: p.name,
      label: p.result?.label ?? 'No result',
      score: p.finalScore,
    })),
  });

  broadcast(room);
}

// ─── Socket handling ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  socket.on('create_room', ({ name }) => {
    const n = (name ?? '').trim();
    if (!n) return socket.emit('error', { msg: 'Enter your name first.' });

    const code = genCode();
    const room = {
      code,
      state: 'lobby',
      round: 0,
      currentTurnIndex: 0,
      winner: null,
      isTie: false,
      roundHistory: [],
      players: [makePlayer(socket.id, n, true)],
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;

    socket.emit('room_joined', { code, playerId: socket.id });
    broadcast(room);
    console.log(`[+] Room ${code} created by ${n}`);
  });

  socket.on('join_room', ({ name, code }) => {
    const n = (name ?? '').trim();
    const c = (code ?? '').trim().toUpperCase();
    if (!n) return socket.emit('error', { msg: 'Enter your name first.' });
    if (!c) return socket.emit('error', { msg: 'Enter a room code.' });

    const room = rooms.get(c);
    if (!room) return socket.emit('error', { msg: `Room "${c}" not found.` });
    if (room.state !== 'lobby') return socket.emit('error', { msg: 'Game already in progress.' });
    if (room.players.length >= 6) return socket.emit('error', { msg: 'Room full (max 6 players).' });
    if (room.players.some(p => p.name.toLowerCase() === n.toLowerCase()))
      return socket.emit('error', { msg: `Name "${n}" is taken in this room.` });

    room.players.push(makePlayer(socket.id, n, false));
    socket.join(c);
    socket.data.room = c;

    socket.emit('room_joined', { code: c, playerId: socket.id });
    broadcast(room);
    console.log(`[+] ${n} joined room ${c}`);
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me?.isHost) return;
    if (room.state !== 'lobby') return socket.emit('error', { msg: 'Game already started.' });
    if (room.players.length < 2) return socket.emit('error', { msg: 'Need at least 2 players.' });
    startRound(room);
    console.log(`[>] Room ${room.code} — round ${room.round} started`);
  });

  socket.on('roll_dice', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'rolling') return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentTurnIndex) return;

    const player = room.players[idx];
    if (player.done) return;

    const dice = roll3();
    const ev = evaluate(dice);

    player.rolls.push(dice);
    player.rollCount++;

    // Fire animation event first (before state broadcast)
    io.to(room.code).emit('dice_rolled', {
      playerId: socket.id,
      name: player.name,
      dice,
      evaluation: ev,
      rollCount: player.rollCount,
    });

    if (ev.type !== 'none') {
      player.result = ev;
      player.finalScore = ev.score;
      player.done = true;
      advanceTurn(room);
    } else if (player.rollCount >= 3) {
      player.result = { type: 'bust', score: -2, label: 'Bust!  No combo in 3 rolls', emoji: '💥' };
      player.finalScore = -2;
      player.done = true;
      advanceTurn(room);
    }
    // else: still their turn, can re-roll

    broadcast(room);
  });

  socket.on('next_round', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'results') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me?.isHost) return;
    startRound(room);
    console.log(`[>] Room ${room.code} — round ${room.round} started`);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const wasCurrentTurn = room.state === 'rolling' && idx === room.currentTurnIndex;
    const name = room.players[idx].name;
    room.players.splice(idx, 1);

    if (room.players.length === 0) {
      rooms.delete(socket.data.room);
      console.log(`[-] Room ${socket.data.room} closed (empty)`);
      return;
    }

    // Reassign host if needed
    if (!room.players.some(p => p.isHost)) room.players[0].isHost = true;

    if (room.state === 'rolling') {
      // Fix turn index after splice
      if (idx < room.currentTurnIndex) room.currentTurnIndex--;

      if (wasCurrentTurn) {
        // The index now points to the next player (or past the end)
        if (room.currentTurnIndex >= room.players.length) {
          endRound(room);
          return;
        }
      }

      // Check if everyone still in the game is done
      if (room.players.every(p => p.done)) {
        endRound(room);
        return;
      }
    }

    broadcast(room);
    console.log(`[-] ${name} left room ${socket.data.room}`);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🎲  Cee-lo server running →  http://localhost:${PORT}`)
);
