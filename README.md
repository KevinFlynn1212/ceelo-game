# 骰子 · CEE-LO · 京都
### Multiplayer Street Dice — Kyoto Alley Edition

A visually atmospheric, fully multiplayer Cee-lo dice game set in a dark lantern-lit alley in old Kyoto.

## Features

### 🎨 Visual Theme
- **Kyoto night alley** atmosphere — deep blacks, warm amber lantern glows, gold accents
- **Animated background canvas** — swaying lantern glow effects, drifting mist, firefly sparks
- **3D CSS dice** — realistic ivory dice with proper pip/dot patterns, tumble animation on roll, bounce on landing
- **Cinzel Decorative** font for the dramatic title, atmospheric typography throughout

### 🐉 Dragon Celebration (4-5-6)
- Rolling 4-5-6 triggers an **epic dragon animation** — 🐉 flies across the screen
- Gold & fire **particle trail** behind the dragon using canvas
- Screen flash and dramatic glow effects
- **3–4 second celebration** then fades out

### 🔊 Sound Effects (Web Audio API — no external files)
All sounds are synthesised with oscillators and noise generators:
- Dice rattle/shaking when rolling
- Thud when dice land
- Win ascending arpeggio
- Lose descending sad tone
- Epic 4-5-6 dragon fanfare
- Chat message ping
- Player join chime
- 🔊/🔇 **Mute button** (floating)

### 💰 Play Money Betting System
- Every player starts with **金10,000** (kin coins)
- **Ante** auto-deducted at round start (host configurable, default 金100)
- **Raise** before your first roll — optional, adds to the pot
  - Quick chips: +100, +500, +1K, +2.5K
- **Winner takes the pot** (ties split evenly)
- Balances shown on scoreboard and lobby
- **Rebuy** back to 金10,000 when you run out
- `WalletService` abstraction — designed to swap to a real-money backend

### 💬 In-Game Chat
- Real-time chat via Socket.io (always open)
- Player names colour-coded consistently
- **System messages** for all game events (joins, rolls, wins, raises)
- Auto-scroll, emoji support, max 200 chars per message
- **Collapsible drawer on mobile** — chat toggle FAB with unread badge

### 👁 Spectator Mode
- Join any room as a spectator (even mid-game)
- See all rolls, balances, and chat in real time
- Spectators can chat but cannot roll or bet
- Spectator count shown in room and scoreboard

### 📱 Mobile UI
- Fully responsive — great on phones
- Touch-friendly large tap targets
- Dice area front and center on small screens
- Chat slides in from the right as a drawer
- Backdrop click to close chat drawer

## Tech Stack
- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Single `public/index.html` (embedded CSS + JS, no build step)
- All visuals: pure CSS + Canvas (no image dependencies)
- All audio: Web Audio API synthesis (no external audio files)

## Running

```bash
npm install
npm start
# → http://localhost:3000
```

For development with auto-restart:
```bash
npm run dev
```

## Game Rules

| Roll    | Result                                    |
|---------|-------------------------------------------|
| 4-5-6   | 🐉 Dragon Roll — instant win (score 1000) |
| 1-2-3   | 💀 Instant loss (score -1)                |
| Trips   | 🔥 Three of a kind — higher is better    |
| Pair+N  | 🎯 Your point — odd die value            |
| Nothing | 🎲 Re-roll — up to 3 times, then bust    |

- Each player rolls up to 3 times per round until they get a valid combo or bust
- Highest score wins the pot
- Ties split the pot equally
- Players take turns in join order

## Architecture Notes

### Wallet Abstraction
Money logic lives entirely in `WalletService` in `server.js`. To connect a real database or payment backend, replace the in-memory wallet with async calls to your payment service — the game logic calls only `debit`, `credit`, `rebuy`, and `canAfford`.

### State
All game state is server-authoritative. The client only renders; it never modifies state directly.
