// Pump.fun paper sprint — early-demand rider (see strategy.ts for the idea).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
// Final tune (dev window, grade-local --driver process): net -0.0149 SOL over
// 34 round trips / 34 coins, max drawdown 0.21%, guardrails met.
//
// How a run flows, one batch at a time:
// - hello: the harness hands the bot its caps (max orders per batch, max
//   open positions) and the fee schedule; the bot answers with no orders.
// - batch: each batch carries the slot's events, marks and fills. The
//   strategy folds the events into per-coin tapes, then answers with its
//   orders for that slot — exits first, entries second.
// - orders: buys and sells are priced off the batch's marks; the harness
//   fills them against the curve and reports fills in the next batch.
// - slot: every decision is keyed to the batch's slot, never to wall time,
//   so the run is deterministic and replays byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
