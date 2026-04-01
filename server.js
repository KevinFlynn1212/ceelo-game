const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─── Constants ──────────────────────────────────────────────────────────────────
const STARTING_BALANCE      = 50_000;
const MAX_PLAYERS           = 5;
const MAX_SPECTATORS        = 20;
const MAX_CHAT_HISTORY      = 100;
const MAX_RAISE             = 50_000;
const MAX_ROLL_ATTEMPTS     = 7;
const MAX_MISSED_ROUNDS     = 5;
const RAKE_PCT              = 0.05;           // 5%

const TIMER_ANTE_MS         = 5_000;
const TIMER_ROLL_MS         = 5_000;
const TIMER_REANTE_MS       = 5_000;
const TIMER_RESULTS_MS      = 6_000;
const TIMER_SHOOTOUT_RAISE_MS = 5_000;
const TIMER_BETWEEN_MS      = 2_000;

// Pre-configured room definitions
const ROOM_CONFIGS = [
  { id: 'room-100',  name: '金100 Table',  ante: 100  },
  { id: 'room-500',  name: '金500 Table',  ante: 500  },
  { id: 'room-1000', name: '金1000 Table', ante: 1000 },
  { id: 'room-5000', name: '金5000 Table', ante: 5000 },
];

// ─── Wallet abstraction ─────────────────────────────────────────────────────────
const WalletService = {
  create(balance = STARTING_BALANCE) {
    return { balance, totalWon: 0, totalLost: 0, rebuys: 0 };
  },
  debit(wallet, amount) {
    if (amount <= 0 || wallet.balance < amount) return false;
    wallet.balance   -= amount;
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
  },
  canAfford(wallet, amount) {
    return wallet.balance >= amount;
  },
};

// ─── Room store ─────────────────────────────────────────────────────────────────
const rooms = new Map();

function createRoom(config) {
  return {
    id:                config.id,
    name:              config.name,
    ante:              config.ante,
    state:             'lobby',  // lobby | ante | rolling | re_ante | shootout | results
    round:             0,
    pot:               0,
    rake:              0,
    carryoverPot:      0,        // carries over on all-Dancing-Dragon round
    players:           [],
    spectators:        [],
    chatHistory:       [],
    currentTurnIndex:  0,
    winner:            null,
    isTie:             false,
    roundHistory:      [],
    timer:             null,
    timerEnd:          null,
    shootoutPlayerIds: [],
    shootoutRound:     0,
    shootoutPhase:     null,     // 'raise' | 'rolling'
  };
}

ROOM_CONFIGS.forEach(cfg => rooms.set(cfg.id, createRoom(cfg)));

// ─── Player factory ─────────────────────────────────────────────────────────────
function makePlayer(id, name) {
  return {
    id,
    name,
    wallet:          WalletService.create(),
    rolls:           [],
    result:          null,
    rollCount:       0,
    done:            false,
    finalScore:      null,
    antePaid:        false,
    raise:           0,
    missedRounds:    0,
    reAnteOffered:   false,
    reAntePaid:      false,
    reAnteActive:    false,    // currently on the re-ante roll
    inShootout:      false,
    shootoutScore:   null,
    shootoutRolls:   [],
    shootoutDone:    false,
    shootoutRaise:   0,
  };
}

function makeSpectator(id, name) {
  return { id, name };
}

// ─── Dice ───────────────────────────────────────────────────────────────────────
function roll3() {
  return [
    Math.ceil(Math.random() * 6),
    Math.ceil(Math.random() * 6),
    Math.ceil(Math.random() * 6),
  ];
}

/**
 * Evaluate 3 dice.
 *
 * Score hierarchy (higher wins):
 *   1000         = 4-5-6  "Strungflowers"  (instant win)
 *   101–106      = trips  (101 = 1-1-1 … 106 = 6-6-6)
 *   11–65        = point  score = pointValue*10 + pairValue
 *   -1           = 1-2-3  "Dancing Dragon" (instant loss)
 *   -2           = bust   (7 attempts, no combo)
 *   null/type:none = no combo yet
 */
function evaluate(dice) {
  const d = [...dice].sort((a, b) => a - b);
  const [a, b, c] = d;

  if (a === 4 && b === 5 && c === 6)
    return {
      type:  '456', score: 1000,
      label: '🌸 Strungflowers! (4-5-6)',
      emoji: '🌸', point: null, pair: null,
    };

  if (a === 1 && b === 2 && c === 3)
    return {
      type:  '123', score: -1,
      label: '🐉 Dancing Dragon! (1-2-3)',
      emoji: '🐉', point: null, pair: null,
    };

  if (a === b && b === c)
    return {
      type:  'trips', score: 100 + a,
      label: `🔥 Trips ${a}! (${a}-${a}-${a})`,
      emoji: '🔥', point: a, pair: a,
    };

  // Find pair and point value
  let pointVal, pairVal;
  if      (a === b) { pointVal = c; pairVal = a; }
  else if (b === c) { pointVal = a; pairVal = b; }
  else if (a === c) { pointVal = b; pairVal = a; }

  if (pointVal !== undefined) {
    const score = pointVal * 10 + pairVal;
    return {
      type:  'point', score,
      label: `🎯 Point ${pointVal} (pair of ${pairVal})`,
      emoji: '🎯', point: pointVal, pair: pairVal,
    };
  }

  return {
    type:  'none', score: null,
    label: '🎲 No combo — re-roll!',
    emoji: '🎲', point: null, pair: null,
  };
}

