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

// ─── Constants ─────────────────────────────────────────────────────────────────
const STARTING_BALANCE  = 10000;
const DEFAULT_ANTE      = 100;
const MAX_PLAYERS       = 6;
const MAX_SPECTATORS    = 20;
const MAX_CHAT_HISTORY  = 100;
const MAX_RAISE         = 5000;
const MAX_ANTE          = 10000;

// ─── Wallet abstraction ────────────────────────────────────────────────────────
// Designed so the implementation can be swapped to a real-money backend later.
// All money flows go through WalletService methods — no direct field mutation.
const WalletService = {
  create(balance = STARTING_BALANCE) {
    return { balance, totalWon: 0, totalLost: 0, rebuys: 0 };
  },

  debit(wallet, amount) {
    if (amount <= 0 || wallet.balance < amount) return false;
    wallet.balance  -= amount;
    wallet.totalLost += amount;
    return true;
  },

  credit(wallet, amount) {
    if (amount <= 0) return false;
    wallet.balance  += amount;
    wallet.totalWon += amount;
    return true;
  },

  rebuy(wallet) {
    wallet.balance = STARTING_BALANCE;
    wallet.rebuys++;
    return true;
  },

  canAfford(wallet, amount) {
    return wallet.balance >= amount;
  },
};

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
 * Evaluate 3 dice using classic Cee-lo rules.
 * Score hierarchy (higher = better):
 *   1000      = 4-5-6  (instant win)
 *   101–106   = trips  (101=1-1-1 … 106=6-6-6)
 *   1–6       = point  (pair + odd die; score = odd die value)
 *   -1        = 1-2-3  (instant loss)
 *   -2        = bust   (3 rolls, no valid combo)
 *   null      = no combo yet (re-roll available)
 */
function evaluate(dice) {
  const d = [...dice].sort((a, b) => a - b);
  const [a, b, c] = d;

  if (a === 4 && b === 5 && c === 6)
    return { type: '456',   score: 1000, label: '4-5-6!  Dragon Roll!',       emoji: '🐉' };
  if (a === 1 && b === 2 && c === 3)
    return { type: '123',   score: -1,   label: '1-2-3!  Instant Loss',       emoji: '💀' };
  if (a === b && b === c)
    return { type: 'trips', score: 100 + a, label: `Trips ${a}!  (${a}-${a}-${a})`, emoji: '🔥', value: a };
  if (a === b) return { type: 'point', score: c, label: `Point  ${c}`, emoji: '🎯', value: c };
  if (b === c) return { type: 'point', score: a, label: `Point  ${a}`, emoji: '🎯', value: a };
  if (a === c) return { type: 'point', score: b, label: `Point  ${b}`, emoji: '🎯', value: b };

  return { type: 'none', score: null, label: 'No combo — re-roll!', emoji: '🎲' };
}

function makePlayer(id, name, isHost) {
  return {
    id,
    name,
    isHost,
    rolls:      [],
    result:     null,
    rollCount:  0,
    done:       false,
    finalScore: null,
    wallet:     WalletService.create(),
    antePaid:   false,
    raise:      0,
  };
}

function makeSpectator(id, name) {
  return { id, name };
}

// ─── Chat ──────────────────────────────────────────────────────────────────────
function pushChatMsg(room, msg) {
  room.chatHistory.push(msg);
  if (room.chatHistory.length > MAX_CHAT_HISTORY) room.chatHistory.shift();
  io.to(room.code).emit('chat_message', msg);
}

function sysMsg(room, text) {
  pushChatMsg(room, {
    id:        Date.now() + '_' + Math.random(),
    type:      'system',
    text,
    timestamp: Date.now(),
  });
}

