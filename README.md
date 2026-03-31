# 🎲 CEE-LO — Multiplayer Street Dice

A fully playable multiplayer Cee-lo dice game built with **Node.js + Socket.io**.
Dark theme, street-game vibes, mobile-friendly.

## Quick Start

```bash
cd ceelo-game
npm install
npm start
```

Then open **http://localhost:3000** in your browser (or on your local network).

---

## Rules — Classic Cee-lo

Each player rolls 3 dice per turn (up to 3 attempts if no valid combo):

| Roll          | Result                              |
|---------------|-------------------------------------|
| **4-5-6**     | 🎉 Instant Win — best possible      |
| **1-2-3**     | 💀 Instant Loss — worst possible    |
| **Trips**     | 🔥 Three of a kind (6-6-6 > 5-5-5 … > 1-1-1) |
| **Pair + N**  | 🎯 Your "point" is N (higher point wins) |
| **No combo**  | Re-roll — up to 3 attempts, then bust |

**Winner** = highest score each round.
**Ties** = shared win if multiple players have identical scores.

---

## How to Play

1. **Create a room** → share the 4-letter room code with friends
2. Friends **join** using the same code
3. **Host** starts the game (minimum 2 players, max 6)
4. Players roll **in turn** — animated dice, results visible to all
5. After everyone rolls, the **winner is announced**
6. Host can start the **next round**

---

## Tech Stack

- **Backend:** Node.js + Express + Socket.io
- **Frontend:** Single HTML file (`public/index.html`) — embedded CSS + JS
- **No database** — all state in memory (rooms reset on server restart)
- **Fonts:** Oswald + Inter via Google Fonts

## Ports & Config

| Env var | Default | Description          |
|---------|---------|----------------------|
| `PORT`  | `3000`  | HTTP server port     |

```bash
PORT=8080 npm start
```

## Project Structure

```
ceelo-game/
├── server.js          # Game server + socket logic
├── package.json
├── README.md
└── public/
    └── index.html     # Full frontend (CSS + JS embedded)
```