// ─── Chat ────────────────────────────────────────────────────────────────────────
function pushChatMsg(room, msg) {
  room.chatHistory.push(msg);
  if (room.chatHistory.length > MAX_CHAT_HISTORY) room.chatHistory.shift();
  io.to(room.id).emit('chat_message', msg);
}

function sysMsg(room, text) {
  pushChatMsg(room, {
    id:        `${Date.now()}_${Math.random()}`,
    type:      'system',
    text,
    timestamp: Date.now(),
  });
}

// ─── Lobby ───────────────────────────────────────────────────────────────────────
function getLobbyState() {
  return {
    rooms: Array.from(rooms.values()).map(r => ({
      id:             r.id,
      name:           r.name,
      ante:           r.ante,
      state:          r.state,
      round:          r.round,
      pot:            r.pot,
      playerCount:    r.players.length,
      maxPlayers:     MAX_PLAYERS,
      spectatorCount: r.spectators.length,
    })),
  };
}

function broadcastLobby() {
  io.emit('lobby_state', getLobbyState());
}

// ─── Room serialisation ──────────────────────────────────────────────────────────
function serializeRoom(room) {
  return {
    id:                room.id,
    name:              room.name,
    ante:              room.ante,
    state:             room.state,
    round:             room.round,
    pot:               room.pot,
    rake:              room.rake,
    winner:            room.winner,
    isTie:             room.isTie,
    roundHistory:      room.roundHistory,
    currentTurnIndex:  room.currentTurnIndex,
    spectatorCount:    room.spectators.length,
    timerEnd:          room.timerEnd,
    shootoutPlayerIds: room.shootoutPlayerIds,
    shootoutRound:     room.shootoutRound,
    shootoutPhase:     room.shootoutPhase,
    players: room.players.map(p => ({
      id:             p.id,
      name:           p.name,
      balance:        p.wallet.balance,
      rolls:          p.rolls,
      result:         p.result,
      rollCount:      p.rollCount,
      done:           p.done,
      finalScore:     p.finalScore,
      antePaid:       p.antePaid,
      raise:          p.raise,
      missedRounds:   p.missedRounds,
      reAnteOffered:  p.reAnteOffered,
      reAntePaid:     p.reAntePaid,
      reAnteActive:   p.reAnteActive,
      inShootout:     p.inShootout,
      shootoutScore:  p.shootoutScore,
      shootoutRolls:  p.shootoutRolls,
      shootoutDone:   p.shootoutDone,
      shootoutRaise:  p.shootoutRaise,
    })),
  };
}

function broadcast(room) {
  io.to(room.id).emit('room_state', serializeRoom(room));
}

// ─── Timer helpers ───────────────────────────────────────────────────────────────
function clearRoomTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.timerEnd = null;
}

function setRoomTimer(room, ms, fn) {
  clearRoomTimer(room);
  room.timerEnd = Date.now() + ms;
  room.timer = setTimeout(() => {
    room.timer   = null;
    room.timerEnd = null;
    fn();
  }, ms);
}

// ─── Game flow ───────────────────────────────────────────────────────────────────

function checkAutoStart(room) {
  if (room.state !== 'lobby') return;
  if (room.players.length >= 2) startAntePhase(room);
}

// Phase 1: Ante collection countdown
function startAntePhase(room) {
  clearRoomTimer(room);
  room.state = 'ante';
  sysMsg(room, `⏳ Round starting in 5 seconds! Ante: 金${room.ante.toLocaleString()}`);
  broadcast(room);
  broadcastLobby();
  setRoomTimer(room, TIMER_ANTE_MS, () => collectAntes(room));
}

function collectAntes(room) {
  if (room.state !== 'ante') return;

  // Carry over any doubled pot from all-Dragon round
  room.pot  = room.carryoverPot;
  room.rake = 0;
  room.carryoverPot = 0;

  // Collect ante from each player; bump those who can't afford it
  const toRemove = [];
  room.players.forEach(p => {
    if (WalletService.debit(p.wallet, room.ante)) {
      room.pot   += room.ante;
      p.antePaid  = true;
    } else {
      toRemove.push(p.id);
    }
  });

  toRemove.forEach(id => {
    const p = room.players.find(x => x.id === id);
    if (p) sysMsg(room, `💸 ${p.name} couldn't afford the ante and was removed.`);
    removePlayer(room, id);
  });

  if (room.players.length < 2) {
    clearRoomTimer(room);
    room.state = 'lobby';
    room.pot   = 0;
    sysMsg(room, '⚠️ Not enough players to start. Waiting...');
    broadcast(room);
    broadcastLobby();
    return;
  }

  startRolling(room);
}