// ─── Serialisation ─────────────────────────────────────────────────────────────
function serialize(room) {
  return {
    code:             room.code,
    state:            room.state,
    round:            room.round,
    currentTurnIndex: room.currentTurnIndex,
    winner:           room.winner,
    isTie:            room.isTie,
    roundHistory:     room.roundHistory,
    pot:              room.pot,
    ante:             room.ante,
    spectatorCount:   room.spectators.length,
    players: room.players.map(p => ({
      id:         p.id,
      name:       p.name,
      isHost:     p.isHost,
      rolls:      p.rolls,
      result:     p.result,
      rollCount:  p.rollCount,
      done:       p.done,
      finalScore: p.finalScore,
      balance:    p.wallet.balance,
      antePaid:   p.antePaid,
      raise:      p.raise,
    })),
  };
}

function broadcast(room) {
  io.to(room.code).emit('room_state', serialize(room));
}

// ─── Game logic ────────────────────────────────────────────────────────────────
function startRound(room) {
  room.state            = 'rolling';
  room.round           += 1;
  room.winner           = null;
  room.isTie            = false;
  room.currentTurnIndex = 0;
  room.pot              = 0;

  room.players.forEach(p => {
    p.rolls      = [];
    p.result     = null;
    p.rollCount  = 0;
    p.done       = false;
    p.finalScore = null;
    p.antePaid   = false;
    p.raise      = 0;

    // Auto-pay ante (or what they can afford)
    const ante = Math.min(room.ante, p.wallet.balance);
    if (ante > 0) {
      WalletService.debit(p.wallet, ante);
      room.pot  += ante;
      p.antePaid = true;
    }
  });

  sysMsg(room, `🎲 Round ${room.round} started! Ante: 金${room.ante.toLocaleString()}  |  Pot: 金${room.pot.toLocaleString()}`);
  broadcast(room);
}

function advanceTurn(room) {
  let next = room.currentTurnIndex + 1;
  while (next < room.players.length && room.players[next].done) next++;
  if (next >= room.players.length) endRound(room);
  else room.currentTurnIndex = next;
}

function endRound(room) {
  room.state = 'results';

  let maxScore = -Infinity;
  room.players.forEach(p => { if ((p.finalScore ?? -Infinity) > maxScore) maxScore = p.finalScore; });

  const winners = room.players.filter(p => p.finalScore === maxScore);
  room.isTie  = winners.length > 1;
  room.winner = room.isTie
    ? winners.map(w => w.name).join(' & ')
    : (winners[0]?.name ?? '—');

  // Distribute pot
  if (winners.length > 0 && room.pot > 0) {
    const share     = Math.floor(room.pot / winners.length);
    const remainder = room.pot - share * winners.length;
    winners.forEach((w, idx) => {
      WalletService.credit(w.wallet, share + (idx === 0 ? remainder : 0));
    });
  }

  room.roundHistory.push({
    round:   room.round,
    winner:  room.winner,
    isTie:   room.isTie,
    pot:     room.pot,
    summary: room.players.map(p => ({
      name:    p.name,
      label:   p.result?.label ?? 'No result',
      score:   p.finalScore,
      balance: p.wallet.balance,
    })),
  });

  if (room.isTie) {
    sysMsg(room, `🤝 Tie! ${room.winner} split pot of 金${room.pot.toLocaleString()}`);
  } else {
    sysMsg(room, `🏆 ${room.winner} wins 金${room.pot.toLocaleString()}!`);
  }

  broadcast(room);
}

