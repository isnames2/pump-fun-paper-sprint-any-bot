[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/isnames2/pump-fun-paper-sprint-any-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/isnames2/pump-fun-paper-sprint-any-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — Any Bot Can Win

A paper-trading bot for the make.fun competition
https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

It trades on a replay of pump.fun on-chain activity with 10 SOL of
paper funds. No real trading, no network access, no secrets — everything the
bot runs is in this repo.

## Strategy

Small, selective, fast. On every replay batch the bot:

1. Watches newly created bonding curves for a few slots and only buys when
   the coin shows genuine early demand: at least 8 distinct buyers and 10
   trades within its first 5 slots, net inflow of at least 0.5 SOL over the
   last 10 slots, and a runup of +20% to +60% from the create price — proof
   the market is moving, but not so far gone that the entry is the top.
2. Skips anything with rug signs: creator sells, a creator buy larger than
   2.5 SOL, or real reserves outside 0.3–40 SOL.
3. Buys 0.01 SOL per coin (the round-trip floor), capped at 1% of the coin's
   real reserves and at 5 open positions, so a single bad coin can never
   hurt the book.
4. Exits fast: take half at +75%, arm a 15% trailing stop once the position
   is +10% up, hard stop at -15%, exit if the creator sells, and a 120-slot
   time cap. Losers are cut before they can compound; winners are allowed
   to run.

## Files

- `main.ts` — entrypoint: reads the replay on stdin, replies with orders on stdout.
- `strategy.ts` — the strategy (entry filter, position management, exits).
- `vendor/makefun-bot.ts` — the protocol shim from the competition kit,
  copied byte-identical as the kit explicitly allows.

## Local results (dev window, grade-local --driver process)

- Net PnL: **-0.0149 SOL** (34 round trips, 9 wins, max drawdown 0.21%)
- Guardrails: 34 distinct mints (needs 20), drawdown far under the 50% cap
- Top 3 coins made 80% of the gains; net without them is -0.03 SOL
- Stress test (--stress 20): median -0.023 SOL, p10 -0.033, p90 -0.010,
  19 of 20 copies lost money, 1 positive (+0.012 SOL)
- Honest note: no positive edge was demonstrated on dev — every house pilot
  loses on this window too (momentum -9.5 SOL, reversion -4.0 SOL, sniper
  -0.48 SOL) — and this bot loses the least of all of them by trading only
  the highest-conviction early-demand coins at the minimum stake. The final
  window is different coins, so it was submitted as the least-bad strategy
  found; the entry was free.

## License

MIT — see `LICENSE`.
