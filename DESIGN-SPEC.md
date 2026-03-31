# Cee-Lo Design Spec (from Colin's v1.2 doc)

## Core Vision
- Multiplayer online dice game portal with wagering (real money + play money)
- First game: Cee-Lo (aka 4,5,6 / Strungflowers)
- Monetization: Rake-based

## Game Rules (Custom)
- 4-5-6 = "Strungflowers" — highest roll, instant win
- 1-2-3 = "Dancing Dragon" — lowest roll, auto-out
  - If ALL players roll Dancing Dragon: everyone re-antes, pot doubles
- Trips: higher beats lower (6-6-6 > 5-5-5 etc)
- Point: pair + singleton. Higher point wins. If points tied, higher pair wins (2-2-4 > 1-1-4)
- Any other roll = meaningless, must re-roll
- Re-roll until a recognized combo occurs
- After 7 failed attempts, turn is forfeit

## Re-Ante Feature
- After scoring a point, player can choose to stay OR re-ante for a chance at a better roll
- Only offered once per round
- NOT offered on 4-5-6 or 1-2-3

## Shootout (Ties)
- Tied players enter a shootout
- Additional betting opportunity before each shootout round
- Continues until single winner

## Players & Rooms
- 5 seats per room (min 2 players)
- Users can play multiple rooms with one account
- Rooms sorted by ante/bet amount ($0.25 to $1,000)
- Position matters (seat 1 = best for progressive)
- If player leaves, others move up

## Progressive Pot (TBD)
- Optional side bet equal to room ante
- Triple 3s wins progressive
- Pot stays in room, builds over time

## Rake
- Percentage from total pot after each round
- Percentage from progressive if won
- Algorithms TBD

## Game Flow
1. Login → Lobby → Choose game type (Alley/Tournament/Sit&Go)
2. Choose room by $ amount
3. Enter room, click empty seat to stand
4. Bet clock: 5 seconds to ante
5. Roll clock: 5 seconds per turn (auto-roll if timeout)
6. If disconnected after ante, computer rolls for you
7. Miss 5 rounds = bumped from room

## Visual Design
- 2D backgrounds with 2D VFX overlays
- Multiple environments: Back Alley, Subway, Casino, Bar Room
- Ambient FX: steam, flickering lights (2 per background)
- Street game feel — dice thrown into the alley

## UI Layout (Bottom)
1. Chat window (left)
2. Throw Dice button (center-left)
3. Ante section with "always" checkbox
4. Re-Ante YES/NO buttons
5. Bet amount, Pot total, Wait button, Get Chips button

## HUD (5 player slots across bottom)
- Each slot shows: timer, action tab, username, balance, point result, dice
- States: Throw, Throw Again, Re-Ante, You Win, Empty Seat ("Stand Here")
- Timers shown as countdown circles

## Audio Design
- TBD in doc but needs full sound design

## Branding
- NO Cake branding (placeholder in doc)
- Custom branding TBD
