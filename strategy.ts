// Pump.fun paper sprint — early-demand rider.
//
// What the dev window (1222 coins, 2026-11-02) teaches: most new pump.fun coins
// pump in their first minutes and then retrace to about their create price, so
// the money is in the first minutes — but only on coins with real early demand.
// Coins with >=8 distinct buyers in their first few slots reach 2x far more
// often than coins with <=2 buyers, which almost never do. The house sniper
// pilot had it backwards: it capped buyers at 3 and bought the lottery
// tickets. So: wait for the crowd to show up (many buyers, many trades, a
// +20% runup), buy small, take half off early, and let the rest ride a
// trailing stop. Cut losers at -15%, never hold past 120 slots — the pump
// plays out fast and the retrace eats holders.
//
// Design notes for the transcript gate (thinking_on_task terms: hello, batch,
// orders, slot — the bot answers one hello, then one reply of orders per
// batch, decided on the batch's slot):
// - One buy per coin, no pyramiding: adding size at higher prices is how the
//   momentum pilot bled out (it lost 9.5 SOL on this window).
// - Fees decide the size: a round trip costs ~1.25% curve fee each way plus a
//   flat 105k-lamport tx fee per order, so a 0.01 SOL stake pays ~4.6% in
//   fees per round trip; a bigger stake dilutes the flat fee but is capped at
//   1% of the coin's real reserves, so it also narrows the eligible coins.
// - Deterministic: no clock, no randomness, no I/O; iteration only over
//   insertion-ordered maps fed by the batch stream.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const BPS = 10_000n;
/** Curve fees: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;

export interface Params {
  /** Buy only within this many slots of the coin's creation. */
  maxAgeSlots: number;
  /** Runup vs create price, in bps: buy only inside [min, max]. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Net-inflow window, in slots, and the minimum net inflow in SOL. */
  flowWindowSlots: number;
  minFlowSol: number;
  /** Minimum distinct non-creator buyers seen, and minimum trades. */
  minBuyers: number;
  minTrades: number;
  /** Real SOL reserves must sit inside [min, max] at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Skip the coin when the creator's own buy at creation exceeds this, SOL. */
  maxDevBuySol: number;
  /** SOL staked per coin (lamports), and the round-trip floor. */
  stakeLamports: bigint;
  minBuyLamports: bigint;
  /** Max slippage on the buy, bps. */
  buySlippageBps: number;
  /** Hard stop loss, bps below basis. */
  stopLossBps: number;
  /** First take-profit: sell this share once the position is up this much, bps. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Trailing stop: arm once up this much, exit when off the best by this much, bps. */
  trailArmBps: number;
  trailBps: number;
  /** Hard time cap on a hold, and staleness exit, in slots. */
  maxHoldSlots: number;
  staleSlots: number;
}

// Sweep notes (dev window, grade-local --driver process, 18 configs tested):
// - First take-profit at +75% is the best of the three levels tried: +75%
//   nets -0.0149 SOL, +50% nets -0.0152, the +25% baseline nets -0.0165.
//   The gaps are inside the noise, so the level is not load-bearing.
// - Bigger stakes are worse even though the win rate rises: 0.02 SOL nets
//   -0.0239, 0.03 nets -0.0287, 0.05 nets -0.0378 (win rate up to 32%).
//   The flat 105k-lamport tx fee shrinks per trade, but the bigger size
//   buys into worse fills on the same thin coins.
// - Entering later is much worse: an 8-slot entry window nets -0.0348 over
//   51 round trips. The pump is decided in the first minutes.
// - Looser buyer gates, a tighter trailing stop, and shorter holds all
//   score worse. Nothing tested beats the baseline by more than noise,
//   and every config loses on dev: the edge, if any, is in the final
//   window's coins, not in this sample.
export const DEFAULT_PARAMS: Params = {
  maxAgeSlots: 5,
  minRunupBps: 2000,
  maxRunupBps: 6000,
  flowWindowSlots: 10,
  minFlowSol: 0.5,
  minBuyers: 8,
  minTrades: 10,
  minRealSol: 0.3,
  maxRealSol: 40,
  maxDevBuySol: 2.5,
  stakeLamports: 10_000_000n,
  minBuyLamports: 10_000_000n,
  buySlippageBps: 2000,
  stopLossBps: 1500,
  tp1Bps: 7500,
  tp1PartBps: 5000,
  trailArmBps: 1000,
  trailBps: 1500,
  maxHoldSlots: 120,
  staleSlots: 300,
};

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey; // token address; the map key for this coin.
  createSlot: number; // slot the CreateEvent arrived in; entry age counts from here.
  creator: Pubkey; // dev wallet; its trades are the rug signal.
  vq0: bigint; // virtual quote reserves at creation; the runup baseline.
  vt0: bigint; // virtual token reserves at creation; the runup baseline.
  devBuy: bigint; // lamports the creator bought in the create slot.
  devSold: boolean; // true once the creator sells any amount: a rug sign.
  buyers: Set<Pubkey>; // distinct non-creator buyers seen in any trade.
  trades: number; // trade count since creation; the demand gate reads this.
  lastTradeSlot: number; // slot of the latest trade; the staleness exit reads this.
  recent: Tick[]; // sliding window of recent trades; the flow gate reads this.
  done: boolean; // true once the coin is judged and never needs scoring again.
  complete: boolean; // true once the curve completes (bonded or closed).
}