// Phase 2: Rolling
function startRolling(room) {
  room.state            = 'rolling';
  room.round           += 1;
  room.winner           = null;
  room.isTie            = false;
  room.currentTurnIndex = 0;
  room.shootoutPlayerIds = [];
  room.shootoutRound    = 0;

  room.players.forEach(p => {
    p.rolls          = [];
    p.result         = null;
    p.rollCount      = 0;
    p.done           = false;
    p.finalScore     = null;
    p.raise          = 0;
    p.reAnteOffered  = false;
    p.reAntePaid     = false;
    p.reAnteActive   = false;
    p.inShootout     = false;
    p.shootoutScore  = null;
    p.shootoutRolls  = [];
    p.shootoutDone   = false;
    p.shootoutRaise  = 0;
  });

  sysMsg(room, `🎲 Round ${room.round} | Pot: 金${room.pot.toLocaleString()} | Ante: 金${room.ante.toLocaleString()}`);
  broadcast(room);
  scheduleTurnTimer(room);
}

// Start (or reset) the per-roll countdown for the current player
function scheduleTurnTimer(room) {
  clearRoomTimer(room);
  const player = room.players[room.currentTurnIndex];
  if (!player || player.done) { endRound(room); return; }

  room.timerEnd = Date.now() + TIMER_ROLL_MS;
  room.timer    = setTimeout(() => {
    room.timer   = null;
    room.timerEnd = null;
    handleAutoRoll(room);
  }, TIMER_ROLL_MS);

  broadcast(room);
}

function handleAutoRoll(room) {
  if (room.state !== 'rolling') return;
  const player = room.players[room.currentTurnIndex];
  if (!player || player.done) return;

  player.missedRounds++;
  sysMsg(room, `⏱️ ${player.name} auto-rolled (missed ${player.missedRounds}/${MAX_MISSED_ROUNDS})`);

  if (player.missedRounds >= MAX_MISSED_ROUNDS) {
    sysMsg(room, `🚫 ${player.name} bumped for too many missed rounds.`);
    const removedId = player.id;
    removePlayer(room, removedId);

    if (room.players.length < 2) {
      clearRoomTimer(room);
      room.state = 'lobby';
      sysMsg(room, '⚠️ Not enough players. Game paused.');
      broadcast(room);
      broadcastLobby();
      return;
    }

    if (room.players.every(p => p.done)) { endRound(room); return; }
    scheduleTurnTimer(room);
    broadcast(room);
    return;
  }

  performRoll(room, player, true);
}

// Core roll logic
function performRoll(room, player, isAuto) {
  const dice = roll3();
  const ev   = evaluate(dice);

  player.rolls.push(dice);
  player.rollCount++;

  io.to(room.id).emit('roll_result', {
    playerId:      player.id,
    name:          player.name,
    dice,
    evaluation:    ev,
    rollCount:     player.rollCount,
    isAuto,
    isReAnte:      player.reAnteActive,
    animationData: { dice, duration: 800, bounces: 3 },
  });

  // ── Re-ante roll: exactly one roll, final regardless ──────────────────────
  if (player.reAnteActive) {
    player.reAnteActive = false;
    const finalEv = ev.type === 'none'
      ? { type: 'bust', score: -2, label: '💥 Re-ante bust!', emoji: '💥', point: null, pair: null }
      : ev;
    finalisePlayerResult(room, player, finalEv);
    advanceTurn(room);
    broadcast(room);
    return;
  }

  // ── Valid combo obtained ──────────────────────────────────────────────────
  if (ev.type !== 'none') {
    if      (ev.type === '456')   sysMsg(room, `🌸 ${player.name} rolled Strungflowers (4-5-6)! INSTANT WIN!`);
    else if (ev.type === '123')   sysMsg(room, `🐉 ${player.name} rolled Dancing Dragon (1-2-3)!`);
    else if (ev.type === 'trips') sysMsg(room, `🔥 ${player.name} rolled Trips ${ev.point}!`);
    else if (ev.type === 'point') sysMsg(room, `🎯 ${player.name}: Point ${ev.point} (pair of ${ev.pair})`);

    // Offer re-ante only for point results, not on auto-roll
    if (ev.type === 'point' && !isAuto && WalletService.canAfford(player.wallet, room.ante)) {
      finalisePlayerResult(room, player, ev);
      offerReAnte(room, player);
      broadcast(room);
      return;
    }

    finalisePlayerResult(room, player, ev);
    advanceTurn(room);
    broadcast(room);
    return;
  }

  // ── Bust after MAX_ROLL_ATTEMPTS ──────────────────────────────────────────
  if (player.rollCount >= MAX_ROLL_ATTEMPTS) {
    const bustEv = { type: 'bust', score: -2, label: '💥 Bust! (7 attempts)', emoji: '💥', point: null, pair: null };
    sysMsg(room, `💥 ${player.name} busted (7 attempts, no combo)`);
    finalisePlayerResult(room, player, bustEv);
    advanceTurn(room);
    broadcast(room);
    return;
  }

  // ── No combo yet; reset timer for next roll ───────────────────────────────
  if (!isAuto) scheduleTurnTimer(room);
  broadcast(room);
}

