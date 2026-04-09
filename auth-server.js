const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const nodemailer = require('nodemailer');
const db       = require('./db');

const app = express();
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const JWT_SECRET   = process.env.JWT_SECRET   || 'ceelo-dev-secret';
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN  || 'ceelo-admin-2024';
const APP_URL      = process.env.APP_URL      || 'http://187.124.64.233:4000';

// ─── Email ────────────────────────────────────────────────────────────────────
function getMailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendVerifyEmail(email, token) {
  const link = `${APP_URL}/api/auth/verify-email?token=${token}`;
  const mailer = getMailer();
  if (!mailer) {
    console.log(`\n📧 [EMAIL NOT CONFIGURED] Verify link for ${email}:\n   ${link}\n`);
    return;
  }
  await mailer.sendMail({
    from:    process.env.SMTP_FROM || 'CEE-LO <noreply@ceelo.game>',
    to:      email,
    subject: '🎲 Verify your CEE-LO account',
    html: `
      <div style="background:#050302;color:#e8dcc8;font-family:sans-serif;padding:32px;border-radius:12px;max-width:480px;">
        <h2 style="color:#f5c842;font-family:serif;">🎲 CEE-LO</h2>
        <p>Thanks for signing up! Click below to verify your email and start playing.</p>
        <a href="${link}" style="display:inline-block;margin:20px 0;background:#f5c842;color:#050302;padding:12px 28px;border-radius:8px;font-weight:bold;text-decoration:none;">Verify Email</a>
        <p style="color:#9a8a6a;font-size:0.85rem;">Link expires in 24 hours. If you didn't sign up, ignore this email.</p>
      </div>
    `,
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.player = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function validateNickname(n) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(n);
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nickname } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Valid email required.' });
    if (!password || password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!nickname || !validateNickname(nickname))
      return res.status(400).json({ error: 'Nickname must be 3–20 characters (letters, numbers, underscore).' });

    if (db.getPlayerByEmail(email.toLowerCase()))
      return res.status(409).json({ error: 'Email already registered.' });
    if (db.getPlayerByNickname(nickname))
      return res.status(409).json({ error: 'Nickname already taken.' });

    const passwordHash  = await bcrypt.hash(password, 10);
    const verifyToken   = crypto.randomBytes(32).toString('hex');
    const verifyExpires = Math.floor(Date.now() / 1000) + 86400; // 24h

    db.createPlayer(email.toLowerCase(), passwordHash, nickname, verifyToken, verifyExpires);
    await sendVerifyEmail(email.toLowerCase(), verifyToken);

    res.json({ ok: true, message: 'Account created! Check your email to verify your account.' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// GET /api/auth/verify-email?token=xxx  (link from email)
app.get('/api/auth/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');
  const player = db.getPlayerByToken(token);
  if (!player) return res.status(400).send('Invalid or expired verification link.');
  if (player.verify_token_expires < Math.floor(Date.now() / 1000))
    return res.status(400).send('Verification link expired. Please register again.');
  db.setEmailVerified(player.id);
  res.send(`
    <html><head><meta http-equiv="refresh" content="3;url=${APP_URL}"></head>
    <body style="background:#050302;color:#f5c842;font-family:sans-serif;text-align:center;padding:60px;">
      <h2>🎲 Email Verified!</h2>
      <p style="color:#e8dcc8;">Your account is ready. Redirecting to the game...</p>
    </body></html>
  `);
});

// POST /api/auth/verify-email  (from body — alternate)
app.post('/api/auth/verify-email', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token.' });
  const player = db.getPlayerByToken(token);
  if (!player) return res.status(400).json({ error: 'Invalid or expired token.' });
  if (player.verify_token_expires < Math.floor(Date.now() / 1000))
    return res.status(400).json({ error: 'Token expired.' });
  db.setEmailVerified(player.id);
  res.json({ ok: true, message: 'Email verified! You can now log in.' });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const player = db.getPlayerByEmail(email.toLowerCase());
    if (!player) return res.status(401).json({ error: 'Invalid email or password.' });

    const match = await bcrypt.compare(password, player.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

    if (!player.email_verified)
      return res.status(403).json({ error: 'Please verify your email before logging in.', unverified: true });

    db.updateLastLogin(player.id);

    const token = jwt.sign(
      { playerId: player.id, accountId: player.account_id, nickname: player.nickname },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      ok: true,
      token,
      player: {
        accountId: player.account_id,
        nickname:  player.nickname,
        balance:   (player.balance / 100).toFixed(2),
        balanceCents: player.balance,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  const player = db.getPlayerById(req.player.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  res.json({
    ok: true,
    player: {
      accountId: player.account_id,
      nickname:  player.nickname,
      balance:   (player.balance / 100).toFixed(2),
      balanceCents: player.balance,
      totalWon:  (player.total_won / 100).toFixed(2),
      totalLost: (player.total_lost / 100).toFixed(2),
      rebuys:    player.rebuys,
    },
  });
});

// POST /api/auth/check-nickname
app.post('/api/auth/check-nickname', (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !validateNickname(nickname))
    return res.json({ available: false, reason: 'Invalid format' });
  const existing = db.getPlayerByNickname(nickname);
  res.json({ available: !existing });
});

// POST /api/auth/check-email
app.post('/api/auth/check-email', (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ available: false });
  const existing = db.getPlayerByEmail(email.toLowerCase());
  res.json({ available: !existing });
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

// POST /api/admin/verify-token
app.post('/api/admin/verify-token', (req, res) => {
  const { token } = req.body;
  if (token === ADMIN_TOKEN) return res.json({ ok: true });
  res.status(403).json({ error: 'Invalid admin token.' });
});

// GET /api/admin/players
app.get('/api/admin/players', requireAdmin, (req, res) => {
  const players = db.getAllPlayers().map(p => ({
    id:         p.id,
    accountId:  p.account_id,
    nickname:   p.nickname,
    email:      p.email,
    balance:    (p.balance / 100).toFixed(2),
    totalWon:   (p.total_won / 100).toFixed(2),
    totalLost:  (p.total_lost / 100).toFixed(2),
    rebuys:     p.rebuys,
    verified:   !!p.email_verified,
    createdAt:  p.created_at,
    lastLogin:  p.last_login,
  }));
  res.json({ ok: true, players });
});

// GET /api/admin/players/:accountId
app.get('/api/admin/players/:accountId', requireAdmin, (req, res) => {
  const player = db.getPlayerByAccountId(req.params.accountId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const txs = db.getTransactions(player.id, 50);
  res.json({
    ok: true,
    player: {
      id:         player.id,
      accountId:  player.account_id,
      nickname:   player.nickname,
      email:      player.email,
      balance:    (player.balance / 100).toFixed(2),
      totalWon:   (player.total_won / 100).toFixed(2),
      totalLost:  (player.total_lost / 100).toFixed(2),
      rebuys:     player.rebuys,
      verified:   !!player.email_verified,
      createdAt:  player.created_at,
      lastLogin:  player.last_login,
    },
    transactions: txs.map(t => ({
      id:          t.id,
      type:        t.type,
      amount:      (t.amount / 100).toFixed(2),
      balanceAfter:(t.balance_after / 100).toFixed(2),
      roomId:      t.room_id,
      round:       t.round,
      note:        t.note,
      createdAt:   t.created_at,
    })),
  });
});

// GET /api/admin/transactions
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const txs = db.getAllTransactions(200);
  res.json({
    ok: true,
    transactions: txs.map(t => ({
      id:           t.id,
      accountId:    t.account_id,
      nickname:     t.nickname || '—',
      type:         t.type,
      amount:       (t.amount / 100).toFixed(2),
      balanceAfter: (t.balance_after / 100).toFixed(2),
      roomId:       t.room_id,
      round:        t.round,
      note:         t.note,
      createdAt:    t.created_at,
    })),
  });
});

// POST /api/admin/players/:accountId/adjust
app.post('/api/admin/players/:accountId/adjust', requireAdmin, (req, res) => {
  const player = db.getPlayerByAccountId(req.params.accountId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });

  const { amount, isCredit, note } = req.body;
  const amountCents = Math.round(parseFloat(amount) * 100);
  if (!amountCents || amountCents <= 0) return res.status(400).json({ error: 'Invalid amount.' });

  const newBalance = db.adminAdjustBalance(player.id, amountCents, isCredit, note || 'Admin adjustment');
  if (newBalance === false) return res.status(400).json({ error: 'Insufficient balance for debit.' });

  res.json({ ok: true, newBalance: (newBalance / 100).toFixed(2) });
});

// GET /api/admin/rake
app.get('/api/admin/rake', requireAdmin, (req, res) => {
  const summary = db.getRakeSummary();
  res.json({
    ok: true,
    total:        (summary.total / 100).toFixed(2),
    today:        (summary.today / 100).toFixed(2),
    week:         (summary.week / 100).toFixed(2),
    month:        (summary.month / 100).toFixed(2),
    byRoom:       summary.byRoom.map(r => ({ ...r, total: (r.total / 100).toFixed(2) })),
    log:          summary.log.map(r => ({
      ...r,
      pot:        (r.pot / 100).toFixed(2),
      rake_amount:(r.rake_amount / 100).toFixed(2),
    })),
    totalBalance: (summary.totalBalance / 100).toFixed(2),
    totalPlayers: summary.totalPlayers,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.AUTH_PORT || 4001;
app.listen(PORT, () => console.log(`🔐  Auth server running → http://localhost:${PORT}`));
