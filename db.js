const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'ceelo.db'));

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nickname TEXT UNIQUE NOT NULL,
    email_verified INTEGER DEFAULT 0,
    verify_token TEXT,
    verify_token_expires INTEGER,
    balance INTEGER DEFAULT 10000,
    total_won INTEGER DEFAULT 0,
    total_lost INTEGER DEFAULT 0,
    total_rake INTEGER DEFAULT 0,
    rebuys INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    last_login INTEGER
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    room_id TEXT,
    round INTEGER,
    note TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(player_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS rake_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    room_name TEXT NOT NULL,
    round INTEGER NOT NULL,
    pot INTEGER NOT NULL,
    rake_amount INTEGER NOT NULL,
    player_count INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  insertPlayer: db.prepare(`
    INSERT INTO players (account_id, email, password_hash, nickname, verify_token, verify_token_expires)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getByEmail:      db.prepare(`SELECT * FROM players WHERE email = ?`),
  getByNickname:   db.prepare(`SELECT * FROM players WHERE LOWER(nickname) = LOWER(?)`),
  getById:         db.prepare(`SELECT * FROM players WHERE id = ?`),
  getByAccountId:  db.prepare(`SELECT * FROM players WHERE account_id = ?`),
  getByToken:      db.prepare(`SELECT * FROM players WHERE verify_token = ?`),
  setVerified:     db.prepare(`UPDATE players SET email_verified = 1, verify_token = NULL, verify_token_expires = NULL WHERE id = ?`),
  updateLastLogin: db.prepare(`UPDATE players SET last_login = strftime('%s','now') WHERE id = ?`),
  getAllPlayers:    db.prepare(`SELECT * FROM players ORDER BY created_at DESC`),
  insertTx: db.prepare(`
    INSERT INTO transactions (player_id, account_id, type, amount, balance_after, room_id, round, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getTxByPlayer: db.prepare(`SELECT * FROM transactions WHERE player_id = ? ORDER BY created_at DESC LIMIT ?`),
  getAllTx:       db.prepare(`SELECT t.*, p.nickname FROM transactions t LEFT JOIN players p ON t.player_id = p.id ORDER BY t.created_at DESC LIMIT ?`),
  insertRake:    db.prepare(`INSERT INTO rake_log (room_id, room_name, round, pot, rake_amount, player_count) VALUES (?, ?, ?, ?, ?, ?)`),
  totalRake:     db.prepare(`SELECT COALESCE(SUM(rake_amount),0) as total FROM rake_log`),
  rakeToday:     db.prepare(`SELECT COALESCE(SUM(rake_amount),0) as total FROM rake_log WHERE created_at >= strftime('%s','now','-1 day')`),
  rakeWeek:      db.prepare(`SELECT COALESCE(SUM(rake_amount),0) as total FROM rake_log WHERE created_at >= strftime('%s','now','-7 days')`),
  rakeMonth:     db.prepare(`SELECT COALESCE(SUM(rake_amount),0) as total FROM rake_log WHERE created_at >= strftime('%s','now','-30 days')`),
  rakeByRoom:    db.prepare(`SELECT room_name, COALESCE(SUM(rake_amount),0) as total, COUNT(*) as rounds FROM rake_log GROUP BY room_id ORDER BY total DESC`),
  allRakeLog:    db.prepare(`SELECT * FROM rake_log ORDER BY created_at DESC LIMIT 500`),
  totalBalance:  db.prepare(`SELECT COALESCE(SUM(balance),0) as total FROM players`),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function padAccountId(id) {
  return '#' + String(id).padStart(6, '0');
}

// ─── Exported functions ───────────────────────────────────────────────────────

function createPlayer(email, passwordHash, nickname, verifyToken, verifyExpires) {
  // Insert with placeholder account_id, then update with real one based on rowid
  const result = stmts.insertPlayer.run(
    'TEMP', email, passwordHash, nickname, verifyToken, verifyExpires
  );
  const realAccountId = padAccountId(result.lastInsertRowid);
  db.prepare(`UPDATE players SET account_id = ? WHERE id = ?`)
    .run(realAccountId, result.lastInsertRowid);
  return db.prepare(`SELECT * FROM players WHERE id = ?`).get(result.lastInsertRowid);
}

function getPlayerByEmail(email)           { return stmts.getByEmail.get(email); }
function getPlayerByNickname(nickname)     { return stmts.getByNickname.get(nickname); }
function getPlayerById(id)                 { return stmts.getById.get(id); }
function getPlayerByAccountId(accountId)   { return stmts.getByAccountId.get(accountId); }
function getPlayerByToken(token)           { return stmts.getByToken.get(token); }
function setEmailVerified(playerId)        { stmts.setVerified.run(playerId); }
function updateLastLogin(playerId)         { stmts.updateLastLogin.run(playerId); }
function getAllPlayers()                    { return stmts.getAllPlayers.all(); }

function debitBalance(playerId, amountCents, type, roomId, round, note) {
  const player = stmts.getById.get(playerId);
  if (!player || player.balance < amountCents) return false;
  const newBalance = player.balance - amountCents;
  db.prepare(`UPDATE players SET balance = ?, total_lost = total_lost + ? WHERE id = ?`)
    .run(newBalance, amountCents, playerId);
  stmts.insertTx.run(playerId, player.account_id, type, amountCents, newBalance, roomId || null, round || null, note || null);
  return newBalance;
}

function creditBalance(playerId, amountCents, type, roomId, round, note) {
  const player = stmts.getById.get(playerId);
  if (!player) return false;
  const newBalance = player.balance + amountCents;
  db.prepare(`UPDATE players SET balance = ?, total_won = total_won + ? WHERE id = ?`)
    .run(newBalance, amountCents, playerId);
  stmts.insertTx.run(playerId, player.account_id, type, amountCents, newBalance, roomId || null, round || null, note || null);
  return newBalance;
}

function adminAdjustBalance(playerId, amountCents, isCredit, note) {
  if (isCredit) {
    return creditBalance(playerId, amountCents, 'manual_credit', null, null, note);
  } else {
    return debitBalance(playerId, amountCents, 'manual_debit', null, null, note);
  }
}

function getTransactions(playerId, limit = 100) {
  return stmts.getTxByPlayer.all(playerId, limit);
}

function getAllTransactions(limit = 200) {
  return stmts.getAllTx.all(limit);
}

function logRake(roomId, roomName, round, pot, rakeAmount, playerCount) {
  stmts.insertRake.run(roomId, roomName, round, pot, rakeAmount, playerCount);
  // Also increment total_rake on all players in the round (approximate — just increment house)
}

function getRakeSummary() {
  return {
    total:      stmts.totalRake.get().total,
    today:      stmts.rakeToday.get().total,
    week:       stmts.rakeWeek.get().total,
    month:      stmts.rakeMonth.get().total,
    byRoom:     stmts.rakeByRoom.all(),
    log:        stmts.allRakeLog.all(),
    totalBalance: stmts.totalBalance.get().total,
    totalPlayers: db.prepare(`SELECT COUNT(*) as count FROM players`).get().count,
  };
}

module.exports = {
  createPlayer,
  getPlayerByEmail,
  getPlayerByNickname,
  getPlayerById,
  getPlayerByAccountId,
  getPlayerByToken,
  setEmailVerified,
  updateLastLogin,
  getAllPlayers,
  debitBalance,
  creditBalance,
  adminAdjustBalance,
  getTransactions,
  getAllTransactions,
  logRake,
  getRakeSummary,
};