function finalisePlayerResult(room, player, ev) {
  player.result     = ev;
  player.finalScore = ev.score;
  player.done       = true;
}

// ── Re-Ante offer ─────────────────────────────────────────────────────────────
function offerReAnte(room, player) {
  clearRoomTimer(room);
  room.state          = 're_ante';
  player.reAnteOffered = true;

  sysMsg(room, `💰 ${player.name}: Re-ante 金${room.ante.toLocaleString()} to re-roll once? (5s)`);
  broadcast(room);

  const sock = io.sockets.sockets.get(player.id);
  if (sock) {
    sock.emit('re_ante_offer', {
      playerId:      player.id,
      ante:          room.ante,
      currentScore:  player.finalScore,
      currentResult: player.result,
      timerMs:       TIMER_REANTE_MS,
    });
  }

  setRoomTimer(room, TIMER_REANTE_MS, () => {
    if (player.reAnteOffered) {
      player.reAnteOffered = false;
      sysMsg(room, `⏱️ ${player.name} passed on re-ante (timeout).`);
      room.state = 'rolling';
      advanceTurn(room);
      broadcast(room);
    }
  });
}

// ── Turn advancement ─────────────────────────────────────────────────────────
function advanceTurn(room) {
  clearRoomTimer(room);
  room.state = 'rolling';

  if (room.players.every(p => p.done)) { endRound(room); return; }

  let next = room.currentTurnIndex + 1;
  while (next < room.players.length && room.players[next].done) next++;

  if (next >= room.players.length) { endRound(room); return; }

  room.currentTurnIndex = next;
  scheduleTurnTimer(room);
}

// ─── End of round ────────────────────────────────────────────────────────────────
function endRound(room) {
  clearRoomTimer(room);
  room.state = 'results';

  const players = room.players;

  // ── All Dancing Dragon → pot doubles, everyone re-antes ──
  if (players.length > 0 && players.every(p => p.result?.type === '123')) {
    sysMsg(room, `🐉🐉🐉 ALL players rolled Dancing Dragon! Pot DOUBLES and carries over!`);
    room.carryoverPot = room.pot * 2;
    room.pot = 0;

    io.to(room.id).emit('round_end', {
      roomId:     room.id,
      round:      room.round,
      winner:     null,
      isTie:      false,
      allDancing: true,
      carryoverPot: room.carryoverPot,
      rakeTaken:  0,
      results:    players.map(p => ({ id: p.id, name: p.name, result: p.result, score: p.finalScore })),
    });
    broadcast(room);

    setRoomTimer(room, TIMER_RESULTS_MS, () => {
      if (room.players.length >= 2) startAntePhase(room);
      else { room.state = 'lobby'; broadcast(room); broadcastLobby(); }
    });
    return;
  }

  // ── Rake ──────────────────────────────────────────────────────────────────
  const rakeAmount      = Math.floor(room.pot * RAKE_PCT);
  const distributablePot = room.pot - rakeAmount;
  room.rake = rakeAmount;
  if (rakeAmount > 0)
    sysMsg(room, `🏦 Rake: 金${rakeAmount.toLocaleString()} (5%) — House takes its cut.`);

  // ── Find top scorer(s) ────────────────────────────────────────────────────
  let maxScore = -Infinity;
  players.forEach(p => { if ((p.finalScore ?? -Infinity) > maxScore) maxScore = p.finalScore; });
  const topPlayers = players.filter(p => p.finalScore === maxScore && maxScore > -2);

  // ── Tie → shootout ────────────────────────────────────────────────────────
  if (topPlayers.length > 1) {
    sysMsg(room, `⚔️ TIE between ${topPlayers.map(w => w.name).join(' & ')}! SHOOTOUT begins!`);
    io.to(room.id).emit('round_end', {
      roomId:    room.id,
      round:     room.round,
      winner:    null,
      isTie:     true,
      allDancing: false,
      pot:       distributablePot,
      rakeTaken: rakeAmount,
      results:   players.map(p => ({ id: p.id, name: p.name, result: p.result, score: p.finalScore })),
    });
    broadcast(room);
    setRoomTimer(room, TIMER_BETWEEN_MS, () => startShootout(room, topPlayers, distributablePot));
    return;
  }

  // ── Single winner ─────────────────────────────────────────────────────────
  if (topPlayers.length === 1 && distributablePot > 0) {
    WalletService.credit(topPlayers[0].wallet, distributablePot);
    room.winner = topPlayers[0].name;
    sysMsg(room, `🏆 ${room.winner} wins 金${distributablePot.toLocaleString()}!`);
  } else {
    room.winner = '—';
  }
  room.isTie = false;

  room.roundHistory.push({
    round:    room.round,
    winner:   room.winner,
    isTie:    false,
    pot:      room.pot,
    rake:     rakeAmount,
    summary:  players.map(p => ({
      name:    p.name,
      label:   p.result?.label ?? '—',
      score:   p.finalScore,
      balance: p.wallet.balance,
    })),
  });

  io.to(room.id).emit('round_end', {
    roomId:    room.id,
    round:     room.round,
    winner:    room.winner,
    isTie:     false,
    allDancing: false,
    pot:       distributablePot,
    rakeTaken: rakeAmount,
    results:   players.map(p => ({ id: p.id, name: p.name, result: p.result, score: p.finalScore })),
  });
  broadcast(room);

  setRoomTimer(room, TIMER_RESULTS_MS, () => {
    if (room.players.length >= 2) startAntePhase(room);
    else { room.state = 'lobby'; broadcast(room); broadcastLobby(); }
  });
}