// ─── Socket handling ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  // ── Create room ──
  socket.on('create_room', ({ name }) => {
    const n = (name ?? '').trim();
    if (!n)        return socket.emit('error', { msg: 'Enter your name first.' });
    if (n.length > 20) return socket.emit('error', { msg: 'Name too long (max 20 chars).' });

    const code = genCode();
    const room = {
      code,
      state:            'lobby',
      round:            0,
      currentTurnIndex: 0,
      winner:           null,
      isTie:            false,
      roundHistory:     [],
      players:          [makePlayer(socket.id, n, true)],
      spectators:       [],
      pot:              0,
      ante:             DEFAULT_ANTE,
      chatHistory:      [],
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.room        = code;
    socket.data.isSpectator = false;
    socket.data.name        = n;

    socket.emit('room_joined', { code, playerId: socket.id, isSpectator: false });
    broadcast(room);
    sysMsg(room, `👑 ${n} created the room`);
    console.log(`[+] Room ${code} created by ${n}`);
  });

  // ── Join room ──
  socket.on('join_room', ({ name, code, spectator }) => {
    const n = (name ?? '').trim();
    const c = (code ?? '').trim().toUpperCase();
    if (!n) return socket.emit('error', { msg: 'Enter your name first.' });
    if (!c) return socket.emit('error', { msg: 'Enter a room code.' });
    if (n.length > 20) return socket.emit('error', { msg: 'Name too long (max 20 chars).' });

    const room = rooms.get(c);
    if (!room) return socket.emit('error', { msg: `Room "${c}" not found.` });

    const isSpectator = !!spectator;
    const nameTaken = [...room.players, ...room.spectators]
      .some(p => p.name.toLowerCase() === n.toLowerCase());
    if (nameTaken) return socket.emit('error', { msg: `Name "${n}" is already taken.` });

    if (!isSpectator) {
      if (room.state !== 'lobby') return socket.emit('error', { msg: 'Game in progress — join as spectator?' });
      if (room.players.length >= MAX_PLAYERS) return socket.emit('error', { msg: 'Room full (max 6 players).' });
      room.players.push(makePlayer(socket.id, n, false));
    } else {
      if (room.spectators.length >= MAX_SPECTATORS) return socket.emit('error', { msg: 'Spectator slots full.' });
      room.spectators.push(makeSpectator(socket.id, n));
    }

    socket.join(c);
    socket.data.room        = c;
    socket.data.isSpectator = isSpectator;
    socket.data.name        = n;

    socket.emit('room_joined', { code: c, playerId: socket.id, isSpectator });
    socket.emit('chat_history', room.chatHistory);
    broadcast(room);
    sysMsg(room, isSpectator ? `👁 ${n} is spectating` : `🎲 ${n} joined the game`);
    console.log(`[+] ${n} ${isSpectator ? 'spectating' : 'joined'} room ${c}`);
  });

  // ── Start game ──
  socket.on('start_game', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me?.isHost)           return;
    if (room.state !== 'lobby') return socket.emit('error', { msg: 'Game already started.' });
    if (room.players.length < 2) return socket.emit('error', { msg: 'Need at least 2 players.' });
    startRound(room);
    console.log(`[>] Room ${room.code} — round ${room.round} started`);
  });

  // ── Set ante (host only, lobby only) ──
  socket.on('set_ante', ({ amount }) => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me?.isHost)            return socket.emit('error', { msg: 'Only the host can set the ante.' });
    if (room.state !== 'lobby') return socket.emit('error', { msg: 'Cannot change ante during a game.' });
    const a = parseInt(amount);
    if (isNaN(a) || a < 0 || a > MAX_ANTE)
      return socket.emit('error', { msg: `Ante must be 0–${MAX_ANTE.toLocaleString()}.` });
    room.ante = a;
    broadcast(room);
    sysMsg(room, `💰 Host set ante to 金${a.toLocaleString()}`);
  });

  // ── Place raise (before first roll on your turn) ──
  socket.on('place_raise', ({ amount }) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'rolling') return;
    if (socket.data.isSpectator) return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentTurnIndex) return socket.emit('error', { msg: 'Not your turn.' });

    const player = room.players[idx];
    if (player.done || player.rollCount > 0)
      return socket.emit('error', { msg: 'Can only raise before your first roll.' });

    const a = parseInt(amount);
    if (isNaN(a) || a <= 0 || a > MAX_RAISE)
      return socket.emit('error', { msg: `Raise must be 1–${MAX_RAISE.toLocaleString()}.` });
    if (!WalletService.canAfford(player.wallet, a))
      return socket.emit('error', { msg: 'Not enough coins.' });

    WalletService.debit(player.wallet, a);
    player.raise  = a;
    room.pot     += a;

    sysMsg(room, `💰 ${player.name} raised 金${a.toLocaleString()} — pot: 金${room.pot.toLocaleString()}`);
    broadcast(room);
  });

  // ── Rebuy ──
  socket.on('rebuy', () => {
    const room = rooms.get(socket.data.room);
    if (!room || socket.data.isSpectator) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (player.wallet.balance > 0) return socket.emit('error', { msg: 'You still have coins!' });
    WalletService.rebuy(player.wallet);
    sysMsg(room, `💸 ${player.name} rebought for 金${STARTING_BALANCE.toLocaleString()}`);
    broadcast(room);
  });

  // ── Roll dice ──
  socket.on('roll_dice', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'rolling') return;
    if (socket.data.isSpectator) return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentTurnIndex) return;

    const player = room.players[idx];
    if (player.done) return;

    const dice = roll3();
    const ev   = evaluate(dice);

    player.rolls.push(dice);
    player.rollCount++;

    // Broadcast roll event for animation (before state update)
    io.to(room.code).emit('dice_rolled', {
      playerId:   socket.id,
      name:       player.name,
      dice,
      evaluation: ev,
      rollCount:  player.rollCount,
    });

    // System messages for notable rolls
    if      (ev.type === '456')   sysMsg(room, `🐉 ${player.name} rolled 4-5-6 — DRAGON ROLL! ⚡`);
    else if (ev.type === '123')   sysMsg(room, `💀 ${player.name} rolled 1-2-3!`);
    else if (ev.type === 'trips') sysMsg(room, `🔥 ${player.name} rolled Trips ${ev.value}!`);

    if (ev.type !== 'none') {
      player.result     = ev;
      player.finalScore = ev.score;
      player.done       = true;
      advanceTurn(room);
    } else if (player.rollCount >= 3) {
      player.result     = { type: 'bust', score: -2, label: 'Bust!  No combo in 3 rolls', emoji: '💥' };
      player.finalScore = -2;
      player.done       = true;
      advanceTurn(room);
    }

    broadcast(room);
  });

  // ── Chat ──
  socket.on('send_chat', ({ text }) => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const t = (text ?? '').trim().substring(0, 200);
    if (!t) return;
    pushChatMsg(room, {
      id:          Date.now() + '_' + Math.random(),
      type:        'chat',
      name:        socket.data.name,
      text:        t,
      isSpectator: socket.data.isSpectator,
      timestamp:   Date.now(),
    });
  });

  // ── Next round ──
  socket.on('next_round', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'results') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me?.isHost) return;
    startRound(room);
    console.log(`[>] Room ${room.code} — round ${room.round} started`);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;

    if (socket.data.isSpectator) {
      const idx = room.spectators.findIndex(s => s.id === socket.id);
      if (idx !== -1) {
        const name = room.spectators[idx].name;
        room.spectators.splice(idx, 1);
        sysMsg(room, `👁 ${name} stopped spectating`);
        broadcast(room);
      }
      return;
    }

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const wasCurrentTurn = room.state === 'rolling' && idx === room.currentTurnIndex;
    const name           = room.players[idx].name;
    room.players.splice(idx, 1);

    if (room.players.length === 0) {
      rooms.delete(socket.data.room);
      console.log(`[-] Room ${socket.data.room} closed (empty)`);
      return;
    }

    if (!room.players.some(p => p.isHost)) room.players[0].isHost = true;

    if (room.state === 'rolling') {
      if (idx < room.currentTurnIndex) room.currentTurnIndex--;
      if (wasCurrentTurn && room.currentTurnIndex >= room.players.length) {
        endRound(room);
        return;
      }
      if (room.players.every(p => p.done)) {
        endRound(room);
        return;
      }
    }

    sysMsg(room, `👋 ${name} left the game`);
    broadcast(room);
    console.log(`[-] ${name} left room ${socket.data.room}`);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🎲  Cee-lo server running →  http://localhost:${PORT}`)
);