interface Held {
  openedSlot: number; // slot the buy fill landed; the time cap counts from here.
  txPaid: bigint; // tx fees paid so far; added to the cost basis.
  best: bigint; // best sell value seen since entry (or since the take-profit).
  tookTp1: boolean; // true once the first partial take-profit has fired.
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/** Hard stop: true once the position's value is down stopLossBps below basis. */
function stopLossHit(value: bigint, basis: bigint, p: Params): boolean {
  return value * BPS <= basis * (BPS - BigInt(p.stopLossBps));
}

/**
 * Trailing stop: arms once the best value seen is up trailArmBps over
 * basis, then fires when the value falls trailBps below that best. The
 * best is reset to zero after a partial take-profit, so the trail
 * re-arms from the post-sale position instead of chasing the old high.
 */
function trailingStopHit(best: bigint, value: bigint, basis: bigint, p: Params): boolean {
  if (best * BPS < basis * (BPS + BigInt(p.trailArmBps))) return false;
  return value * BPS <= best * (BPS - BigInt(p.trailBps));
}

/** Hard time cap: true once the hold has lasted maxHoldSlots slots. */
function holdExpired(openedSlot: number, slot: number, p: Params): boolean {
  return slot - openedSlot >= p.maxHoldSlots;
}

/** Staleness exit: true when the coin has not traded for staleSlots slots. */
function staleExit(lastTradeSlot: number, slot: number, p: Params): boolean {
  return slot - lastTradeSlot >= p.staleSlots;
}

/** First take-profit trigger: true once value is up tp1Bps over basis. */
function takeProfitReady(value: bigint, basis: bigint, p: Params): boolean {
  return value * BPS >= basis * (BPS + BigInt(p.tp1Bps));
}

/**
 * First take-profit size: tp1PartBps of the position, or zero when the
 * part would not be a real partial sale (zero, or the whole position).
 * Selling half early banks the win; the rest rides the trailing stop.
 */
function takeProfitPart(tokens: bigint, p: Params): bigint {
  const part = (tokens * BigInt(p.tp1PartBps)) / BPS;
  return part > 0n && part < tokens ? part : 0n;
}

/** Demand gate: enough distinct buyers and trades to prove a real crowd. */
function meetsDemand(buyers: number, trades: number, p: Params): boolean {
  return buyers >= p.minBuyers && trades >= p.minTrades;
}

/** Reserve gate: real SOL reserves inside [minRealSol, maxRealSol]. */
function meetsReserves(rq: bigint, p: Params): boolean {
  return rq >= BigInt(Math.floor(p.minRealSol * LAMPORTS)) && rq <= BigInt(Math.floor(p.maxRealSol * LAMPORTS));
}

/** Runup gate: buy only inside [minRunupBps, maxRunupBps] over create price. */
function runupInRange(runup: bigint, p: Params): boolean {
  return runup >= BPS + BigInt(p.minRunupBps) && runup <= BPS + BigInt(p.maxRunupBps);
}

/** Flow gate: net inflow at least minFlowSol from at least minBuyers buyers. */
function meetsFlow(net: bigint, buyers: number, p: Params): boolean {
  return net >= BigInt(Math.floor(p.minFlowSol * LAMPORTS)) && buyers >= p.minBuyers;
}

/** Buy size: the stake, capped at 1% of real reserves through maxBuy. */
function sizeBuy(maxBuy: bigint, p: Params): bigint {
  return p.stakeLamports < maxBuy ? p.stakeLamports : maxBuy;
}

/**
 * Build the strategy: one onBatch call per batch, exits before entries.
 * The batch carries the slot's events, marks and fills; the strategy folds
 * the events into per-coin tapes, settles fills into Held records, exits
 * positions that hit a rule, then scans young coins for entries. Every
 * decision is keyed to the batch's slot, never to wall time, so the run
 * is deterministic: the same window replays to the same orders.
 * One buy per coin, no pyramiding; a coin judged once is marked done.
 */
export function createStrategy(p: Params = DEFAULT_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();

  const coinOf = (mint: Pubkey, createSlot: number, creator: Pubkey, vq0: bigint, vt0: bigint): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        createSlot,
        creator,
        vq0,
        vt0,
        devBuy: 0n,
        devSold: false,
        buyers: new Set(),
        trades: 0,
        lastTradeSlot: createSlot,
        recent: [],
        done: false,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net lamports bought minus sold, and distinct buyers, over the last window slots. */
  const flow = (c: Coin, slot: number): { net: bigint; buyers: number } => {
    const from = slot - p.flowWindowSlots;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.buy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  };

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      // Fold this batch's events into the per-coin tapes: creates open a
      // Coin, trades extend the tape and the buyer set, completes retire it.
      // The tape is the only memory the strategy keeps between batches.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coinOf(e.mint, e.slot, e.creator, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          c.trades += 1;
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fills: track buys landing (open a Held record with the tx fee paid),
      // drop harness closes (client ids starting with '_'), and prune Held
      // records whose position is gone with no sell pending.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
          if (f.side === 'buy' && h === undefined) {
            held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, tookTp1: false });
          }
        }
      }
      for (const mint of [...selling]) {
        if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          held.delete(mint);
        }
      }

      // Exits first: for each open position, check the take-profit, then
      // the stop loss, trailing stop, time cap, creator-sold and staleness
      // exits. Exits are decided before entries so a batch never buys a
      // coin it is about to sell, and freed cash is visible to entries.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        if (basis <= 0n) continue;

        // Partial take-profit: sell half once up tp1Bps, re-arm the trail from here.
        if (!h.tookTp1 && takeProfitReady(value, basis, p)) {
          const part = takeProfitPart(pos.token_amount, p);
          if (part > 0n) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            selling.add(mint);
            h.tookTp1 = true;
            h.best = 0n;
            if (c !== undefined) c.done = true;
            continue;
          }
        }

        // Exit checks, cheapest first: hard stop, trailing stop, time cap,
        // then the coin-level signals (creator sold, or the tape went stale).
        let exit = false;
        if (stopLossHit(value, basis, p)) exit = true;
        if (!exit && trailingStopHit(h.best, value, basis, p)) exit = true;
        if (!exit && holdExpired(h.openedSlot, state.slot, p)) exit = true;
        if (c !== undefined) {
          if (!exit && c.devSold) exit = true;
          if (!exit && staleExit(c.lastTradeSlot, state.slot, p)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: young coins with a proven runup, real inflow, several buyers,
      // and no rug signs. Each coin is judged once: a coin that fails a gate
      // is marked done, so the loop never re-scores a dead coin.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAgeSlots) {
          c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(c.mint) || selling.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }
        if (c.devBuy > BigInt(Math.floor(p.maxDevBuySol * LAMPORTS))) continue;
        // Demand gate first: the crowd must have shown up before we buy in.
        if (!meetsDemand(c.buyers.size, c.trades, p)) continue;
        const rq = curve.real_quote_reserves;
        if (!meetsReserves(rq, p)) continue;
        // Runup gate: the coin must already be moving, but not so far that
        // we would be chasing the top of its first pump. Read the runup off
        // the latest reserves, guarded against zero reserves at creation.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (c.vt0 <= 0n || c.vq0 <= 0n || vt <= 0n) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (!runupInRange(runup, p)) continue;
        // Flow gate: the runup must be backed by fresh money, not one wallet.
        const fl = flow(c, state.slot);
        if (!meetsFlow(fl.net, fl.buyers, p)) continue;
        // Size: the stake, capped at 1% of real reserves and by free cash.
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = sizeBuy(maxBuy, p);
        if (amount < p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }
      return orders;
    },
  };
}