// ─── Shootout ────────────────────────────────────────────────────────────────────
function startShootout(room, tiedPlayers, pot) {
  clearRoomTimer(room);
  room.state             = 'shootout';
  room.shootoutPhase     = 'raise';
  room.shootoutRound    += 1;
  room.pot               = pot;
  room.shootoutPlayerIds = tiedPlayers.map(p => p.id);

  tiedPlayers.forEach(p => {
    p.inShootout    = true;
    p.shootoutScore = null;
    p.shootoutRolls = [];
    p.shootoutDone  = false;
    p.shootoutRaise = 0;
    p.done          = false;
  });

  // Point currentTurnIndex at first tied player (for raise window UX)
  room.currentTurnIndex = room.players.findIndex(p => p.id === tiedPlayers[0].id);

  sysMsg(room, `⚔️ SHOOTOUT Round ${room.shootoutRound}: ${tiedPlayers.map(p => p.name).join(' vs ')} | Optional raise for 5 seconds...`);

  io.to(room.id).emit('shootout_start', {
    roomId:          room.id,
    shootoutRound:   room.shootoutRound,
    pot:             room.pot,
    raisePeriodMs:   TIMER_SHOOTOUT_RAISE_MS,
    shootoutPlayers: tiedPlayers.map(p => ({
      id:      p.id,
      name:    p.name,
      balance: p.wallet.balance,
    })),
  });

  broadcast(room);

  setRoomTimer(room, TIMER_SHOOTOUT_RAISE_MS, () => {
    room.shootoutPhase = 'rolling';
    // Start rolling for first tied player
    const firstIdx = room.players.findIndex(p => p.inShootout && !p.shootoutDone);
    room.currentTurnIndex = firstIdx !== -1 ? firstIdx : 0;
    broadcast(room);
    scheduleShootoutTimer(room);
  });
}

function scheduleShootoutTimer(room) {
  clearRoomTimer(room);
  const player = room.players[room.currentTurnIndex];
  if (!player || !player.inShootout || player.shootoutDone) {
    resolveShootout(room);
    return;
  }

  room.timerEnd = Date.now() + TIMER_ROLL_MS;
  room.timer    = setTimeout(() => {
    room.timer    = null;
    room.timerEnd = null;
    // Auto-roll for the shootout player
    player.missedRounds++;
    sysMsg(room, `⏱️ ${player.name} auto-rolled in shootout`);
    performShootoutRoll(room, player, true);
  }, TIMER_ROLL_MS);

  broadcast(room);
}

function performShootoutRoll(room, player, isAuto) {
  // Roll until valid combo or MAX_ROLL_ATTEMPTS
  let dice, ev, attempts = 0;
  do {
    dice = roll3();
    ev   = evaluate(dice);
    player.shootoutRolls.push(dice);
    attempts++;

    io.to(room.id).emit('roll_result', {
      playerId:      player.id,
      name:          player.name,
      dice,
      evaluation:    ev,
      rollCount:     attempts,
      isAuto,
      isShootout:    true,
      animationData: { dice, duration: 800, bounces: 3 },
    });
  } while (ev.type === 'none' && attempts < MAX_ROLL_ATTEMPTS);

  if (ev.type === 'none')
    ev = { type: 'bust', score: -2, label: '💥 Bust!', emoji: '💥', point: null, pair: null };

  player.shootoutScore = ev.score;
  player.result        = ev;
  player.shootoutDone  = true;

  if      (ev.type === '456')   sysMsg(room, `🌸 ${player.name}: Strungflowers in shootout!`);
  else if (ev.type === '123')   sysMsg(room, `🐉 ${player.name}: Dancing Dragon in shootout!`);
  else if (ev.type === 'trips') sysMsg(room, `🔥 ${player.name}: Trips ${ev.point} in shootout`);
  else if (ev.type === 'point') sysMsg(room, `🎯 ${player.name}: Point ${ev.point} (pair ${ev.pair}) in shootout`);
  else                          sysMsg(room, `💥 ${player.name} busted in shootout`);

  // Advance to next shootout player
  const nextIdx = room.players.findIndex((p, i) =>
    i > room.currentTurnIndex && p.inShootout && !p.shootoutDone
  );

  if (nextIdx !== -1) {
    room.currentTurnIndex = nextIdx;
    broadcast(room);
    scheduleShootoutTimer(room);
  } else {
    broadcast(room);
    resolveShootout(room);
  }
}

function resolveShootout(room) {
  clearRoomTimer(room);

  const contenders = room.players.filter(p => p.inShootout);
  let maxScore = -Infinity;
  contenders.forEach(p => { if ((p.shootoutScore ?? -Infinity) > maxScore) maxScore = p.shootoutScore; });
  const winners = contenders.filter(p => p.shootoutScore === maxScore);

  if (winners.length === 1) {
    // Clear winner
    WalletService.credit(winners[0].wallet, room.pot);
    room.winner = winners[0].name;
    room.isTie  = false;
    sysMsg(room, `⚔️ SHOOTOUT WINNER: ${room.winner} takes 金${room.pot.toLocaleString()}!`);

    room.roundHistory.push({
      round:         room.round,
      winner:        room.winner,
      isTie:         false,
      wasShootout:   true,
      shootoutRound: room.shootoutRound,
      pot:           room.pot,
      rake:          room.rake,
    });

    io.to(room.id).emit('round_end', {
      roomId:       room.id,
      round:        room.round,
      winner:       room.winner,
      isTie:        false,
      wasShootout:  true,
      shootoutRound: room.shootoutRound,
      pot:          room.pot,
      rakeTaken:    room.rake,
    });

    room.state = 'results';
    broadcast(room);

    setRoomTimer(room, TIMER_RESULTS_MS, () => {
      if (room.players.length >= 2) startAntePhase(room);
      else { room.state = 'lobby'; broadcast(room); broadcastLobby(); }
    });
  } else {
    // Still tied — another shootout
    sysMsg(room, `⚔️ Still tied! Another shootout round!`);
    setRoomTimer(room, TIMER_BETWEEN_MS, () => startShootout(room, winners, room.pot));
  }
}

// ─── Player removal helper ───────────────────────────────────────────────────────
function removePlayer(room, playerId) {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return;
  room.players.splice(idx, 1);

  // Adjust current turn pointer
  if (idx < room.currentTurnIndex) {
    room.currentTurnIndex = Math.max(0, room.currentTurnIndex - 1);
  } else if (idx === room.currentTurnIndex) {
    room.currentTurnIndex = Math.min(room.currentTurnIndex, Math.max(0, room.players.length - 1));
  }
}

// ─── Socket handling ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  // Send lobby state immediately on connect
  socket.emit('lobby_state', getLobbyState());

  // ── Get lobby ──────────────────────────────────────────────────────────────
  socket.on('get_lobby', () => {
    socket.emit('lobby_state', getLobbyState());
  });

  // ── Join room ──────────────────────────────────────────────────────────────
  socket.on('join_room', ({ name, roomId, spectator }) => {
    const n   = (name   ?? '').trim();
    const rid = (roomId ?? '').trim();
    if (!n)          return socket.emit('error', { msg: 'Enter your name.' });
    if (n.length > 20) return socket.emit('error', { msg: 'Name too long (max 20).' });

    const room = rooms.get(rid);
    if (!room) return socket.emit('error', { msg: `Room "${rid}" not found.` });

    const isSpectator = !!spectator;

    const nameTaken = [...room.players, ...room.spectators]
      .some(p => p.name.toLowerCase() === n.toLowerCase());
    if (nameTaken) return socket.emit('error', { msg: `Name "${n}" is taken.` });

    if (!isSpectator) {
      if (room.players.length >= MAX_PLAYERS)
        return socket.emit('error', { msg: `Room full (max ${MAX_PLAYERS} players).` });
      // Only allow joining during lobby or brief results window
      if (room.state !== 'lobby' && room.state !== 'results')
        return socket.emit('error', { msg: 'Game in progress — join as spectator?' });
      room.players.push(makePlayer(socket.id, n));
    } else {
      if (room.spectators.length >= MAX_SPECTATORS)
        return socket.emit('error', { msg: 'Spectator slots full.' });
      room.spectators.push(makeSpectator(socket.id, n));
    }

    socket.join(rid);
    socket.data.room        = rid;
    socket.data.isSpectator = isSpectator;
    socket.data.name        = n;

    socket.emit('room_joined', { roomId: rid, playerId: socket.id, isSpectator });
    socket.emit('chat_history', room.chatHistory);
    socket.emit('room_state',   serializeRoom(room));

    sysMsg(room, isSpectator ? `👁 ${n} is spectating` : `🎮 ${n} joined`);
    broadcast(room);
    broadcastLobby();

    if (!isSpectator) checkAutoStart(room);
    console.log(`[+] ${n} ${isSpectator ? 'spectating' : 'joined'} ${rid}`);
  });

  // ── Leave room ─────────────────────────────────────────────────────────────
  socket.on('leave_room', () => handleLeave(socket));

  // ── Roll dice (main rolling phase) ────────────────────────────────────────
  socket.on('roll_dice', () => {
    if (socket.data.isSpectator) return;
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'rolling') return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentTurnIndex) return;
    const player = room.players[idx];
    if (player.done) return;

    clearRoomTimer(room);
    performRoll(room, player, false);
  });

  // ── Re-ante decision ───────────────────────────────────────────────────────
  socket.on('re_ante_decision', ({ accept }) => {
    if (socket.data.isSpectator) return;
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 're_ante') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.reAnteOffered) return;

    clearRoomTimer(room);
    player.reAnteOffered = false;

    if (accept) {
      if (!WalletService.debit(player.wallet, room.ante)) {
        sysMsg(room, `💸 ${player.name} couldn't afford the re-ante.`);
        room.state = 'rolling';
        advanceTurn(room);
        broadcast(room);
        return;
      }

      room.pot        += room.ante;
      player.reAntePaid   = true;
      player.reAnteActive = true;
      player.done         = false;
      player.result       = null;
      player.finalScore   = null;
      player.rollCount    = 0;

      sysMsg(room, `💰 ${player.name} re-anted 金${room.ante.toLocaleString()} — one more roll! Pot: 金${room.pot.toLocaleString()}`);
      room.state = 'rolling';
      scheduleTurnTimer(room);
      broadcast(room);
    } else {
      sysMsg(room, `${player.name} passed on re-ante.`);
      room.state = 'rolling';
      advanceTurn(room);
      broadcast(room);
    }
  });

  // ── Shootout roll ──────────────────────────────────────────────────────────
  socket.on('shootout_roll', () => {
    if (socket.data.isSpectator) return;
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'shootout' || room.shootoutPhase !== 'rolling') return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentTurnIndex) return socket.emit('error', { msg: 'Not your shootout turn.' });
    const player = room.players[idx];
    if (!player.inShootout || player.shootoutDone) return;

    clearRoomTimer(room);
    performShootoutRoll(room, player, false);
  });

  // ── Shootout raise (during raise window) ──────────────────────────────────
  socket.on('shootout_raise', ({ amount }) => {
    if (socket.data.isSpectator) return;
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'shootout' || room.shootoutPhase !== 'raise') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.inShootout || player.shootoutRaise > 0) return;

    const a = parseInt(amount);
    if (isNaN(a) || a <= 0 || a > MAX_RAISE)
      return socket.emit('error', { msg: `Raise must be 1–${MAX_RAISE.toLocaleString()}.` });
    if (!WalletService.canAfford(player.wallet, a))
      return socket.emit('error', { msg: 'Not enough coins.' });

    WalletService.debit(player.wallet, a);
    player.shootoutRaise  = a;
    player.raise         += a;
    room.pot             += a;

    sysMsg(room, `⚔️ ${player.name} raised 金${a.toLocaleString()} in shootout! Pot: 金${room.pot.toLocaleString()}`);
    broadcast(room);
  });

  // ── Regular raise (before first roll, main phase) ─────────────────────────
  socket.on('place_raise', ({ amount }) => {
    if (socket.data.isSpectator) return;
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'rolling') return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.currentTurnIndex) return socket.emit('error', { msg: 'Not your turn.' });
    const player = room.players[idx];
    if (player.rollCount > 0) return socket.emit('error', { msg: 'Can only raise before first roll.' });
    if (player.reAnteActive)  return socket.emit('error', { msg: 'No raise on re-ante roll.' });

    const a = parseInt(amount);
    if (isNaN(a) || a <= 0 || a > MAX_RAISE)
      return socket.emit('error', { msg: `Raise must be 1–${MAX_RAISE.toLocaleString()}.` });
    if (!WalletService.canAfford(player.wallet, a))
      return socket.emit('error', { msg: 'Not enough coins.' });

    WalletService.debit(player.wallet, a);
    player.raise  += a;
    room.pot      += a;

    sysMsg(room, `💰 ${player.name} raised 金${a.toLocaleString()} — Pot: 金${room.pot.toLocaleString()}`);
    broadcast(room);
  });

  // ── Rebuy ──────────────────────────────────────────────────────────────────
  socket.on('rebuy', () => {
    if (socket.data.isSpectator) return;
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (player.wallet.balance > 0) return socket.emit('error', { msg: 'You still have coins!' });
    WalletService.rebuy(player.wallet);
    sysMsg(room, `💸 ${player.name} rebought for 金${STARTING_BALANCE.toLocaleString()}`);
    broadcast(room);
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  socket.on('send_chat', ({ text }) => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const t = (text ?? '').trim().substring(0, 200);
    if (!t) return;
    pushChatMsg(room, {
      id:          `${Date.now()}_${Math.random()}`,
      type:        'chat',
      name:        socket.data.name,
      text:        t,
      isSpectator: !!socket.data.isSpectator,
      timestamp:   Date.now(),
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    handleLeave(socket);
    console.log(`[-] ${socket.id} disconnected`);
  });

  // ── Internal: handle a player/spectator leaving ────────────────────────────
  function handleLeave(sock) {
    const rid  = sock.data.room;
    const room = rooms.get(rid);
    if (!room) return;

    // ── Spectator leave ──
    if (sock.data.isSpectator) {
      const idx = room.spectators.findIndex(s => s.id === sock.id);
      if (idx !== -1) {
        const name = room.spectators[idx].name;
        room.spectators.splice(idx, 1);
        sysMsg(room, `👁 ${name} stopped spectating`);
        broadcast(room);
        broadcastLobby();
      }
      return;
    }

    // ── Player leave ──
    const player = room.players.find(p => p.id === sock.id);
    if (!player) return;

    const name         = player.name;
    const wasTheirTurn = ['rolling', 're_ante', 'shootout'].includes(room.state)
      && room.players[room.currentTurnIndex]?.id === sock.id;

    // Refund ante if they leave during ante countdown
    if (room.state === 'ante' && player.antePaid) {
      WalletService.credit(player.wallet, room.ante);
      room.pot = Math.max(0, room.pot - room.ante);
    }

    removePlayer(room, sock.id);

    if (room.players.length === 0) {
      clearRoomTimer(room);
      room.state       = 'lobby';
      room.round       = 0;
      room.pot         = 0;
      room.carryoverPot = 0;
      sysMsg(room, '👋 Room is empty, resetting.');
      broadcast(room);
      broadcastLobby();
      return;
    }

    sysMsg(room, `👋 ${name} left`);

    // Not enough players to continue
    if (room.players.length < 2 && !['lobby', 'results'].includes(room.state)) {
      clearRoomTimer(room);
      room.state = 'lobby';
      sysMsg(room, '⚠️ Not enough players. Game paused.');
      broadcast(room);
      broadcastLobby();
      return;
    }

    // Mid-turn handling
    if (wasTheirTurn) {
      if (room.state === 're_ante') room.state = 'rolling';

      if (room.state === 'rolling') {
        if (room.players.every(p => p.done)) endRound(room);
        else scheduleTurnTimer(room);
      } else if (room.state === 'shootout') {
        const nextIdx = room.players.findIndex(p => p.inShootout && !p.shootoutDone);
        if (nextIdx === -1) resolveShootout(room);
        else {
          room.currentTurnIndex = nextIdx;
          scheduleShootoutTimer(room);
        }
      }
    }

    broadcast(room);
    broadcastLobby();
  }
});

// ─── Bot Player ───────────────────────────────────────────────────────────────────
const BOT_NAMES = ['🤖 Sagan', '🤖 Yuki', '🤖 Dice-san', '🤖 Kenji', '🤖 Miko'];
let botCounter = 0;

function spawnBot(roomId) {
  const Client = require('socket.io-client');
  const botName = BOT_NAMES[botCounter % BOT_NAMES.length];
  botCounter++;
  
  const bot = Client(`http://localhost:${PORT}`, { forceNew: true });
  
  bot.on('connect', () => {
    console.log(`[BOT] ${botName} connecting to ${roomId}`);
    bot.emit('join_room', { name: botName, roomId, spectator: false });
  });

  bot.on('room_state', (state) => {
    const me = state.players.find(p => p.name === botName);
    if (!me) return;

    // Auto-roll when it's our turn
    if (state.state === 'rolling' && !me.done) {
      const myIdx = state.players.findIndex(p => p.name === botName);
      if (myIdx === state.currentTurnIndex) {
        // Random delay 500-1500ms to feel human
        setTimeout(() => bot.emit('roll_dice'), 500 + Math.random() * 1000);
      }
    }
  });

  // Auto-accept re-ante (50% chance)
  bot.on('re_ante_offer', () => {
    setTimeout(() => {
      if (Math.random() > 0.5) bot.emit('re_ante_accept');
      else bot.emit('re_ante_decline');
    }, 500 + Math.random() * 1000);
  });

  // Auto-roll in shootout
  bot.on('shootout_turn', () => {
    setTimeout(() => bot.emit('shootout_roll'), 500 + Math.random() * 1000);
  });

  bot.on('disconnect', () => {
    console.log(`[BOT] ${botName} disconnected`);
  });

  return { bot, name: botName };
}

// API endpoint to add a bot
app.post('/api/bot/add', express.json(), (req, res) => {
  const roomId = req.body.roomId || 'room-100';
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.players.length >= MAX_PLAYERS) return res.status(400).json({ error: 'Room full' });
  
  const botInfo = spawnBot(roomId);
  res.json({ ok: true, botName: botInfo.name, roomId });
});

// ─── Start ────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🎲  Cee-lo server running →  http://localhost:${PORT}`)
);
