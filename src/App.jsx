// ============================================================
// ALPHA BOT v34.EL — Emergency Lock: TREND Strategy Disabled
// BTC Futures Trading System — PAPER / ANALYTICS ONLY
// Real execution requires Node.js backend + Delta Exchange API
// ============================================================
// v34.EL Changes (Emergency Strategy Lock):
//  EL1. Strategy enable/disable toggles (TREND/RANGE/BREAKOUT/REVERSAL)
//       Default: TREND=OFF, RANGE=ON, BREAKOUT=ON, REVERSAL=ON
//       Disabled strategies become WATCH-only; signals logged but not traded
//       Persisted to localStorage (LS_STRATEGY_TOGGLES)
//  EL2. Strategy performance auto-block: ≥20 trades + WR < 30% → blocked
//       Block reason: STRATEGY_POOR_PERFORMANCE
//  EL3. Session performance auto-block: ≥10 trades + WR < 30% → blocked
//       Block reason: SESSION_POOR_PERFORMANCE
//  EL4. Strict TREND entry: SMC bias aligned + BOS aligned + EMA21 distance
//       ≤ 1.5% + last closed candle direction + no opposite CHoCH
//       Block reason: STRICT_TREND_ENTRY_FAIL
//  EL5. TREND loss cooldown: 10 candles after any TREND loss in same direction
//       Block reason: TREND_LOSS_COOLDOWN
//  EL6. Auto-block status panel in Settings tab (read-only, live computed)
// ============================================================
// v34 Changes (Profitability Pass):
//  P1. Net Profitability Filter: blocks trades where expectedNetReward ≤ 0 → NEGATIVE_NET_EXPECTANCY
//  P2. Minimum Net RR Filter: netRR (after fees) must be ≥ 1.2 → LOW_NET_RR
//  P3. TP Distance Guard: grossReward must be ≥ 3× round-trip fee (hard requirement)
//  P4. Overtrading Cooldown: max 1 active TREND LONG + 1 active TREND SHORT; 5-candle cooldown
//  P5. Duplicate Setup Detection: same strategy+direction+regime within recent candles → downgrade/WATCH
//  P6. Strategy Distribution Audit: tracks TREND/RANGE/BREAKOUT/REVERSAL separately; warns on imbalance
//  P7. Confidence Recalibration: negative expectancy, duplicate, poor session, fee-heavy all reduce conf
//  P8. Session Performance Engine: per-session win rate, PnL, expectancy with automatic penalties
//  P9. Fee-Aware Signal Labels: shows Gross TP, Total Fees, Net TP, Fee Impact % on each signal
//  P10. Trade Replay Enhancements: expectedGrossReward, expectedNetReward, fees, netRR, duplicate flag
//  P11. Analytics Enhancements: Net Winners, Gross-Win/Net-Loss count, Fees Killed, avg fee%, avg netRR
//  P12. Regime Accuracy Tracking: predicted vs actual regime outcome accuracy table
//  P13. Strategy Imbalance Warning: shown when only one strategy generates trades
// ============================================================
// v33.x Bug Fixes (Audit Pass):
//  B1. SL/TP now fires BEFORE health exit; checks candle wicks (high/low)
//  B2. Blocked signal details now include direction/strategy/regime/confidence/timestamp
//  B3. Settings persistence: patienceMode, feeGateMode, paperTradeWatchSignals,
//      unlimitedPaperLearning, paperRespectsRiskLock now saved to LS_BEHAVIOR
//  B4. Settings tab: Reset All Settings button + Settings loaded source indicator
//  B5. Exports: added Signal Log CSV, Blocked Signals CSV/JSON, Daily Report CSV/JSON,
//      Analytics Summary JSON — all with settings snapshot; no API secrets
//  B6. Trade Replay: added distance to SL/TP, current price, SL/TP hit status,
//      fee estimate, live unrealized PnL for open trades
//  B7. FEE_EFFICIENCY_FAIL renamed to FEE_GATE_HARD_BLOCK to match spec
//  B8. Signal tab: added Blocked Signal Forensics panel
//  B9. All behavior settings wired to saveBehaviorSettings on toggle change
// ============================================================
// v33 Changes (Fix Pass):
//  F1. Fee Efficiency Pre-Trade Gate: blocks trades where reward < 3× fee
//  F2. Post-Exit Sim Expiry: postExitCandleCount only on closed candles
//  F3. Restore seenSignalIds for open trades on reload (no duplicates)
//  F4. Populate healthHistory[] with capped 200-entry health snapshots
//  F5. Regime Distribution Funnel panel in Analytics tab
//  F6. UI label fixes: Phase 5, WATCH (observe only), WATCH ≥75%/TRADE ≥85%
//  F7. Maker fee display uses only makerTotalFee (no wrong fallback)
// ============================================================

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
// v26: Cloud sync, auth, notifications
import { useAuth } from "./auth/AuthContext.jsx";
import { LoginScreen } from "./auth/LoginScreen.jsx";
import { useCloudSync } from "./hooks/useCloudSync.js";
import { useNotifications } from "./hooks/useNotifications.js";

// ============================================================
// CONSTANTS & CONFIG
// ============================================================
const CONFIG = {
  SYMBOL: "BTCUSDT",
  DELTA_SYMBOL: "BTCUSD",
  BINANCE_WS: "wss://stream.binance.com:9443/ws",
  BINANCE_REST: "https://api.binance.com/api/v3",
  BINANCE_FUTURES: "https://fapi.binance.com/fapi/v1",
  CANDLE_LIMIT: 200,
  RISK_PER_TRADE: 1.0,
  LEVERAGE: 10,
  CONTRACT_SIZE: 1,
  MIN_RR: 1.5,
  DAILY_LOSS_LIMIT: 3.0,
  MAX_CONSECUTIVE_LOSSES: 3,
  MAX_DAILY_TRADES: 6,
  // CONFIDENCE thresholds (v29 fix):
  //   < 75   = Low confidence WAIT (no label)
  //   75–84  = WATCH only — log signal but do NOT open paper trade by default
  //   85–94  = TRADE allowed (STRONG)
  //   95+    = TRADE allowed (EXCEPTIONAL)
  CONFIDENCE: { WATCH: 75, TRADE: 85, STRONG: 95 },
  ATR_MULTIPLIER_SL: 1.5,
  ATR_MULTIPLIER_TP: 2.5,
  MIN_HOLD_CANDLES: 3,
  MIN_HOLD_SECONDS: 60,
  NEWS_BLOCK_MINUTES: 30,
  // Delta Exchange BTC perpetual fees (v29 — confirmed contract fees)
  TAKER_FEE: 0.0005,  // 0.05% — market orders default
  MAKER_FEE: 0.0002,  // 0.02% — limit orders
  FUNDING_INTERVAL_HOURS: 8,
  VERSION: "34.EL",
  // v30: Patience modes
  PATIENCE_MODES: { CONSERVATIVE: "CONSERVATIVE", NORMAL: "NORMAL", PATIENT: "PATIENT", SWING_TEST: "SWING_TEST" },
  // Patient mode: min 5 closed candles before health exit
  PATIENT_MIN_CANDLES: 5,
  // v31: Post-exit simulation expiry limits
  POST_EXIT_MAX_CANDLES: 50,
  POST_EXIT_MAX_HOURS: 24,
  // v32: localStorage keys (never store API secrets)
  LS_TRADES: "alpha_bot_trades_v33",
  LS_SIGNALS: "alpha_bot_signals_v33",
  LS_SIMS: "alpha_bot_postsims_v33",
  LS_NOTES: "alpha_bot_notes_v33",
  LS_REGIME_ACC: "alpha_bot_regime_acc_v33",
  // v34: persisted sizing settings
  LS_SIZING: "alpha_bot_sizing_v34",
  // v33.x: persisted behavior settings
  LS_BEHAVIOR: "alpha_bot_behavior_v33x",
  // v34.EL: persisted strategy enable/disable toggles
  LS_STRATEGY_TOGGLES: "alpha_bot_strategy_toggles_v34",
  // v34: Net profitability filter thresholds
  MIN_NET_RR: 1.2,            // minimum net RR after fees required to trade
  TREND_COOLDOWN_CANDLES: 5,  // candles to wait after TREND trade before re-entering same direction
  DUPLICATE_CANDLE_WINDOW: 10, // candles to look back for duplicate setup detection
  SESSION_PENALTY_WINRATE: 30, // session win rate below this triggers confidence penalty
  // v34.EL: Emergency lock constants
  STRATEGY_POOR_WR_TRADES: 20,   // min trades before win-rate block kicks in
  STRATEGY_POOR_WR_THRESHOLD: 30, // win rate % below which strategy is auto-trading blocked
  SESSION_POOR_TRADES: 10,        // min trades before session auto-block kicks in
  SESSION_POOR_WR_THRESHOLD: 30,  // session win rate % below which auto-trading is blocked
  TREND_LOSS_COOLDOWN_CANDLES: 10, // candles to wait after a TREND loss before same-direction re-entry
};

const SESSIONS = { ASIA: "ASIA", LONDON: "LONDON", NEW_YORK: "NEW_YORK", OFF: "OFF" };
const MODES = { GUIDANCE: "guidance", PAPER: "paper", LIVE: "live" };

// ============================================================
// UTILITY: Canonical Futures PnL
// feeRate defaults to TAKER_FEE (market orders). Pass MAKER_FEE for limit orders.
// ============================================================
function calcFuturesPnL({ direction, entry, exit, btcQty, leverage = CONFIG.LEVERAGE, fundingRate = 0, holdHours = 0, feeRate = CONFIG.TAKER_FEE }) {
  if (!entry || !exit || !btcQty) return { grossPnL: 0, fees: 0, funding: 0, netPnL: 0, returnPct: 0, roi: 0, entryFee: 0, exitFee: 0 };
  const grossPnL = direction === "LONG"
    ? (exit - entry) * btcQty
    : (entry - exit) * btcQty;
  const notionalEntry = entry * btcQty;
  const notionalExit = exit * btcQty;
  // v29: Show entry/exit fees separately for transparency
  const entryFee = notionalEntry * feeRate;
  const exitFee = notionalExit * feeRate;
  const fees = entryFee + exitFee;
  const fundingIntervals = holdHours / CONFIG.FUNDING_INTERVAL_HOURS;
  const fundingCost = direction === "LONG"
    ? notionalEntry * (fundingRate || 0) * fundingIntervals
    : -notionalEntry * (fundingRate || 0) * fundingIntervals;
  const funding = fundingCost;
  const netPnL = grossPnL - fees - funding;
  const margin = notionalEntry / leverage;
  const returnPct = (netPnL / notionalEntry) * 100;
  const roi = margin > 0 ? (netPnL / margin) * 100 : 0;
  return {
    grossPnL: parseFloat(grossPnL.toFixed(8)),
    fees: parseFloat(fees.toFixed(8)),
    entryFee: parseFloat(entryFee.toFixed(8)),
    exitFee: parseFloat(exitFee.toFixed(8)),
    funding: parseFloat(funding.toFixed(8)),
    netPnL: parseFloat(netPnL.toFixed(8)),
    returnPct: parseFloat(returnPct.toFixed(8)),
    roi: parseFloat(roi.toFixed(8)),
    feeRate,
  };
}

function formatPnL(val) {
  if (val === null || val === undefined || isNaN(val)) return "—";
  const sign = val >= 0 ? "+" : "";
  return `${sign}$${Math.abs(val).toFixed(2)}`;
}

function formatPrice(p) {
  if (!p) return "—";
  return `$${Number(p).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatPct(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

// ============================================================
// POSITION SIZING — AUTO (ATR-based) and MANUAL (user-controlled)
// Delta BTCUSD: 1 lot = 0.001 BTC, notional = btcQty × price
// ============================================================
function calcPositionSize(entry, atr, accountBalance, riskPercent = CONFIG.RISK_PER_TRADE, leverage = CONFIG.LEVERAGE) {
  if (!entry || !atr) return null;
  const slDist = atr * CONFIG.ATR_MULTIPLIER_SL;
  const riskUSDT = (accountBalance * riskPercent) / 100;
  const btcQty = riskUSDT / slDist;
  const notionalUSDT = entry * btcQty;
  // Delta BTCUSD: lots = btcQty / 0.001 (rounded to nearest integer)
  const deltaContracts = Math.max(1, Math.round(btcQty / 0.001));
  const marginUsed = notionalUSDT / leverage;
  return { btcQty, notionalUSDT, deltaContracts, marginUsed, riskUSDT, slDist };
}

// v32: Manual sizing preview — Delta BTCUSD: 1 lot = 0.001 BTC
// btcQty = lots × 0.001
// notional = lots × 0.001 × BTC price
// margin = notional / leverage
// fees on notional (NOT multiplied by leverage)
function calcManualSizingPreview({ entryPrice, leverage, lots, slDist, tpDist, feeRate = CONFIG.TAKER_FEE }) {
  if (!entryPrice || !leverage || !lots) return null;
  // Delta BTCUSD: 1 lot = 0.001 BTC
  const btcQty = lots * 0.001;
  const notionalUSDT = btcQty * entryPrice;
  const marginUsed = notionalUSDT / leverage;
  const entryFee = notionalUSDT * feeRate;
  const exitFee = notionalUSDT * feeRate;
  const totalFee = entryFee + exitFee;
  const feePctOfNotional = (totalFee / notionalUSDT) * 100;
  // PnL direction-agnostic estimates (absolute distances)
  const estimatedSLLoss = slDist ? (slDist * btcQty) + totalFee : null;
  const estimatedTPProfit = tpDist ? (tpDist * btcQty) - totalFee : null;
  const makerEntryFee = notionalUSDT * CONFIG.MAKER_FEE;
  const makerExitFee = notionalUSDT * CONFIG.MAKER_FEE;
  const makerTotalFee = makerEntryFee + makerExitFee;
  return {
    btcQty, notionalUSDT, marginUsed, leverage, lots,
    entryFee, exitFee, totalFee, feePctOfNotional,
    makerEntryFee, makerExitFee, makerTotalFee,
    estimatedSLLoss, estimatedTPProfit,
  };
}

// ============================================================
// v34: NET EXPECTANCY ENGINE
// All filters use net reward (after estimated round-trip fees).
// ============================================================

/**
 * Compute net trade expectancy metrics for a signal.
 * @param {number} tpDist - distance to TP in USD
 * @param {number} slDist - distance to SL in USD
 * @param {number} btcQty - position size in BTC
 * @param {number} entryPrice - entry price
 * @param {number} feeRate - taker fee rate (default TAKER_FEE)
 * @returns {object} { grossReward, estimatedRoundTripFee, expectedNetReward, netRisk, netRR, feePctOfReward, feeImpactPct }
 */
function calcNetExpectancy(tpDist, slDist, btcQty, entryPrice, feeRate = CONFIG.TAKER_FEE) {
  if (!tpDist || !slDist || !btcQty || !entryPrice) return null;
  const notional = entryPrice * btcQty;
  const grossReward = tpDist * btcQty;
  const estimatedRoundTripFee = notional * feeRate * 2;
  const expectedNetReward = grossReward - estimatedRoundTripFee;
  const expectedSLLoss = slDist * btcQty;
  const netRisk = expectedSLLoss + estimatedRoundTripFee;
  const netRR = netRisk > 0 ? expectedNetReward / netRisk : 0;
  const feePctOfReward = grossReward > 0 ? (estimatedRoundTripFee / grossReward) * 100 : 100;
  const feeImpactPct = estimatedRoundTripFee > 0 && grossReward > 0
    ? Math.min(100, (estimatedRoundTripFee / grossReward) * 100)
    : 0;
  return {
    grossReward,
    estimatedRoundTripFee,
    expectedNetReward,
    expectedSLLoss,
    netRisk,
    netRR,
    feePctOfReward,
    feeImpactPct,
    tpDist,
    slDist,
    btcQty,
    notional,
  };
}

/**
 * v34 P4: OVERTRADING COOLDOWN
 * Returns whether a new TREND trade in a given direction is allowed.
 * Prevents re-entry if: active TREND trade in same direction, OR < 5 closed candles since last close.
 */
function checkTrendCooldown(openTrades, closedTrades, direction, closedCandles) {
  // Rule 1: max 1 active TREND trade per direction
  const activeTrend = openTrades.filter(t => t.strategy === "TREND" && t.direction === direction);
  if (activeTrend.length > 0) {
    return { blocked: true, reason: `COOLDOWN: Active TREND ${direction} already open (ID: ${activeTrend[0].id.slice(-8)})` };
  }
  // Rule 2: must wait 5 closed candles since last TREND close in same direction
  const recentTrendClose = [...closedTrades]
    .filter(t => t.strategy === "TREND" && t.direction === direction && t.exitTime)
    .sort((a, b) => b.exitTime - a.exitTime)[0];
  if (recentTrendClose) {
    const candlesSinceClose = closedCandles.filter(c => c.t > recentTrendClose.exitTime).length;
    if (candlesSinceClose < CONFIG.TREND_COOLDOWN_CANDLES) {
      return { blocked: true, reason: `COOLDOWN: Only ${candlesSinceClose}/${CONFIG.TREND_COOLDOWN_CANDLES} candles since last TREND ${direction} close` };
    }
  }
  return { blocked: false, reason: null };
}

/**
 * v34 P5: DUPLICATE SETUP DETECTION
 * Detects if the same strategy+direction+regime appeared within recent candles.
 */
function checkDuplicateSetup(signalLog, strategy, direction, regime) {
  if (!strategy || !direction || !regime) return false;
  const recent = signalLog.slice(-CONFIG.DUPLICATE_CANDLE_WINDOW);
  return recent.some(s =>
    s.strategy === strategy &&
    s.direction === direction &&
    s.regime === regime &&
    (s.action === "TRADE" || s.action === "WATCH")
  );
}

/**
 * v34 P8: SESSION PERFORMANCE ENGINE
 * Returns per-session stats from closed trades.
 */
function calcSessionPerformance(closedTrades) {
  const sessions = ["ASIA", "LONDON", "NEW_YORK", "OFF"];
  return sessions.reduce((acc, sess) => {
    const trades = closedTrades.filter(t => t.session === sess);
    const wins = trades.filter(t => (t.pnl?.netPnL || 0) > 0);
    const pnl = trades.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
    const fees = trades.reduce((s, t) => s + (t.pnl?.fees || 0), 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : null;
    const expectancy = trades.length > 0 ? pnl / trades.length : null;
    acc[sess] = { trades: trades.length, wins: wins.length, losses: trades.length - wins.length, pnl, fees, winRate, expectancy };
    return acc;
  }, {});
}

// ============================================================
// v34.EL: EMERGENCY LOCK HELPERS
// ============================================================

/**
 * Check if a strategy is auto-blocked by poor performance.
 * Blocks if: ≥ STRATEGY_POOR_WR_TRADES trades AND win rate < STRATEGY_POOR_WR_THRESHOLD%
 */
function checkStrategyPerformanceBlock(strategy, closedTrades) {
  const strats = closedTrades.filter(t => t.strategy === strategy);
  if (strats.length < CONFIG.STRATEGY_POOR_WR_TRADES) return { blocked: false };
  const wins = strats.filter(t => (t.pnl?.netPnL || 0) > 0).length;
  const wr = (wins / strats.length) * 100;
  if (wr < CONFIG.STRATEGY_POOR_WR_THRESHOLD) {
    return {
      blocked: true,
      reason: `${strategy} auto-blocked: ${strats.length} trades, WR ${wr.toFixed(1)}% < ${CONFIG.STRATEGY_POOR_WR_THRESHOLD}% threshold`,
    };
  }
  return { blocked: false };
}

/**
 * Check if a session is auto-blocked by poor performance.
 * Blocks if: ≥ SESSION_POOR_TRADES trades AND win rate < SESSION_POOR_WR_THRESHOLD%
 */
function checkSessionAutoBlock(session, closedTrades) {
  const sessTrades = closedTrades.filter(t => t.session === session);
  if (sessTrades.length < CONFIG.SESSION_POOR_TRADES) return { blocked: false };
  const wins = sessTrades.filter(t => (t.pnl?.netPnL || 0) > 0).length;
  const wr = (wins / sessTrades.length) * 100;
  if (wr < CONFIG.SESSION_POOR_WR_THRESHOLD) {
    return {
      blocked: true,
      reason: `Session ${session} auto-blocked: ${sessTrades.length} trades, WR ${wr.toFixed(1)}% < ${CONFIG.SESSION_POOR_WR_THRESHOLD}% threshold`,
    };
  }
  return { blocked: false };
}

/**
 * v34.EL: TREND loss cooldown — blocks same-direction TREND re-entry
 * for TREND_LOSS_COOLDOWN_CANDLES candles after a loss.
 */
function checkTrendLossCooldown(closedTrades, direction, closedCandles) {
  const recentTrendLoss = [...closedTrades]
    .filter(t => t.strategy === "TREND" && t.direction === direction && t.exitTime && (t.pnl?.netPnL || 0) < 0)
    .sort((a, b) => b.exitTime - a.exitTime)[0];
  if (!recentTrendLoss) return { blocked: false };
  const candlesSinceLoss = closedCandles.filter(c => c.t > recentTrendLoss.exitTime).length;
  if (candlesSinceLoss < CONFIG.TREND_LOSS_COOLDOWN_CANDLES) {
    return {
      blocked: true,
      reason: `TREND ${direction} loss cooldown: ${candlesSinceLoss}/${CONFIG.TREND_LOSS_COOLDOWN_CANDLES} candles since last loss`,
    };
  }
  return { blocked: false };
}

/**
 * v34.EL: Strict TREND entry validator.
 * Returns { pass: bool, reason: string }
 * All 6 conditions must be met for TREND to trade.
 */
function checkStrictTrendEntry(candles, smcData, signal) {
  const fails = [];
  const lastCandle = candles[candles.length - 1];
  const closes = candles.map(c => c.c);
  const ema21 = calcEMA(closes, 21);
  const e21 = ema21[ema21.length - 1];
  const currentPrice = lastCandle?.c || 0;

  // 1) SMC bias aligned
  const smcBias = smcData.bosChoch?.bias;
  const biasDir = signal.direction === "LONG" ? "BULLISH" : "BEARISH";
  if (smcBias !== biasDir) {
    fails.push(`SMC bias ${smcBias || "NEUTRAL"} ≠ ${biasDir}`);
  }

  // 2) BOS aligned
  const bos = smcData.bosChoch?.bos;
  const bosDir = signal.direction === "LONG" ? "BULLISH" : "BEARISH";
  if (bos !== bosDir) {
    fails.push(`BOS ${bos || "none"} ≠ ${bosDir}`);
  }

  // 3) Price not overextended from EMA21 (max 1.5% away)
  const distFromEma = e21 > 0 ? Math.abs(currentPrice - e21) / e21 : 0;
  if (distFromEma > 0.015) {
    fails.push(`Price ${(distFromEma * 100).toFixed(2)}% from EMA21 (max 1.5%)`);
  }

  // 4) Latest closed candle supports direction
  const closedCandles = candles.filter(c => c.closed);
  const lastClosed = closedCandles[closedCandles.length - 1];
  if (lastClosed) {
    const bullish = lastClosed.c > lastClosed.o;
    const bearish = lastClosed.c < lastClosed.o;
    if (signal.direction === "LONG" && !bullish) {
      fails.push("Last closed candle is bearish");
    } else if (signal.direction === "SHORT" && !bearish) {
      fails.push("Last closed candle is bullish");
    }
  }

  // 5) No opposite CHoCH
  const choch = smcData.bosChoch?.choch;
  if (choch) {
    if (signal.direction === "LONG" && choch === "BEARISH") {
      fails.push("Opposite BEARISH CHoCH present");
    } else if (signal.direction === "SHORT" && choch === "BULLISH") {
      fails.push("Opposite BULLISH CHoCH present");
    }
  }

  // 6) No duplicate direction within last 5 candles (check open positions only)
  // This is enforced separately via TREND_COOLDOWN; no extra check needed here.

  if (fails.length > 0) {
    return { pass: false, reason: `STRICT_TREND_FAIL: ${fails.join(" | ")}` };
  }
  return { pass: true, reason: null };
}

/**
 * v34 P6: STRATEGY DISTRIBUTION AUDIT
 * Tracks detection, qualification, trades, wins, losses, net PnL per strategy.
 */
function calcStrategyDistribution(signalLog, closedTrades) {
  const strategies = ["TREND", "RANGE", "BREAKOUT", "REVERSAL"];
  return strategies.reduce((acc, strat) => {
    const detected = signalLog.filter(s => s.strategy === strat).length;
    const qualified = signalLog.filter(s => s.strategy === strat && s.confidence >= CONFIG.CONFIDENCE.WATCH).length;
    const traded = signalLog.filter(s => s.strategy === strat && s.tradedAs && s.tradedAs !== "BLOCKED").length;
    const stratTrades = closedTrades.filter(t => t.strategy === strat);
    const wins = stratTrades.filter(t => (t.pnl?.netPnL || 0) > 0).length;
    const losses = stratTrades.length - wins;
    const netPnL = stratTrades.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
    const expectancy = stratTrades.length > 0 ? netPnL / stratTrades.length : null;
    acc[strat] = { detected, qualified, traded, wins, losses, netPnL, expectancy };
    return acc;
  }, {});
}

/**
 * v34 P11: EXTENDED ANALYTICS
 * Computes additional metrics: net winners, gross-win/net-loss, fees-killed, avg fee%, avg netRR.
 */
function calcExtendedAnalytics(closedTrades) {
  if (!closedTrades.length) return null;
  const netWinners = closedTrades.filter(t => (t.pnl?.netPnL || 0) > 0).length;
  const grossWinNetLoss = closedTrades.filter(t => (t.pnl?.grossPnL || 0) > 0 && (t.pnl?.netPnL || 0) <= 0).length;
  const feesKilled = grossWinNetLoss; // alias for clarity
  const avgFeePct = closedTrades.reduce((s, t) => {
    const f = t.pnl?.fees || 0;
    const n = t.notionalUSDT || 0;
    return n > 0 ? s + (f / n) * 100 : s;
  }, 0) / closedTrades.length;
  const netRRs = closedTrades
    .filter(t => t.netExpectancy?.netRR !== undefined)
    .map(t => t.netExpectancy.netRR);
  const avgNetRR = netRRs.length > 0 ? netRRs.reduce((s, v) => s + v, 0) / netRRs.length : null;
  const duplicateSetupCount = closedTrades.filter(t => t.duplicateSetup).length;
  const cooldownPreventedCount = 0; // tracked in blockedSignalDetails
  const totalFees = closedTrades.reduce((s, t) => s + (t.pnl?.fees || 0), 0);
  const totalGross = closedTrades.reduce((s, t) => s + (t.pnl?.grossPnL || 0), 0);
  return {
    netWinners,
    grossWinNetLoss,
    feesKilled,
    avgFeePct,
    avgNetRR,
    duplicateSetupCount,
    cooldownPreventedCount,
    totalFees,
    totalGross,
    total: closedTrades.length,
  };
}

// ============================================================
// 1. MARKET DATA ENGINE
// v29: WebSocket exponential backoff, REST fallback status, graceful news failure
// ============================================================
class MarketDataEngine {
  constructor() {
    this.candles = {};
    this.activeInterval = "1m";
    this.ticker = null;
    this.orderBook = { bids: [], asks: [] };
    this.fundingRate = null;
    this.openInterest = null;
    this.ws = null;
    this.listeners = new Set();
    this.errors = {};
    this.lastUpdate = null;
    this.news = [];
    // v29: WebSocket connection state tracking
    this.wsStatus = "DISCONNECTED"; // DISCONNECTED | CONNECTING | CONNECTED | FAILED | RECONNECTING
    this.wsReconnectAttempts = 0;
    this.wsMaxReconnectAttempts = 20;
    this.wsReconnectTimer = null;
    // v29: REST fallback is always active — it's the primary reliability mechanism
    this.restFallbackActive = true;
    // v29: News availability status
    this.newsAvailable = false;
  }

  subscribe(fn) { this.listeners.add(fn); }
  unsubscribe(fn) { this.listeners.delete(fn); }
  emit(event, data) { this.listeners.forEach(fn => fn(event, data)); }

  async fetchCandles(interval = "1m") {
    try {
      const res = await fetch(
        `${CONFIG.BINANCE_REST}/klines?symbol=${CONFIG.SYMBOL}&interval=${interval}&limit=${CONFIG.CANDLE_LIMIT}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const parsed = raw.map(c => ({
        t: c[0], o: parseFloat(c[1]), h: parseFloat(c[2]),
        l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[5]),
        closed: true,
      }));
      if (!this.candles[interval]) this.candles[interval] = [];
      this.candles[interval] = parsed;
      delete this.errors[`candles_${interval}`];
      this.restFallbackActive = true;
    } catch (e) {
      this.errors[`candles_${interval}`] = e.message;
    }
  }

  async fetchAllIntervals() {
    await Promise.all(["1m", "5m", "15m", "1h", "4h"].map(i => this.fetchCandles(i)));
  }

  getCandles(interval = "1m") {
    return this.candles[interval] || [];
  }

  async fetchOrderBook() {
    try {
      const res = await fetch(`${CONFIG.BINANCE_REST}/depth?symbol=${CONFIG.SYMBOL}&limit=20`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.orderBook = {
        bids: data.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) })),
        asks: data.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) })),
      };
      delete this.errors.orderBook;
    } catch (e) {
      this.errors.orderBook = e.message;
    }
  }

  async fetchFundingRate() {
    try {
      const res = await fetch(`${CONFIG.BINANCE_FUTURES}/fundingRate?symbol=${CONFIG.SYMBOL}&limit=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.fundingRate = data[0] ? parseFloat(data[0].fundingRate) : null;
      delete this.errors.fundingRate;
    } catch (e) {
      this.errors.fundingRate = e.message;
      this.fundingRate = null;
    }
  }

  async fetchOpenInterest() {
    try {
      const res = await fetch(`${CONFIG.BINANCE_FUTURES}/openInterest?symbol=${CONFIG.SYMBOL}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.openInterest = data.openInterest ? parseFloat(data.openInterest) : null;
      delete this.errors.openInterest;
    } catch (e) {
      this.errors.openInterest = e.message;
      this.openInterest = null;
    }
  }

  // v32: Graceful news failure — CORS/network fail marks as UNAVAILABLE, not FAIL
  // If fetch succeeds and events = 0 → OK (newsAvailable = true, no error)
  // If fetch fails (CORS/network) → UNAVAILABLE (newsAvailable = false, errors.news = "UNAVAILABLE")
  // Never mark as FAIL — that's reserved for app bugs, not external API failures
  async fetchNews() {
    const sources = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json"];
    for (const url of sources) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          // HTTP error (non-200) — treat as unavailable, not fatal
          this.errors.news = "UNAVAILABLE";
          this.newsAvailable = false;
          this.news = [];
          this.newsLastAttempt = Date.now();
          return;
        }
        const data = await res.json();
        this.news = (data || []).filter(e =>
          ["USD", ""].includes(e.country) &&
          ["high", "medium"].includes(e.impact?.toLowerCase())
        ).map(e => ({
          title: e.title,
          date: e.date,
          impact: e.impact,
          country: e.country,
        }));
        // Success — even if 0 events found, mark as OK
        delete this.errors.news;
        this.newsAvailable = true;
        this.newsLastAttempt = Date.now();
        return;
      } catch (e) {
        // Network error (CORS, offline, timeout) → UNAVAILABLE, not FAIL
        this.errors.news = "UNAVAILABLE";
        this.newsAvailable = false;
      }
    }
    this.news = [];
    this.newsAvailable = false;
    this.errors.news = "UNAVAILABLE";
    this.newsLastAttempt = Date.now();
  }

  // v29: WebSocket with exponential backoff reconnection
  connectWebSocket(onCandle) {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.wsStatus = "CONNECTING";
    const stream = `${CONFIG.SYMBOL.toLowerCase()}@kline_1m`;
    try {
      this.ws = new WebSocket(`${CONFIG.BINANCE_WS}/${stream}`);
    } catch (e) {
      this._scheduleWsReconnect(onCandle);
      return;
    }

    this.ws.onopen = () => {
      this.wsStatus = "CONNECTED";
      this.wsReconnectAttempts = 0;
      delete this.errors.ws;
    };

    this.ws.onmessage = (msg) => {
      try {
        const d = JSON.parse(msg.data);
        if (d.k) {
          const k = d.k;
          const candle = {
            t: k.t, o: parseFloat(k.o), h: parseFloat(k.h),
            l: parseFloat(k.l), c: parseFloat(k.c), v: parseFloat(k.v),
            closed: k.x,
          };
          this.ticker = { price: candle.c, time: Date.now() };
          if (!this.candles["1m"]) this.candles["1m"] = [];
          const arr = this.candles["1m"];
          if (arr.length > 0) {
            const last = arr[arr.length - 1];
            if (last.t === candle.t) {
              arr[arr.length - 1] = candle;
            } else if (candle.closed) {
              arr.push(candle);
              if (arr.length > CONFIG.CANDLE_LIMIT) arr.shift();
            }
          }
          this.lastUpdate = Date.now();
          onCandle(candle);
        }
      } catch {}
    };

    this.ws.onerror = () => {
      this.wsStatus = "FAILED";
      this.errors.ws = `WebSocket error (attempt ${this.wsReconnectAttempts + 1})`;
    };

    this.ws.onclose = () => {
      if (this.wsStatus === "CONNECTED") {
        this.wsStatus = "RECONNECTING";
      }
      this._scheduleWsReconnect(onCandle);
    };
  }

  // v29: Exponential backoff — 1s, 2s, 4s, 8s … capped at 30s
  _scheduleWsReconnect(onCandle) {
    if (this.wsReconnectAttempts >= this.wsMaxReconnectAttempts) {
      this.wsStatus = "FAILED";
      this.errors.ws = `WebSocket failed after ${this.wsMaxReconnectAttempts} attempts. REST fallback active.`;
      return;
    }
    const delay = Math.min(30000, 1000 * Math.pow(2, this.wsReconnectAttempts));
    this.wsReconnectAttempts += 1;
    this.wsStatus = "RECONNECTING";
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    this.wsReconnectTimer = setTimeout(() => {
      this.connectWebSocket(onCandle);
    }, delay);
  }

  disconnect() {
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.wsStatus = "DISCONNECTED";
  }

  dataStatus() {
    const candles1m = this.candles["1m"] || [];
    return {
      candles: candles1m.length > 50,
      orderBook: !this.errors.orderBook && this.orderBook.bids.length > 0,
      fundingRate: this.fundingRate !== null,
      openInterest: this.openInterest !== null,
      // v32: news is "ok" if fetch succeeded (even 0 events); UNAVAILABLE is not FAIL
      news: this.newsAvailable,
      newsAvailable: this.newsAvailable,
      newsLastAttempt: this.newsLastAttempt || null,
      // v29: ws status is granular
      ws: this.wsStatus === "CONNECTED",
      wsStatus: this.wsStatus,
      wsReconnectAttempts: this.wsReconnectAttempts,
      restFallbackActive: this.restFallbackActive,
      restFallback: this.restFallbackActive,
      errors: this.errors,
    };
  }
}

// ============================================================
// 2. INDICATORS ENGINE
// ============================================================
function calcEMA(data, period) {
  if (!data || data.length === 0) return [];
  const k = 2 / (period + 1);
  let ema = data[0];
  const result = [ema];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(closes) {
  if (!closes || closes.length < 35) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMA(macdLine.slice(26), 9);
  const last = signal.length - 1;
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signal[last],
    hist: macdLine[macdLine.length - 1] - signal[last],
  };
}

function calcBollingerBands(closes, period = 20, stdMult = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + stdMult * std, mid: mean, lower: mean - stdMult * std, std, width: (std * 2) / mean };
}

function calcADX(candles, period = 14) {
  if (!candles || candles.length < period * 2) return null;
  const slice = candles.slice(-(period * 2));
  const pDM = [], nDM = [], tr = [];
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    const upMove = c.h - p.h, downMove = p.l - c.l;
    pDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    nDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const smooth = (arr, p) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const res = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; res.push(s); }
    return res;
  };
  const sTR = smooth(tr, period), sPDM = smooth(pDM, period), sNDM = smooth(nDM, period);
  const pDI = sPDM.map((v, i) => (v / sTR[i]) * 100);
  const nDI = sNDM.map((v, i) => (v / sTR[i]) * 100);
  const dx = pDI.map((v, i) => Math.abs(v - nDI[i]) / (v + nDI[i]) * 100);
  const adx = dx.slice(-period).reduce((a, b) => a + b, 0) / period;
  return { adx, pdi: pDI[pDI.length - 1], ndi: nDI[nDI.length - 1] };
}

function calcVolumeProfile(candles, lookback = 20) {
  if (!candles || candles.length < lookback) return { avgVol: 0, lastVol: 0, ratio: 0 };
  const slice = candles.slice(-lookback);
  const avgVol = slice.reduce((s, c) => s + c.v, 0) / slice.length;
  const lastVol = candles[candles.length - 1]?.v || 0;
  return { avgVol, lastVol, ratio: avgVol > 0 ? lastVol / avgVol : 0 };
}

// ============================================================
// 3. SMC ENGINE
// ============================================================
function detectSwingPoints(candles, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const isSwingHigh = candles[i].h === Math.max(...slice.map(c => c.h));
    const isSwingLow = candles[i].l === Math.min(...slice.map(c => c.l));
    if (isSwingHigh) highs.push({ idx: i, price: candles[i].h, t: candles[i].t });
    if (isSwingLow) lows.push({ idx: i, price: candles[i].l, t: candles[i].t });
  }
  return { highs: highs.slice(-5), lows: lows.slice(-5) };
}

function detectOrderBlocks(candles, swings) {
  const obs = [];
  for (let i = 2; i < candles.length - 3; i++) {
    const c = candles[i];
    if (c.c < c.o) {
      const nextThree = candles.slice(i + 1, i + 4);
      const strongUp = nextThree.every(nc => nc.c > nc.o) && nextThree[nextThree.length - 1].c > c.h;
      if (strongUp) obs.push({ type: "bullish", high: c.h, low: c.l, idx: i, t: c.t });
    }
    if (c.c > c.o) {
      const nextThree = candles.slice(i + 1, i + 4);
      const strongDown = nextThree.every(nc => nc.c < nc.o) && nextThree[nextThree.length - 1].c < c.l;
      if (strongDown) obs.push({ type: "bearish", high: c.h, low: c.l, idx: i, t: c.t });
    }
  }
  return obs.slice(-6);
}

function detectFairValueGaps(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1], curr = candles[i], next = candles[i + 1];
    if (next.l > prev.h) fvgs.push({ type: "bullish", high: next.l, low: prev.h, idx: i, t: curr.t });
    if (next.h < prev.l) fvgs.push({ type: "bearish", high: prev.l, low: next.h, idx: i, t: curr.t });
  }
  return fvgs.slice(-6);
}

function detectBOS_CHoCH(candles, swings) {
  if (!swings || swings.highs.length < 2 || swings.lows.length < 2) return null;
  const lastHigh = swings.highs[swings.highs.length - 1];
  const prevHigh = swings.highs[swings.highs.length - 2];
  const lastLow = swings.lows[swings.lows.length - 1];
  const prevLow = swings.lows[swings.lows.length - 2];
  const last = candles[candles.length - 1];
  let bos = null, choch = null, bias = "NEUTRAL";

  if (last.c > lastHigh.price) { bos = "BULLISH"; bias = "BULLISH"; }
  else if (last.c < lastLow.price) { bos = "BEARISH"; bias = "BEARISH"; }
  if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price && last.c > lastHigh.price) choch = "BULLISH";
  else if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price && last.c < lastLow.price) choch = "BEARISH";

  return { bos, choch, bias };
}

function detectLiquiditySweep(candles, swings) {
  if (!swings || candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!last || !prev || !swings.highs.length || !swings.lows.length) return null;
  const recentHigh = swings.highs[swings.highs.length - 1];
  const recentLow = swings.lows[swings.lows.length - 1];
  if (last.h > recentHigh.price && last.c < recentHigh.price) return { type: "BEAR_SWEEP", level: recentHigh.price };
  if (last.l < recentLow.price && last.c > recentLow.price) return { type: "BULL_SWEEP", level: recentLow.price };
  return null;
}

function calcPremiumDiscount(candles, swings) {
  if (!swings || !swings.highs.length || !swings.lows.length) return "NEUTRAL";
  const rangeHigh = Math.max(...swings.highs.map(h => h.price));
  const rangeLow = Math.min(...swings.lows.map(l => l.price));
  const mid = (rangeHigh + rangeLow) / 2;
  const price = candles[candles.length - 1]?.c || 0;
  if (price > mid * 1.002) return "PREMIUM";
  if (price < mid * 0.998) return "DISCOUNT";
  return "NEUTRAL";
}

// ============================================================
// 4. MARKET REGIME BRAIN
// ============================================================
function detectRegime(candles) {
  if (!candles || candles.length < 60) return { regime: "UNCERTAIN", reason: "Insufficient data" };
  const closes = candles.map(c => c.c);
  const atr = calcATR(candles);
  const adx = calcADX(candles);
  const bb = calcBollingerBands(closes);
  const vol = calcVolumeProfile(candles);
  const ema21 = calcEMA(closes, 21);
  if (!atr || !adx || !bb) return { regime: "UNCERTAIN", reason: "Indicator data missing" };
  const lastClose = closes[closes.length - 1];
  const normalizedATR = atr / lastClose;
  const isHighVol = normalizedATR > 0.008;
  const isTrending = adx.adx > 25;
  const isRanging = adx.adx < 20 && bb.width < 0.015;
  const isBreakout = vol.ratio > 2.0 && bb.width > 0.02;
  const emaSlope = (ema21[ema21.length - 1] - ema21[ema21.length - 5]) / ema21[ema21.length - 5];
  const swings = detectSwingPoints(candles);
  const sweep = detectLiquiditySweep(candles, swings);
  const bosChoch = detectBOS_CHoCH(candles, swings);
  if (isHighVol && normalizedATR > 0.012) return { regime: "HIGH_VOLATILITY", reason: `ATR ${(normalizedATR * 100).toFixed(2)}% — extreme volatility`, adx, bb, atr };
  if (sweep && bosChoch?.choch) return { regime: "REVERSAL", reason: `Liquidity sweep + CHoCH`, adx, bb, atr, sweep, bosChoch };
  if (isBreakout) return { regime: "BREAKOUT", reason: `Volume ${vol.ratio.toFixed(1)}x + BB expansion`, adx, bb, atr, vol };
  if (isTrending) {
    const dir = emaSlope > 0 ? "UPTREND" : "DOWNTREND";
    return { regime: "TRENDING", direction: dir, reason: `ADX ${adx.adx.toFixed(1)} — ${dir}`, adx, bb, atr };
  }
  if (isRanging) return { regime: "RANGING", reason: `ADX ${adx.adx.toFixed(1)}, BB width ${(bb.width * 100).toFixed(2)}%`, adx, bb, atr };
  return { regime: "UNCERTAIN", reason: `ADX ${adx.adx.toFixed(1)} borderline`, adx, bb, atr };
}

// ============================================================
// 5. STRATEGY ENGINE
// ============================================================
function runTrendStrategy(candles, smcData) {
  const closes = candles.map(c => c.c);
  const ema21 = calcEMA(closes, 21);
  const ema55 = calcEMA(closes, 55);
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : null;
  const macd = calcMACD(closes);
  const vol = calcVolumeProfile(candles);
  const adx = calcADX(candles);
  const lastClose = closes[closes.length - 1];
  const e21 = ema21[ema21.length - 1];
  const e55 = ema55[ema55.length - 1];
  const e200 = ema200 ? ema200[ema200.length - 1] : null;
  if (!macd || !adx) return null;
  let longScore = 0, shortScore = 0, factors = [];
  if (lastClose > e21 && e21 > e55) { longScore += 25; factors.push("EMA bullish stack"); }
  else if (lastClose < e21 && e21 < e55) { shortScore += 25; factors.push("EMA bearish stack"); }
  if (e200 && lastClose > e200) { longScore += 10; factors.push("Above EMA200"); }
  else if (e200 && lastClose < e200) { shortScore += 10; factors.push("Below EMA200"); }
  if (macd.hist > 0 && macd.macd > 0) { longScore += 20; factors.push("MACD bullish"); }
  else if (macd.hist < 0 && macd.macd < 0) { shortScore += 20; factors.push("MACD bearish"); }
  if (adx.adx > 30) {
    if (adx.pdi > adx.ndi) { longScore += 15; factors.push(`ADX ${adx.adx.toFixed(0)} bullish`); }
    else { shortScore += 15; factors.push(`ADX ${adx.adx.toFixed(0)} bearish`); }
  }
  if (vol.ratio > 1.2) factors.push(`Vol ${vol.ratio.toFixed(1)}x`);
  if (smcData.bosChoch?.bos === "BULLISH") { longScore += 15; factors.push("Bullish BOS"); }
  else if (smcData.bosChoch?.bos === "BEARISH") { shortScore += 15; factors.push("Bearish BOS"); }
  const direction = longScore > shortScore ? "LONG" : longScore < shortScore ? "SHORT" : null;
  if (!direction) return null;
  const score = direction === "LONG" ? longScore : shortScore;
  return { strategy: "TREND", direction, confidence: Math.min(98, score), factors };
}

function runRangeStrategy(candles, smcData) {
  const closes = candles.map(c => c.c);
  const rsi = calcRSI(closes);
  const bb = calcBollingerBands(closes);
  const lastClose = closes[closes.length - 1];
  const vol = calcVolumeProfile(candles);
  if (!rsi || !bb) return null;
  let direction = null, confidence = 0, factors = [];
  if (rsi < 35) { direction = "LONG"; confidence += 30; factors.push(`RSI ${rsi.toFixed(0)} oversold`); }
  else if (rsi > 65) { direction = "SHORT"; confidence += 30; factors.push(`RSI ${rsi.toFixed(0)} overbought`); }
  else return null;
  if (direction === "LONG" && lastClose <= bb.lower * 1.001) { confidence += 25; factors.push("At BB lower"); }
  else if (direction === "SHORT" && lastClose >= bb.upper * 0.999) { confidence += 25; factors.push("At BB upper"); }
  else confidence -= 15;
  if (smcData.swings) {
    const nearLow = smcData.swings.lows.some(l => Math.abs(lastClose - l.price) / lastClose < 0.003);
    const nearHigh = smcData.swings.highs.some(h => Math.abs(lastClose - h.price) / lastClose < 0.003);
    if (direction === "LONG" && nearLow) { confidence += 20; factors.push("Near swing low"); }
    if (direction === "SHORT" && nearHigh) { confidence += 20; factors.push("Near swing high"); }
  }
  if (vol.ratio < 0.8) { confidence += 10; factors.push("Low vol range"); }
  return { strategy: "RANGE", direction, confidence: Math.min(98, confidence), factors };
}

function runBreakoutStrategy(candles, smcData) {
  const closes = candles.map(c => c.c);
  const vol = calcVolumeProfile(candles);
  const atr = calcATR(candles);
  const bb = calcBollingerBands(closes);
  const lastClose = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  if (!atr || !bb || !vol) return null;
  const swings = smcData.swings || { highs: [], lows: [] };
  const recentHigh = swings.highs.length ? Math.max(...swings.highs.map(h => h.price)) : null;
  const recentLow = swings.lows.length ? Math.min(...swings.lows.map(l => l.price)) : null;
  let direction = null, confidence = 0, factors = [];
  if (recentHigh && lastClose > recentHigh && prev <= recentHigh) { direction = "LONG"; confidence += 30; factors.push("Broke swing high"); }
  else if (recentLow && lastClose < recentLow && prev >= recentLow) { direction = "SHORT"; confidence += 30; factors.push("Broke swing low"); }
  else return null;
  if (vol.ratio > 1.8) { confidence += 25; factors.push(`Vol ${vol.ratio.toFixed(1)}x`); }
  else if (vol.ratio > 1.4) { confidence += 15; factors.push(`Vol ${vol.ratio.toFixed(1)}x`); }
  if (atr / lastClose > 0.004) { confidence += 20; factors.push("ATR expanding"); }
  if (direction === "LONG" && lastClose > bb.upper) { confidence += 15; factors.push("Above BB upper"); }
  else if (direction === "SHORT" && lastClose < bb.lower) { confidence += 15; factors.push("Below BB lower"); }
  return { strategy: "BREAKOUT", direction, confidence: Math.min(98, confidence), factors };
}

function runReversalStrategy(candles, smcData) {
  if (!smcData.sweep) return null;
  const closes = candles.map(c => c.c);
  const lastClose = closes[closes.length - 1];
  const lastCandle = candles[candles.length - 1];
  let direction = null, confidence = 0, factors = [];
  if (smcData.sweep.type === "BULL_SWEEP") { direction = "LONG"; confidence += 25; factors.push("Bull liquidity sweep"); }
  else if (smcData.sweep.type === "BEAR_SWEEP") { direction = "SHORT"; confidence += 25; factors.push("Bear liquidity sweep"); }
  if (!direction) return null;
  if (smcData.bosChoch?.choch) { confidence += 20; factors.push("CHoCH detected"); }
  const ob = (smcData.orderBlocks || []).find(ob => ob.type === (direction === "LONG" ? "bullish" : "bearish") && lastClose >= ob.low && lastClose <= ob.high);
  if (ob) { confidence += 20; factors.push(`${ob.type} order block`); }
  const fvg = (smcData.fvgs || []).find(f => f.type === (direction === "LONG" ? "bullish" : "bearish") && lastClose >= f.low && lastClose <= f.high);
  if (fvg) { confidence += 15; factors.push("Price in FVG"); }
  const bodySize = Math.abs(lastCandle.c - lastCandle.o);
  const totalRange = lastCandle.h - lastCandle.l;
  const wickRatio = totalRange > 0 ? bodySize / totalRange : 1;
  if (direction === "LONG" && lastCandle.c > lastCandle.o && wickRatio < 0.5) { confidence += 15; factors.push("Bullish rejection candle"); }
  else if (direction === "SHORT" && lastCandle.c < lastCandle.o && wickRatio < 0.5) { confidence += 15; factors.push("Bearish rejection candle"); }
  if (direction === "LONG" && smcData.premiumDiscount === "DISCOUNT") { confidence += 10; factors.push("Discount zone"); }
  else if (direction === "SHORT" && smcData.premiumDiscount === "PREMIUM") { confidence += 10; factors.push("Premium zone"); }
  return { strategy: "REVERSAL", direction, confidence: Math.min(98, confidence), factors };
}

// ============================================================
// 6. SIGNAL ENGINE
// v29 fixes:
//  - 75–84 confidence = WATCH (logs signal, does NOT auto-trade)
//  - 85+ = TRADE allowed
//  - SMC opposition filter: SHORT + BULLISH bias = blocked/downgraded
// v34: duplicateSetup flag and session penalty applied to confidence
// ============================================================
function generateSignal(candles, regimeData, smcData, orderBook, fundingRate, openInterest, extraCtx = {}) {
  const { regime } = regimeData;
  const lastCandle = candles[candles.length - 1];
  const candleOpenTime = lastCandle ? lastCandle.t : 0;
  // extraCtx: { signalLog, closedTrades, sessionPerf, currentSession }
  const { signalLog = [], closedTrades = [], sessionPerf = {}, currentSession = null } = extraCtx;

  if (regime === "UNCERTAIN" || regime === "HIGH_VOLATILITY") {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_NONE_WAIT_${regime}`;
    return { action: "WAIT", reason: regime === "HIGH_VOLATILITY" ? "High volatility — capital preservation" : regimeData.reason, confidence: 0, regime, strategy: null, direction: null, signalId, candleOpenTime };
  }
  let strategyResult = null;
  if (regime === "TRENDING") strategyResult = runTrendStrategy(candles, smcData);
  else if (regime === "RANGING") strategyResult = runRangeStrategy(candles, smcData);
  else if (regime === "BREAKOUT") strategyResult = runBreakoutStrategy(candles, smcData);
  else if (regime === "REVERSAL") strategyResult = runReversalStrategy(candles, smcData);
  if (!strategyResult) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${regime}_WAIT_NOSETUP`;
    return { action: "WAIT", reason: `No valid ${regime} setup`, confidence: 0, regime, strategy: regime, direction: null, signalId, candleOpenTime };
  }
  let conf = strategyResult.confidence;
  const boosts = [];
  if (fundingRate !== null) {
    if (strategyResult.direction === "SHORT" && fundingRate > 0.0005) { conf += 3; boosts.push("Funding favors short"); }
    else if (strategyResult.direction === "LONG" && fundingRate < -0.0002) { conf += 3; boosts.push("Funding favors long"); }
  }
  const wallResult = checkOrderBookWalls(orderBook, candles[candles.length - 1]?.c);
  if (wallResult.largeWall) {
    if (strategyResult.direction === "LONG" && wallResult.wallSide === "BID") { conf += 5; boosts.push("Large bid wall"); }
    else if (strategyResult.direction === "SHORT" && wallResult.wallSide === "ASK") { conf += 5; boosts.push("Large ask wall"); }
  }
  conf = Math.min(98, conf);

  // v34 P5: DUPLICATE SETUP DETECTION
  const isDuplicateSetup = checkDuplicateSetup(signalLog, strategyResult.strategy, strategyResult.direction, regime);
  if (isDuplicateSetup) {
    conf = Math.max(0, conf - 15);
    boosts.push("⚠ Duplicate setup detected (-15 conf)");
  }

  // v34 P7: SESSION PERFORMANCE PENALTY
  // If current session win rate < SESSION_PENALTY_WINRATE, penalize confidence
  let sessionPenaltyApplied = false;
  if (currentSession && sessionPerf[currentSession]) {
    const sp = sessionPerf[currentSession];
    if (sp.trades >= 3 && sp.winRate !== null && sp.winRate < CONFIG.SESSION_PENALTY_WINRATE) {
      conf = Math.max(0, conf - 10);
      boosts.push(`⚠ Poor ${currentSession} session (${sp.winRate.toFixed(0)}% WR) -10 conf`);
      sessionPenaltyApplied = true;
    }
  }

  // v29: SMC OPPOSITION FILTER
  // If SMC bias strongly opposes trade direction, block or heavily downgrade.
  const smcBias = smcData.bosChoch?.bias;
  let smcOpposed = false;
  let smcOppositionReason = null;
  if (smcBias === "BULLISH" && strategyResult.direction === "SHORT") {
    smcOpposed = true;
    smcOppositionReason = "SMC bias BULLISH opposes SHORT — blocked";
    conf -= 25; // heavy downgrade
  } else if (smcBias === "BEARISH" && strategyResult.direction === "LONG") {
    smcOpposed = true;
    smcOppositionReason = "SMC bias BEARISH opposes LONG — blocked";
    conf -= 25;
  }
  conf = Math.max(0, conf);

  // v31 fix: If SMC opposition drove confidence below WATCH threshold, return SMC_OPPOSITION
  // not a plain LOWCONF — so the signal log captures the real reason.
  if (smcOpposed && conf < CONFIG.CONFIDENCE.WATCH) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_SMC_OPPOSITION`;
    return {
      action: "WAIT",
      reason: smcOppositionReason || "SMC opposition blocked",
      confidence: conf,
      regime,
      strategy: strategyResult.strategy,
      direction: strategyResult.direction,
      factors: [...(strategyResult.factors || []), ...boosts],
      signalId, candleOpenTime,
      smcOpposed: true,
      smcOppositionReason,
    };
  }

  // v29: Confidence threshold changes:
  //   < WATCH (75) = plain WAIT
  //   WATCH (75–84) = WATCH signal — logged but does NOT auto-open paper trade
  //   TRADE (85+)  = TRADE signal — opens paper trade
  if (conf < CONFIG.CONFIDENCE.WATCH) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_LOWCONF`;
    return { action: "WAIT", reason: `Confidence ${conf.toFixed(0)} < threshold ${CONFIG.CONFIDENCE.WATCH}`, confidence: conf, regime, strategy: strategyResult.strategy, direction: strategyResult.direction, factors: strategyResult.factors, signalId, candleOpenTime };
  }

  // v29: SMC opposition after threshold check — if opposed even after conf deduction,
  // return a WATCH signal with clear reason (even if still ≥75)
  if (smcOpposed && conf < CONFIG.CONFIDENCE.TRADE) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_SMC_OPPOSED`;
    return {
      action: "WATCH",
      reason: smcOppositionReason,
      confidence: conf,
      regime,
      strategy: strategyResult.strategy,
      direction: strategyResult.direction,
      factors: [...(strategyResult.factors || []), ...boosts, smcOppositionReason],
      signalId, candleOpenTime,
      smcOpposed: true,
      smcOppositionReason,
    };
  }

  // v29: WATCH band (75–84) — log but do NOT auto-trade
  if (conf >= CONFIG.CONFIDENCE.WATCH && conf < CONFIG.CONFIDENCE.TRADE) {
    const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_WATCH`;
    return {
      action: "WATCH",
      reason: `Confidence ${conf.toFixed(0)} — WATCH only (need ≥${CONFIG.CONFIDENCE.TRADE} to trade)`,
      confidence: conf,
      confidenceLabel: "WATCH",
      regime,
      strategy: strategyResult.strategy,
      direction: strategyResult.direction,
      factors: [...(strategyResult.factors || []), ...boosts],
      signalId, candleOpenTime,
      smcOpposed,
      duplicateSetup: isDuplicateSetup,
      sessionPenaltyApplied,
    };
  }

  // TRADE band (85+)
  const confLabel = conf >= CONFIG.CONFIDENCE.STRONG ? "EXCEPTIONAL" : "STRONG";
  const signalId = `${CONFIG.SYMBOL}_${candleOpenTime}_${strategyResult.strategy}_${strategyResult.direction}_${confLabel}`;
  return {
    action: "TRADE", direction: strategyResult.direction, strategy: strategyResult.strategy, regime,
    confidence: conf, confidenceLabel: confLabel, factors: [...(strategyResult.factors || []), ...boosts],
    reason: `${confLabel} ${strategyResult.direction} — ${strategyResult.factors[0] || ""}`,
    signalId,
    candleOpenTime,
    smcOpposed,
    smcOppositionReason: smcOpposed ? smcOppositionReason : null,
    duplicateSetup: isDuplicateSetup,
    sessionPenaltyApplied,
  };
}

function checkOrderBookWalls(orderBook, price) {
  if (!orderBook || !orderBook.bids?.length || !price) return { largeWall: false };
  const avgBidQty = orderBook.bids.reduce((s, b) => s + b.qty, 0) / orderBook.bids.length;
  const largeBid = orderBook.bids.find(b => b.qty > avgBidQty * 5 && b.price < price);
  const largeAsk = orderBook.asks?.find(a => a.qty > avgBidQty * 5 && a.price > price);
  if (largeBid) return { largeWall: true, wallSide: "BID", level: largeBid.price };
  if (largeAsk) return { largeWall: true, wallSide: "ASK", level: largeAsk.price };
  return { largeWall: false };
}

// ============================================================
// 6b. SIGNAL QUALITY ENGINE — grades A+ through D
// v29: Updated for new WATCH/TRADE confidence thresholds
// ============================================================
function gradeSignal(signal, smcData, regime, orderBook, price) {
  if (!signal || (signal.action !== "TRADE" && signal.action !== "WATCH")) return null;
  let score = 0;
  const reasons = [];
  const demerits = [];

  // Regime alignment (0-25)
  const regimeStratMap = { TRENDING: "TREND", RANGING: "RANGE", BREAKOUT: "BREAKOUT", REVERSAL: "REVERSAL" };
  if (regime && regimeStratMap[regime.regime] === signal.strategy) {
    score += 25; reasons.push("Strategy matches regime");
  } else {
    score += 10; demerits.push("Strategy/regime mismatch");
  }

  // Confidence (0-25) — v29 thresholds
  if (signal.confidence >= 95) { score += 25; reasons.push("Exceptional confidence"); }
  else if (signal.confidence >= 85) { score += 18; reasons.push("Strong confidence"); }
  else if (signal.confidence >= 75) { score += 10; reasons.push("Watch confidence (WATCH only)"); }
  else { score += 0; demerits.push("Low confidence"); }

  // SMC structure alignment (0-20)
  let smcScore = 0;
  if (smcData.bosChoch?.bias) {
    if ((signal.direction === "LONG" && smcData.bosChoch.bias === "BULLISH") ||
        (signal.direction === "SHORT" && smcData.bosChoch.bias === "BEARISH")) {
      smcScore += 10; reasons.push("SMC bias aligned");
    } else {
      demerits.push("SMC bias opposed");
      if (signal.smcOpposed) demerits.push("⚠ SMC opposition filtered this signal");
    }
  }
  if (smcData.bosChoch?.bos) {
    if ((signal.direction === "LONG" && smcData.bosChoch.bos === "BULLISH") ||
        (signal.direction === "SHORT" && smcData.bosChoch.bos === "BEARISH")) {
      smcScore += 5; reasons.push("BOS confirmed");
    }
  }
  if (smcData.sweep) {
    if ((signal.direction === "LONG" && smcData.sweep.type === "BULL_SWEEP") ||
        (signal.direction === "SHORT" && smcData.sweep.type === "BEAR_SWEEP")) {
      smcScore += 5; reasons.push("Liquidity sweep aligned");
    }
  }
  score += Math.min(20, smcScore);

  // Liquidity / order book (0-15)
  if (orderBook?.bids?.length > 0 && price) {
    const wallResult = checkOrderBookWalls(orderBook, price);
    if (wallResult.largeWall) {
      if ((signal.direction === "LONG" && wallResult.wallSide === "BID") ||
          (signal.direction === "SHORT" && wallResult.wallSide === "ASK")) {
        score += 15; reasons.push("Order book wall supporting");
      } else {
        score += 5; demerits.push("Order book wall opposing");
      }
    } else {
      score += 8; // neutral
    }
  }

  // Premium/Discount zone (0-10)
  if (smcData.premiumDiscount) {
    if ((signal.direction === "LONG" && smcData.premiumDiscount === "DISCOUNT") ||
        (signal.direction === "SHORT" && smcData.premiumDiscount === "PREMIUM")) {
      score += 10; reasons.push("Price in favorable zone");
    } else if (smcData.premiumDiscount !== "NEUTRAL") {
      demerits.push("Price in unfavorable zone");
    } else {
      score += 5;
    }
  }

  // FVG presence (0-5)
  const fvgAligned = (smcData.fvgs || []).some(f =>
    f.type === (signal.direction === "LONG" ? "bullish" : "bearish")
  );
  if (fvgAligned) { score += 5; reasons.push("FVG present"); }

  const grade = score >= 90 ? "A+" : score >= 75 ? "A" : score >= 60 ? "B" : score >= 45 ? "C" : "D";
  const gradeColor = score >= 90 ? "#00ff9d" : score >= 75 ? "#4db8ff" : score >= 60 ? "#ffd700" : score >= 45 ? "#fb923c" : "#ff4566";
  return { grade, score, reasons, demerits, gradeColor };
}

// ============================================================
// 6c. AI COPILOT DETAILED ANALYSIS ENGINE
// v29: Handles WATCH signals, SMC opposition, news unavailable
// ============================================================
function buildCopilotAnalysis(signal, regime, smcData, newsRisk, dailyLimits, orderBook, price, fundingRate) {
  const analysis = {
    status: "WAIT",
    headline: "",
    why: [],
    missing: [],
    invalidators: [],
    strategy: null,
    regime: regime?.regime || "UNCERTAIN",
  };

  // Hard blocks first
  if (newsRisk?.blocked) {
    analysis.status = "BLOCKED";
    analysis.headline = `⛔ NEWS BLOCK — Trading halted`;
    analysis.why = [`High-impact news event within ${CONFIG.NEWS_BLOCK_MINUTES}min window: ${newsRisk.reason}`];
    analysis.invalidators = ["Event-driven volatility risk — price may gap without warning"];
    analysis.missing = ["Wait for news event to clear and volatility to normalize"];
    return analysis;
  }
  if (dailyLimits?.blocked) {
    analysis.status = "BLOCKED";
    analysis.headline = `⛔ RISK LIMIT — ${dailyLimits.reason}`;
    analysis.why = [`Risk management gate triggered: ${dailyLimits.reason}`];
    analysis.invalidators = ["Capital preservation takes priority over trade count"];
    analysis.missing = ["Wait for next UTC trading day to reset limits"];
    return analysis;
  }
  // v33 F1: Fee efficiency block
  if (signal?.feeEfficiencyFail) {
    analysis.status = "BLOCKED";
    analysis.headline = `⛔ FEE_EFFICIENCY_FAIL — Blocked: reward after fees too small`;
    analysis.why = [signal.feeEfficiencyReason || "Expected reward < 3× round-trip fee"];
    analysis.invalidators = ["Trade would likely be eaten by fees — no edge after costs"];
    analysis.missing = ["Wait for wider ATR / larger position / better entry to improve reward-to-fee ratio"];
    return analysis;
  }
  // v34 P1: Negative net expectancy
  if (signal?.netExpectancyFail) {
    analysis.status = "WATCH";
    analysis.headline = `⛔ NEGATIVE_NET_EXPECTANCY — Net reward ≤ 0 after fees`;
    analysis.why = [signal.netExpectancyReason || "Expected net reward after fees is zero or negative"];
    analysis.invalidators = ["Position too small relative to fees — no mathematical edge"];
    analysis.missing = ["Need larger ATR / wider TP / bigger position to overcome fee drag"];
    return analysis;
  }
  // v34 P2: Low net RR
  if (signal?.lowNetRR) {
    analysis.status = "WATCH";
    analysis.headline = `⛔ LOW_NET_RR — Net R:R ${signal.lowNetRRReason?.match(/[\d.]+/)?.[0] || "?"} below minimum ${CONFIG.MIN_NET_RR}`;
    analysis.why = [signal.lowNetRRReason || `Net RR after fees below required ${CONFIG.MIN_NET_RR}`];
    analysis.invalidators = ["Risk-adjusted return insufficient after fees"];
    analysis.missing = [`Require net RR ≥ ${CONFIG.MIN_NET_RR} after round-trip fee deduction`];
    return analysis;
  }
  // v34 P4: Trend cooldown
  if (signal?.cooldownReason) {
    analysis.status = "WATCH";
    analysis.headline = `🕐 TREND COOLDOWN — ${signal.direction} entry suppressed`;
    analysis.why = [signal.cooldownReason];
    analysis.invalidators = ["Re-entering same trend direction too soon increases overtrading risk"];
    analysis.missing = [`Wait for ${CONFIG.TREND_COOLDOWN_CANDLES} candles or new BOS/CHoCH before re-entering`];
    return analysis;
  }
  if (!regime || regime.regime === "UNCERTAIN") {
    analysis.status = "WAIT";
    analysis.headline = `⏳ WAIT — Market structure unclear`;
    analysis.why = [`Regime detection: ${regime?.reason || "insufficient data"}`];
    analysis.missing = ["Need at least 60 candles with defined structure", "ADX must exceed 20 or BB width must confirm ranging"];
    analysis.invalidators = ["Entering without regime clarity leads to random-walk trades"];
    return analysis;
  }
  if (regime.regime === "HIGH_VOLATILITY") {
    analysis.status = "WAIT";
    analysis.headline = `⚠️ HIGH VOLATILITY — Defensive mode`;
    analysis.why = [`ATR is elevated (normalized > 1.2%). Stop losses would be oversized.`];
    analysis.missing = ["Wait for ATR to normalize below 0.8% of price"];
    analysis.invalidators = ["Extreme volatility invalidates normal ATR-based position sizing"];
    return analysis;
  }

  analysis.strategy = signal?.strategy;
  analysis.regime = regime.regime;

  // v29: SMC opposition — show as WATCH with clear block reason
  if (signal?.action === "WATCH" && signal?.smcOpposed) {
    analysis.status = "WATCH";
    analysis.headline = `👁️ WATCH — ${signal.direction} blocked by SMC opposition`;
    analysis.why = [
      `⚠ ${signal.smcOppositionReason}`,
      `Regime: ${regime.regime}`,
      ...(signal.factors || []).slice(0, 4).map(f => `→ ${f}`),
    ];
    analysis.missing = ["SMC bias must align with trade direction before entering"];
    analysis.invalidators = ["Trading against SMC bias has historically low win rate"];
    return analysis;
  }

  // v29: WATCH band (75–84) — informational
  if (signal?.action === "WATCH" && !signal?.smcOpposed) {
    analysis.status = "WATCH";
    analysis.headline = `👁️ WATCH — ${signal.direction} ${signal.strategy} at ${signal.confidence?.toFixed(0)}% conf`;
    analysis.why = [
      `Confidence ${signal.confidence?.toFixed(0)}% is in WATCH zone (75–84) — not enough to auto-trade`,
      `Regime: ${regime.regime}`,
      ...(signal.factors || []).slice(0, 3).map(f => `→ ${f}`),
    ];
    analysis.missing = [
      `Need ≥${CONFIG.CONFIDENCE.TRADE}% confidence to open a paper trade`,
      "Enable 'paper trade watch signals' in settings to trade these manually",
    ];
    analysis.invalidators = [];
    return analysis;
  }

  if (!signal || signal.action !== "TRADE") {
    analysis.status = "WAIT";
    // Build specific missing items per regime
    if (regime.regime === "TRENDING") {
      analysis.headline = `⏳ WAIT — Trend setup incomplete`;
      analysis.why = [`ADX: ${regime.adx?.adx?.toFixed(1) || "?"} — Trend active but no valid entry`];
      analysis.missing = [
        "EMA9/21/55 stack alignment needed",
        "MACD histogram must confirm direction",
        `Bullish/Bearish BOS required — current: ${smcData.bosChoch?.bos || "none"}`,
        `Confidence must reach ≥${CONFIG.CONFIDENCE.TRADE}%`,
      ];
      analysis.invalidators = smcData.bosChoch?.choch ? [`CHoCH detected — structure may be reversing`] : [];
    } else if (regime.regime === "RANGING") {
      analysis.headline = `⏳ WAIT — Range setup incomplete`;
      analysis.why = [`ADX ${regime.adx?.adx?.toFixed(1) || "?"} — Market ranging`];
      analysis.missing = [
        "RSI must reach oversold (<35) or overbought (>65)",
        "Price must be at/near BB lower or upper band",
        "Swing high/low proximity required",
      ];
      analysis.invalidators = regime.adx?.adx > 20 ? ["ADX rising — range may be breaking out"] : [];
    } else if (regime.regime === "BREAKOUT") {
      analysis.headline = `⏳ WAIT — Breakout setup incomplete`;
      analysis.why = [`Volume expansion detected but breakout entry conditions not met`];
      analysis.missing = [
        "Clean break above recent swing high (LONG) or below swing low (SHORT)",
        `Volume ratio must exceed 1.8x average — current: ${regime.vol?.ratio?.toFixed(1) || "?"}x`,
        "BB expansion must confirm",
      ];
      analysis.invalidators = smcData.sweep ? ["Liquidity sweep may make this a false breakout"] : [];
    } else if (regime.regime === "REVERSAL") {
      analysis.headline = `⏳ WAIT — Reversal setup incomplete`;
      analysis.why = [`Liquidity sweep detected: ${smcData.sweep?.type || "none"}`];
      analysis.missing = [
        smcData.bosChoch?.choch ? "CHoCH confirmed ✓" : "CHoCH still needed — structure must flip",
        "Price must be in Order Block or FVG",
        "Rejection candle pattern needed for entry",
        smcData.premiumDiscount !== "NEUTRAL" ? `Zone check: ${smcData.premiumDiscount} ✓` : "Discount/Premium zone entry preferred",
      ];
      analysis.invalidators = !smcData.sweep ? ["No liquidity sweep — reversal signal not valid"] : [];
    }
    if (signal?.confidence > 0) {
      analysis.why.push(`Confidence score: ${signal.confidence.toFixed(0)}% (need ≥${CONFIG.CONFIDENCE.TRADE}%)`);
    }
    return analysis;
  }

  // TRADE signal (85+)
  analysis.status = "TRADE";
  analysis.headline = `✅ ${signal.direction} — ${signal.confidenceLabel} ${signal.strategy} setup`;
  analysis.why = [
    `Regime: ${regime.regime} (${regime.reason})`,
    ...(signal.factors || []).map(f => `✓ ${f}`),
  ];
  if (smcData.bosChoch?.bos) analysis.why.push(`✓ ${smcData.bosChoch.bos} BOS confirmed`);
  if (smcData.bosChoch?.choch) analysis.why.push(`✓ ${smcData.bosChoch.choch} CHoCH`);
  if (smcData.premiumDiscount !== "NEUTRAL") {
    const zoneGood = (signal.direction === "LONG" && smcData.premiumDiscount === "DISCOUNT") ||
                     (signal.direction === "SHORT" && smcData.premiumDiscount === "PREMIUM");
    analysis.why.push(`${zoneGood ? "✓" : "⚠"} Price at ${smcData.premiumDiscount} zone`);
  }
  if (fundingRate !== null) {
    analysis.why.push(`Funding: ${(fundingRate * 100).toFixed(4)}% — ${fundingRate > 0 ? "Longs paying (favors SHORT)" : "Shorts paying (favors LONG)"}`);
  }

  // Invalidators
  analysis.invalidators = [];
  if (signal.direction === "LONG") {
    analysis.invalidators.push("Bearish BOS or CHoCH would invalidate long bias");
    analysis.invalidators.push("Price closing below EMA21 on next candle");
    if (smcData.swings?.lows?.length) analysis.invalidators.push(`Break below swing low ${formatPrice(Math.min(...smcData.swings.lows.map(l => l.price)))}`);
  } else {
    analysis.invalidators.push("Bullish BOS or CHoCH would invalidate short bias");
    analysis.invalidators.push("Price closing above EMA21 on next candle");
    if (smcData.swings?.highs?.length) analysis.invalidators.push(`Break above swing high ${formatPrice(Math.max(...smcData.swings.highs.map(h => h.price)))}`);
  }
  if (newsRisk?.events?.length > 0) {
    analysis.invalidators.push(`Upcoming event: ${newsRisk.events[0].title}`);
  }

  return analysis;
}

// ============================================================
// 6d. CONFIDENCE CALIBRATION ENGINE
// v29: Updated bands — WATCH (75-84), STRONG (85-94), EXCEPTIONAL (95+)
// ============================================================
function calcConfidenceCalibration(closedTrades) {
  const bands = [
    { label: "EXCEPTIONAL", min: 95, max: 100, expected: 80, color: "#00ff9d" },
    { label: "STRONG",      min: 85, max: 94,  expected: 60, color: "#4db8ff" },
    { label: "WATCH",       min: 75, max: 84,  expected: 50, color: "#ffd700",
      note: "WATCH band — trades only opened if 'paper trade watch signals' is ON" },
  ];
  return bands.map(band => {
    const inBand = closedTrades.filter(t => t.confidence >= band.min && t.confidence <= band.max);
    const wins = inBand.filter(t => (t.pnl?.netPnL || 0) > 0).length;
    const actual = inBand.length > 0 ? (wins / inBand.length * 100) : null;
    const pnl = inBand.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
    const inflated = actual !== null && actual < band.expected - 10;
    return { ...band, count: inBand.length, wins, actual, pnl, inflated };
  });
}

// ============================================================
// 7. RISK ENGINE
// v34 P3: TP distance guard — grossReward must be ≥ 3× round-trip fee
// ============================================================
function calcRiskLevels(direction, entryPrice, atr, accountBalance) {
  if (!entryPrice || !atr) return null;
  const slDist = atr * CONFIG.ATR_MULTIPLIER_SL;
  let tpDist = atr * CONFIG.ATR_MULTIPLIER_TP;
  if (tpDist / slDist < CONFIG.MIN_RR) return null;

  // v34 P3: Ensure grossReward ≥ 3× estimated round-trip fee
  const sizing = calcPositionSize(entryPrice, atr, accountBalance);
  if (!sizing) return null;
  const notional = entryPrice * sizing.btcQty;
  const roundTripFee = notional * CONFIG.TAKER_FEE * 2;
  const minTpDist = (3 * roundTripFee) / sizing.btcQty;
  if (tpDist < minTpDist) tpDist = minTpDist; // extend TP to meet fee threshold

  const sl = direction === "LONG" ? entryPrice - slDist : entryPrice + slDist;
  const tp = direction === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;
  const rr = tpDist / slDist;
  if (rr < CONFIG.MIN_RR) return null;
  return { sl, tp, rr, slDist, tpDist, ...sizing };
}

function checkDailyLimits(trades, accountBalance) {
  const today = new Date().toDateString();
  const todayTrades = trades.filter(t => new Date(t.entryTime).toDateString() === today);
  const closedToday = todayTrades.filter(t => t.status === "closed");
  const dailyPnL = closedToday.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
  const dailyLossLimit = (accountBalance * CONFIG.DAILY_LOSS_LIMIT) / 100;
  const consecutiveLosses = getConsecutiveLosses(closedToday);
  return {
    blocked: dailyPnL <= -dailyLossLimit || consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES || closedToday.length >= CONFIG.MAX_DAILY_TRADES,
    reason: dailyPnL <= -dailyLossLimit ? "Daily loss limit reached" : consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES ? `${consecutiveLosses} consecutive losses` : closedToday.length >= CONFIG.MAX_DAILY_TRADES ? "Max daily trades reached" : null,
    dailyPnL, consecutiveLosses, tradesCount: closedToday.length,
  };
}

function getConsecutiveLosses(trades) {
  let count = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if ((trades[i].pnl?.netPnL || 0) < 0) count++;
    else break;
  }
  return count;
}

// ============================================================
// 8. NEWS ENGINE
// ============================================================
function checkNewsRisk(newsData) {
  if (!newsData || newsData.length === 0) return { blocked: false, score: 0, events: [] };
  const now = Date.now();
  const windowMs = CONFIG.NEWS_BLOCK_MINUTES * 60 * 1000;
  const upcoming = newsData.filter(e => {
    const eventTime = new Date(e.date).getTime();
    return Math.abs(eventTime - now) < windowMs;
  });
  const highImpact = upcoming.filter(e => e.impact === "High");
  const score = highImpact.length > 0 ? 100 : upcoming.length > 0 ? 60 : 0;
  return { blocked: highImpact.length > 0, score, events: upcoming.slice(0, 3), reason: highImpact.length > 0 ? `High impact: ${highImpact[0]?.title}` : null };
}

// ============================================================
// 9. SESSION DETECTION
// ============================================================
function detectSession() {
  const hour = new Date().getUTCHours();
  if (hour >= 23 || hour < 8) return SESSIONS.ASIA;
  if (hour >= 8 && hour < 12) return SESSIONS.LONDON;
  if (hour >= 13 && hour < 22) return SESSIONS.NEW_YORK;
  return SESSIONS.OFF;
}

// ============================================================
// 10. TRADE HEALTH ENGINE v30 — Closed-candle-only + ATR significance filter
// Patience mode aware: no health exit before patience threshold
// patienceMode: "CONSERVATIVE" | "NORMAL" | "PATIENT" | "SWING_TEST"
// ============================================================
function calcTradeHealth(trade, currentPrice, candles, smcData, patienceMode = "PATIENT") {
  if (!trade || !currentPrice) return { score: 100, action: "HOLD", phase: "OBSERVE" };
  const atr = calcATR(candles) || 1;
  const elapsed = (Date.now() - trade.entryTime) / 1000;

  // Only use CLOSED candles for health scoring (v30 fix — no forming-candle penalty)
  const closedCandles = candles.filter(c => c.closed);
  const closedCandlesSinceEntry = closedCandles.filter(c => c.t > trade.entryTime).length;

  // Patience thresholds
  const minHoldCandles = {
    CONSERVATIVE: CONFIG.MIN_HOLD_CANDLES,   // 3
    NORMAL:       CONFIG.MIN_HOLD_CANDLES,   // 3
    PATIENT:      CONFIG.PATIENT_MIN_CANDLES, // 5
    SWING_TEST:   9999,                       // run until SL/TP only
  }[patienceMode] || CONFIG.PATIENT_MIN_CANDLES;

  // PHASE 1: Observation — first 60 seconds, emergency exit only
  if (elapsed < CONFIG.MIN_HOLD_SECONDS) {
    const adverseMove = trade.direction === "LONG" ? (trade.entry - currentPrice) / atr : (currentPrice - trade.entry) / atr;
    if (adverseMove > 3) return { score: 0, action: "CLOSE", reason: "Emergency: 3x ATR immediate adverse", phase: "EMERGENCY" };
    return { score: 100, action: "OBSERVE", reason: `Phase 1: Observation (${elapsed.toFixed(0)}s / 60s)`, phase: "OBSERVE" };
  }

  // SL/TP always trigger regardless of patience
  if (trade.direction === "LONG" && currentPrice <= trade.sl) return { score: 0, action: "CLOSE", reason: "Stop loss hit", phase: "SL" };
  if (trade.direction === "SHORT" && currentPrice >= trade.sl) return { score: 0, action: "CLOSE", reason: "Stop loss hit", phase: "SL" };
  if (trade.direction === "LONG" && currentPrice >= trade.tp) return { score: 100, action: "CLOSE", reason: "Take profit reached", phase: "TP" };
  if (trade.direction === "SHORT" && currentPrice <= trade.tp) return { score: 100, action: "CLOSE", reason: "Take profit reached", phase: "TP" };

  // SWING_TEST mode: only SL/TP exits, no health scoring
  if (patienceMode === "SWING_TEST") {
    const pnlPct = trade.direction === "LONG" ? (currentPrice - trade.entry) / trade.entry : (trade.entry - currentPrice) / trade.entry;
    return { score: 90, action: "HOLD", reason: `Swing Test mode — hold until SL/TP. Current: ${(pnlPct * 100).toFixed(2)}%`, phase: "SWING_TEST" };
  }

  // PHASE 2: Minimum candle patience hold — no health exits, only SL/TP (already handled above)
  if (closedCandlesSinceEntry < minHoldCandles) {
    return { score: 90, action: "HOLD", reason: `Patience hold: ${closedCandlesSinceEntry}/${minHoldCandles} closed candles`, phase: "PATIENCE" };
  }

  // PHASE 3: Active health scoring — closed candles only
  let score = 100;
  const factors = [];
  const weaknessSignals = [];

  // v30: ATR candle significance filter — only closed candles after entry
  const recentClosed = closedCandles.filter(c => c.t > trade.entryTime).slice(-5);
  recentClosed.forEach(c => {
    const body = Math.abs(c.c - c.o);
    const atrRatio = body / atr;
    const isOpposite = trade.direction === "LONG" ? c.c < c.o : c.c > c.o;
    if (isOpposite) {
      if (atrRatio < 0.25) {
        // <0.25 ATR body — ignore entirely
      } else if (atrRatio < 0.5) {
        // Minor warning only
        weaknessSignals.push({ level: "minor", msg: `Minor opposite candle (${atrRatio.toFixed(2)}x ATR)` });
      } else if (atrRatio < 1.0) {
        // Moderate warning
        weaknessSignals.push({ level: "moderate", msg: `Moderate opposite candle (${atrRatio.toFixed(2)}x ATR)` });
      } else {
        // Strong warning
        weaknessSignals.push({ level: "strong", msg: `Strong opposite candle (${atrRatio.toFixed(2)}x ATR)` });
      }
    }
  });

  // Count strong weakness signals — need 2+ confirmed or 1 major structural event
  const strongCount = weaknessSignals.filter(s => s.level === "strong").length;
  const moderateCount = weaknessSignals.filter(s => s.level === "moderate").length;

  // v30: Only reduce score on CLOSED candle evidence, not forming candle
  if (strongCount >= 2) { score -= 35; factors.push(`${strongCount} strong opposite candles`); }
  else if (strongCount === 1 && moderateCount >= 1) { score -= 20; factors.push("Mixed opposite pressure"); }
  else if (moderateCount >= 2) { score -= 15; factors.push(`${moderateCount} moderate opposite candles`); }
  else if (weaknessSignals.length > 0) { score -= 5; factors.push("Minor opposite pressure (monitoring)"); }

  // Structural invalidation — high weight (major invalidation)
  const bosDir = smcData.bosChoch?.bos;
  if (bosDir) {
    if (trade.direction === "LONG" && bosDir === "BEARISH") { score -= 25; factors.push("Bearish BOS — structural invalidation"); }
    if (trade.direction === "SHORT" && bosDir === "BULLISH") { score -= 25; factors.push("Bullish BOS — structural invalidation"); }
  }
  const chochDir = smcData.bosChoch?.choch;
  if (chochDir) {
    if (trade.direction === "LONG" && chochDir === "BEARISH") { score -= 20; factors.push("Bearish CHoCH — structure flipped"); }
    if (trade.direction === "SHORT" && chochDir === "BULLISH") { score -= 20; factors.push("Bullish CHoCH — structure flipped"); }
  }

  // EMA21 invalidation — closed candles only
  const closes = closedCandles.map(c => c.c);
  if (closes.length >= 21) {
    const ema21 = calcEMA(closes, 21);
    const lastEMA = ema21[ema21.length - 1];
    if (trade.direction === "LONG" && currentPrice < lastEMA * 0.997) { score -= 15; factors.push("Confirmed EMA21 loss"); }
    else if (trade.direction === "SHORT" && currentPrice > lastEMA * 1.003) { score -= 15; factors.push("Confirmed EMA21 reclaim"); }
  }

  // Large adverse move (2x+ ATR)
  const adverseMove = trade.direction === "LONG" ? (trade.entry - currentPrice) / atr : (currentPrice - trade.entry) / atr;
  if (adverseMove > 2) { score -= 25; factors.push(`Adverse move ${adverseMove.toFixed(1)}x ATR`); }
  else if (adverseMove > 1) { score -= 10; factors.push(`Mild adverse ${adverseMove.toFixed(1)}x ATR`); }

  // v30: CONSERVATIVE needs 1 confirmed weakness signal to exit
  // NORMAL needs 2+ confirmed weakness signals OR 1 major structural event
  // PATIENT needs 2-3 confirmed weakness OR 2 consecutive closed candles OR major structural
  let closeThreshold = 30;
  if (patienceMode === "CONSERVATIVE") closeThreshold = 45;
  else if (patienceMode === "NORMAL") closeThreshold = 35;
  else if (patienceMode === "PATIENT") closeThreshold = 25; // needs more evidence to close

  if (score <= closeThreshold) return { score, action: "CLOSE", reason: `Health critical: ${factors.join(", ") || "multiple invalidations"}`, phase: "ACTIVE" };
  if (score <= 55) return { score, action: "WARN", reason: factors.join(", ") || "Monitoring weakness", phase: "ACTIVE" };
  return { score, action: "HOLD", reason: factors.join(", ") || "Trade valid", phase: "ACTIVE" };
}

// ============================================================
// 11. PAPER TRADE ENGINE v30 — Unlimited paper, patience modes,
//     WATCH_PAPER tagging, trade outcome learning (MFE/MAE/1R-5R),
//     exit style parallel simulation
// ============================================================
class PaperTradeEngine {
  constructor() {
    this.positions = [];
    this.trades = [];         // paper positions only (TRADE signals that executed)
    this.signalLog = [];      // ALL signals: TRADE + WAIT + WATCH + FILTERED
    this.seenSignalIds = new Set();
    this.counter = 0;
    // v31: Post-exit simulation tracker
    // Keyed by trade.id; each entry holds the trade snapshot + ongoing sim state
    this.postExitSims = {};   // { [tradeId]: PostExitSimEntry }
  }

  hasPosition(signalId) {
    return this.seenSignalIds.has(signalId);
  }

  // Log every signal — called for ALL signals regardless of action
  logSignal(signal, filteredBy = null) {
    if (!signal?.signalId) return;
    // Avoid duplicate log entries for same signal ID
    if (this.signalLog.some(s => s.signalId === signal.signalId)) return;
    this.signalLog.push({
      signalId: signal.signalId,
      action: signal.action,
      direction: signal.direction || null,
      strategy: signal.strategy || null,
      regime: signal.regime || null,
      confidence: signal.confidence || 0,
      confidenceLabel: signal.confidenceLabel || null,
      factors: signal.factors || [],
      reason: signal.reason || null,
      filteredBy,   // "NEWS", "DAILY_LIMIT", "WATCH_BAND", "SMC_OPPOSITION", null
      smcOpposed: signal.smcOpposed || false,
      smcOppositionReason: signal.smcOppositionReason || null,
      loggedAt: Date.now(),
      candleOpenTime: signal.candleOpenTime || null,
      tradedAs: null, // will be set to trade.id if trade opened, "BLOCKED" if blocked
    });
  }

  // v34: Patch an existing signal log entry's filteredBy and tradedAs fields.
  // Called after fee-gate or block-reason is determined — the entry already exists.
  updateSignalLog(signalId, { filteredBy, tradedAs, blockedDetails, feeEfficiencyWarning } = {}) {
    const entry = this.signalLog.find(s => s.signalId === signalId);
    if (!entry) return;
    if (filteredBy !== undefined) entry.filteredBy = filteredBy;
    if (tradedAs !== undefined) entry.tradedAs = tradedAs;
    if (blockedDetails !== undefined) entry.blockedDetails = blockedDetails;
    if (feeEfficiencyWarning !== undefined) entry.feeEfficiencyWarning = feeEfficiencyWarning;
  }

  // v29: enter accepts sizingSettings for manual mode
  // paperRiskLockRespected: if true, checks daily limits before entering paper trade
  enter(signal, riskLevels, currentPrice, regime, smcData, newsRisk, session, fundingRate, sizingSettings = null) {
    if (!riskLevels || !signal.signalId) return null;
    if (this.seenSignalIds.has(signal.signalId)) return null;
    this.seenSignalIds.add(signal.signalId);
    const id = `paper_${Date.now()}_${++this.counter}`;

    // v32: Determine sizing mode — Delta BTCUSD: 1 lot = 0.001 BTC
    const sizingMode = sizingSettings?.mode === "manual" ? "manual" : "auto";
    const usedLeverage = sizingMode === "manual" ? (sizingSettings.leverage || CONFIG.LEVERAGE) : CONFIG.LEVERAGE;
    const usedLots = sizingMode === "manual" ? (sizingSettings.lots || riskLevels.deltaContracts) : riskLevels.deltaContracts;
    // Manual: 1 lot = 0.001 BTC → btcQty = lots × 0.001
    const usedBtcQty = sizingMode === "manual"
      ? usedLots * 0.001
      : riskLevels.btcQty;
    const usedNotional = sizingMode === "manual"
      ? usedBtcQty * currentPrice   // notional = btcQty × price
      : riskLevels.notionalUSDT;
    const usedMargin = usedNotional / usedLeverage;

    // v32: Capture SMC context at entry for replay
    const entryBos = smcData.bosChoch?.bos || null;
    const entryChoch = smcData.bosChoch?.choch || null;
    const entrySweep = smcData.sweep ? { type: smcData.sweep.type, level: smcData.sweep.level } : null;
    // Order book wall at entry
    const obWallResult = (() => {
      try {
        const ob = smcData._orderBook;
        if (!ob || !ob.bids?.length) return null;
        const avgBidQty = ob.bids.reduce((s, b) => s + b.qty, 0) / ob.bids.length;
        const largeBid = ob.bids.find(b => b.qty > avgBidQty * 5 && b.price < currentPrice);
        const largeAsk = ob.asks?.find(a => a.qty > avgBidQty * 5 && a.price > currentPrice);
        if (largeBid) return { side: "BID", level: largeBid.price };
        if (largeAsk) return { side: "ASK", level: largeAsk.price };
      } catch {}
      return null;
    })();

    const trade = {
      id, type: "paper",
      signalId: signal.signalId,
      direction: signal.direction,
      strategy: signal.strategy,
      regime, confidence: signal.confidence,
      confidenceLabel: signal.confidenceLabel || null,
      entry: currentPrice,
      sl: riskLevels.sl,
      tp: riskLevels.tp,
      rr: riskLevels.rr,
      btcQty: usedBtcQty,
      notionalUSDT: usedNotional,
      deltaContracts: usedLots,
      marginUsed: usedMargin,
      leverage: usedLeverage,
      sizingMode,
      lots: usedLots,
      feeRate: CONFIG.TAKER_FEE, // v29: always taker for paper trades
      riskUSDT: riskLevels.riskUSDT,
      entryTime: Date.now(),
      status: "open",
      session, newsRisk: newsRisk.score,
      factors: signal.factors,
      smcBias: smcData.bosChoch?.bias || "NEUTRAL",
      smcOpposed: signal.smcOpposed || false,
      // v34: Fee efficiency warning (WARN_ONLY mode — trade still executes)
      feeEfficiencyWarning: signal.feeEfficiencyWarning || false,
      feeEfficiencyReason: signal.feeEfficiencyReason || null,
      // v32: SMC context at entry for replay
      entryBos,
      entryChoch,
      entrySweep,
      entryOrderBookWall: obWallResult,
      mfe: 0, mae: 0,
      // v30: R-multiple tracking
      reached1R: false, reached2R: false, reached3R: false, reached5R: false,
      maxRR: 0,
      // v32: Health score history for replay chart (sampled every update)
      healthHistory: [],
      // v30: Exit style parallel simulations (closed when main trade closes)
      exitStyleSims: {
        sltp: { active: true, exitPrice: null, exitReason: null, pnl: null },
        trailing: { active: true, trailingStop: null, exitPrice: null, exitReason: null, pnl: null },
        patient: { active: true, warningCount: 0, exitPrice: null, exitReason: null, pnl: null },
        swing: { active: true, exitPrice: null, exitReason: null, pnl: null },
      },
      pnl: null,
      fundingRate: fundingRate || 0,
      health: null,
      // v31: post-exit simulation state (populated when trade closes)
      postExitSim: null,
      // v34: net expectancy at entry
      netExpectancy: calcNetExpectancy(riskLevels.tpDist, riskLevels.slDist, usedBtcQty, currentPrice),
      duplicateSetup: signal.duplicateSetup || false,
      sessionPenaltyApplied: signal.sessionPenaltyApplied || false,
    };
    // Link signal log entry to this trade — tradedAs = trade ID (string, not null)
    const logEntry = this.signalLog.find(s => s.signalId === signal.signalId);
    if (logEntry) { logEntry.tradedAs = id; logEntry.filteredBy = null; }
    this.positions.push(trade);
    this.trades.push(trade);
    return trade;
  }

  updateAll(currentPrice, candles, smcData, patienceMode = "PATIENT") {
    for (let i = 0; i < this.positions.length; i++) {
      const t = this.positions[i];
      if (t.status !== "open") continue;
      const holdHours = (Date.now() - t.entryTime) / 3600000;
      const pnlObj = calcFuturesPnL({
        direction: t.direction, entry: t.entry, exit: currentPrice,
        btcQty: t.btcQty, leverage: t.leverage || CONFIG.LEVERAGE,
        fundingRate: t.fundingRate, holdHours,
        feeRate: t.feeRate || CONFIG.TAKER_FEE,
      });
      const pnlPct = ((currentPrice - t.entry) / t.entry) * (t.direction === "LONG" ? 1 : -1);
      t.mfe = Math.max(t.mfe, pnlPct);
      t.mae = Math.min(t.mae, pnlPct);
      t.currentPnL = pnlObj;

      // v30: Track R-multiple milestones
      const slDist = Math.abs(t.entry - t.sl);
      if (slDist > 0) {
        const currentR = (t.direction === "LONG" ? currentPrice - t.entry : t.entry - currentPrice) / slDist;
        t.maxRR = Math.max(t.maxRR || 0, currentR);
        if (currentR >= 1 && !t.reached1R) t.reached1R = true;
        if (currentR >= 2 && !t.reached2R) t.reached2R = true;
        if (currentR >= 3 && !t.reached3R) t.reached3R = true;
        if (currentR >= 5 && !t.reached5R) t.reached5R = true;
      }

      // v30: Update exit style simulations
      this._updateExitStyleSims(t, currentPrice, candles, holdHours);

      // ── BUG FIX v33.x: SL/TP closure must happen BEFORE health exit ──
      // Also check candle high/low (wicks) for SL/TP hits, not just close price.
      const lastCandle = candles[candles.length - 1];
      const candleHigh = lastCandle?.h ?? currentPrice;
      const candleLow  = lastCandle?.l ?? currentPrice;

      let slHit = false, tpHit = false, slTpExitPrice = currentPrice, slTpReason = "";
      if (t.direction === "LONG") {
        if (candleLow <= t.sl)  { slHit = true;  slTpExitPrice = t.sl;  slTpReason = "STOP_LOSS"; }
        if (candleHigh >= t.tp) { tpHit = true;  slTpExitPrice = t.tp;  slTpReason = "TAKE_PROFIT"; }
        // If both wick hit SL and TP in same candle, SL wins (conservative)
        if (slHit && tpHit) { tpHit = false; slTpExitPrice = t.sl; slTpReason = "STOP_LOSS"; }
      } else {
        if (candleHigh >= t.sl) { slHit = true;  slTpExitPrice = t.sl;  slTpReason = "STOP_LOSS"; }
        if (candleLow  <= t.tp) { tpHit = true;  slTpExitPrice = t.tp;  slTpReason = "TAKE_PROFIT"; }
        if (slHit && tpHit) { tpHit = false; slTpExitPrice = t.sl; slTpReason = "STOP_LOSS"; }
      }

      if (slHit || tpHit) {
        const finalPnL = calcFuturesPnL({
          direction: t.direction, entry: t.entry, exit: slTpExitPrice,
          btcQty: t.btcQty, leverage: t.leverage || CONFIG.LEVERAGE,
          fundingRate: t.fundingRate, holdHours,
          feeRate: t.feeRate || CONFIG.TAKER_FEE,
        });
        t.status = "closed";
        t.exitTime = Date.now();
        t.exitReason = slTpReason;
        t.exit = slTpExitPrice;
        t.pnl = finalPnL;
        t.wasEarlyExit = false; // SL/TP is never an early exit

        // Update health history with final SL/TP snapshot
        if (!t.healthHistory) t.healthHistory = [];
        t.healthHistory.push({ t: Date.now(), score: tpHit ? 100 : 0, action: "CLOSE", reason: slTpReason, phase: tpHit ? "TP" : "SL" });
        if (t.healthHistory.length > 200) t.healthHistory.splice(0, t.healthHistory.length - 200);

        this._startPostExitSim(t, slTpExitPrice, candles);
        try { regimeAccuracy.recordOutcome(t); } catch {}
        try { journalStore.saveAll(this); } catch {}
        this.positions.splice(i, 1);
        i--;
        continue; // skip health check — SL/TP takes priority
      }

      // ── Health exit (only runs if SL/TP not hit) ──
      const health = calcTradeHealth(t, currentPrice, candles, smcData, patienceMode);
      t.health = health;
      // v33 F4: Append health snapshot to healthHistory (capped at 200)
      if (!t.healthHistory) t.healthHistory = [];
      t.healthHistory.push({
        t: Date.now(),
        score: health.score,
        action: health.action,
        reason: health.reason,
        phase: health.phase,
      });
      if (t.healthHistory.length > 200) t.healthHistory.splice(0, t.healthHistory.length - 200);
      if (health.action === "CLOSE") {
        const finalPnL = calcFuturesPnL({
          direction: t.direction, entry: t.entry, exit: currentPrice,
          btcQty: t.btcQty, leverage: t.leverage || CONFIG.LEVERAGE,
          fundingRate: t.fundingRate, holdHours,
          feeRate: t.feeRate || CONFIG.TAKER_FEE,
        });
        t.status = "closed";
        t.exitTime = Date.now();
        t.exitReason = health.reason;
        t.exit = currentPrice;
        t.pnl = finalPnL;
        // v30: Check if health exit was "early" (trade later reached TP)
        t.wasEarlyExit = health.phase !== "SL" && health.phase !== "TP" && !t.reached3R;

        // v31: Start post-exit simulation for this trade
        this._startPostExitSim(t, currentPrice, candles);

        // v32: Record regime accuracy outcome
        try { regimeAccuracy.recordOutcome(t); } catch {}
        // v32: Persist to localStorage
        try { journalStore.saveAll(this); } catch {}

        this.positions.splice(i, 1);
        i--;
      }
    }

    // v31: Tick all active post-exit sims on every price update
    this._tickPostExitSims(currentPrice, candles);
  }

  // v30: Update parallel exit style simulations
  _updateExitStyleSims(t, currentPrice, candles, holdHours) {
    if (!t.exitStyleSims) return;
    const atr = calcATR(candles) || 1;
    const calcPnL = (exit) => calcFuturesPnL({
      direction: t.direction, entry: t.entry, exit,
      btcQty: t.btcQty, leverage: t.leverage || CONFIG.LEVERAGE,
      fundingRate: t.fundingRate, holdHours, feeRate: t.feeRate || CONFIG.TAKER_FEE,
    });

    // SL/TP only sim: stays open until actual SL or TP hit
    const sim = t.exitStyleSims;
    if (sim.sltp.active) {
      const hitSL = t.direction === "LONG" ? currentPrice <= t.sl : currentPrice >= t.sl;
      const hitTP = t.direction === "LONG" ? currentPrice >= t.tp : currentPrice <= t.tp;
      if (hitSL) { sim.sltp.active = false; sim.sltp.exitPrice = t.sl; sim.sltp.exitReason = "SL"; sim.sltp.pnl = calcPnL(t.sl); }
      else if (hitTP) { sim.sltp.active = false; sim.sltp.exitPrice = t.tp; sim.sltp.exitReason = "TP"; sim.sltp.pnl = calcPnL(t.tp); }
    }

    // Trailing stop sim: trail at 1.5x ATR from highest/lowest reached
    if (sim.trailing.active) {
      if (sim.trailing.trailingStop === null) sim.trailing.trailingStop = t.sl;
      if (t.direction === "LONG") {
        const newStop = currentPrice - atr * 1.5;
        if (newStop > sim.trailing.trailingStop) sim.trailing.trailingStop = newStop;
        if (currentPrice <= sim.trailing.trailingStop) { sim.trailing.active = false; sim.trailing.exitPrice = sim.trailing.trailingStop; sim.trailing.exitReason = "TRAILING_STOP"; sim.trailing.pnl = calcPnL(sim.trailing.trailingStop); }
      } else {
        const newStop = currentPrice + atr * 1.5;
        if (newStop < sim.trailing.trailingStop || sim.trailing.trailingStop === t.sl) sim.trailing.trailingStop = newStop;
        if (currentPrice >= sim.trailing.trailingStop) { sim.trailing.active = false; sim.trailing.exitPrice = sim.trailing.trailingStop; sim.trailing.exitReason = "TRAILING_STOP"; sim.trailing.pnl = calcPnL(sim.trailing.trailingStop); }
      }
      // Also close on SL/TP
      const hitSL = t.direction === "LONG" ? currentPrice <= t.sl : currentPrice >= t.sl;
      const hitTP = t.direction === "LONG" ? currentPrice >= t.tp : currentPrice <= t.tp;
      if (hitSL) { sim.trailing.active = false; sim.trailing.exitPrice = t.sl; sim.trailing.exitReason = "SL"; sim.trailing.pnl = calcPnL(t.sl); }
      else if (hitTP) { sim.trailing.active = false; sim.trailing.exitPrice = t.tp; sim.trailing.exitReason = "TP"; sim.trailing.pnl = calcPnL(t.tp); }
    }

    // Patient health exit sim: only exits on major structural invalidation (not minor warnings)
    if (sim.patient.active) {
      const hitSL = t.direction === "LONG" ? currentPrice <= t.sl : currentPrice >= t.sl;
      const hitTP = t.direction === "LONG" ? currentPrice >= t.tp : currentPrice <= t.tp;
      if (hitSL) { sim.patient.active = false; sim.patient.exitPrice = t.sl; sim.patient.exitReason = "SL"; sim.patient.pnl = calcPnL(t.sl); }
      else if (hitTP) { sim.patient.active = false; sim.patient.exitPrice = t.tp; sim.patient.exitReason = "TP"; sim.patient.pnl = calcPnL(t.tp); }
      // Patient: only exits on critical structural invalidation (score <= 15)
      const patientHealth = calcTradeHealth(t, currentPrice, candles, {}, "SWING_TEST");
      if (patientHealth.score <= 10) { sim.patient.active = false; sim.patient.exitPrice = currentPrice; sim.patient.exitReason = "MAJOR_INVALIDATION"; sim.patient.pnl = calcPnL(currentPrice); }
    }

    // v31: Swing test sim — holds until exact SL or TP, no health exits at all
    if (sim.swing && sim.swing.active) {
      const hitSL = t.direction === "LONG" ? currentPrice <= t.sl : currentPrice >= t.sl;
      const hitTP = t.direction === "LONG" ? currentPrice >= t.tp : currentPrice <= t.tp;
      if (hitSL) { sim.swing.active = false; sim.swing.exitPrice = t.sl; sim.swing.exitReason = "SL"; sim.swing.pnl = calcPnL(t.sl); }
      else if (hitTP) { sim.swing.active = false; sim.swing.exitPrice = t.tp; sim.swing.exitReason = "TP"; sim.swing.pnl = calcPnL(t.tp); }
    }
  }

  // v31: Start post-exit simulation for a trade that just closed
  // Captures snapshot of state at exit, then continues to track remaining sims
  _startPostExitSim(trade, exitPrice, candles) {
    // Only simulate if at least one of the style sims is still incomplete at exit time
    const sim = trade.exitStyleSims;
    const anySimStillActive = sim && (
      (sim.sltp && sim.sltp.active) ||
      (sim.trailing && sim.trailing.active) ||
      (sim.patient && sim.patient.active) ||
      (sim.swing && sim.swing.active)
    );

    // Always create a post-exit record to track what happened after normal exit
    const postExitEntry = {
      tradeId: trade.id,
      direction: trade.direction,
      entry: trade.entry,
      normalExitPrice: exitPrice,
      normalExitReason: trade.exitReason,
      normalExitPnL: trade.pnl?.netPnL ?? null,
      sl: trade.sl,
      tp: trade.tp,
      btcQty: trade.btcQty,
      leverage: trade.leverage || CONFIG.LEVERAGE,
      fundingRate: trade.fundingRate || 0,
      feeRate: trade.feeRate || CONFIG.TAKER_FEE,
      exitTime: trade.exitTime,
      wasEarlyExit: trade.wasEarlyExit || false,
      // Copy any sims that haven't yet completed — they continue in post-exit window
      sims: {
        sltp: sim?.sltp ? { ...sim.sltp } : { active: false, exitPrice: null, exitReason: "COMPLETED_PRE_EXIT", pnl: sim?.sltp?.pnl ?? null },
        trailing: sim?.trailing ? { ...sim.trailing } : { active: false, exitPrice: null, exitReason: "COMPLETED_PRE_EXIT", pnl: null },
        patient: sim?.patient ? { ...sim.patient } : { active: false, exitPrice: null, exitReason: "COMPLETED_PRE_EXIT", pnl: null },
        swing: sim?.swing ? { ...sim.swing } : { active: false, exitPrice: null, exitReason: "COMPLETED_PRE_EXIT", pnl: null },
      },
      // Post-exit tracking
      postExitCandleCount: 0,
      expired: false,
      // Whether price reached TP after normal exit
      laterHitTP: false,
      laterHit1R: false,
      laterHit2R: false,
      laterHit3R: false,
      laterHit5R: false,
      // Best style determination (computed when all sims complete or expire)
      bestExitStyle: null,
    };

    // If no active sims remain, still record but mark as immediately expired
    if (!anySimStillActive) {
      postExitEntry.expired = true;
      postExitEntry.bestExitStyle = this._computeBestExitStyle(postExitEntry, trade);
    }

    this.postExitSims[trade.id] = postExitEntry;
    // Link back to trade
    trade.postExitSim = postExitEntry;
  }

  // v31: Tick all post-exit sims on each price update
  // v33 F2: postExitCandleCount only increments on closed candles, not every tick
  _tickPostExitSims(currentPrice, candles) {
    const atr = calcATR(candles) || 1;
    const now = Date.now();
    // Determine if the latest candle is closed
    const lastCandle = candles[candles.length - 1];
    const isClosedCandle = lastCandle && lastCandle.closed === true;

    for (const id of Object.keys(this.postExitSims)) {
      const pe = this.postExitSims[id];
      if (pe.expired) continue;

      // v33 F2 / v33.1: Only count each unique closed candle once
      if (isClosedCandle && lastCandle.t !== pe.lastPostExitCountedCandleTime) {
        pe.postExitCandleCount++;
        pe.lastPostExitCountedCandleTime = lastCandle.t;
      }
      const elapsedHours = (now - pe.exitTime) / 3600000;

      // Check expiry: 50 candles OR 24 hours
      const expired =
        pe.postExitCandleCount >= CONFIG.POST_EXIT_MAX_CANDLES ||
        elapsedHours >= CONFIG.POST_EXIT_MAX_HOURS;

      // Check if all sims completed
      const allDone =
        !pe.sims.sltp.active &&
        !pe.sims.trailing.active &&
        !pe.sims.patient.active &&
        !pe.sims.swing.active;

      if (expired || allDone) {
        pe.expired = true;
        // Force-close any still-active sims at current price on expiry
        const calcPnL = (exit, holdHours) => calcFuturesPnL({
          direction: pe.direction, entry: pe.entry, exit,
          btcQty: pe.btcQty, leverage: pe.leverage,
          fundingRate: pe.fundingRate,
          holdHours: holdHours || elapsedHours,
          feeRate: pe.feeRate,
        });
        if (pe.sims.sltp.active) { pe.sims.sltp.active = false; pe.sims.sltp.exitPrice = currentPrice; pe.sims.sltp.exitReason = "EXPIRED"; pe.sims.sltp.pnl = calcPnL(currentPrice); }
        if (pe.sims.trailing.active) { pe.sims.trailing.active = false; pe.sims.trailing.exitPrice = currentPrice; pe.sims.trailing.exitReason = "EXPIRED"; pe.sims.trailing.pnl = calcPnL(currentPrice); }
        if (pe.sims.patient.active) { pe.sims.patient.active = false; pe.sims.patient.exitPrice = currentPrice; pe.sims.patient.exitReason = "EXPIRED"; pe.sims.patient.pnl = calcPnL(currentPrice); }
        if (pe.sims.swing.active) { pe.sims.swing.active = false; pe.sims.swing.exitPrice = currentPrice; pe.sims.swing.exitReason = "EXPIRED"; pe.sims.swing.pnl = calcPnL(currentPrice); }
        pe.bestExitStyle = this._computeBestExitStyle(pe);
        continue;
      }

      const holdHours = elapsedHours;
      const calcPnL = (exit) => calcFuturesPnL({
        direction: pe.direction, entry: pe.entry, exit,
        btcQty: pe.btcQty, leverage: pe.leverage,
        fundingRate: pe.fundingRate, holdHours,
        feeRate: pe.feeRate,
      });

      // Track whether price later hit TP / R-milestones after the normal exit
      const slDist = Math.abs(pe.entry - pe.sl);
      const currentR = slDist > 0 ? (pe.direction === "LONG" ? currentPrice - pe.entry : pe.entry - currentPrice) / slDist : 0;
      const hitTP = pe.direction === "LONG" ? currentPrice >= pe.tp : currentPrice <= pe.tp;
      if (hitTP) pe.laterHitTP = true;
      if (currentR >= 1) pe.laterHit1R = true;
      if (currentR >= 2) pe.laterHit2R = true;
      if (currentR >= 3) pe.laterHit3R = true;
      if (currentR >= 5) pe.laterHit5R = true;

      // Tick SL/TP sim
      if (pe.sims.sltp.active) {
        const hitSL = pe.direction === "LONG" ? currentPrice <= pe.sl : currentPrice >= pe.sl;
        if (hitSL) { pe.sims.sltp.active = false; pe.sims.sltp.exitPrice = pe.sl; pe.sims.sltp.exitReason = "SL"; pe.sims.sltp.pnl = calcPnL(pe.sl); }
        else if (hitTP) { pe.sims.sltp.active = false; pe.sims.sltp.exitPrice = pe.tp; pe.sims.sltp.exitReason = "TP"; pe.sims.sltp.pnl = calcPnL(pe.tp); }
      }

      // Tick trailing sim
      if (pe.sims.trailing.active) {
        if (!pe.sims.trailing.trailingStop) pe.sims.trailing.trailingStop = pe.sl;
        const hitSL = pe.direction === "LONG" ? currentPrice <= pe.sl : currentPrice >= pe.sl;
        if (hitSL) { pe.sims.trailing.active = false; pe.sims.trailing.exitPrice = pe.sl; pe.sims.trailing.exitReason = "SL"; pe.sims.trailing.pnl = calcPnL(pe.sl); }
        else if (hitTP) { pe.sims.trailing.active = false; pe.sims.trailing.exitPrice = pe.tp; pe.sims.trailing.exitReason = "TP"; pe.sims.trailing.pnl = calcPnL(pe.tp); }
        else {
          if (pe.direction === "LONG") {
            const newStop = currentPrice - atr * 1.5;
            if (newStop > pe.sims.trailing.trailingStop) pe.sims.trailing.trailingStop = newStop;
            if (currentPrice <= pe.sims.trailing.trailingStop) { pe.sims.trailing.active = false; pe.sims.trailing.exitPrice = pe.sims.trailing.trailingStop; pe.sims.trailing.exitReason = "TRAILING_STOP"; pe.sims.trailing.pnl = calcPnL(pe.sims.trailing.trailingStop); }
          } else {
            const newStop = currentPrice + atr * 1.5;
            if (newStop < pe.sims.trailing.trailingStop) pe.sims.trailing.trailingStop = newStop;
            if (currentPrice >= pe.sims.trailing.trailingStop) { pe.sims.trailing.active = false; pe.sims.trailing.exitPrice = pe.sims.trailing.trailingStop; pe.sims.trailing.exitReason = "TRAILING_STOP"; pe.sims.trailing.pnl = calcPnL(pe.sims.trailing.trailingStop); }
          }
        }
      }

      // Tick patient sim (only major invalidation = score ≤ 10 or SL/TP)
      if (pe.sims.patient.active) {
        const hitSL = pe.direction === "LONG" ? currentPrice <= pe.sl : currentPrice >= pe.sl;
        if (hitSL) { pe.sims.patient.active = false; pe.sims.patient.exitPrice = pe.sl; pe.sims.patient.exitReason = "SL"; pe.sims.patient.pnl = calcPnL(pe.sl); }
        else if (hitTP) { pe.sims.patient.active = false; pe.sims.patient.exitPrice = pe.tp; pe.sims.patient.exitReason = "TP"; pe.sims.patient.pnl = calcPnL(pe.tp); }
      }

      // Tick swing sim (only SL or TP, nothing else)
      if (pe.sims.swing.active) {
        const hitSL = pe.direction === "LONG" ? currentPrice <= pe.sl : currentPrice >= pe.sl;
        if (hitSL) { pe.sims.swing.active = false; pe.sims.swing.exitPrice = pe.sl; pe.sims.swing.exitReason = "SL"; pe.sims.swing.pnl = calcPnL(pe.sl); }
        else if (hitTP) { pe.sims.swing.active = false; pe.sims.swing.exitPrice = pe.tp; pe.sims.swing.exitReason = "TP"; pe.sims.swing.pnl = calcPnL(pe.tp); }
      }
    }
  }

  // v31: Determine which exit style produced the best PnL for a given trade
  _computeBestExitStyle(pe) {
    const candidates = [
      { name: "NORMAL", pnl: pe.normalExitPnL },
      { name: "SL/TP", pnl: pe.sims?.sltp?.pnl?.netPnL ?? null },
      { name: "TRAILING", pnl: pe.sims?.trailing?.pnl?.netPnL ?? null },
      { name: "PATIENT", pnl: pe.sims?.patient?.pnl?.netPnL ?? null },
      { name: "SWING", pnl: pe.sims?.swing?.pnl?.netPnL ?? null },
    ].filter(c => c.pnl !== null);
    if (candidates.length === 0) return "UNKNOWN";
    return candidates.reduce((best, c) => c.pnl > best.pnl ? c : best, candidates[0]).name;
  }

  // v31: Aggregate post-exit simulation analytics
  getPostExitAnalytics() {
    const allEntries = Object.values(this.postExitSims);
    if (allEntries.length === 0) return null;

    const expired = allEntries.filter(pe => pe.expired);
    const earlyExits = expired.filter(pe => pe.wasEarlyExit);

    // Early exits that later hit TP (price reversed and reached TP after normal close)
    const earlyHitTP = earlyExits.filter(pe => pe.laterHitTP);
    const earlyHit3R = earlyExits.filter(pe => pe.laterHit3R);
    const earlyHit5R = earlyExits.filter(pe => pe.laterHit5R);

    // Best exit style tally
    const styleCounts = { NORMAL: 0, "SL/TP": 0, TRAILING: 0, PATIENT: 0, SWING: 0, UNKNOWN: 0 };
    expired.forEach(pe => { if (pe.bestExitStyle) styleCounts[pe.bestExitStyle] = (styleCounts[pe.bestExitStyle] || 0) + 1; });
    const bestStyle = Object.entries(styleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "UNKNOWN";

    // Per-style aggregate PnL stats
    const calcStyleStats = (getPnL) => {
      const pnls = expired.map(getPnL).filter(v => v !== null && !isNaN(v));
      if (pnls.length === 0) return null;
      const wins = pnls.filter(v => v > 0).length;
      const total = pnls.reduce((s, v) => s + v, 0);
      return {
        trades: pnls.length,
        wins,
        winRate: (wins / pnls.length * 100).toFixed(1),
        totalPnL: total.toFixed(4),
        avgPnL: (total / pnls.length).toFixed(4),
      };
    };

    return {
      totalTracked: allEntries.length,
      totalExpired: expired.length,
      totalActive: allEntries.length - expired.length,
      earlyExitsCount: earlyExits.length,
      earlyHitTPCount: earlyHitTP.length,
      earlyHit3RCount: earlyHit3R.length,
      earlyHit5RCount: earlyHit5R.length,
      earlyHitTPPct: earlyExits.length > 0 ? (earlyHitTP.length / earlyExits.length * 100).toFixed(1) : null,
      earlyHit3RPct: earlyExits.length > 0 ? (earlyHit3R.length / earlyExits.length * 100).toFixed(1) : null,
      bestExitStyle: bestStyle,
      styleCounts,
      styleStats: {
        normal:   calcStyleStats(pe => pe.normalExitPnL),
        sltp:     calcStyleStats(pe => pe.sims?.sltp?.pnl?.netPnL ?? null),
        trailing: calcStyleStats(pe => pe.sims?.trailing?.pnl?.netPnL ?? null),
        patient:  calcStyleStats(pe => pe.sims?.patient?.pnl?.netPnL ?? null),
        swing:    calcStyleStats(pe => pe.sims?.swing?.pnl?.netPnL ?? null),
      },
      // Recent post-exit entries for display
      recent: allEntries.slice(-20).reverse(),
    };
  }

  getStats() {
    const closed = this.trades.filter(t => t.status === "closed");
    if (closed.length === 0) return null;
    const wins = closed.filter(t => (t.pnl?.netPnL || 0) > 0);
    const totalNetPnL = closed.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
    const grossWin = wins.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
    const grossLoss = closed.filter(t => (t.pnl?.netPnL || 0) < 0).reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
    const totalFees = closed.reduce((s, t) => s + (t.pnl?.fees || 0), 0);
    const totalFunding = closed.reduce((s, t) => s + (t.pnl?.funding || 0), 0);
    const totalGrossPnL = closed.reduce((s, t) => s + (t.pnl?.grossPnL || 0), 0);
    return {
      total: closed.length, wins: wins.length, losses: closed.length - wins.length,
      winRate: (wins.length / closed.length * 100).toFixed(1),
      totalNetPnL, totalGrossPnL, totalFees, totalFunding,
      profitFactor: grossLoss !== 0 ? Math.abs(grossWin / grossLoss).toFixed(2) : "∞",
      avgPnL: totalNetPnL / closed.length,
    };
  }

  // Separate analytics buckets per spec
  getSignalAnalytics() {
    const all = this.signalLog;
    const tradable = all.filter(s => s.action === "TRADE");
    const watchSignals = all.filter(s => s.action === "WATCH");
    const smcOpposed = all.filter(s => s.smcOpposed);
    const filtered = all.filter(s => s.action === "WAIT" && s.filteredBy);
    const waited = all.filter(s => s.action === "WAIT" && !s.filteredBy);
    const paperTrades = this.trades;
    const closedTrades = this.trades.filter(t => t.status === "closed");

    // v33 F5: Regime distribution funnel
    const regimes = ["TRENDING", "RANGING", "BREAKOUT", "REVERSAL", "HIGH_VOLATILITY", "UNCERTAIN"];
    const regimeFunnel = regimes.map(regime => {
      const regimeSignals = all.filter(s => s.regime === regime);
      const qualified = regimeSignals.filter(s => s.confidence >= 75);
      const traded = regimeSignals.filter(s => s.tradedAs !== null && s.tradedAs !== undefined);
      const watch = regimeSignals.filter(s => s.action === "WATCH");
      const wait = regimeSignals.filter(s => s.action === "WAIT");
      // Win rate and PnL for traded signals
      const tradedTrades = traded.map(s => closedTrades.find(t => t.id === s.tradedAs)).filter(Boolean);
      const wins = tradedTrades.filter(t => (t.pnl?.netPnL || 0) > 0).length;
      const netPnL = tradedTrades.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
      return {
        regime,
        detected: regimeSignals.length,
        qualified: qualified.length,
        traded: traded.length,
        watch: watch.length,
        wait: wait.length,
        winRate: tradedTrades.length > 0 ? (wins / tradedTrades.length * 100).toFixed(1) : null,
        netPnL: tradedTrades.length > 0 ? netPnL : null,
      };
    });

    return {
      allSignals: all.length,
      tradableSignals: tradable.length,
      watchSignals: watchSignals.length,
      smcOpposedSignals: smcOpposed.length,
      filteredSignals: filtered.length,
      waitedSignals: waited.length,
      paperTradesOpened: paperTrades.length,
      paperTradesClosed: closedTrades.length,
      signalLog: all,
      regimeFunnel,
    };
  }

  getDetailedStats() {
    const closed = this.trades.filter(t => t.status === "closed");
    const groupBy = (key) => {
      const groups = {};
      closed.forEach(t => {
        const k = t[key] || "UNKNOWN";
        if (!groups[k]) groups[k] = [];
        groups[k].push(t);
      });
      return Object.entries(groups).map(([name, trades]) => {
        const wins = trades.filter(t => (t.pnl?.netPnL || 0) > 0);
        const losses = trades.filter(t => (t.pnl?.netPnL || 0) <= 0);
        const pnl = trades.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
        const grossWin = wins.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0));
        const expectancy = trades.length > 0 ? pnl / trades.length : 0;
        const profitFactor = grossLoss > 0 ? (grossWin / grossLoss) : wins.length > 0 ? Infinity : 0;
        const avgDuration = trades.length > 0
          ? trades.reduce((s, t) => s + ((t.exitTime || Date.now()) - t.entryTime), 0) / trades.length / 60000
          : 0;
        return {
          name, total: trades.length, wins: wins.length, losses: losses.length,
          winRate: trades.length > 0 ? Math.round(wins.length / trades.length * 100) : 0,
          pnl, expectancy, profitFactor: profitFactor === Infinity ? 999 : profitFactor,
          avgDuration,
        };
      });
    };
    return {
      byStrategy: groupBy("strategy"),
      byRegime: groupBy("regime"),
      bySession: groupBy("session"),
      byDirection: groupBy("direction"),
    };
  }

  // v29: Enhanced diagnostics — SMC opposition, watch-as-trade, fee impact, WS
  getDiagnosticsReport(dataStatus = null, paperSettings = null) {
    const trades = this.trades;
    const open = trades.filter(t => t.status === "open");
    const closed = trades.filter(t => t.status === "closed");
    const wins = closed.filter(t => (t.pnl?.netPnL || 0) > 0);
    const signals = this.signalLog;
    const tradedSignals = signals.filter(s => s.tradedAs);
    const duplicateSignalIds = (() => {
      const counts = {};
      signals.forEach(s => { counts[s.signalId] = (counts[s.signalId] || 0) + 1; });
      return Object.values(counts).filter(v => v > 1).length;
    })();

    const issues = [];

    // v29: WebSocket status
    if (dataStatus) {
      if (!dataStatus.ws && dataStatus.wsStatus === "FAILED") {
        issues.push({ level: "WARN", msg: `WebSocket failed after ${dataStatus.wsReconnectAttempts} attempts. REST fallback active — bot still receiving candle data.` });
      } else if (dataStatus.wsStatus === "RECONNECTING") {
        issues.push({ level: "INFO", msg: `WebSocket reconnecting (attempt ${dataStatus.wsReconnectAttempts}) — REST fallback active.` });
      }
      if (!dataStatus.newsAvailable) {
        issues.push({ level: "INFO", msg: `Economic calendar unavailable (CORS/network). News risk checks disabled — confidence slightly unverified.` });
      }
    }

    // v29: SMC opposition trades
    const smcOpposedTrades = closed.filter(t => t.smcOpposed);
    if (smcOpposedTrades.length > 0) {
      const oppWins = smcOpposedTrades.filter(t => (t.pnl?.netPnL || 0) > 0).length;
      issues.push({ level: "WARN", msg: `${smcOpposedTrades.length} SMC-opposed trade(s) in log — win rate ${(oppWins / smcOpposedTrades.length * 100).toFixed(0)}%. SMC opposition filter may have been bypassed.` });
    }

    // v29: Fee impact check
    const totalFees = closed.reduce((s, t) => s + (t.pnl?.fees || 0), 0);
    const totalGross = closed.reduce((s, t) => s + (t.pnl?.grossPnL || 0), 0);
    if (closed.length >= 3 && totalGross > 0 && (totalFees / totalGross) > 0.3) {
      issues.push({ level: "WARN", msg: `High fee impact — fees are ${(totalFees / totalGross * 100).toFixed(1)}% of gross profit. Consider larger position sizes or fewer small trades.` });
    }

    // Watch signals wrongly opened as trades
    const watchSignalsTraded = signals.filter(s => s.action === "WATCH" && s.tradedAs);
    if (watchSignalsTraded.length > 0) {
      issues.push({ level: "WARN", msg: `${watchSignalsTraded.length} WATCH signal(s) were opened as paper trades. This only happens if 'paper trade watch signals' is ON.` });
    }

    if (duplicateSignalIds > 0) issues.push({ level: "WARN", msg: `${duplicateSignalIds} duplicate signal IDs in log` });
    if (open.length > 5) issues.push({ level: "WARN", msg: `${open.length} concurrent open positions — excessive concurrency` });
    const stuckTrades = open.filter(t => Date.now() - t.entryTime > 3600000 * 4);
    if (stuckTrades.length > 0) issues.push({ level: "WARN", msg: `${stuckTrades.length} position(s) open >4h without health-based exit` });
    if (closed.length > 5 && wins.length / closed.length < 0.3) {
      issues.push({ level: "WARN", msg: `Win rate ${(wins.length / closed.length * 100).toFixed(0)}% below 30% — strategy may be misaligned with market` });
    }
    if (signals.length > 0 && tradedSignals.length === 0) {
      issues.push({ level: "INFO", msg: `Signals being generated but no trades opened — check confidence threshold (need ≥${CONFIG.CONFIDENCE.TRADE}%)` });
    }
    const confInflation = closed.length >= 5 && wins.length / closed.length < 0.45;
    if (confInflation) issues.push({ level: "WARN", msg: `Low win rate suggests confidence scoring may be inflated` });

    // Leverage risk
    const highLevTrades = [...open, ...closed].filter(t => (t.leverage || 0) > 50);
    if (highLevTrades.length > 0) {
      const maxLev = Math.max(...highLevTrades.map(t => t.leverage));
      issues.push({ level: "WARN", msg: `${highLevTrades.length} trade(s) used >50x leverage (max: ${maxLev}x). High liquidation risk.` });
    }

    return {
      issues,
      summary: {
        totalSignals: signals.length,
        tradableSignals: signals.filter(s => s.action === "TRADE").length,
        watchSignals: signals.filter(s => s.action === "WATCH").length,
        smcOpposedSignals: signals.filter(s => s.smcOpposed).length,
        filteredSignals: signals.filter(s => s.filteredBy).length,
        openPositions: open.length,
        closedTrades: closed.length,
        winRate: closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : null,
        duplicateSignalIds,
        stuckTrades: stuckTrades.length,
        totalFees: totalFees.toFixed(4),
        feeImpactPct: totalGross > 0 ? (totalFees / totalGross * 100).toFixed(1) : null,
      },
    };
  }

  // v30: Trade outcome learning — MFE/MAE/R-milestone analytics
  getOutcomeLearning() {
    const closed = this.trades.filter(t => t.status === "closed");
    if (closed.length === 0) return null;
    const earlyExits = closed.filter(t => t.wasEarlyExit);
    const reached1R = closed.filter(t => t.reached1R).length;
    const reached2R = closed.filter(t => t.reached2R).length;
    const reached3R = closed.filter(t => t.reached3R).length;
    const reached5R = closed.filter(t => t.reached5R).length;
    const avgMFE = closed.reduce((s, t) => s + (t.mfe || 0), 0) / closed.length;
    const avgMAE = closed.reduce((s, t) => s + (t.mae || 0), 0) / closed.length;
    const avgMaxRR = closed.reduce((s, t) => s + (t.maxRR || 0), 0) / closed.length;

    // Early exits that could have been profitable
    const earlyExitMissed = earlyExits.filter(t => {
      const sltpSim = t.exitStyleSims?.sltp;
      return sltpSim && sltpSim.pnl && (sltpSim.pnl.netPnL || 0) > (t.pnl?.netPnL || 0);
    });

    return {
      totalClosed: closed.length,
      earlyExitsCount: earlyExits.length,
      earlyExitMissedCount: earlyExitMissed.length,
      reached1R, reached2R, reached3R, reached5R,
      pctReached1R: closed.length > 0 ? (reached1R / closed.length * 100).toFixed(1) : null,
      pctReached3R: closed.length > 0 ? (reached3R / closed.length * 100).toFixed(1) : null,
      pctReached5R: closed.length > 0 ? (reached5R / closed.length * 100).toFixed(1) : null,
      avgMFEPct: (avgMFE * 100).toFixed(3),
      avgMAEPct: (avgMAE * 100).toFixed(3),
      avgMaxRR: avgMaxRR.toFixed(2),
    };
  }

  // v30: Exit style comparison analytics (uses in-trade sim data for completed sims)
  getExitStyleComparison() {
    const closed = this.trades.filter(t => t.status === "closed" && t.exitStyleSims);
    if (closed.length === 0) return null;
    const calcStyleStats = (getSimPnL) => {
      const pnls = closed.map(getSimPnL).filter(v => v !== null);
      if (pnls.length === 0) return null;
      const wins = pnls.filter(v => v > 0).length;
      const total = pnls.reduce((s, v) => s + v, 0);
      return { trades: pnls.length, wins, winRate: (wins / pnls.length * 100).toFixed(1), totalPnL: total.toFixed(4) };
    };
    return {
      normal:   calcStyleStats(t => t.pnl?.netPnL ?? null),
      sltp:     calcStyleStats(t => t.exitStyleSims?.sltp?.pnl?.netPnL ?? null),
      trailing: calcStyleStats(t => t.exitStyleSims?.trailing?.pnl?.netPnL ?? null),
      patient:  calcStyleStats(t => t.exitStyleSims?.patient?.pnl?.netPnL ?? null),
      swing:    calcStyleStats(t => t.exitStyleSims?.swing?.pnl?.netPnL ?? null),
    };
  }

  // v32: Strategy + Session Leaderboard
  getLeaderboard() {
    const closed = this.trades.filter(t => t.status === "closed");
    if (closed.length === 0) return null;
    const buildStats = (key, values) => {
      const result = {};
      for (const val of values) {
        const trades = closed.filter(t => (t[key] || "UNKNOWN") === val);
        if (trades.length === 0) continue;
        const wins = trades.filter(t => (t.pnl?.netPnL || 0) > 0);
        const losses = trades.filter(t => (t.pnl?.netPnL || 0) <= 0);
        const grossPnL = trades.reduce((s, t) => s + (t.pnl?.grossPnL || 0), 0);
        const fees = trades.reduce((s, t) => s + (t.pnl?.fees || 0), 0);
        const netPnL = trades.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
        const winPnLs = wins.map(t => t.pnl?.netPnL || 0);
        const lossPnLs = losses.map(t => Math.abs(t.pnl?.netPnL || 0));
        const grossWin = winPnLs.reduce((s, v) => s + v, 0);
        const grossLoss = lossPnLs.reduce((s, v) => s + v, 0);
        const profitFactor = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : wins.length > 0 ? "∞" : "0";
        const expectancy = trades.length > 0 ? (netPnL / trades.length).toFixed(4) : "0";
        const rrVals = trades.map(t => t.maxRR || 0).filter(v => v > 0);
        const avgRR = rrVals.length > 0 ? (rrVals.reduce((s, v) => s + v, 0) / rrVals.length).toFixed(2) : "0";
        const holdTimes = trades.filter(t => t.exitTime && t.entryTime).map(t => (t.exitTime - t.entryTime) / 60000);
        const avgHold = holdTimes.length > 0 ? (holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length).toFixed(0) : "0";
        result[val] = {
          label: val, trades: trades.length,
          wins: wins.length, losses: losses.length,
          winRate: (wins.length / trades.length * 100).toFixed(1),
          grossPnL: grossPnL.toFixed(4), fees: fees.toFixed(4),
          netPnL: netPnL.toFixed(4), expectancy, profitFactor,
          avgRR, avgHold,
        };
      }
      return result;
    };
    const strategies = buildStats("strategy", ["TREND", "RANGE", "BREAKOUT", "REVERSAL"]);
    const sessions = buildStats("session", ["ASIA", "LONDON", "NEW_YORK", "OFF"]);
    // Find best/worst
    const stratVals = Object.values(strategies);
    const sessVals = Object.values(sessions);
    const best = (arr) => arr.length ? arr.reduce((b, s) => parseFloat(s.netPnL) > parseFloat(b.netPnL) ? s : b, arr[0])?.label : "—";
    const worst = (arr) => arr.length ? arr.reduce((b, s) => parseFloat(s.netPnL) < parseFloat(b.netPnL) ? s : b, arr[0])?.label : "—";
    return {
      strategies, sessions,
      bestStrategy: best(stratVals), worstStrategy: worst(stratVals),
      bestSession: best(sessVals), worstSession: worst(sessVals),
    };
  }

  // v32: Fee Impact Analytics
  getFeeImpact() {
    const closed = this.trades.filter(t => t.status === "closed");
    if (closed.length === 0) return null;
    const grossProfit = closed.filter(t => (t.pnl?.grossPnL || 0) > 0).reduce((s, t) => s + (t.pnl?.grossPnL || 0), 0);
    const grossLoss = closed.filter(t => (t.pnl?.grossPnL || 0) < 0).reduce((s, t) => s + (t.pnl?.grossPnL || 0), 0);
    const totalFees = closed.reduce((s, t) => s + (t.pnl?.fees || 0), 0);
    const netProfit = closed.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
    const feePct = grossProfit > 0 ? (totalFees / grossProfit * 100).toFixed(2) : "0";
    const avgFee = closed.length > 0 ? (totalFees / closed.length).toFixed(4) : "0";
    // Trades where fees destroyed profit: gross > 0 but net <= 0
    const feesDestroyedProfit = closed.filter(t => (t.pnl?.grossPnL || 0) > 0 && (t.pnl?.netPnL || 0) <= 0);
    return {
      grossProfit: grossProfit.toFixed(4),
      grossLoss: grossLoss.toFixed(4),
      totalFees: totalFees.toFixed(4),
      netProfit: netProfit.toFixed(4),
      feePct, avgFee,
      feesDestroyedCount: feesDestroyedProfit.length,
      feesDestroyedTrades: feesDestroyedProfit,
      totalTrades: closed.length,
    };
  }

  // v32: Daily Report Generator
  getDailyReport() {
    const closed = this.trades.filter(t => t.status === "closed" && t.exitTime);
    if (closed.length === 0) return null;
    // Group by day (UTC)
    const byDay = {};
    for (const t of closed) {
      const day = new Date(t.exitTime).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(t);
    }
    // Signal log per day
    const signalsByDay = {};
    for (const s of this.signalLog) {
      const day = new Date(s.loggedAt || s.candleOpenTime || Date.now()).toISOString().slice(0, 10);
      if (!signalsByDay[day]) signalsByDay[day] = [];
      signalsByDay[day].push(s);
    }
    const reports = Object.entries(byDay).sort(([a], [b]) => b.localeCompare(a)).map(([day, trades]) => {
      const wins = trades.filter(t => (t.pnl?.netPnL || 0) > 0);
      const losses = trades.filter(t => (t.pnl?.netPnL || 0) <= 0);
      const grossPnL = trades.reduce((s, t) => s + (t.pnl?.grossPnL || 0), 0);
      const fees = trades.reduce((s, t) => s + (t.pnl?.fees || 0), 0);
      const netPnL = trades.reduce((s, t) => s + (t.pnl?.netPnL || 0), 0);
      const earlyExits = trades.filter(t => t.wasEarlyExit);
      const laterHitTP = earlyExits.filter(t => t.postExitSim?.laterHitTP);
      const later3R = earlyExits.filter(t => t.postExitSim?.laterHit3R);
      const signals = signalsByDay[day] || [];
      // Strategy breakdown
      const stratStats = {};
      for (const t of trades) {
        const s = t.strategy || "UNKNOWN";
        if (!stratStats[s]) stratStats[s] = { trades: 0, netPnL: 0 };
        stratStats[s].trades++;
        stratStats[s].netPnL += t.pnl?.netPnL || 0;
      }
      const stratEntries = Object.entries(stratStats);
      const bestStrat = stratEntries.length ? stratEntries.reduce((b, s) => s[1].netPnL > b[1].netPnL ? s : b, stratEntries[0])[0] : "—";
      const worstStrat = stratEntries.length ? stratEntries.reduce((b, s) => s[1].netPnL < b[1].netPnL ? s : b, stratEntries[0])[0] : "—";
      // Session breakdown
      const sessStats = {};
      for (const t of trades) {
        const sess = t.session || "UNKNOWN";
        if (!sessStats[sess]) sessStats[sess] = { trades: 0, netPnL: 0 };
        sessStats[sess].trades++;
        sessStats[sess].netPnL += t.pnl?.netPnL || 0;
      }
      // Confidence band performance
      const confBands = { EXCEPTIONAL: { trades: 0, wins: 0 }, STRONG: { trades: 0, wins: 0 }, WATCH: { trades: 0, wins: 0 } };
      for (const t of trades) {
        const band = t.confidence >= 95 ? "EXCEPTIONAL" : t.confidence >= 85 ? "STRONG" : "WATCH";
        confBands[band].trades++;
        if ((t.pnl?.netPnL || 0) > 0) confBands[band].wins++;
      }
      return {
        day, tradesCount: trades.length, wins: wins.length, losses: losses.length,
        winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "0",
        grossPnL: grossPnL.toFixed(4), fees: fees.toFixed(4), netPnL: netPnL.toFixed(4),
        bestStrategy: bestStrat, worstStrategy: worstStrat,
        sessStats, confBands,
        earlyExits: earlyExits.length, laterHitTP: laterHitTP.length, later3R: later3R.length,
        signalsGenerated: signals.length,
        tradesOpened: trades.length,
      };
    });
    return reports;
  }

  // v30: Enhanced CSV with R-milestone columns
  exportCSV() {
    const closed = this.trades.filter(t => t.status === "closed");
    if (closed.length === 0) return null;
    const headers = [
      "id","direction","strategy","regime","confidence","entry","exit","sl","tp","rr",
      "btcQty","notionalUSDT","deltaContracts","marginUsed","leverage","sizingMode","lots",
      "feeRate","entryFee","exitFee","totalFee","feeImpactPct",
      "riskUSDT","session","grossPnL","fees","funding","netPnL","roi","returnPct",
      "entryTime","exitTime","exitReason","mfe","mae","maxRR",
      "reached1R","reached2R","reached3R","reached5R","wasEarlyExit",
      "smcBias","smcOpposed",
    ];
    const rows = closed.map(t => {
      const feeImpact = t.pnl?.grossPnL > 0 ? ((t.pnl?.fees || 0) / t.pnl.grossPnL * 100).toFixed(2) : "";
      return [
        t.id, t.direction, t.strategy, t.regime, t.confidence,
        t.entry, t.exit, t.sl, t.tp, t.rr?.toFixed(3),
        t.btcQty?.toFixed(6), t.notionalUSDT?.toFixed(2), t.deltaContracts,
        t.marginUsed?.toFixed(2), t.leverage || CONFIG.LEVERAGE,
        t.sizingMode || "auto", t.lots || t.deltaContracts,
        (t.feeRate || CONFIG.TAKER_FEE).toFixed(4),
        t.pnl?.entryFee?.toFixed(4), t.pnl?.exitFee?.toFixed(4),
        t.pnl?.fees?.toFixed(4), feeImpact,
        t.riskUSDT?.toFixed(2), t.session,
        t.pnl?.grossPnL?.toFixed(4), t.pnl?.fees?.toFixed(4), t.pnl?.funding?.toFixed(4), t.pnl?.netPnL?.toFixed(4),
        t.pnl?.roi?.toFixed(4), t.pnl?.returnPct?.toFixed(4),
        new Date(t.entryTime).toISOString(), t.exitTime ? new Date(t.exitTime).toISOString() : "",
        t.exitReason || "", t.mfe?.toFixed(6), t.mae?.toFixed(6),
        (t.maxRR || 0).toFixed(2),
        t.reached1R ? "YES" : "NO", t.reached2R ? "YES" : "NO",
        t.reached3R ? "YES" : "NO", t.reached5R ? "YES" : "NO",
        t.wasEarlyExit ? "YES" : "NO",
        t.smcBias, t.smcOpposed ? "YES" : "NO",
      ];
    });
    return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  }

  exportJSON() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      version: CONFIG.VERSION,
      summary: this.getStats(),
      feeSettings: { makerFee: CONFIG.MAKER_FEE, takerFee: CONFIG.TAKER_FEE, note: "Paper trades use taker fee by default" },
      trades: this.trades.filter(t => t.status === "closed").map(t => ({
        ...t,
        // Never export API secret (no secret fields on trades, but explicit safeguard)
        deltaApiSecret: undefined,
      })),
      signalLog: this.signalLog,
    }, null, 2);
  }
}

// ============================================================
// 12. BACKTEST ENGINE v30 — Full filter support
// ============================================================
function runBacktest(candles, strategy = "ALL", accountBalance = 1000, confidenceMin = 75, sessionFilter = "ALL") {
  if (!candles || candles.length < 100) return null;
  const results = [];
  let balance = accountBalance;
  let maxBalance = accountBalance;
  let maxDrawdown = 0;

  for (let i = 60; i < candles.length - 5; i++) {
    const slice = candles.slice(0, i + 1);
    const swings = detectSwingPoints(slice);
    const bosChoch = detectBOS_CHoCH(slice, swings);
    const orderBlocks = detectOrderBlocks(slice, swings);
    const fvgs = detectFairValueGaps(slice);
    const sweep = detectLiquiditySweep(slice, swings);
    const premiumDiscount = calcPremiumDiscount(slice, swings);
    const smcData = { swings, bosChoch, orderBlocks, fvgs, sweep, premiumDiscount };
    const regime = detectRegime(slice);
    if (strategy !== "ALL" && regime.regime !== strategy) continue;

    // v30: Session filter
    if (sessionFilter !== "ALL") {
      const candleHour = new Date(candles[i].t).getUTCHours();
      let candleSession = "OFF";
      if (candleHour >= 23 || candleHour < 8) candleSession = "ASIA";
      else if (candleHour >= 8 && candleHour < 12) candleSession = "LONDON";
      else if (candleHour >= 13 && candleHour < 22) candleSession = "NEW_YORK";
      if (candleSession !== sessionFilter) continue;
    }

    let stratResult = null;
    if (regime.regime === "TRENDING") stratResult = runTrendStrategy(slice, smcData);
    else if (regime.regime === "RANGING") stratResult = runRangeStrategy(slice, smcData);
    else if (regime.regime === "BREAKOUT") stratResult = runBreakoutStrategy(slice, smcData);
    else if (regime.regime === "REVERSAL") stratResult = runReversalStrategy(slice, smcData);
    if (!stratResult || stratResult.confidence < confidenceMin) continue;

    const entry = candles[i].c;
    const atr = calcATR(slice);
    if (!atr) continue;
    const rl = calcRiskLevels(stratResult.direction, entry, atr, balance);
    if (!rl) continue;

    let hit = "TIME";
    let exitPrice = entry;
    for (let j = i + 1; j < Math.min(i + 21, candles.length); j++) {
      const c = candles[j];
      if (stratResult.direction === "LONG") {
        if (c.l <= rl.sl) { hit = "SL"; exitPrice = rl.sl; break; }
        if (c.h >= rl.tp) { hit = "TP"; exitPrice = rl.tp; break; }
      } else {
        if (c.h >= rl.sl) { hit = "SL"; exitPrice = rl.sl; break; }
        if (c.l <= rl.tp) { hit = "TP"; exitPrice = rl.tp; break; }
      }
      exitPrice = c.c;
    }

    const holdHours = hit === "TIME" ? 20 : hit === "TP" ? 5 : 3;
    const pnlObj = calcFuturesPnL({ direction: stratResult.direction, entry, exit: exitPrice, btcQty: rl.btcQty, holdHours });
    balance += pnlObj.netPnL;
    maxBalance = Math.max(maxBalance, balance);
    maxDrawdown = Math.max(maxDrawdown, (maxBalance - balance) / maxBalance * 100);

    results.push({
      idx: i, direction: stratResult.direction, strategy: stratResult.strategy || regime.regime,
      entry, exit: exitPrice, outcome: hit, pnl: pnlObj, balance,
      confidence: stratResult.confidence,
    });
  }

  if (results.length === 0) return null;
  const wins = results.filter(r => r.outcome === "TP" || (r.pnl?.netPnL || 0) > 0);
  const losses = results.filter(r => r.outcome === "SL" || (r.pnl?.netPnL || 0) < 0);
  const totalNetPnL = results.reduce((s, r) => s + (r.pnl?.netPnL || 0), 0);
  const grossWin = wins.reduce((s, r) => s + (r.pnl?.netPnL || 0), 0);
  const grossLoss = losses.reduce((s, r) => s + (r.pnl?.netPnL || 0), 0);
  const winRate = results.length > 0 ? (wins.length / results.length * 100) : 0;
  const profitFactor = grossLoss < 0 ? Math.abs(grossWin / grossLoss) : wins.length > 0 ? Infinity : 0;
  const expectancy = results.length > 0 ? totalNetPnL / results.length : 0;

  // Equity + drawdown curves (downsample to max 60 points)
  const equityCurve = results.map((r, i) => ({ x: i, y: r.balance }));
  const step = Math.max(1, Math.floor(equityCurve.length / 60));
  const equitySampled = equityCurve.filter((_, i) => i % step === 0 || i === equityCurve.length - 1);
  const drawdownCurve = (() => {
    let peak = accountBalance;
    return results.map((r, i) => {
      if (r.balance > peak) peak = r.balance;
      return { x: i, y: peak > 0 ? ((r.balance - peak) / peak * 100) : 0 };
    }).filter((_, i) => i % step === 0 || i === results.length - 1);
  })();

  // Strategy breakdown
  const stratGroups = {};
  results.forEach(r => {
    if (!stratGroups[r.strategy]) stratGroups[r.strategy] = { trades: [], wins: 0, pnl: 0 };
    stratGroups[r.strategy].trades.push(r);
    if ((r.pnl?.netPnL || 0) > 0) stratGroups[r.strategy].wins++;
    stratGroups[r.strategy].pnl += r.pnl?.netPnL || 0;
  });
  const stratBreakdown = Object.entries(stratGroups).map(([name, d]) => ({
    name, total: d.trades.length, wins: d.wins,
    winRate: d.trades.length > 0 ? (d.wins / d.trades.length * 100).toFixed(1) : "0",
    pnl: d.pnl,
  }));

  // Monthly performance breakdown
  const monthlyGroups = {};
  results.forEach(r => {
    const d = new Date(candles[r.idx]?.t || 0);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!monthlyGroups[key]) monthlyGroups[key] = { trades: 0, wins: 0, pnl: 0 };
    monthlyGroups[key].trades++;
    if ((r.pnl?.netPnL || 0) > 0) monthlyGroups[key].wins++;
    monthlyGroups[key].pnl += r.pnl?.netPnL || 0;
  });
  const monthlyPerf = Object.entries(monthlyGroups).map(([month, d]) => ({
    month, trades: d.trades, wins: d.wins,
    winRate: d.trades > 0 ? (d.wins / d.trades * 100).toFixed(1) : "0",
    pnl: d.pnl,
  }));

  return {
    totalTrades: results.length, wins: wins.length, losses: losses.length,
    winRate: winRate.toFixed(1), profitFactor: profitFactor === Infinity ? "∞" : profitFactor.toFixed(2),
    expectancy: expectancy.toFixed(4), maxDrawdown: maxDrawdown.toFixed(2),
    totalNetPnL, finalBalance: balance,
    trades: results.slice(-50),
    equityCurve: equitySampled,
    drawdownCurve,
    stratBreakdown,
    monthlyPerf,
    appliedFilters: { strategy, confidenceMin, sessionFilter },
  };
}

// ============================================================
// 11b. JOURNAL STORE v32 — Persistent localStorage journal
// Never saves API secrets. Deduplication on tradeId + signalId.
// ============================================================
class JournalStore {
  constructor() {
    this._loaded = false;
  }

  _safeGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
  }
  _safeSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  // Load saved data into paperEngine on app init
  loadInto(engine) {
    if (this._loaded) return;
    this._loaded = true;

    // --- trades ---
    const savedTrades = this._safeGet(CONFIG.LS_TRADES) || [];
    const savedSignals = this._safeGet(CONFIG.LS_SIGNALS) || [];
    const savedSims = this._safeGet(CONFIG.LS_SIMS) || {};
    const savedNotes = this._safeGet(CONFIG.LS_NOTES) || {};

    const tradeIds = new Set(engine.trades.map(t => t.id));
    const signalIds = new Set(engine.signalLog.map(s => s.signalId));

    for (const t of savedTrades) {
      if (!tradeIds.has(t.id)) {
        engine.trades.push(t);
        if (t.status === "closed") {
          engine.seenSignalIds.add(t.signalId);
        }
        // v33 F3: Also add open trade signalIds to prevent duplicate on refresh
        if (t.status === "open" && t.signalId) {
          engine.seenSignalIds.add(t.signalId);
        }
        tradeIds.add(t.id);
      }
    }
    for (const s of savedSignals) {
      if (!signalIds.has(s.signalId)) {
        engine.signalLog.push(s);
        signalIds.add(s.signalId);
      }
    }
    // Restore post-exit sims
    for (const [id, sim] of Object.entries(savedSims)) {
      if (!engine.postExitSims[id]) {
        engine.postExitSims[id] = sim;
      }
    }
    // Attach notes
    engine._notes = { ...savedNotes, ...(engine._notes || {}) };
  }

  saveAll(engine) {
    // Only save closed trades (no open — they'll be reconstructed from runtime on next load if same session)
    // Actually save all — open positions may be partially tracked. Filter out secrets.
    const trades = engine.trades.map(t => this._sanitizeTrade(t));
    this._safeSet(CONFIG.LS_TRADES, trades);
    this._safeSet(CONFIG.LS_SIGNALS, engine.signalLog);
    this._safeSet(CONFIG.LS_SIMS, engine.postExitSims);
    this._safeSet(CONFIG.LS_NOTES, engine._notes || {});
  }

  _sanitizeTrade(t) {
    // Strip any accidental secret fields — only allow known safe fields
    const { deltaApiSecret, apiSecret, secret, ...safe } = t;
    return safe;
  }

  importJSON(jsonStr, engine) {
    try {
      const data = JSON.parse(jsonStr);
      const trades = data.trades || [];
      const signals = data.signalLog || data.signals || [];
      const sims = data.postExitSims || {};
      const notes = data.notes || {};
      const existingTradeIds = new Set(engine.trades.map(t => t.id));
      const existingSignalIds = new Set(engine.signalLog.map(s => s.signalId));
      let importedTrades = 0, importedSignals = 0;
      for (const t of trades) {
        if (!existingTradeIds.has(t.id)) {
          engine.trades.push(this._sanitizeTrade(t));
          existingTradeIds.add(t.id);
          importedTrades++;
        }
      }
      for (const s of signals) {
        if (!existingSignalIds.has(s.signalId)) {
          engine.signalLog.push(s);
          existingSignalIds.add(s.signalId);
          importedSignals++;
        }
      }
      for (const [id, sim] of Object.entries(sims)) {
        if (!engine.postExitSims[id]) engine.postExitSims[id] = sim;
      }
      engine._notes = { ...(engine._notes || {}), ...notes };
      this.saveAll(engine);
      return { ok: true, importedTrades, importedSignals };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  clearAll(engine) {
    engine.trades = engine.trades.filter(t => t.status === "open"); // keep open positions
    engine.signalLog = [];
    engine.postExitSims = {};
    engine._notes = {};
    try { localStorage.removeItem(CONFIG.LS_TRADES); } catch {}
    try { localStorage.removeItem(CONFIG.LS_SIGNALS); } catch {}
    try { localStorage.removeItem(CONFIG.LS_SIMS); } catch {}
    try { localStorage.removeItem(CONFIG.LS_NOTES); } catch {}
    try { localStorage.removeItem(CONFIG.LS_REGIME_ACC); } catch {}
  }

  setNote(tradeId, note, engine) {
    if (!engine._notes) engine._notes = {};
    engine._notes[tradeId] = note;
    this._safeSet(CONFIG.LS_NOTES, engine._notes);
  }

  getNote(tradeId, engine) {
    return (engine._notes || {})[tradeId] || "";
  }
}

// ============================================================
// 11c. REGIME ACCURACY TRACKER v32
// Logs what the market actually did after each entry.
// ============================================================
class RegimeAccuracyTracker {
  constructor() {
    this.records = [];
    this._load();
  }
  _load() {
    try { this.records = JSON.parse(localStorage.getItem(CONFIG.LS_REGIME_ACC) || "[]"); } catch { this.records = []; }
  }
  _save() {
    try { localStorage.setItem(CONFIG.LS_REGIME_ACC, JSON.stringify(this.records.slice(-500))); } catch {}
  }
  // Called when a trade closes — evaluates if regime prediction was correct
  recordOutcome(trade) {
    if (!trade || !trade.regime) return;
    const direction = trade.direction;
    const regime = trade.regime;
    const exitReason = trade.exitReason || "";
    const netPnL = trade.pnl?.netPnL ?? 0;
    // Regime was "correct" if the trade was profitable AND exited at TP or held well
    const isWin = netPnL > 0;
    const hitTP = exitReason.includes("TP");
    // Simple accuracy: regime predicted direction, if win = regime was correct
    const correct = isWin;
    this.records.push({
      id: trade.id,
      regime,
      direction,
      strategy: trade.strategy,
      correct,
      hitTP,
      exitReason,
      netPnL,
      entryTime: trade.entryTime,
    });
    this._save();
  }
  getStats() {
    if (this.records.length === 0) return null;
    const byRegime = {};
    for (const r of this.records) {
      if (!byRegime[r.regime]) byRegime[r.regime] = { total: 0, correct: 0, label: r.regime };
      byRegime[r.regime].total++;
      if (r.correct) byRegime[r.regime].correct++;
    }
    const regimeStats = Object.values(byRegime).map(r => ({
      ...r,
      accuracy: r.total > 0 ? (r.correct / r.total * 100).toFixed(1) : "0",
    })).sort((a, b) => b.total - a.total);

    const falseTrend = this.records.filter(r => r.regime === "TRENDING" && !r.correct).length;
    const falseBreakout = this.records.filter(r => r.regime === "BREAKOUT" && !r.correct).length;
    const rangeFail = this.records.filter(r => r.regime === "RANGING" && !r.correct).length;
    const bestRegime = regimeStats.sort((a, b) => parseFloat(b.accuracy) - parseFloat(a.accuracy))[0];
    const worstRegime = regimeStats.sort((a, b) => parseFloat(a.accuracy) - parseFloat(b.accuracy))[0];
    const overall = this.records.length > 0
      ? (this.records.filter(r => r.correct).length / this.records.length * 100).toFixed(1)
      : "0";
    return { regimeStats: Object.values(byRegime).map(r => ({ ...r, accuracy: r.total > 0 ? (r.correct / r.total * 100).toFixed(1) : "0" })), falseTrend, falseBreakout, rangeFail, bestRegime: bestRegime?.label || "—", worstRegime: worstRegime?.label || "—", overall, totalRecords: this.records.length };
  }
  clear() {
    this.records = [];
    try { localStorage.removeItem(CONFIG.LS_REGIME_ACC); } catch {}
  }
}

// ============================================================
// SINGLETON ENGINES
// ============================================================
const marketDataEngine = new MarketDataEngine();
const paperEngine = new PaperTradeEngine();
const journalStore = new JournalStore();
const regimeAccuracy = new RegimeAccuracyTracker();

// Initialize _notes on paperEngine
paperEngine._notes = {};

// ============================================================
// UI COMPONENTS
// ============================================================
function Badge({ label, color, size = "sm" }) {
  const colors = { green: "#00ff9d", red: "#ff4566", yellow: "#ffd700", blue: "#4db8ff", purple: "#c084fc", gray: "#9ca3af", orange: "#fb923c", cyan: "#22d3ee" };
  const col = colors[color] || colors.gray;
  return (
    <span style={{ background: `${col}18`, color: col, border: `1px solid ${col}44`, padding: size === "sm" ? "2px 8px" : "4px 12px", borderRadius: 4, fontSize: size === "sm" ? 10 : 12, fontWeight: 600, letterSpacing: "0.08em", fontFamily: "'Space Mono', monospace", whiteSpace: "nowrap" }}>{label}</span>
  );
}

function Divider() { return <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "12px 0" }} />; }

function Card({ children, style = {}, glow }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.028)", border: `1px solid ${glow ? glow + "33" : "rgba(255,255,255,0.07)"}`, borderRadius: 10, padding: 16, backdropFilter: "blur(8px)", boxShadow: glow ? `0 0 16px ${glow}11` : "none", ...style }}>{children}</div>
  );
}

function SectionTitle({ icon, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      <span style={{ fontSize: 13 }}>{icon}</span>
      <span style={{ color: "#9ca3af", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</span>
    </div>
  );
}

function Metric({ label, value, color, sub }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>{label}</div>
      <div style={{ color: color || "#e5e7eb", fontSize: 14, fontWeight: 700, fontFamily: "'Space Mono', monospace", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ color: "#6b7280", fontSize: 9, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function ConfidenceBar({ value }) {
  const color = value >= 95 ? "#00ff9d" : value >= 85 ? "#4db8ff" : value >= 75 ? "#ffd700" : "#ff4566";
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>Confidence</span>
        <span style={{ color, fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>{value.toFixed(0)}%</span>
      </div>
      <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${value}%`, height: "100%", background: `linear-gradient(90deg, ${color}88, ${color})`, borderRadius: 2, transition: "width 0.5s ease", boxShadow: `0 0 6px ${color}66` }} />
      </div>
    </div>
  );
}

function HealthBar({ score }) {
  const color = score >= 70 ? "#00ff9d" : score >= 40 ? "#ffd700" : "#ff4566";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>Trade Health</span>
        <span style={{ color, fontSize: 11, fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>{score}</span>
      </div>
      <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", background: `linear-gradient(90deg, ${color}88, ${color})`, borderRadius: 2, transition: "width 0.3s" }} />
      </div>
    </div>
  );
}

function StatusDot({ ok, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: ok ? "#00ff9d" : "#ff4566", boxShadow: ok ? "0 0 4px #00ff9d88" : "0 0 4px #ff456688" }} />
      <span style={{ color: ok ? "#9ca3af" : "#ff4566", fontSize: 10 }}>{label}</span>
    </div>
  );
}

function RegimeBadge({ regime }) {
  const cfg = { TRENDING: { color: "green", icon: "📈" }, RANGING: { color: "blue", icon: "↔️" }, BREAKOUT: { color: "yellow", icon: "⚡" }, REVERSAL: { color: "purple", icon: "🔄" }, HIGH_VOLATILITY: { color: "red", icon: "🔥" }, UNCERTAIN: { color: "gray", icon: "❓" } };
  const c = cfg[regime] || cfg.UNCERTAIN;
  return <Badge label={`${c.icon} ${regime}`} color={c.color} size="md" />;
}

// ============================================================
// TRADINGVIEW CHART WIDGET
// ============================================================
function TradingViewChart({ symbol = "BTCUSDT", interval = "1" }) {
  const containerRef = useRef(null);
  const widgetId = useRef(`tv_${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = "";
    const container = document.createElement("div");
    container.id = widgetId.current;
    container.style.width = "100%";
    container.style.height = "100%";
    containerRef.current.appendChild(container);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      width: "100%", height: "100%",
      symbol: `BINANCE:${symbol}`,
      interval,
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      toolbar_bg: "#060b14",
      enable_publishing: false,
      allow_symbol_change: false,
      container_id: widgetId.current,
      backgroundColor: "rgba(6,11,20,1)",
      gridColor: "rgba(255,255,255,0.04)",
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      studies: ["RSI@tv-basicstudies", "MASimple@tv-basicstudies"],
    });
    container.appendChild(script);
    return () => { if (containerRef.current) containerRef.current.innerHTML = ""; };
  }, [symbol, interval]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: 420 }} />;
}

// ============================================================
// ROTATING GLOBE COMPONENT
// ============================================================
function RotatingGlobe({ size = 200 }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const angleRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const r = size / 2;

    function drawGlobe(angle) {
      ctx.clearRect(0, 0, size, size);
      const grd = ctx.createRadialGradient(r, r, r * 0.3, r, r, r);
      grd.addColorStop(0, "rgba(77,184,255,0.08)");
      grd.addColorStop(0.8, "rgba(0,255,157,0.04)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
      const baseGrd = ctx.createRadialGradient(r * 0.7, r * 0.6, 0, r, r, r);
      baseGrd.addColorStop(0, "rgba(20,40,80,0.95)");
      baseGrd.addColorStop(1, "rgba(6,11,20,0.95)");
      ctx.beginPath();
      ctx.arc(r, r, r * 0.92, 0, Math.PI * 2);
      ctx.fillStyle = baseGrd;
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.arc(r, r, r * 0.92, 0, Math.PI * 2);
      ctx.clip();
      for (let i = 0; i < 8; i++) {
        const lineAngle = (i / 8) * Math.PI + angle;
        const xScale = Math.cos(lineAngle);
        ctx.beginPath();
        ctx.ellipse(r, r, Math.abs(xScale) * r * 0.92, r * 0.92, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(77,184,255,${0.06 + Math.abs(xScale) * 0.08})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
      for (let lat = -3; lat <= 3; lat++) {
        const y = r + (lat / 4) * r * 0.92;
        const latR = Math.sqrt(Math.max(0, (r * 0.92) ** 2 - (y - r) ** 2));
        if (latR < 1) continue;
        ctx.beginPath();
        ctx.ellipse(r, y, latR, latR * 0.15, 0, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0,255,157,0.07)";
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
      ctx.restore();
      const hlGrd = ctx.createRadialGradient(r * 0.65, r * 0.5, 0, r * 0.65, r * 0.5, r * 0.55);
      hlGrd.addColorStop(0, "rgba(255,255,255,0.07)");
      hlGrd.addColorStop(1, "rgba(255,255,255,0)");
      ctx.beginPath();
      ctx.arc(r, r, r * 0.92, 0, Math.PI * 2);
      ctx.fillStyle = hlGrd;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(r, r, r * 0.92, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(77,184,255,0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();
      const pulse = 0.93 + 0.03 * Math.sin(angle * 3);
      ctx.beginPath();
      ctx.arc(r, r, r * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0,255,157,${0.08 + 0.04 * Math.sin(angle * 3)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    function animate() {
      angleRef.current += 0.005;
      drawGlobe(angleRef.current);
      animRef.current = requestAnimationFrame(animate);
    }
    animate();
    return () => cancelAnimationFrame(animRef.current);
  }, [size]);

  return <canvas ref={canvasRef} width={size} height={size} style={{ display: "block" }} />;
}

// ============================================================
// NEWS TAB COMPONENT
// ============================================================
function NewsTab({ newsData, dataStatus, manualNewsRisk, setManualNewsRisk, onRetry, newsRetryLoading, newsLastAttempt }) {
  const [cryptoNews, setCryptoNews] = useState([]);
  const [loadingNews, setLoadingNews] = useState(true);
  const [newsError, setNewsError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchCryptoNews = useCallback(async () => {
    setLoadingNews(true);
    setNewsError(null);
    try {
      const rssUrl = encodeURIComponent("https://feeds.feedburner.com/CoinDesk");
      const res2 = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${rssUrl}&count=15`);
      if (res2.ok) {
        const d = await res2.json();
        if (d.items && d.items.length > 0) {
          setCryptoNews(d.items.map(n => ({
            title: n.title, url: n.link,
            source: "CoinDesk",
            time: n.pubDate,
            description: n.description?.replace(/<[^>]*>/g, "").slice(0, 120) + "...",
            kind: "news",
          })));
          setLastFetch(new Date());
          setLoadingNews(false);
          return;
        }
      }
    } catch (e) {}
    setCryptoNews([]);
    setNewsError("Live crypto news feed unavailable. Check economic calendar below.");
    setLoadingNews(false);
  }, []);

  useEffect(() => {
    fetchCryptoNews();
    const interval = setInterval(fetchCryptoNews, 300000);
    return () => clearInterval(interval);
  }, []);

  const formatNewsTime = (timeStr) => {
    try {
      const d = new Date(timeStr);
      const diff = Date.now() - d.getTime();
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return d.toLocaleDateString();
    } catch { return ""; }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20, animation: "slideIn 0.3s ease", minHeight: 500 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <Card style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: 24 }}>
          <div style={{ marginBottom: 12, color: "#6b7280", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Global Markets</div>
          <RotatingGlobe size={200} />
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#4db8ff", fontWeight: 700, letterSpacing: "0.08em" }}>LIVE FEED</div>
            <div style={{ fontSize: 9, color: "#6b7280", marginTop: 4 }}>{lastFetch ? lastFetch.toLocaleTimeString() : "Loading..."}</div>
          </div>
        </Card>
        <Card style={{ width: "100%" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <SectionTitle icon="📅" label="Econ Calendar" />
            <button onClick={onRetry} disabled={newsRetryLoading}
              style={{ background: "rgba(77,184,255,0.1)", border: "1px solid rgba(77,184,255,0.3)", color: "#4db8ff", fontSize: 9, padding: "3px 8px", borderRadius: 4, cursor: newsRetryLoading ? "not-allowed" : "pointer", fontFamily: "'Space Mono', monospace" }}>
              {newsRetryLoading ? "⏳" : "↻ RETRY"}
            </button>
          </div>
          {/* v32: Calendar status — OK if fetch succeeded (even 0 events), UNAVAILABLE on network fail */}
          {!dataStatus?.newsAvailable ? (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.2)", marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: "#ffd700", fontWeight: 700 }}>⚠ Calendar Unavailable</div>
              <div style={{ fontSize: 9, color: "#92400e", marginTop: 2 }}>CORS/network — use manual news risk override below.</div>
              {(newsLastAttempt || dataStatus?.newsLastAttempt) && (
                <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>
                  Last checked: {new Date(newsLastAttempt || dataStatus.newsLastAttempt).toLocaleTimeString()}
                </div>
              )}
            </div>
          ) : newsData.length === 0 ? (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(0,255,157,0.04)", border: "1px solid rgba(0,255,157,0.15)", marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: "#00ff9d", fontWeight: 700 }}>✅ Calendar OK</div>
              <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>No high-impact events found this week.</div>
              {(newsLastAttempt || dataStatus?.newsLastAttempt) && (
                <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>
                  Last checked: {new Date(newsLastAttempt || dataStatus.newsLastAttempt).toLocaleTimeString()}
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 9, color: "#00ff9d", marginBottom: 8 }}>
              ✅ Calendar live · {newsData.length} events
              {(newsLastAttempt || dataStatus?.newsLastAttempt) && (
                <span style={{ color: "#6b7280", marginLeft: 6 }}>
                  · checked {new Date(newsLastAttempt || dataStatus.newsLastAttempt).toLocaleTimeString()}
                </span>
              )}
            </div>
          )}
          {/* v30: Manual news risk toggle */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Manual Risk Override</div>
            <div style={{ display: "flex", gap: 4 }}>
              {["NORMAL", "MEDIUM", "HIGH"].map(r => (
                <button key={r} onClick={() => setManualNewsRisk(r)}
                  style={{ flex: 1, padding: "4px 0", borderRadius: 4, border: manualNewsRisk === r ? `1px solid ${r === "HIGH" ? "rgba(255,69,102,0.4)" : r === "MEDIUM" ? "rgba(255,215,0,0.4)" : "rgba(0,255,157,0.4)"}` : "1px solid rgba(255,255,255,0.08)", background: manualNewsRisk === r ? (r === "HIGH" ? "rgba(255,69,102,0.12)" : r === "MEDIUM" ? "rgba(255,215,0,0.12)" : "rgba(0,255,157,0.08)") : "transparent", color: manualNewsRisk === r ? (r === "HIGH" ? "#ff4566" : r === "MEDIUM" ? "#ffd700" : "#00ff9d") : "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace", fontWeight: manualNewsRisk === r ? 700 : 400 }}>
                  {r}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: "#4b5563", marginTop: 4 }}>
              {manualNewsRisk === "HIGH" && "⛔ HIGH: All trade signals blocked"}
              {manualNewsRisk === "MEDIUM" && "⚠ MEDIUM: Confidence -5 on all signals"}
              {manualNewsRisk === "NORMAL" && "✅ NORMAL: No override applied"}
            </div>
          </div>
          {newsData.length === 0 && dataStatus?.news ? (
            <div style={{ color: "#374151", fontSize: 10 }}>No upcoming high/medium impact events</div>
          ) : newsData.slice(0, 8).map((e, i) => (
            <div key={i} style={{ marginBottom: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: `1px solid ${e.impact === "High" ? "rgba(255,69,102,0.2)" : "rgba(255,215,0,0.1)"}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                <Badge label={e.impact} color={e.impact === "High" ? "red" : "yellow"} />
                <span style={{ fontSize: 9, color: "#6b7280" }}>{e.country}</span>
              </div>
              <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 3, lineHeight: 1.4 }}>{e.title}</div>
              <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>{e.date ? new Date(e.date).toLocaleString() : "—"}</div>
            </div>
          ))}
        </Card>
      </div>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <SectionTitle icon="📰" label="Crypto News Feed" />
          <button onClick={fetchCryptoNews} style={{ background: "rgba(77,184,255,0.1)", border: "1px solid rgba(77,184,255,0.3)", color: "#4db8ff", fontSize: 9, padding: "4px 10px", borderRadius: 4, cursor: "pointer", letterSpacing: "0.08em", fontFamily: "'Space Mono', monospace" }}>↻ REFRESH</button>
        </div>
        {loadingNews && (
          <div style={{ textAlign: "center", padding: 60, color: "#374151" }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>⏳</div>
            <div style={{ fontSize: 11 }}>Fetching crypto news...</div>
          </div>
        )}
        {newsError && !loadingNews && (
          <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.15)", marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: "#ffd700" }}>⚠ {newsError}</div>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 600, overflowY: "auto" }}>
          {cryptoNews.map((n, i) => (
            <div key={i} style={{ padding: "10px 12px", borderRadius: 7, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", transition: "border-color 0.2s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(77,184,255,0.25)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <Badge label={n.source || "NEWS"} color="blue" />
                  {n.kind && n.kind !== "news" && <Badge label={n.kind.toUpperCase()} color="purple" />}
                </div>
                <span style={{ fontSize: 9, color: "#6b7280" }}>{formatNewsTime(n.time)}</span>
              </div>
              <div style={{ fontSize: 11, color: "#e5e7eb", lineHeight: 1.5, marginBottom: n.description ? 6 : 0, fontWeight: 500 }}>{n.title}</div>
              {n.description && <div style={{ fontSize: 9, color: "#6b7280", lineHeight: 1.4 }}>{n.description}</div>}
              {n.url && (
                <a href={n.url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 9, color: "#4db8ff", display: "inline-block", marginTop: 6, textDecoration: "none", letterSpacing: "0.06em" }}>
                  READ MORE →
                </a>
              )}
            </div>
          ))}
          {!loadingNews && cryptoNews.length === 0 && !newsError && (
            <div style={{ textAlign: "center", padding: 40, color: "#374151", fontSize: 11 }}>No news items available</div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  // ── v26: Auth + Cloud Sync + Notifications ────────────────
  const { user, loading: authLoading, signOut, isConfigured: authConfigured } = useAuth();
  const [localMode, setLocalMode] = useState(() => {
    // Allow bypass of auth for local-only use
    try { return localStorage.getItem('alpha_bot_local_mode') === 'true'; } catch { return false; }
  });
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [cloudBotStatus, setCloudBotStatus] = useState(null); // RUNNING | STOPPED | PAUSED (from cloud)
  const [offlineStatus, setOfflineStatus] = useState(navigator.onLine ? 'online' : 'offline');
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const deferredInstallPrompt = useRef(null);
  const cloudBotWS = useRef(null); // WebSocket to cloud backend

  const notifications = useNotifications();

  // Show PWA install prompt
  useEffect(() => {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt.current = e;
      setShowInstallBanner(true);
    });
    window.addEventListener('appinstalled', () => setShowInstallBanner(false));
  }, []);

  // Responsive breakpoint
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Offline detection
  useEffect(() => {
    const handleOnline = () => setOfflineStatus('online');
    const handleOffline = () => setOfflineStatus('offline');
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Listen for local mode bypass
  useEffect(() => {
    const handler = () => {
      setLocalMode(true);
      try { localStorage.setItem('alpha_bot_local_mode', 'true'); } catch {}
    };
    document.addEventListener('alpha-bot-local-mode', handler);
    return () => document.removeEventListener('alpha-bot-local-mode', handler);
  }, []);

  // Navigate from SW notification tap
  useEffect(() => {
    const handler = (e) => { if (e.detail?.tab) setActiveTab(e.detail.tab); };
    window.addEventListener('alpha-bot-navigate', handler);
    return () => window.removeEventListener('alpha-bot-navigate', handler);
  }, []);

  // Cloud sync hook
  const { syncStatus, lastSynced, pendingChanges, syncSetting, syncBotState, syncTrades, syncNote, forceSync, isConfigured: cloudConfigured } =
    useCloudSync({
      userId: user?.id,
      onBotStateChange: (state) => setCloudBotStatus(state),
      onTradesChange: (eventType, payload) => {
        // Realtime trade updates — trigger re-render
        if (eventType === 'trade' || eventType === '__init__') {
          // Force refresh of paper stats
          setPaperTrades([...paperEngine.trades]);
          setPaperPositions([...paperEngine.positions]);
        }
      },
      onSettingsChange: (key, value) => {
        // Apply incoming setting changes from another device
        if (key === '__all__') {
          // Batch load: value is { key: parsedValue }
          applyCloudSettings(value);
        }
      },
    });

  // Apply cloud-loaded settings to local state
  function applyCloudSettings(settings) {
    if (settings.patienceMode) { setPatienceMode(settings.patienceMode); patienceModeRef.current = settings.patienceMode; }
    if (settings.sizingMode) { setSizingMode(settings.sizingMode); sizingModeRef.current = settings.sizingMode; }
    if (typeof settings.manualLeverage === 'number') { setManualLeverage(settings.manualLeverage); manualLeverageRef.current = settings.manualLeverage; }
    if (typeof settings.manualLots === 'number') { setManualLots(settings.manualLots); manualLotsRef.current = settings.manualLots; }
    if (settings.feeGateMode) { setFeeGateMode(settings.feeGateMode); feeGateModeRef.current = settings.feeGateMode; }
    if (typeof settings.paperTradeWatchSignals === 'boolean') { setPaperTradeWatchSignals(settings.paperTradeWatchSignals); paperTradeWatchSignalsRef.current = settings.paperTradeWatchSignals; }
    if (typeof settings.unlimitedPaperLearning === 'boolean') { setUnlimitedPaperLearning(settings.unlimitedPaperLearning); unlimitedPaperLearningRef.current = settings.unlimitedPaperLearning; }
    if (typeof settings.strategyToggles === 'object') { setStrategyToggles(settings.strategyToggles); strategyTogglesRef.current = settings.strategyToggles; }
  }

  // Sync trade changes to cloud when paper trades change
  const syncTradesDebounceRef = useRef(null);
  function scheduleTradeSyncToCloud() {
    if (!user?.id) return;
    if (syncTradesDebounceRef.current) clearTimeout(syncTradesDebounceRef.current);
    syncTradesDebounceRef.current = setTimeout(() => {
      syncTrades(paperEngine.trades.slice(-100)); // sync latest 100 trades
    }, 3000);
  }

  // v34.EL Cloud: extended bot_status / logs / market snapshot state
  const [cloudBotDetail, setCloudBotDetail] = useState(null);
  const [engineLogs, setEngineLogs] = useState([]);
  const [marketSnapshot, setMarketSnapshot] = useState(null);

  // Subscribe to bot_status + engine_logs + market_snapshots via Supabase realtime
  useEffect(() => {
    if (!user?.id || !cloudConfigured) return;
    let channels = [];
    import('./auth/AuthContext.jsx').then(({ supabase: sb }) => {
      if (!sb) return;
      // bot_status channel
      const statusCh = sb.channel(`bot_status_${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_status', filter: `user_id=eq.${user.id}` }, payload => {
          const row = payload.new;
          if (!row) return;
          setCloudBotDetail(row);
          setCloudBotStatus(row.status);
          if (row.current_signal) setSignal(row.current_signal);
          if (row.current_regime) setRegime(prev => ({ ...(prev || {}), regime: row.current_regime }));
        }).subscribe();
      // market_snapshots channel
      const mktCh = sb.channel(`market_snap_${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'market_snapshots', filter: `user_id=eq.${user.id}` }, payload => {
          const d = payload.new?.data;
          if (!d) return;
          setMarketSnapshot(d);
          if (d.price) setPrice(d.price);
          if (d.fundingRate !== undefined) setFundingRate(d.fundingRate);
        }).subscribe();
      // engine_logs channel (new inserts only)
      const logsCh = sb.channel(`eng_logs_${user.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'engine_logs', filter: `user_id=eq.${user.id}` }, payload => {
          if (payload.new) setEngineLogs(prev => [payload.new, ...prev].slice(0, 100));
        }).subscribe();
      channels = [statusCh, mktCh, logsCh];
      // Load initial values
      sb.from('bot_status').select('*').eq('user_id', user.id).maybeSingle().then(({ data }) => {
        if (data) { setCloudBotDetail(data); setCloudBotStatus(data.status); }
      });
      sb.from('market_snapshots').select('data').eq('user_id', user.id).maybeSingle().then(({ data }) => {
        if (data?.data) { setMarketSnapshot(data.data); if (data.data.price) setPrice(data.data.price); }
      });
      sb.from('engine_logs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50).then(({ data }) => {
        if (data) setEngineLogs(data);
      });
    }).catch(() => {});
    return () => {
      import('./auth/AuthContext.jsx').then(({ supabase: sb }) => {
        if (sb) channels.forEach(ch => sb.removeChannel(ch));
      }).catch(() => {});
    };
  }, [user?.id, cloudConfigured]);

  // Send a command to the cloud backend via Supabase bot_commands table
  async function controlCloudBot(action) {
    if (!user?.id || !cloudConfigured) {
      console.warn('[CloudBot] Supabase not configured — cannot send command:', action);
      return;
    }
    const MAP = { start:'START', stop:'STOP', pause:'PAUSE', resume:'RESUME', restart:'START' };
    const command = MAP[action.toLowerCase()] || action.toUpperCase();
    try {
      const { supabase: sb } = await import('./auth/AuthContext.jsx');
      if (!sb) return;
      const { error } = await sb.from('bot_commands').insert({
        user_id: user.id, command, payload: null,
        status: 'PENDING', created_at: new Date().toISOString(),
      });
      if (error) console.warn('[CloudBot] Command insert failed:', error.message);
      else console.log('[CloudBot] Command sent to backend:', command);
    } catch (e) { console.warn('[CloudBot] insert error:', e.message); }
  }

  // Push settings change to backend via bot_commands
  async function sendSettingsToBackend(payload) {
    if (!user?.id || !cloudConfigured) return;
    try {
      const { supabase: sb } = await import('./auth/AuthContext.jsx');
      if (!sb) return;
      await sb.from('bot_commands').insert({
        user_id: user.id, command: 'UPDATE_SETTINGS', payload,
        status: 'PENDING', created_at: new Date().toISOString(),
      });
    } catch {}
  }

  // ── End v26/v34.EL cloud additions ────────────────────────

  const [mode, setMode] = useState(MODES.PAPER);
  const [price, setPrice] = useState(null);
  const [candles, setCandles] = useState([]);
  const [activeTimeframe, setActiveTimeframe] = useState("1m");
  const [chartInterval, setChartInterval] = useState("1");
  const [regime, setRegime] = useState(null);
  const [signal, setSignal] = useState(null);
  const [riskLevels, setRiskLevels] = useState(null);
  const [smcData, setSmcData] = useState({});
  const [orderBook, setOrderBook] = useState({ bids: [], asks: [] });
  const [fundingRate, setFundingRate] = useState(null);
  const [openInterest, setOpenInterest] = useState(null);
  const [newsData, setNewsData] = useState([]);
  const [newsRisk, setNewsRisk] = useState({ blocked: false, score: 0, events: [] });
  const [session, setSession] = useState(null);
  const [paperPositions, setPaperPositions] = useState([]);
  const [paperTrades, setPaperTrades] = useState([]);
  const [signalLogCount, setSignalLogCount] = useState(0);
  const [postExitSimsCount, setPostExitSimsCount] = useState(0);
  const [dataStatus, setDataStatus] = useState({});
  const [accountBalance] = useState(1000);
  const [dailyLimits, setDailyLimits] = useState({ blocked: false });
  const [copilotMsg, setCopilotMsg] = useState("Initializing systems...");
  const [copilotAnalysis, setCopilotAnalysis] = useState(null);
  const [signalGrade, setSignalGrade] = useState(null);
  const [activeTab, setActiveTab] = useState(() => {
    // Support ?tab= from notification shortcuts and SW notification taps
    try {
      const param = new URLSearchParams(window.location.search).get("tab");
      if (param) return param;
      if (window.__ALPHA_BOT_INITIAL_TAB__) return window.__ALPHA_BOT_INITIAL_TAB__;
    } catch {}
    return "dashboard";
  });
  const [isLive, setIsLive] = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);
  const [backtestRunning, setBacktestRunning] = useState(false);
  const [backtestStrategy, setBacktestStrategy] = useState("ALL");

  // v34: Blocked TRADE signal forensics — populated in runAnalysis for every skipped TRADE signal
  const [blockedSignalDetails, setBlockedSignalDetails] = useState([]);

  // v34.EL: Strategy enable/disable toggles
  // TREND defaults OFF (emergency lock); others default ON
  const [strategyToggles, setStrategyToggles] = useState({
    TREND: false,
    RANGE: true,
    BREAKOUT: true,
    REVERSAL: true,
  });
  const strategyTogglesRef = useRef({ TREND: false, RANGE: true, BREAKOUT: true, REVERSAL: true });

  // v34: Fee Gate Mode — controls how fee efficiency check affects paper trades
  // "OFF"        — skip fee check entirely
  // "WARN_ONLY"  — allow trade, attach feeEfficiencyWarning flag (default)
  // "HARD_BLOCK" — block trade, set tradedAs = "BLOCKED"
  const [feeGateMode, setFeeGateMode] = useState("WARN_ONLY");

  // Delta Exchange API Settings
  const [deltaApiKey, setDeltaApiKey] = useState("");
  const [deltaApiSecret, setDeltaApiSecret] = useState("");
  const [deltaProduct, setDeltaProduct] = useState("BTCUSD");
  const [deltaRememberKeys, setDeltaRememberKeys] = useState(false);
  const [deltaConnected, setDeltaConnected] = useState(false);
  const [deltaConnectionStatus, setDeltaConnectionStatus] = useState(null);
  const [deltaTestLoading, setDeltaTestLoading] = useState(false);
  const [apiVerified, setApiVerified] = useState(false);

  // v29: Manual leverage / lot control
  // v34: Draft (unapplied) vs Applied (active) split.
  //   Draft fields are what the user types in Settings.
  //   Applied fields are what runAnalysis and the fee gate actually use.
  //   Clicking "Apply Settings" copies draft → applied, syncs refs, saves to localStorage.
  const [sizingMode, setSizingMode] = useState("auto");       // APPLIED — "auto" | "manual"
  const [manualLeverage, setManualLeverage] = useState(10);   // APPLIED
  const [manualLots, setManualLots] = useState(100);          // APPLIED
  const [draftSizingMode, setDraftSizingMode] = useState("auto");    // DRAFT (UI input)
  const [draftLeverage, setDraftLeverage] = useState(10);            // DRAFT (UI input)
  const [draftLots, setDraftLots] = useState(100);                   // DRAFT (UI input)
  const [settingsApplied, setSettingsApplied] = useState(true);      // false = pending unapplied changes
  const [settingsError, setSettingsError] = useState(null);          // validation error
  const [manualMargin, setManualMargin] = useState("");  // display only
  const [sizingPreview, setSizingPreview] = useState(null);

  // v29: Paper risk lock setting — when ON, paper trades respect daily limits
  const [paperRespectsRiskLock, setPaperRespectsRiskLock] = useState(true);
  // v29: Paper trade watch signals — when ON, 75–84 confidence signals open paper trades
  const [paperTradeWatchSignals, setPaperTradeWatchSignals] = useState(false);

  // v30: Patience mode
  const [patienceMode, setPatienceMode] = useState("PATIENT"); // CONSERVATIVE|NORMAL|PATIENT|SWING_TEST
  // v30: Unlimited paper learning — no daily/loss/trade limits in paper mode (default ON)
  const [unlimitedPaperLearning, setUnlimitedPaperLearning] = useState(true);
  // v30: Manual news risk override
  const [manualNewsRisk, setManualNewsRisk] = useState("NORMAL"); // NORMAL | MEDIUM | HIGH
  // v30: Last candle update time display
  const [lastCandleTime, setLastCandleTime] = useState(null);
  // v30: Backtest extra filters
  const [backtestTimeframe, setBacktestTimeframe] = useState("1m");
  const [backtestConfidenceMin, setBacktestConfidenceMin] = useState(75);
  const [backtestSession, setBacktestSession] = useState("ALL");
  const [backtestError, setBacktestError] = useState(null);
  // v30: News retry state
  const [newsRetryLoading, setNewsRetryLoading] = useState(false);
  const [newsLastAttempt, setNewsLastAttempt] = useState(null);

  // v32: Trade replay state
  const [selectedTradeId, setSelectedTradeId] = useState(null);
  // v32: Trade notes editing
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteText, setNoteText] = useState("");
  // v32: Journal tab sub-section
  const [journalImportError, setJournalImportError] = useState(null);
  const [journalImportResult, setJournalImportResult] = useState(null);
  // v32: Daily report selected day
  const [selectedReportDay, setSelectedReportDay] = useState(null);

  const modeRef = useRef(mode);
  const candlesRef = useRef(candles);
  const smcDataRef = useRef(smcData);
  const activeTimeframeRef = useRef(activeTimeframe);
  // v29: Refs for settings accessed in runAnalysis (async callbacks)
  const sizingModeRef = useRef(sizingMode);
  const manualLeverageRef = useRef(manualLeverage);
  const manualLotsRef = useRef(manualLots);
  const paperRespectsRiskLockRef = useRef(paperRespectsRiskLock);
  const paperTradeWatchSignalsRef = useRef(paperTradeWatchSignals);
  const patienceModeRef = useRef(patienceMode);
  const unlimitedPaperLearningRef = useRef(unlimitedPaperLearning);
  const manualNewsRiskRef = useRef(manualNewsRisk);
  const feeGateModeRef = useRef("WARN_ONLY");

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { smcDataRef.current = smcData; }, [smcData]);
  useEffect(() => { activeTimeframeRef.current = activeTimeframe; }, [activeTimeframe]);
  useEffect(() => { sizingModeRef.current = sizingMode; }, [sizingMode]);
  useEffect(() => { manualLeverageRef.current = manualLeverage; }, [manualLeverage]);
  useEffect(() => { manualLotsRef.current = manualLots; }, [manualLots]);
  useEffect(() => { paperRespectsRiskLockRef.current = paperRespectsRiskLock; }, [paperRespectsRiskLock]);
  useEffect(() => { paperTradeWatchSignalsRef.current = paperTradeWatchSignals; }, [paperTradeWatchSignals]);
  useEffect(() => { patienceModeRef.current = patienceMode; }, [patienceMode]);
  useEffect(() => { unlimitedPaperLearningRef.current = unlimitedPaperLearning; }, [unlimitedPaperLearning]);
  useEffect(() => { manualNewsRiskRef.current = manualNewsRisk; }, [manualNewsRisk]);
  useEffect(() => { feeGateModeRef.current = feeGateMode; }, [feeGateMode]);
  useEffect(() => { strategyTogglesRef.current = strategyToggles; }, [strategyToggles]);

  // ── Init ──────────────────────────────────────────────────
  useEffect(() => {
    // v32: Load persisted journal data before starting data fetch
    journalStore.loadInto(paperEngine);

    // v34: Load persisted sizing settings and apply them immediately
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG.LS_SIZING) || "null");
      if (saved) {
        const lev = Math.min(200, Math.max(1, Math.floor(Number(saved.leverage || 10))));
        const lots = Math.max(1, Math.floor(Number(saved.lots || 100)));
        const mode = saved.sizingMode === "manual" ? "manual" : "auto";
        setSizingMode(mode);         setManualLeverage(lev);        setManualLots(lots);
        setDraftSizingMode(mode);    setDraftLeverage(lev);         setDraftLots(lots);
        sizingModeRef.current = mode;
        manualLeverageRef.current = lev;
        manualLotsRef.current = lots;
      }
    } catch {}

    // v33.x: Load persisted behavior settings
    try {
      const beh = JSON.parse(localStorage.getItem(CONFIG.LS_BEHAVIOR) || "null");
      if (beh) {
        if (beh.patienceMode)           { setPatienceMode(beh.patienceMode);                     patienceModeRef.current = beh.patienceMode; }
        if (beh.feeGateMode)            { setFeeGateMode(beh.feeGateMode);                       feeGateModeRef.current = beh.feeGateMode; }
        if (beh.manualNewsRisk)         { setManualNewsRisk(beh.manualNewsRisk);                  manualNewsRiskRef.current = beh.manualNewsRisk; }
        if (typeof beh.paperTradeWatchSignals === "boolean")   { setPaperTradeWatchSignals(beh.paperTradeWatchSignals);   paperTradeWatchSignalsRef.current = beh.paperTradeWatchSignals; }
        if (typeof beh.unlimitedPaperLearning === "boolean")   { setUnlimitedPaperLearning(beh.unlimitedPaperLearning);   unlimitedPaperLearningRef.current = beh.unlimitedPaperLearning; }
        if (typeof beh.paperRespectsRiskLock === "boolean")    { setPaperRespectsRiskLock(beh.paperRespectsRiskLock);     paperRespectsRiskLockRef.current = beh.paperRespectsRiskLock; }
      }
    } catch {}

    // v34.EL: Load persisted strategy toggles (defaults: TREND=OFF, rest=ON)
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG.LS_STRATEGY_TOGGLES) || "null");
      if (saved && typeof saved === "object") {
        const merged = { TREND: false, RANGE: true, BREAKOUT: true, REVERSAL: true, ...saved };
        setStrategyToggles(merged);
        strategyTogglesRef.current = merged;
      }
    } catch {}

    async function init() {
      setCopilotMsg("Fetching market data...");
      await marketDataEngine.fetchCandles("1m");
      await Promise.all([
        marketDataEngine.fetchOrderBook(),
        marketDataEngine.fetchFundingRate(),
        marketDataEngine.fetchOpenInterest(),
        marketDataEngine.fetchNews(),
      ]);
      marketDataEngine.fetchAllIntervals();

      const c = marketDataEngine.getCandles("1m");
      if (c.length) {
        setCandles([...c]);
        setPrice(c[c.length - 1].c);
        runAnalysis(c);
      }
      setOrderBook({ ...marketDataEngine.orderBook });
      setFundingRate(marketDataEngine.fundingRate);
      setOpenInterest(marketDataEngine.openInterest);
      setNewsData([...(marketDataEngine.news || [])]);
      setDataStatus(marketDataEngine.dataStatus());
      setSession(detectSession());
      setIsLive(true);

      marketDataEngine.connectWebSocket((candle) => {
        const tf = activeTimeframeRef.current;
        const updatedCandles = [...marketDataEngine.getCandles("1m")];
        setCandles(updatedCandles);
        setPrice(candle.c);
        setLastCandleTime(Date.now());
        if (candle.c && updatedCandles.length > 0) {
          // v26: capture open positions BEFORE update to detect newly closed trades
          const openIdsBefore = new Set(paperEngine.positions.map(p => p.id));
          paperEngine.updateAll(candle.c, updatedCandles, smcDataRef.current, patienceModeRef.current);
          // Detect closed trades and fire notifications
          const openIdsAfter = new Set(paperEngine.positions.map(p => p.id));
          openIdsBefore.forEach(id => {
            if (!openIdsAfter.has(id)) {
              const closed = paperEngine.trades.find(t => t.id === id && t.status === "closed");
              if (closed) {
                const pnlVal = closed.pnl?.netPnL ?? null;
                const isTP = closed.exitReason === "TAKE_PROFIT" || closed.exitReason?.includes("TP");
                const isSL = closed.exitReason === "STOP_LOSS" || closed.exitReason?.includes("SL");
                try {
                  if (isTP) notifications.tpHit({ direction: closed.direction, pnl: pnlVal, exit: closed.exit });
                  else if (isSL) notifications.slHit({ direction: closed.direction, pnl: pnlVal, exit: closed.exit });
                  else notifications.tradeClosed({ direction: closed.direction, pnl: pnlVal, exitReason: closed.exitReason, exit: closed.exit });
                } catch {}
              }
            }
          });
          setPaperPositions([...paperEngine.positions]);
          setPaperTrades([...paperEngine.trades]);
          setSignalLogCount(paperEngine.signalLog.length);
          setPostExitSimsCount(Object.keys(paperEngine.postExitSims).length);
          // v26: debounced cloud sync on every candle
          scheduleTradeSyncToCloud();
        }
        if (candle.closed) runAnalysis(updatedCandles);
      });
    }
    init();

    const interval = setInterval(async () => {
      await Promise.all([marketDataEngine.fetchOrderBook(), marketDataEngine.fetchFundingRate(), marketDataEngine.fetchOpenInterest()]);
      setOrderBook({ ...marketDataEngine.orderBook });
      setFundingRate(marketDataEngine.fundingRate);
      setOpenInterest(marketDataEngine.openInterest);
      setDataStatus(marketDataEngine.dataStatus());
      setSession(detectSession());
    }, 30000);

    const newsInterval = setInterval(async () => {
      await marketDataEngine.fetchNews();
      setNewsData([...(marketDataEngine.news || [])]);
    }, 300000);

    return () => {
      clearInterval(interval);
      clearInterval(newsInterval);
      marketDataEngine.disconnect();
    };
  }, []);

  function runAnalysis(c) {
    if (!c || c.length < 60) return;
    const swings = detectSwingPoints(c);
    const bosChoch = detectBOS_CHoCH(c, swings);
    const orderBlocks = detectOrderBlocks(c, swings);
    const fvgs = detectFairValueGaps(c);
    const sweep = detectLiquiditySweep(c, swings);
    const premiumDiscount = calcPremiumDiscount(c, swings);
    const smc = { swings, bosChoch, orderBlocks, fvgs, sweep, premiumDiscount };
    setSmcData(smc);
    smcDataRef.current = smc;

    const r = detectRegime(c);
    setRegime(r);

    const nr = checkNewsRisk(marketDataEngine.news || []);
    setNewsRisk(nr);

    const dl = checkDailyLimits(paperEngine.trades, accountBalance);
    setDailyLimits(dl);

    const ob = marketDataEngine.orderBook;
    const fr = marketDataEngine.fundingRate;
    const oi = marketDataEngine.openInterest;
    const currentSess = detectSession();

    // v34: Build session performance + extra context for generateSignal
    const closedTrades = paperEngine.trades.filter(t => t.status === "closed");
    const sessionPerf = calcSessionPerformance(closedTrades);
    const extraCtx = {
      signalLog: paperEngine.signalLog,
      closedTrades,
      sessionPerf,
      currentSession: currentSess,
    };

    let sig;
    if (nr.blocked && !unlimitedPaperLearningRef.current) {
      // News block only applies if unlimited paper learning is OFF
      const lastCandle = c[c.length - 1];
      sig = { action: "WAIT", reason: nr.reason, confidence: 0, regime: r.regime, signalId: `${CONFIG.SYMBOL}_${lastCandle?.t || 0}_BLOCKED_NEWS`, candleOpenTime: lastCandle?.t || 0 };
      paperEngine.logSignal(sig, "NEWS");
    } else if (!unlimitedPaperLearningRef.current && paperRespectsRiskLockRef.current && dl.blocked) {
      // v30: Daily limits only block if unlimited paper learning is OFF
      const lastCandle = c[c.length - 1];
      sig = generateSignal(c, r, smc, ob, fr, oi, extraCtx);
      paperEngine.logSignal(sig, "DAILY_LIMIT");
      sig = { action: "WAIT", reason: dl.reason, confidence: 0, regime: r.regime, signalId: `${CONFIG.SYMBOL}_${lastCandle?.t || 0}_BLOCKED_DAILY`, candleOpenTime: lastCandle?.t || 0 };
    } else {
      sig = generateSignal(c, r, smc, ob, fr, oi, extraCtx);
      // v30: Apply manual news risk confidence penalty
      if (manualNewsRiskRef.current === "MEDIUM" && sig.confidence > 0) {
        sig = { ...sig, confidence: Math.max(0, sig.confidence - 5), reason: (sig.reason || "") + " [Med news risk -5]" };
      } else if (manualNewsRiskRef.current === "HIGH") {
        // Block trade signals in manual high risk mode
        const lastCandle = c[c.length - 1];
        sig = { action: "WAIT", reason: "Manual HIGH news risk — trade blocked", confidence: 0, regime: r.regime, signalId: `${sig.signalId || CONFIG.SYMBOL + "_" + (lastCandle?.t || 0)}_HIGH_NEWSRISK`, candleOpenTime: lastCandle?.t || 0 };
      }
      const filterReason = sig.smcOpposed ? "SMC_OPPOSITION" : sig.action === "WATCH" ? "WATCH_BAND" : null;
      paperEngine.logSignal(sig, filterReason);
    }
    setSignalLogCount(paperEngine.signalLog.length);
    setSignal(sig);

    // v29: Auto-update sizing preview when price changes
    if (sig.action === "TRADE" || sig.action === "WATCH") {
      const atr = calcATR(c);
      const ep = c[c.length - 1].c;
      const rl = calcRiskLevels(sig.direction, ep, atr, accountBalance);
      setRiskLevels(rl);

      // Sizing preview for manual mode
      if (rl) {
        const preview = calcManualSizingPreview({
          entryPrice: ep,
          leverage: sizingModeRef.current === "manual" ? manualLeverageRef.current : CONFIG.LEVERAGE,
          lots: sizingModeRef.current === "manual" ? manualLotsRef.current : (rl.deltaContracts || 100),
          slDist: rl.slDist,
          tpDist: rl.tpDist,
          feeRate: CONFIG.TAKER_FEE,
        });
        setSizingPreview(preview);
      }

      // v29: Only open paper trades for TRADE signals (confidence ≥85)
      // WATCH signals only trade if paperTradeWatchSignals is explicitly ON
      const shouldTrade = sig.action === "TRADE" ||
        (sig.action === "WATCH" && paperTradeWatchSignalsRef.current);

      // v34: Full block-reason gate for TRADE signals
      // Every blocked TRADE signal must land with an exact reason in signalLog + blockedSignalDetails
      if (sig.action === "TRADE" || shouldTrade) {
        const originalSigId = sig.signalId;
        const usedBtcQty = sizingModeRef.current === "manual"
          ? (manualLotsRef.current * 0.001)
          : (rl?.btcQty || 0);
        const usedLeverage = sizingModeRef.current === "manual" ? manualLeverageRef.current : CONFIG.LEVERAGE;
        const usedLots = sizingModeRef.current === "manual" ? manualLotsRef.current : (rl?.deltaContracts || 0);
        const usedNotional = usedBtcQty * ep;
        const totalFee = usedNotional * CONFIG.TAKER_FEE * 2;
        const expectedReward = rl ? rl.tpDist * usedBtcQty : 0;
        const rewardFeeRatio = totalFee > 0 ? expectedReward / totalFee : 0;

        // v34 P1: Net profitability computation
        const netExpectancy = rl ? calcNetExpectancy(rl.tpDist, rl.slDist, usedBtcQty, ep) : null;
        const expectedNetReward = netExpectancy?.expectedNetReward ?? (expectedReward - totalFee);
        const netRR = netExpectancy?.netRR ?? 0;

        // --- Determine block reason ---
        let blockReason = null;

        if (modeRef.current !== MODES.PAPER) {
          blockReason = "PAPER_MODE_OFF";
        } else if (!rl || !rl.sl || !rl.tp || !rl.btcQty) {
          blockReason = "INVALID_RISK_LEVELS";
        } else if (paperEngine.hasPosition(originalSigId)) {
          blockReason = "DUPLICATE_SIGNAL";

        // v34.EL: Strategy toggle block — WATCH only if strategy is disabled
        } else if (sig.strategy && !strategyTogglesRef.current[sig.strategy]) {
          blockReason = "STRATEGY_DISABLED";
          sig = { ...sig, action: "WATCH", reason: `${sig.strategy} auto-trading DISABLED (strategy toggle OFF)` };
          setSignal(sig);

        // v34.EL: Session auto-block — WATCH if session has 10+ trades and WR < 30%
        } else if (currentSess) {
          const sessBlock = checkSessionAutoBlock(currentSess, closedTrades);
          if (sessBlock.blocked) {
            blockReason = "SESSION_POOR_PERFORMANCE";
            sig = { ...sig, action: "WATCH", reason: sessBlock.reason };
            setSignal(sig);
          }
        }

        // v34.EL: Strategy poor performance auto-block (20+ trades, WR < 30%)
        if (!blockReason && sig.strategy) {
          const stratBlock = checkStrategyPerformanceBlock(sig.strategy, closedTrades);
          if (stratBlock.blocked) {
            blockReason = "STRATEGY_POOR_PERFORMANCE";
            sig = { ...sig, action: "WATCH", reason: stratBlock.reason };
            setSignal(sig);
          }
        }

        // v34 P4 + EL: OVERTRADING COOLDOWN — TREND only
        if (!blockReason && sig.strategy === "TREND") {
          const openPositions = paperEngine.positions.filter(t => t.status === "open");
          const closedCandles = c.filter(candle => candle.closed);
          const cooldown = checkTrendCooldown(openPositions, closedTrades, sig.direction, closedCandles);
          if (cooldown.blocked) {
            blockReason = "TREND_COOLDOWN";
            sig = { ...sig, cooldownReason: cooldown.reason };
            setSignal(sig);
          }
          // v34.EL: TREND loss cooldown — 10 candles after a loss
          if (!blockReason) {
            const lossCooldown = checkTrendLossCooldown(closedTrades, sig.direction, closedCandles);
            if (lossCooldown.blocked) {
              blockReason = "TREND_LOSS_COOLDOWN";
              sig = { ...sig, cooldownReason: lossCooldown.reason };
              setSignal(sig);
            }
          }
          // v34.EL: Strict TREND entry check
          if (!blockReason) {
            const strictCheck = checkStrictTrendEntry(c, smc, sig);
            if (!strictCheck.pass) {
              blockReason = "STRICT_TREND_ENTRY_FAIL";
              sig = { ...sig, action: "WATCH", reason: strictCheck.reason };
              setSignal(sig);
            }
          }
        }

        // v34 P1: NET PROFITABILITY FILTER — only if not already blocked
        if (!blockReason) {
          if (expectedNetReward <= 0) {
            blockReason = "NEGATIVE_NET_EXPECTANCY";
            sig = {
              ...sig,
              netExpectancyFail: true,
              netExpectancyReason: `Net reward $${expectedNetReward.toFixed(4)} ≤ 0 after fees $${totalFee.toFixed(4)}`,
              action: "WATCH",
              reason: `NEGATIVE_NET_EXPECTANCY — net reward $${expectedNetReward.toFixed(4)} after fees`,
            };
            setSignal(sig);
          }
        }

        // v34 P2: MINIMUM NET RR FILTER — only if not already blocked
        if (!blockReason) {
          if (netRR < CONFIG.MIN_NET_RR) {
            blockReason = "LOW_NET_RR";
            sig = {
              ...sig,
              lowNetRR: true,
              lowNetRRReason: `Net RR ${netRR.toFixed(2)} < required ${CONFIG.MIN_NET_RR}`,
              action: "WATCH",
              reason: `LOW_NET_RR — net RR ${netRR.toFixed(2)} after fees (min ${CONFIG.MIN_NET_RR})`,
            };
            setSignal(sig);
          }
        }

        // Existing fee efficiency check — behaviour depends on feeGateMode
        if (!blockReason) {
          const feeWeak = expectedReward < 3 * totalFee;
          const fgm = feeGateModeRef.current; // "OFF" | "WARN_ONLY" | "HARD_BLOCK"
          if (feeWeak && fgm === "HARD_BLOCK") {
            blockReason = "FEE_GATE_HARD_BLOCK";
            sig = {
              ...sig,
              action: "WATCH",
              feeEfficiencyFail: true,
              feeEfficiencyWarning: false,
              feeEfficiencyReason: `HARD BLOCK: reward $${expectedReward.toFixed(4)} < 3× fee $${(3 * totalFee).toFixed(4)}`,
              reason: `FEE_EFFICIENCY_FAIL — reward $${expectedReward.toFixed(4)} < 3× fee $${(3 * totalFee).toFixed(4)}`,
            };
            setSignal(sig);
          } else if (feeWeak && fgm === "WARN_ONLY") {
            sig = {
              ...sig,
              feeEfficiencyWarning: true,
              feeEfficiencyFail: false,
              feeEfficiencyReason: `Fee efficiency weak: reward $${expectedReward.toFixed(4)} < 3× fee $${(3 * totalFee).toFixed(4)} (trade allowed — WARN ONLY)`,
            };
            setSignal(sig);
            paperEngine.updateSignalLog(originalSigId, { feeEfficiencyWarning: true });
          }
        }

        if (blockReason) {
          // Patch the existing log entry with exact block reason + BLOCKED tradedAs
          const blockedDetails = {
            signalId: originalSigId,
            reason: blockReason,
            direction: sig.direction || null,
            strategy: sig.strategy || null,
            regime: sig.regime || null,
            confidence: sig.confidence || 0,
            lots: usedLots,
            leverage: usedLeverage,
            btcQty: usedBtcQty.toFixed(6),
            entry: ep,
            sl: rl?.sl || null,
            tp: rl?.tp || null,
            notional: usedNotional.toFixed(2),
            tpDist: rl?.tpDist?.toFixed(2) || null,
            totalFee: totalFee.toFixed(6),
            expectedReward: expectedReward.toFixed(6),
            expectedNetReward: expectedNetReward.toFixed(6),
            netRR: netRR.toFixed(3),
            rewardFeeRatio: rewardFeeRatio.toFixed(3),
            cooldownReason: sig.cooldownReason || null,
            timestamp: Date.now(),
            blockedAt: Date.now(),
          };
          paperEngine.updateSignalLog(originalSigId, {
            filteredBy: blockReason,
            tradedAs: "BLOCKED",
            blockedDetails,
          });
          setBlockedSignalDetails(prev => {
            // dedupe by signalId
            const filtered = prev.filter(d => d.signalId !== originalSigId);
            return [...filtered, blockedDetails].slice(-50); // keep last 50
          });
        } else {
          // All gates passed — open paper trade
          const sizingSettings = sizingModeRef.current === "manual"
            ? { mode: "manual", leverage: manualLeverageRef.current, lots: manualLotsRef.current }
            : { mode: "auto" };
          const pt = paperEngine.enter(sig, rl, ep, r.regime, smc, nr, currentSess, fr, sizingSettings);
          if (pt) {
            // enter() already sets tradedAs = pt.id on the log entry
            paperEngine.updateSignalLog(originalSigId, { tradedAs: pt.id });
            setPaperPositions([...paperEngine.positions]);
            setPaperTrades([...paperEngine.trades]);
            // v32: persist new trade immediately
            try { journalStore.saveAll(paperEngine); } catch {}
            // v26: push notification + cloud sync on new trade
            try { notifications.tradeOpened({ direction: pt.direction, strategy: pt.strategy, confidence: pt.confidence, entry: pt.entry }); } catch {}
            scheduleTradeSyncToCloud();
          } else {
            // enter() returned null (seenSignalIds duplicate or no signalId)
            paperEngine.updateSignalLog(originalSigId, {
              filteredBy: "DUPLICATE_SIGNAL",
              tradedAs: "BLOCKED",
            });
          }
        }
      }
    } else {
      setRiskLevels(null);
      setSizingPreview(null);
    }

    const currentPrice = c[c.length - 1].c;
    updateCopilot(sig, r, smc, nr, dl, ob, fr, currentPrice);
  }

  function updateCopilot(sig, r, smc, nr, dl, ob, fr, currentPrice) {
    // Use the live price passed directly from runAnalysis, NOT React `price` state (which may be stale)
    const analysis = buildCopilotAnalysis(sig, r, smc, nr, dl, ob, currentPrice, fr);
    setCopilotAnalysis(analysis);
    setCopilotMsg(analysis.headline || "Analyzing market...");
    if (sig?.action === "TRADE") {
      const grade = gradeSignal(sig, smc, r, ob, currentPrice);
      setSignalGrade(grade);
    } else {
      setSignalGrade(null);
    }
  }

  function handleRunBacktest() {
    setBacktestRunning(true);
    setBacktestError(null);
    setTimeout(() => {
      try {
        const c = candlesRef.current;
        if (!c || c.length < 100) {
          setBacktestError(`Not enough candle data. Need 100+, have ${c?.length || 0}.`);
          setBacktestRunning(false);
          return;
        }
        // v30: Apply backtest filters
        const result = runBacktest(c, backtestStrategy, accountBalance, backtestConfidenceMin, backtestSession);
        if (!result) {
          setBacktestError(`No trades generated for strategy "${backtestStrategy}" with current filters. Try broadening the filters or waiting for more candle data.`);
          setBacktestResult(null);
        } else {
          setBacktestResult(result);
        }
      } catch (err) {
        setBacktestError(`Backtest error: ${err.message}`);
        setBacktestResult(null);
      }
      setBacktestRunning(false);
    }, 100);
  }

  // v30: News retry handler
  async function handleNewsRetry() {
    setNewsRetryLoading(true);
    setNewsLastAttempt(new Date());
    await marketDataEngine.fetchNews();
    setNewsData([...(marketDataEngine.news || [])]);
    setDataStatus(marketDataEngine.dataStatus());
    setNewsRetryLoading(false);
  }

  // v34: Apply Settings — validate drafts, copy to active state, sync refs, persist, re-run preview
  function handleApplySettings() {
    setSettingsError(null);
    // Validate
    const lev = Math.floor(Number(draftLeverage));
    const lots = Math.floor(Number(draftLots));
    if (!Number.isFinite(lev) || lev < 1 || lev > 200) {
      setSettingsError("Leverage must be an integer between 1 and 200.");
      return;
    }
    if (!Number.isFinite(lots) || lots < 1) {
      setSettingsError("Lots must be a positive integer ≥ 1.");
      return;
    }
    // Apply: set active state
    setSizingMode(draftSizingMode);
    setManualLeverage(lev);
    setManualLots(lots);
    // Sync refs immediately so runAnalysis sees the new values on next candle
    sizingModeRef.current = draftSizingMode;
    manualLeverageRef.current = lev;
    manualLotsRef.current = lots;
    // Persist to localStorage
    try {
      localStorage.setItem(CONFIG.LS_SIZING, JSON.stringify({
        sizingMode: draftSizingMode, leverage: lev, lots,
      }));
    } catch {}
    setSettingsApplied(true);
    // v26: sync sizing to cloud (Supabase settings table)
    try { syncSetting("sizingMode", draftSizingMode); syncSetting("manualLeverage", lev); syncSetting("manualLots", lots); } catch {}
    // v34.EL: also push to backend worker via bot_commands
    try { sendSettingsToBackend({ sizingMode: draftSizingMode, manualLeverage: lev, manualLots: lots }); } catch {}
    // v33.x: Also persist all behavior settings when applying
    saveBehaviorSettings({ patienceMode: patienceModeRef.current, feeGateMode: feeGateModeRef.current });
    // Force immediate preview refresh with current price/candles if available
    const c = candlesRef.current;
    if (c && c.length > 0) {
      const ep = c[c.length - 1].c;
      const atr = calcATR(c);
      if (atr && signal && (signal.action === "TRADE" || signal.action === "WATCH")) {
        const rl = calcRiskLevels(signal.direction, ep, atr, accountBalance);
        if (rl) {
          const preview = calcManualSizingPreview({
            entryPrice: ep,
            leverage: draftSizingMode === "manual" ? lev : CONFIG.LEVERAGE,
            lots: draftSizingMode === "manual" ? lots : (rl.deltaContracts || 100),
            slDist: rl.slDist,
            tpDist: rl.tpDist,
            feeRate: CONFIG.TAKER_FEE,
          });
          setSizingPreview(preview);
        }
      }
    }
  }

  // v33.x: Persist all behavior settings to localStorage
  function saveBehaviorSettings(overrides = {}) {
    try {
      const current = {
        patienceMode: patienceModeRef.current,
        feeGateMode: feeGateModeRef.current,
        manualNewsRisk: manualNewsRiskRef.current,
        paperTradeWatchSignals: paperTradeWatchSignalsRef.current,
        unlimitedPaperLearning: unlimitedPaperLearningRef.current,
        paperRespectsRiskLock: paperRespectsRiskLockRef.current,
        ...overrides,
      };
      localStorage.setItem(CONFIG.LS_BEHAVIOR, JSON.stringify(current));
      // v26: sync each setting key to cloud (Supabase settings table)
      Object.entries(current).forEach(([k, v]) => { try { syncSetting(k, v); } catch {} });
      // v34.EL: push full settings payload to backend worker
      try { sendSettingsToBackend(current); } catch {}
    } catch {}
  }

  // v33.x: Reset all behavior settings to defaults
  function handleResetBehaviorSettings() {
    const defaults = { patienceMode: "PATIENT", feeGateMode: "WARN_ONLY", manualNewsRisk: "NORMAL", paperTradeWatchSignals: false, unlimitedPaperLearning: true, paperRespectsRiskLock: true };
    setPatienceMode(defaults.patienceMode);            patienceModeRef.current = defaults.patienceMode;
    setFeeGateMode(defaults.feeGateMode);              feeGateModeRef.current = defaults.feeGateMode;
    setManualNewsRisk(defaults.manualNewsRisk);        manualNewsRiskRef.current = defaults.manualNewsRisk;
    setPaperTradeWatchSignals(defaults.paperTradeWatchSignals); paperTradeWatchSignalsRef.current = defaults.paperTradeWatchSignals;
    setUnlimitedPaperLearning(defaults.unlimitedPaperLearning); unlimitedPaperLearningRef.current = defaults.unlimitedPaperLearning;
    setPaperRespectsRiskLock(defaults.paperRespectsRiskLock); paperRespectsRiskLockRef.current = defaults.paperRespectsRiskLock;
    saveBehaviorSettings(defaults);
    // Also reset sizing to defaults
    setSizingMode("auto"); setManualLeverage(10); setManualLots(100);
    setDraftSizingMode("auto"); setDraftLeverage(10); setDraftLots(100);
    sizingModeRef.current = "auto"; manualLeverageRef.current = 10; manualLotsRef.current = 100;
    try { localStorage.setItem(CONFIG.LS_SIZING, JSON.stringify({ sizingMode: "auto", leverage: 10, lots: 100 })); } catch {}
    setSettingsApplied(true);
  }

  // Timeframe selector: change bot candles + TradingView chart together
  function handleTimeframeChange(tf) {
    const tvMap = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240" };
    setActiveTimeframe(tf);
    activeTimeframeRef.current = tf;
    setChartInterval(tvMap[tf] || "1");
    const c = marketDataEngine.getCandles(tf);
    if (c.length) {
      setCandles([...c]);
      runAnalysis([...c]);
    }
  }

  // Delta API test connection — FRONTEND ONLY STUB.
  // Real credential verification requires the Node.js backend (POST /delta/test-connection).
  // This function CANNOT verify API keys from the browser due to CORS + HMAC signing constraints.
  async function handleDeltaTestConnection() {
    if (!deltaApiKey || !deltaApiSecret) {
      setDeltaConnectionStatus({ ok: false, error: "API Key and Secret are required." });
      return;
    }
    setDeltaTestLoading(true);
    setDeltaConnectionStatus(null);
    await new Promise(r => setTimeout(r, 1000));
    // NOTE: No real API call is made here. Real testing requires the backend server.
    const mockResult = {
      ok: false,
      error: "⚠ Backend server not running. Real API verification requires the Node.js backend (not this browser app).",
      apiStatus: "UNVERIFIED — BACKEND REQUIRED",
      balance: null,
      productId: deltaProduct,
      positions: null,
      funding: null,
    };
    setDeltaConnectionStatus(mockResult);
    setDeltaConnected(false);
    setApiVerified(false);
    setDeltaTestLoading(false);
  }

  function handleSaveDeltaSettings() {
    if (deltaRememberKeys) {
      try {
        localStorage.setItem("alpha_delta_key", deltaApiKey);
        // Never store secret in localStorage for security — memory only
      } catch {}
    }
  }

  function handleClearDeltaSettings() {
    setDeltaApiKey("");
    setDeltaApiSecret("");
    setDeltaConnected(false);
    setApiVerified(false);
    setDeltaConnectionStatus(null);
    try { localStorage.removeItem("alpha_delta_key"); } catch {}
  }

  // ── Computed ──────────────────────────────────────────────
  const paperStats = useMemo(() => paperEngine.getStats(), [paperTrades]);
  const detailedStats = useMemo(() => paperEngine.getDetailedStats(), [paperTrades]);
  const signalAnalytics = useMemo(() => paperEngine.getSignalAnalytics(), [paperTrades, signalLogCount]);
  const calibration = useMemo(() => calcConfidenceCalibration(paperEngine.trades.filter(t => t.status === "closed")), [paperTrades]);
  // v29: Pass dataStatus to getDiagnosticsReport for WS/news warnings
  const diagnosticsReport = useMemo(() => paperEngine.getDiagnosticsReport(dataStatus), [paperTrades, signalLogCount, dataStatus]);
  // v30: Outcome learning + exit style comparison
  const outcomeLearning = useMemo(() => paperEngine.getOutcomeLearning(), [paperTrades]);
  const exitStyleComparison = useMemo(() => paperEngine.getExitStyleComparison(), [paperTrades]);
  // v31: Post-exit simulation analytics
  const postExitAnalytics = useMemo(() => paperEngine.getPostExitAnalytics(), [paperTrades, postExitSimsCount]);
  // v32: New analytics
  const leaderboard = useMemo(() => paperEngine.getLeaderboard(), [paperTrades]);
  const feeImpact = useMemo(() => paperEngine.getFeeImpact(), [paperTrades]);
  const dailyReports = useMemo(() => paperEngine.getDailyReport(), [paperTrades]);
  const regimeStats = useMemo(() => regimeAccuracy.getStats(), [paperTrades]);
  const latestPaperPosition = paperPositions[paperPositions.length - 1] || null;
  const latestPaperPnL = latestPaperPosition && price
    ? calcFuturesPnL({ direction: latestPaperPosition.direction, entry: latestPaperPosition.entry, exit: price, btcQty: latestPaperPosition.btcQty, fundingRate: latestPaperPosition.fundingRate, holdHours: (Date.now() - latestPaperPosition.entryTime) / 3600000 })
    : null;

  // ── Tabs ──────────────────────────────────────────────────
  const tabs = [
    { id: "dashboard", label: "📊 Dashboard" },
    { id: "chart", label: "📈 Chart" },
    { id: "signal", label: "⚡ Signal" },
    { id: "copilot", label: "🧠 Copilot" },
    { id: "smc", label: "🏗️ SMC" },
    { id: "trades", label: "📋 Trades" },
    { id: "analytics", label: "🎰 Analytics" },
    { id: "leaderboard", label: "🏆 Leaderboard" },
    { id: "journal", label: "📓 Journal" },
    { id: "dailyreport", label: "📅 Daily" },
    { id: "calibration", label: "🎯 Calibration" },
    { id: "diagnostics", label: "🔍 Diagnostics" },
    { id: "backtest", label: "🔬 Backtest" },
    { id: "exports", label: "💾 Exports" },
    { id: "news", label: "🌍 News" },
    { id: "settings", label: "⚙️ Settings" },
    { id: "exchange", label: "🔑 Exchange" },
  ];

  // ── v26: Auth gate ────────────────────────────────────────
  // Show login if Supabase is configured and user is not signed in
  if (authConfigured && !authLoading && !user && !localMode) {
    return <LoginScreen />;
  }
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', background: '#060b14', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace' }}>
        <div style={{ textAlign: 'center', color: '#6b7280' }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>⚡</div>
          <div style={{ fontSize: 11, letterSpacing: '0.1em' }}>LOADING ALPHA BOT...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#060b14", fontFamily: "'Space Mono', 'Courier New', monospace", color: "#e5e7eb", padding: 0 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
        @keyframes slideIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
        .tab-active { background: rgba(255,255,255,0.08) !important; color: #fff !important; }
        .tab-btn:hover { background: rgba(255,255,255,0.04) !important; }

        /* ── v26: Mobile responsive overrides ─────────────────── */
        @media (max-width: 767px) {
          .alpha-content-grid-3 { grid-template-columns: 1fr !important; }
          .alpha-content-grid-2 { grid-template-columns: 1fr !important; }
          .alpha-content-grid-4 { grid-template-columns: 1fr 1fr !important; }
          .alpha-content-grid-5 { grid-template-columns: 1fr 1fr !important; }
          .alpha-content { padding: 12px !important; }
          .alpha-header-price { font-size: 14px !important; }
          .alpha-header-right { gap: 8px !important; }
          .alpha-mode-btn span { display: none; }
          .desktop-only { display: none !important; }
          .alpha-tab-label-long { display: none; }
          .alpha-tab-emoji { font-size: 16px; }
        }
        @media (min-width: 768px) {
          .mobile-only { display: none !important; }
        }

        /* PWA install banner */
        @keyframes slideDown { from { transform: translateY(-100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .install-banner { animation: slideDown 0.3s ease; }

        /* Touch-friendly tap targets */
        @media (hover: none) {
          .tab-btn { min-height: 44px !important; }
          button { min-height: 36px; }
        }

        /* Offline indicator */
        .sync-indicator { transition: all 0.3s ease; }
      `}</style>

      {/* ── v26: PWA Install Banner ── */}
      {showInstallBanner && (
        <div className="install-banner" style={{ background: "rgba(0,255,157,0.08)", borderBottom: "1px solid rgba(0,255,157,0.2)", padding: "8px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ fontSize: 11, color: "#00ff9d", fontWeight: 700 }}>📱 Install Alpha Bot on your device</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={async () => { if (deferredInstallPrompt.current) { deferredInstallPrompt.current.prompt(); const { outcome } = await deferredInstallPrompt.current.userChoice; if (outcome === 'accepted') setShowInstallBanner(false); } }}
              style={{ padding: "4px 12px", borderRadius: 4, border: "1px solid rgba(0,255,157,0.4)", background: "rgba(0,255,157,0.12)", color: "#00ff9d", fontSize: 10, cursor: "pointer", fontFamily: "'Space Mono', monospace", fontWeight: 700 }}>
              INSTALL
            </button>
            <button onClick={() => setShowInstallBanner(false)}
              style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#6b7280", fontSize: 10, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: isMobile ? "0 12px" : "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 52, background: "rgba(0,0,0,0.4)", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 28, height: 28, background: "linear-gradient(135deg, #00ff9d22, #4db8ff22)", border: "1px solid rgba(0,255,157,0.3)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⚡</div>
          <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: isMobile ? 14 : 16, letterSpacing: "-0.01em" }}>ALPHA BOT</span>
          <span className="desktop-only" style={{ color: "#374151", fontSize: 11 }}>v{CONFIG.VERSION}</span>
        </div>

        <div className="alpha-header-right" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* BTC Price */}
          <div style={{ textAlign: "right" }}>
            <div className="alpha-header-price" style={{ fontSize: 18, fontWeight: 700, color: "#00ff9d", letterSpacing: "-0.02em" }}>{price ? formatPrice(price) : "—"}</div>
            <div className="desktop-only" style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.08em" }}>BTC / USD</div>
          </div>

          {/* v26: Cloud sync status */}
          {cloudConfigured && (
            <div className="sync-indicator desktop-only" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: syncStatus === 'synced' ? "#00ff9d" : syncStatus === 'syncing' ? "#ffd700" : syncStatus === 'offline' ? "#ff4566" : "#6b7280", animation: syncStatus === 'syncing' ? "pulse 1s infinite" : "none" }} />
              <span style={{ fontSize: 8, color: "#4b5563", letterSpacing: "0.06em" }}>
                {syncStatus === 'synced' ? "SYNCED" : syncStatus === 'syncing' ? "SYNCING..." : syncStatus === 'offline' ? `OFFLINE (${pendingChanges})` : "CLOUD"}
              </span>
            </div>
          )}

          {paperPositions.length > 0 && (
            <div style={{ background: "rgba(0,255,157,0.08)", border: "1px solid rgba(0,255,157,0.2)", borderRadius: 6, padding: "3px 10px", fontSize: 10, color: "#00ff9d" }}>
              {paperPositions.length} OPEN
            </div>
          )}

          {/* Mode switcher — hidden on mobile (access via Settings) */}
          <div className="desktop-only" style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.04)", padding: 3, borderRadius: 6 }}>
            {[MODES.GUIDANCE, MODES.PAPER, MODES.LIVE].map(m => (
              <button key={m} onClick={() => setMode(m)} className={`tab-btn ${mode === m ? "tab-active" : ""}`}
                style={{ padding: "4px 10px", borderRadius: 4, border: "none", background: "transparent", color: mode === m ? "#fff" : "#6b7280", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase", transition: "all 0.15s" }}>
                {m === MODES.LIVE ? "🔴 LIVE" : m.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="desktop-only" style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: isLive ? "#00ff9d" : "#ff4566", animation: isLive ? "pulse 2s infinite" : "none", boxShadow: isLive ? "0 0 6px #00ff9d" : "none" }} />
            <span style={{ fontSize: 9, color: "#6b7280" }}>{isLive ? "LIVE" : "OFFLINE"}</span>
          </div>

          {/* v26: User menu + sign out */}
          {user && (
            <div className="desktop-only" style={{ position: "relative" }}>
              <button onClick={() => signOut()}
                style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid rgba(255,255,255,0.08)", background: "transparent", color: "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}
                title={user.email}>
                {user.email?.slice(0, 10)}… ↗
              </button>
            </div>
          )}

          {/* Mobile hamburger menu */}
          <button className="mobile-only"
            onClick={() => setMobileMenuOpen(prev => !prev)}
            style={{ padding: "6px 8px", borderRadius: 4, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#9ca3af", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>
            {mobileMenuOpen ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {/* ── v26: Mobile Menu Drawer ── */}
      {mobileMenuOpen && (
        <div className="mobile-only" style={{ position: "fixed", top: 52, left: 0, right: 0, bottom: 0, background: "rgba(6,11,20,0.98)", zIndex: 200, overflowY: "auto", padding: 16 }}>
          {/* Mode selector */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Trading Mode</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[MODES.GUIDANCE, MODES.PAPER, MODES.LIVE].map(m => (
                <button key={m} onClick={() => { setMode(m); setMobileMenuOpen(false); }}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 6, border: `1px solid ${mode === m ? "rgba(0,255,157,0.4)" : "rgba(255,255,255,0.08)"}`, background: mode === m ? "rgba(0,255,157,0.1)" : "transparent", color: mode === m ? "#00ff9d" : "#6b7280", fontSize: 11, fontWeight: mode === m ? 700 : 400, cursor: "pointer", fontFamily: "'Space Mono', monospace", textTransform: "uppercase" }}>
                  {m === MODES.LIVE ? "🔴 LIVE" : m}
                </button>
              ))}
            </div>
          </div>

          {/* Cloud bot controls */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Bot Control</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { label: "▶ START", action: "start", color: "#00ff9d" },
                { label: "■ STOP", action: "stop", color: "#ff4566" },
                { label: "⏸ PAUSE", action: "pause", color: "#ffd700" },
                { label: "↺ RESTART", action: "restart", color: "#4db8ff" },
              ].map(btn => (
                <button key={btn.action} onClick={() => { controlCloudBot(btn.action); setMobileMenuOpen(false); }}
                  style={{ padding: "12px 0", borderRadius: 6, border: `1px solid ${btn.color}33`, background: `${btn.color}11`, color: btn.color, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                  {btn.label}
                </button>
              ))}
            </div>
            {cloudBotStatus && (
              <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 4, background: "rgba(255,255,255,0.03)", fontSize: 10, color: "#6b7280", textAlign: "center" }}>
                Cloud Bot: <span style={{ color: cloudBotStatus === 'RUNNING' ? "#00ff9d" : cloudBotStatus === 'PAUSED' ? "#ffd700" : "#ff4566", fontWeight: 700 }}>{cloudBotStatus}</span>
              </div>
            )}
          </div>

          {/* Tab navigation */}
          <div style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Navigation</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => { setActiveTab(t.id); setMobileMenuOpen(false); }}
                style={{ padding: "12px 10px", borderRadius: 6, border: activeTab === t.id ? "1px solid rgba(0,255,157,0.3)" : "1px solid rgba(255,255,255,0.06)", background: activeTab === t.id ? "rgba(0,255,157,0.06)" : "rgba(255,255,255,0.02)", color: activeTab === t.id ? "#00ff9d" : "#9ca3af", fontSize: 11, cursor: "pointer", fontFamily: "'Space Mono', monospace", textAlign: "left" }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Account */}
          {user && (
            <div style={{ marginTop: 20, padding: "12px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 8 }}>Signed in as: <span style={{ color: "#4db8ff" }}>{user.email}</span></div>
              <button onClick={() => { signOut(); setMobileMenuOpen(false); }}
                style={{ padding: "8px 0", width: "100%", borderRadius: 4, border: "1px solid rgba(255,69,102,0.2)", background: "rgba(255,69,102,0.06)", color: "#ff4566", fontSize: 11, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                Sign Out
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── v26: Offline Status Bar ── */}
      {offlineStatus === 'offline' && (
        <div style={{ background: "rgba(255,69,102,0.08)", borderBottom: "1px solid rgba(255,69,102,0.2)", padding: "6px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, color: "#ff4566", fontWeight: 700 }}>⚠ OFFLINE — Changes will sync when reconnected</span>
          {pendingChanges > 0 && <span style={{ fontSize: 9, color: "#6b7280" }}>{pendingChanges} pending</span>}
        </div>
      )}
      {offlineStatus === 'online' && pendingChanges > 0 && (
        <div style={{ background: "rgba(255,215,0,0.06)", borderBottom: "1px solid rgba(255,215,0,0.2)", padding: "6px 16px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "#ffd700" }}>⟳ Syncing {pendingChanges} pending changes...</span>
        </div>
      )}

      {/* ── LIVE TRADING NOT ACTIVE BANNER ── */}
      {!apiVerified && (
        <div className="desktop-only" style={{ background: "rgba(255,165,0,0.07)", borderBottom: "1px solid rgba(255,165,0,0.25)", padding: "7px 20px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: "#fbbf24", fontWeight: 700, letterSpacing: "0.12em", fontFamily: "'Space Mono', monospace" }}>
            ⚠ LIVE TRADING NOT ACTIVE — PAPER / ANALYTICS ONLY
          </span>
          <span style={{ fontSize: 9, color: "#92400e", letterSpacing: "0.06em" }}>Real orders require a verified Delta Exchange backend connection.</span>
        </div>
      )}

      {/* ── Copilot Bar ── */}
      <div style={{ background: "rgba(0,0,0,0.3)", borderBottom: "1px solid rgba(255,255,255,0.04)", padding: isMobile ? "8px 12px" : "10px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: signal?.action === "TRADE" ? "#00ff9d" : "#ffd700", boxShadow: `0 0 6px ${signal?.action === "TRADE" ? "#00ff9d" : "#ffd700"}88`, flexShrink: 0 }} />
        <span style={{ color: signal?.action === "TRADE" ? "#d1fae5" : "#fef3c7", fontSize: isMobile ? 10 : 11, letterSpacing: "0.02em", fontFamily: "'Space Mono', monospace", flex: 1 }}>{copilotMsg}</span>
        {regime && !isMobile && <RegimeBadge regime={regime.regime} />}
        {signal?.action === "TRADE" && <Badge label={`${signal.confidence.toFixed(0)}%`} color="green" />}
        {signalGrade && !isMobile && <span style={{ background: `${signalGrade.gradeColor}22`, color: signalGrade.gradeColor, border: `1px solid ${signalGrade.gradeColor}55`, padding: "2px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>Grade {signalGrade.grade}</span>}
      </div>

      {/* ── Tabs (desktop only — mobile uses hamburger menu) ── */}
      <div className="desktop-only" style={{ display: "flex", gap: 0, borderBottom: "1px solid rgba(255,255,255,0.05)", padding: "0 20px", background: "rgba(0,0,0,0.2)", overflowX: "auto" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} className="tab-btn"
            style={{ padding: "10px 14px", border: "none", background: "transparent", color: activeTab === t.id ? "#e5e7eb" : "#6b7280", fontSize: 10, fontWeight: activeTab === t.id ? 700 : 400, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em", textTransform: "uppercase", borderBottom: activeTab === t.id ? "2px solid #00ff9d" : "2px solid transparent", marginBottom: -1, whiteSpace: "nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Mobile Tab Bar (bottom) ── */}
      {isMobile && (
        <div className="mobile-only" style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 150, background: "rgba(6,11,20,0.97)", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-around", padding: "4px 0 calc(4px + env(safe-area-inset-bottom))" }}>
          {[
            { id: "dashboard", emoji: "📊" },
            { id: "signal", emoji: "⚡" },
            { id: "trades", emoji: "📋" },
            { id: "analytics", emoji: "🎰" },
          ].map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              style={{ flex: 1, padding: "8px 0", border: "none", background: "transparent", color: activeTab === t.id ? "#00ff9d" : "#4b5563", fontSize: 20, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <span>{t.emoji}</span>
              <span style={{ fontSize: 8, letterSpacing: "0.08em", color: activeTab === t.id ? "#00ff9d" : "#374151", textTransform: "uppercase" }}>{t.id}</span>
            </button>
          ))}
          <button onClick={() => setMobileMenuOpen(true)}
            style={{ flex: 1, padding: "8px 0", border: "none", background: "transparent", color: "#4b5563", fontSize: 20, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <span>☰</span>
            <span style={{ fontSize: 8, letterSpacing: "0.08em", color: "#374151", textTransform: "uppercase" }}>MORE</span>
          </button>
        </div>
      )}

      {/* ── Content ── */}
      <div className="alpha-content" style={{ padding: isMobile ? 12 : 20, maxWidth: 1400, margin: "0 auto", paddingBottom: isMobile ? 80 : 20 }}>

        {/* ── DASHBOARD TAB ── */}
        {activeTab === "dashboard" && (
          <>
          {/* ── v26: Mobile Quick Dashboard ── */}
          {isMobile && (
            <div style={{ marginBottom: 14, animation: "slideIn 0.3s ease" }}>
              {/* Price + Status bar */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div style={{ padding: "14px", borderRadius: 10, background: "rgba(0,255,157,0.06)", border: "1px solid rgba(0,255,157,0.2)", textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#00ff9d", letterSpacing: "-0.02em" }}>{price ? formatPrice(price) : "—"}</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>BTC PRICE</div>
                </div>
                <div style={{ padding: "14px", borderRadius: 10, background: cloudBotStatus === 'RUNNING' ? "rgba(0,255,157,0.06)" : "rgba(255,69,102,0.06)", border: `1px solid ${cloudBotStatus === 'RUNNING' ? "rgba(0,255,157,0.2)" : "rgba(255,69,102,0.2)"}`, textAlign: "center" }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: cloudBotStatus === 'RUNNING' ? "#00ff9d" : cloudBotStatus === 'PAUSED' ? "#ffd700" : "#ff4566" }}>
                    {cloudBotStatus || (isLive ? "LIVE" : "LOCAL")}
                  </div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>BOT STATUS</div>
                </div>
              </div>

              {/* Key stats */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
                {[
                  { label: "PnL", value: formatPnL(paperStats?.totalNetPnL || 0), color: (paperStats?.totalNetPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" },
                  { label: "Win%", value: `${paperStats?.winRate || 0}%`, color: "#4db8ff" },
                  { label: "Open", value: paperPositions.length, color: "#ffd700" },
                  { label: "Trades", value: paperStats?.total || 0, color: "#c084fc" },
                ].map(s => (
                  <div key={s.label} style={{ padding: "10px 6px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", textAlign: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: 8, color: "#6b7280", marginTop: 2, textTransform: "uppercase" }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Signal */}
              {signal && (
                <div style={{ padding: "12px 14px", borderRadius: 10, background: signal.action === "TRADE" ? "rgba(0,255,157,0.06)" : "rgba(255,255,255,0.03)", border: `1px solid ${signal.action === "TRADE" ? "rgba(0,255,157,0.25)" : "rgba(255,255,255,0.07)"}`, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: signal.action === "TRADE" ? (signal.direction === "LONG" ? "#00ff9d" : "#ff4566") : "#ffd700" }}>
                        {signal.action === "TRADE" ? `${signal.direction} SIGNAL` : "WAITING..."}
                      </div>
                      {signal.strategy && <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>{signal.strategy} · {regime?.regime}</div>}
                    </div>
                    {signal.confidence > 0 && (
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: signal.confidence >= 85 ? "#00ff9d" : "#ffd700" }}>{signal.confidence.toFixed(0)}%</div>
                        <div style={{ fontSize: 8, color: "#6b7280" }}>CONF</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Bot Controls */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
                {[
                  { label: "▶ START", action: "start", color: "#00ff9d" },
                  { label: "■ STOP", action: "stop", color: "#ff4566" },
                  { label: "⏸ PAUSE", action: "pause", color: "#ffd700" },
                  { label: "↺", action: "restart", color: "#4db8ff" },
                ].map(btn => (
                  <button key={btn.action} onClick={() => controlCloudBot(btn.action)}
                    style={{ padding: "10px 4px", borderRadius: 7, border: `1px solid ${btn.color}33`, background: `${btn.color}0d`, color: btn.color, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                    {btn.label}
                  </button>
                ))}
              </div>

              {/* Sync / cloud status */}
              {cloudConfigured && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: 7, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: syncStatus === 'synced' ? "#00ff9d" : syncStatus === 'syncing' ? "#ffd700" : "#ff4566", animation: syncStatus === 'syncing' ? "pulse 1s infinite" : "none" }} />
                    <span style={{ fontSize: 9, color: "#6b7280" }}>{syncStatus === 'synced' ? "SYNCED" : syncStatus === 'syncing' ? "SYNCING..." : syncStatus === 'offline' ? "OFFLINE" : "CLOUD"}</span>
                  </div>
                  {lastSynced && <span style={{ fontSize: 8, color: "#374151" }}>Last: {lastSynced.toLocaleTimeString()}</span>}
                  <button onClick={forceSync} style={{ background: "none", border: "none", color: "#4db8ff", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>↻ SYNC</button>
                </div>
              )}
            </div>
          )}

          {/* ── Desktop Dashboard Grid ── */}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 14, animation: "slideIn 0.3s ease" }}>
            <Card>
              <SectionTitle icon="📊" label="Market Overview" />
              <Metric label="BTC Price" value={price ? formatPrice(price) : "Loading..."} color="#00ff9d" />
              <Metric label="Session" value={session || "—"} color="#4db8ff" />
              <Metric label="Regime" value={regime?.regime || "—"} color={
                regime?.regime === "TRENDING" ? "#00ff9d" : regime?.regime === "RANGING" ? "#4db8ff" :
                regime?.regime === "BREAKOUT" ? "#ffd700" : regime?.regime === "REVERSAL" ? "#c084fc" :
                regime?.regime === "HIGH_VOLATILITY" ? "#ff4566" : "#9ca3af"
              } sub={regime?.reason} />
              <Divider />
              <Metric label="ATR (14)" value={regime?.atr ? `$${regime.atr.toFixed(0)}` : "—"} />
              <Metric label="ADX" value={regime?.adx ? regime.adx.adx.toFixed(1) : "—"} />
              <Metric label="BB Width" value={regime?.bb ? `${(regime.bb.width * 100).toFixed(2)}%` : "—"} />
            </Card>

            <Card glow={signal?.action === "TRADE" ? "#00ff9d" : null}>
              <SectionTitle icon="⚡" label="Signal Engine" />
              {signal ? (
                <>
                  <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Badge label={signal.action === "TRADE" ? `● ${signal.direction}` : "◐ WAIT"} color={signal.action === "TRADE" ? (signal.direction === "LONG" ? "green" : "red") : "yellow"} size="md" />
                    {signal.strategy && <Badge label={signal.strategy} color="blue" size="md" />}
                    {signal.confidenceLabel && <Badge label={signal.confidenceLabel} color="purple" size="md" />}
                  </div>
                  {/* v33 F1 / v34: Fee efficiency block banner (HARD_BLOCK) */}
                  {signal.feeEfficiencyFail && (
                    <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 6, background: "rgba(255,69,102,0.08)", border: "1px solid rgba(255,69,102,0.3)" }}>
                      <div style={{ fontSize: 10, color: "#ff4566", fontWeight: 700, marginBottom: 2 }}>⛔ FEE_EFFICIENCY_FAIL — HARD BLOCK</div>
                      <div style={{ fontSize: 9, color: "#fca5a5" }}>Trade blocked — reward after fees too small</div>
                      <div style={{ fontSize: 8, color: "#6b7280", marginTop: 2 }}>{signal.feeEfficiencyReason}</div>
                    </div>
                  )}
                  {/* v34 P1: Negative net expectancy block */}
                  {signal.netExpectancyFail && (
                    <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 6, background: "rgba(255,69,102,0.08)", border: "1px solid rgba(255,69,102,0.3)" }}>
                      <div style={{ fontSize: 10, color: "#ff4566", fontWeight: 700, marginBottom: 2 }}>⛔ NEGATIVE_NET_EXPECTANCY — DOWNGRADED TO WATCH</div>
                      <div style={{ fontSize: 9, color: "#fca5a5" }}>Net reward after fees ≤ 0 — no edge</div>
                      <div style={{ fontSize: 8, color: "#6b7280", marginTop: 2 }}>{signal.netExpectancyReason}</div>
                    </div>
                  )}
                  {/* v34 P2: Low net RR block */}
                  {signal.lowNetRR && (
                    <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 6, background: "rgba(255,215,0,0.07)", border: "1px solid rgba(255,215,0,0.25)" }}>
                      <div style={{ fontSize: 10, color: "#ffd700", fontWeight: 700, marginBottom: 2 }}>⛔ LOW_NET_RR — DOWNGRADED TO WATCH</div>
                      <div style={{ fontSize: 9, color: "#fef3c7" }}>Net R:R after fees below minimum {CONFIG.MIN_NET_RR}</div>
                      <div style={{ fontSize: 8, color: "#6b7280", marginTop: 2 }}>{signal.lowNetRRReason}</div>
                    </div>
                  )}
                  {/* v34 P4: Trend cooldown notice */}
                  {signal.cooldownReason && (
                    <div style={{ marginBottom: 10, padding: "7px 12px", borderRadius: 6, background: "rgba(255,215,0,0.07)", border: "1px solid rgba(255,215,0,0.3)" }}>
                      <div style={{ fontSize: 10, color: "#ffd700", fontWeight: 700, marginBottom: 2 }}>🕐 TREND COOLDOWN ACTIVE</div>
                      <div style={{ fontSize: 8, color: "#6b7280" }}>{signal.cooldownReason}</div>
                    </div>
                  )}
                  {/* v34: Fee efficiency warning badge (WARN_ONLY — trade still executes) */}
                  {signal.feeEfficiencyWarning && !signal.feeEfficiencyFail && (
                    <div style={{ marginBottom: 10, padding: "7px 12px", borderRadius: 6, background: "rgba(255,215,0,0.07)", border: "1px solid rgba(255,215,0,0.3)" }}>
                      <div style={{ fontSize: 10, color: "#ffd700", fontWeight: 700, marginBottom: 2 }}>⚠ Fee efficiency weak</div>
                      <div style={{ fontSize: 9, color: "#fef3c7" }}>Trade executed — fees included in PnL</div>
                      <div style={{ fontSize: 8, color: "#6b7280", marginTop: 2 }}>{signal.feeEfficiencyReason}</div>
                    </div>
                  )}
                  {/* v34 P5: Duplicate setup warning */}
                  {signal.duplicateSetup && (
                    <div style={{ marginBottom: 10, padding: "6px 10px", borderRadius: 6, background: "rgba(255,215,0,0.05)", border: "1px solid rgba(255,215,0,0.2)" }}>
                      <div style={{ fontSize: 9, color: "#ffd700", fontWeight: 700 }}>⚠ Duplicate setup detected — confidence penalized -15</div>
                    </div>
                  )}
                  {signal.confidence > 0 && <ConfidenceBar value={signal.confidence} />}
                  <Divider />
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Factors</div>
                  {(signal.factors || []).slice(0, 5).map((f, i) => (
                    <div key={i} style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3, display: "flex", gap: 6 }}>
                      <span style={{ color: "#00ff9d44" }}>›</span>{f}
                    </div>
                  ))}
                  {!signal.factors?.length && <div style={{ fontSize: 10, color: "#6b7280" }}>{signal.reason}</div>}
                </>
              ) : <div style={{ color: "#6b7280", fontSize: 11 }}>Waiting for data...</div>}
            </Card>

            <Card>
              <SectionTitle icon="🎯" label="Trade Plan" />
              {riskLevels && signal?.action === "TRADE" ? (
                (() => {
                  const usedBtcQtyForPlan = sizingMode === "manual" ? (manualLots * 0.001) : (riskLevels.btcQty || 0);
                  const netExp = calcNetExpectancy(riskLevels.tpDist, riskLevels.slDist, usedBtcQtyForPlan, price || 0);
                  return (
                  <>
                  <Metric label="Direction" value={signal.direction} color={signal.direction === "LONG" ? "#00ff9d" : "#ff4566"} />
                  <Metric label="Entry" value={formatPrice(price)} />
                  <Metric label="Stop Loss" value={formatPrice(riskLevels.sl)} color="#ff4566" sub={`$${riskLevels.slDist.toFixed(0)} from entry`} />
                  <Metric label="Take Profit" value={formatPrice(riskLevels.tp)} color="#00ff9d" sub={`$${riskLevels.tpDist.toFixed(0)} from entry`} />
                  <Metric label="R/R (Gross)" value={`${riskLevels.rr.toFixed(2)}:1`} color={riskLevels.rr >= 2 ? "#00ff9d" : "#ffd700"} />
                  {netExp && (
                    <>
                      <Divider />
                      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>v34 Fee-Aware Breakdown</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                        <Metric label="Gross Reward" value={`$${netExp.grossReward.toFixed(4)}`} color="#4db8ff" sub="Before fees" />
                        <Metric label="Round-Trip Fee" value={`$${netExp.estimatedRoundTripFee.toFixed(4)}`} color="#ff4566" />
                        <Metric label="Net Reward" value={`$${netExp.expectedNetReward.toFixed(4)}`} color={netExp.expectedNetReward > 0 ? "#00ff9d" : "#ff4566"} sub="After fees" />
                        <Metric label="Net RR" value={`${netExp.netRR.toFixed(2)}:1`} color={netExp.netRR >= CONFIG.MIN_NET_RR ? "#00ff9d" : "#ff4566"} sub={`Min: ${CONFIG.MIN_NET_RR}`} />
                        <Metric label="Fee Impact" value={`${netExp.feeImpactPct.toFixed(1)}%`} color={netExp.feeImpactPct < 30 ? "#00ff9d" : netExp.feeImpactPct < 60 ? "#ffd700" : "#ff4566"} sub="of gross reward" />
                        <Metric label="Net Risk" value={`$${netExp.netRisk.toFixed(4)}`} color="#ff4566" sub="SL loss + fees" />
                      </div>
                      {signal.duplicateSetup && (
                        <div style={{ marginTop: 8, padding: "5px 8px", borderRadius: 4, background: "rgba(255,215,0,0.07)", border: "1px solid rgba(255,215,0,0.25)", fontSize: 9, color: "#ffd700" }}>
                          ⚠ Duplicate setup detected — confidence penalized -15
                        </div>
                      )}
                      {signal.sessionPenaltyApplied && (
                        <div style={{ marginTop: 6, padding: "5px 8px", borderRadius: 4, background: "rgba(255,69,102,0.06)", border: "1px solid rgba(255,69,102,0.2)", fontSize: 9, color: "#ff4566" }}>
                          ⚠ Poor session performance — confidence penalized -10
                        </div>
                      )}
                    </>
                  )}
                  <Divider />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Metric label="BTC Qty" value={riskLevels.btcQty ? riskLevels.btcQty.toFixed(5) : "—"} color="#4db8ff" />
                    <Metric label="Notional" value={riskLevels.notionalUSDT ? `$${riskLevels.notionalUSDT.toFixed(0)}` : "—"} />
                    <Metric label="Δ Contracts" value={riskLevels.deltaContracts || "—"} color="#c084fc" />
                    <Metric label="Margin" value={riskLevels.marginUsed ? `$${riskLevels.marginUsed.toFixed(2)}` : "—"} color="#ffd700" />
                  </div>
                  </>
                  );
                })()
              ) : <div style={{ color: "#374151", fontSize: 11, paddingTop: 20, textAlign: "center" }}>No active trade plan</div>}
            </Card>

            <Card glow={latestPaperPosition ? (latestPaperPosition.direction === "LONG" ? "#00ff9d" : "#ff4566") : null}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <SectionTitle icon="📈" label="Paper Position" />
                {paperPositions.length > 1 && (
                  <span style={{ fontSize: 9, color: "#4db8ff" }}>+{paperPositions.length - 1} more</span>
                )}
              </div>
              {latestPaperPosition ? (
                <>
                  <div style={{ marginBottom: 10, display: "flex", gap: 8 }}>
                    <Badge label={latestPaperPosition.direction} color={latestPaperPosition.direction === "LONG" ? "green" : "red"} size="md" />
                    <Badge label="PAPER" color="blue" size="md" />
                    <Badge label={latestPaperPosition.strategy} color="purple" size="md" />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                    <Metric label="Entry" value={formatPrice(latestPaperPosition.entry)} />
                    <Metric label="Gross PnL" value={latestPaperPnL ? formatPnL(latestPaperPnL.grossPnL) : "—"} color={latestPaperPnL?.grossPnL >= 0 ? "#00ff9d" : "#ff4566"} />
                    <Metric label="Fees" value={latestPaperPnL ? formatPnL(-latestPaperPnL.fees) : "—"} color="#ff4566" />
                    <Metric label="Net PnL" value={latestPaperPnL ? formatPnL(latestPaperPnL.netPnL) : "—"} color={latestPaperPnL?.netPnL >= 0 ? "#00ff9d" : "#ff4566"} />
                  </div>
                  <Metric label="ROI" value={latestPaperPnL ? formatPct(latestPaperPnL.roi) : "—"} color={latestPaperPnL?.roi >= 0 ? "#00ff9d" : "#ff4566"} />
                  <Divider />
                  {latestPaperPosition.health && <HealthBar score={latestPaperPosition.health.score} />}
                  {latestPaperPosition.health && <div style={{ fontSize: 9, color: "#6b7280", marginTop: 4 }}>{latestPaperPosition.health.reason} [{latestPaperPosition.health.phase}]</div>}
                </>
              ) : (
                <div style={{ color: "#374151", fontSize: 11, paddingTop: 20, textAlign: "center" }}>No open paper position</div>
              )}
            </Card>

            <Card>
              <SectionTitle icon="🌐" label="Market Context" />
              <Metric label="Funding Rate" value={fundingRate !== null ? `${(fundingRate * 100).toFixed(4)}%` : "Unavailable"} color={fundingRate !== null ? (fundingRate > 0 ? "#ff4566" : "#00ff9d") : "#6b7280"} sub={fundingRate !== null ? (fundingRate > 0 ? "Longs paying shorts" : "Shorts paying longs") : "Data unavailable"} />
              <Metric label="Open Interest" value={openInterest !== null ? `${(openInterest / 1000).toFixed(1)}K BTC` : "Unavailable"} color={openInterest !== null ? "#4db8ff" : "#6b7280"} />
              <Divider />
              <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>Order Book</div>
              {orderBook.asks.slice(0, 3).reverse().map((a, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}>
                  <span style={{ color: "#ff4566" }}>{formatPrice(a.price)}</span>
                  <span style={{ color: "#6b7280" }}>{a.qty.toFixed(2)}</span>
                </div>
              ))}
              <div style={{ height: 1, background: "#00ff9d22", margin: "4px 0" }} />
              {orderBook.bids.slice(0, 3).map((b, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}>
                  <span style={{ color: "#00ff9d" }}>{formatPrice(b.price)}</span>
                  <span style={{ color: "#6b7280" }}>{b.qty.toFixed(2)}</span>
                </div>
              ))}
            </Card>

            <Card>
              <SectionTitle icon="🛡️" label="Risk Control" />
              <Metric label="Account Balance" value={`$${accountBalance.toLocaleString()}`} />
              <Metric label="Daily PnL" value={formatPnL(dailyLimits.dailyPnL)} color={dailyLimits.dailyPnL >= 0 ? "#00ff9d" : "#ff4566"} />
              <Metric label="Trades Today" value={dailyLimits.tradesCount || 0} sub={`Max: ${CONFIG.MAX_DAILY_TRADES}`} />
              <Metric label="Consec. Losses" value={dailyLimits.consecutiveLosses || 0} color={dailyLimits.consecutiveLosses >= 2 ? "#ff4566" : "#9ca3af"} />
              <Divider />
              <SectionTitle icon="📰" label="News Risk" />
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase" }}>Risk Score</span>
                  <span style={{ color: newsRisk.score > 60 ? "#ff4566" : newsRisk.score > 30 ? "#ffd700" : "#00ff9d", fontSize: 11, fontWeight: 700 }}>{newsRisk.score}/100</span>
                </div>
                <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2 }}>
                  <div style={{ width: `${newsRisk.score}%`, height: "100%", background: newsRisk.score > 60 ? "#ff4566" : newsRisk.score > 30 ? "#ffd700" : "#00ff9d", borderRadius: 2 }} />
                </div>
              </div>
              {newsRisk.events.slice(0, 2).map((e, i) => (
                <div key={i} style={{ fontSize: 9, color: "#9ca3af", marginBottom: 3 }}>
                  <span style={{ color: e.impact === "High" ? "#ff4566" : "#ffd700" }}>● </span>{e.title}
                </div>
              ))}
            </Card>

            <Card style={{ gridColumn: "1 / -1" }}>
              <SectionTitle icon="🔌" label="Data Source Status" />
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                <StatusDot ok={dataStatus.candles} label="1m Candles (Binance)" />
                <StatusDot ok={dataStatus.ws} label={`WebSocket ${dataStatus.wsStatus ? `[${dataStatus.wsStatus}]` : ""}`} />
                <StatusDot ok={true} label={`REST Fallback: ${dataStatus.restFallback ? "ACTIVE" : "ACTIVE"}`} />
                <StatusDot ok={dataStatus.orderBook} label="Order Book (L2)" />
                <StatusDot ok={dataStatus.fundingRate} label="Funding Rate" />
                <StatusDot ok={dataStatus.openInterest} label="Open Interest" />
                <StatusDot ok={dataStatus.newsAvailable} label={`News Calendar ${!dataStatus.newsAvailable ? "[UNAVAILABLE — use manual override]" : `[OK · ${newsData.length} events]`}`} />
                <StatusDot ok={paperPositions.length > 0 || paperTrades.length > 0} label={`Paper Engine (${paperTrades.length} trades)`} />
              </div>
              {/* v30: WS reconnect count + last candle time */}
              <div style={{ display: "flex", gap: 24, marginTop: 10, flexWrap: "wrap" }}>
                {dataStatus.wsReconnectAttempts > 0 && (
                  <span style={{ fontSize: 9, color: "#ffd700" }}>⚡ WS reconnect attempts: {dataStatus.wsReconnectAttempts}</span>
                )}
                {lastCandleTime && (
                  <span style={{ fontSize: 9, color: "#6b7280" }}>Last candle: {new Date(lastCandleTime).toLocaleTimeString()}</span>
                )}
                <span style={{ fontSize: 9, color: "#4db8ff" }}>Manual News Risk: <span style={{ color: manualNewsRisk === "HIGH" ? "#ff4566" : manualNewsRisk === "MEDIUM" ? "#ffd700" : "#00ff9d", fontWeight: 700 }}>{manualNewsRisk}</span></span>
                <span style={{ fontSize: 9, color: "#4db8ff" }}>Paper Risk Locks: <span style={{ color: unlimitedPaperLearning ? "#00ff9d" : "#ffd700", fontWeight: 700 }}>{unlimitedPaperLearning ? "OFF (Unlimited Learning)" : "ON"}</span></span>
                <span style={{ fontSize: 9, color: "#4db8ff" }}>Patience: <span style={{ color: "#c084fc", fontWeight: 700 }}>{patienceMode}</span></span>
              </div>
              {Object.keys(dataStatus.errors || {}).length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {Object.entries(dataStatus.errors || {}).map(([k, v]) => (
                    <div key={k} style={{ fontSize: 9, color: v === "UNAVAILABLE" ? "#ffd700" : "#ff4566", marginBottom: 2 }}>
                      {v === "UNAVAILABLE" ? "ℹ" : "⚠"} {k}: {v === "UNAVAILABLE" ? "unavailable (network/CORS)" : v}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* ── Data Source Transparency Panel ── */}
            <Card style={{ gridColumn: "1 / -1" }}>
              <SectionTitle icon="🌐" label="Data Source Transparency" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                <div style={{ background: "rgba(77,184,255,0.06)", border: "1px solid rgba(77,184,255,0.15)", borderRadius: 8, padding: 16 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Chart Source</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#4db8ff", fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>TradingView</div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>Advanced Chart Widget — visual only. Not used for signal generation.</div>
                </div>
                <div style={{ background: "rgba(0,255,157,0.06)", border: "1px solid rgba(0,255,157,0.15)", borderRadius: 8, padding: 16 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Bot Data Source</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#00ff9d", fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>Binance</div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>OHLC candles, order book, open interest, funding rate via REST + WebSocket.</div>
                </div>
                <div style={{ background: `rgba(${apiVerified ? "0,255,157" : "255,69,102"},0.06)`, border: `1px solid rgba(${apiVerified ? "0,255,157" : "255,69,102"},0.15)`, borderRadius: 8, padding: 16 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>Execution Source</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: apiVerified ? "#00ff9d" : "#ff4566", fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>
                    {apiVerified ? "Delta Exchange" : "Paper Only"}
                  </div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>
                    {apiVerified ? "Live orders on Delta Exchange India (BTCUSD perpetual)." : "No live exchange connected. Configure API keys in the Exchange tab."}
                  </div>
                </div>
              </div>
            </Card>

            {/* ── Platform Status Panel ── */}
            <Card style={{ gridColumn: "1 / -1" }}>
              <SectionTitle icon="🖥️" label="Platform Status" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
                {[
                  { label: "Paper Ready", value: "YES", color: "#00ff9d", ok: true },
                  { label: "Live Ready", value: apiVerified ? "YES" : "NO", color: apiVerified ? "#00ff9d" : "#ff4566", ok: apiVerified },
                  { label: "Backtest", value: "BASIC", color: "#4db8ff", ok: true },
                  { label: "Learning", value: signalLogCount > 0 ? "ACTIVE" : "WAITING", color: signalLogCount > 0 ? "#00ff9d" : "#ffd700", ok: signalLogCount > 0 },
                  { label: "Exchange", value: deltaConnected ? "CONNECTED" : "DISCONNECTED", color: deltaConnected ? "#00ff9d" : "#ff4566", ok: deltaConnected },
                  { label: "Signals Logged", value: String(signalLogCount), color: "#c084fc", ok: true },
                ].map(item => (
                  <div key={item.label} style={{ background: `rgba(${item.ok ? "0,255,157" : "255,69,102"},0.04)`, border: `1px solid rgba(${item.ok ? "0,255,157" : "255,69,102"},0.1)`, borderRadius: 8, padding: 12, textAlign: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: item.color, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>{item.value}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>{item.label}</div>
                  </div>
                ))}
              </div>
              {!apiVerified && (
                <div style={{ marginTop: 12, padding: "8px 14px", background: "rgba(255,69,102,0.06)", border: "1px solid rgba(255,69,102,0.15)", borderRadius: 6, fontSize: 10, color: "#ff4566", letterSpacing: "0.04em" }}>
                  ⛔ LIVE MODE BLOCKED — API NOT VERIFIED. Configure and test your Delta Exchange credentials in the Exchange tab.
                </div>
              )}
            </Card>

            {/* v34: Blocked Signal Warning — shows when TRADE signals exist but no paper trades opened */}
            {(() => {
              const tradeSignals = paperEngine.signalLog.filter(s => s.action === "TRADE");
              const paperTradesCount = paperEngine.trades.length;
              const blockedTrades = paperEngine.signalLog.filter(s => s.tradedAs === "BLOCKED");
              const hasBlockedWithNoTrades = tradeSignals.length > 0 && paperTradesCount === 0;
              const hasAnyBlocked = blockedTrades.length > 0;
              if (!hasBlockedWithNoTrades && !hasAnyBlocked) return null;
              // Group block reasons
              const reasonCounts = {};
              blockedTrades.forEach(s => {
                const r = s.filteredBy || "UNKNOWN_BLOCK";
                reasonCounts[r] = (reasonCounts[r] || 0) + 1;
              });
              return (
                <Card style={{ gridColumn: "1 / -1", border: "1px solid rgba(255,69,102,0.35)", background: "rgba(255,69,102,0.05)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span style={{ fontSize: 16 }}>⚠️</span>
                    <span style={{ color: "#ff4566", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>
                      TRADE SIGNALS GENERATED BUT NO PAPER TRADES EXECUTED
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 9, color: "#6b7280" }}>
                      {tradeSignals.length} TRADE signal{tradeSignals.length !== 1 ? "s" : ""} · {paperTradesCount} paper trade{paperTradesCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    {Object.entries(reasonCounts).map(([reason, count]) => (
                      <div key={reason} style={{ padding: "4px 12px", borderRadius: 4, background: "rgba(255,69,102,0.1)", border: "1px solid rgba(255,69,102,0.25)", fontSize: 10, color: "#fca5a5", fontFamily: "'Space Mono', monospace" }}>
                        {reason}: {count}
                      </div>
                    ))}
                  </div>
                  {blockedSignalDetails.length > 0 && (
                    <div style={{ maxHeight: 180, overflowY: "auto" }}>
                      <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Blocked Trade Details</div>
                      {blockedSignalDetails.slice(-5).map((d, i) => (
                        <div key={i} style={{ marginBottom: 6, padding: "6px 10px", background: "rgba(0,0,0,0.2)", borderRadius: 4, fontSize: 9, fontFamily: "'Space Mono', monospace", color: "#9ca3af" }}>
                          <span style={{ color: "#ff4566", fontWeight: 700 }}>{d.reason}</span>
                          {" · "}lots={d.lots} lev={d.leverage}x btc={d.btcQty}
                          {" · "}entry={formatPrice(d.entry)}
                          {d.sl && ` sl=${formatPrice(d.sl)}`}
                          {d.tp && ` tp=${formatPrice(d.tp)}`}
                          {" · "}fee=${d.totalFee} reward=${d.expectedReward} ratio={d.rewardFeeRatio}x
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ marginTop: 8, fontSize: 9, color: "#6b7280", lineHeight: 1.6 }}>
                    Check: Mode={modeRef.current?.toUpperCase()} · Settings Applied={sizingModeRef.current} {manualLeverageRef.current}x {manualLotsRef.current}lots
                  </div>
                </Card>
              );
            })()}
          </div>
        )}

        {/* ── CHART TAB ── */}
        {activeTab === "chart" && (
          <div style={{ animation: "slideIn 0.3s ease" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
              <span style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.1em", textTransform: "uppercase" }}>Timeframe:</span>
              {["1m", "5m", "15m", "1h", "4h"].map(tf => (
                <button key={tf} onClick={() => handleTimeframeChange(tf)}
                  style={{ padding: "5px 12px", borderRadius: 4, border: activeTimeframe === tf ? "1px solid #00ff9d44" : "1px solid rgba(255,255,255,0.08)", background: activeTimeframe === tf ? "rgba(0,255,157,0.08)" : "transparent", color: activeTimeframe === tf ? "#00ff9d" : "#6b7280", fontSize: 10, cursor: "pointer", fontFamily: "'Space Mono', monospace", fontWeight: activeTimeframe === tf ? 700 : 400 }}>
                  {tf}
                </button>
              ))}
              <div style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "center" }}>
                <div style={{ fontSize: 9, color: "#4db8ff" }}>📊 Chart: TradingView</div>
                <div style={{ fontSize: 9, color: "#00ff9d" }}>🤖 Bot: Binance</div>
                <div style={{ fontSize: 9, color: "#374151" }}>Chart and bot analysis synchronized on same timeframe.</div>
              </div>
            </div>
            <Card style={{ padding: 0, overflow: "hidden", height: 520 }}>
              <TradingViewChart symbol="BTCUSDT" interval={chartInterval} />
            </Card>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 14 }}>
              <Card>
                <Metric label="Current Price" value={price ? formatPrice(price) : "—"} color="#00ff9d" />
                <Metric label="Session" value={session || "—"} color="#4db8ff" />
                <Metric label="Timeframe" value={activeTimeframe} color="#c084fc" />
              </Card>
              <Card>
                <Metric label="ATR (14)" value={regime?.atr ? `$${regime.atr.toFixed(0)}` : "—"} />
                <Metric label="ADX" value={regime?.adx ? regime.adx.adx.toFixed(1) : "—"} />
              </Card>
              <Card>
                {riskLevels ? (
                  <>
                    <Metric label="Signal SL" value={formatPrice(riskLevels?.sl)} color="#ff4566" />
                    <Metric label="Signal TP" value={formatPrice(riskLevels?.tp)} color="#00ff9d" />
                  </>
                ) : (
                  <div style={{ color: "#374151", fontSize: 10, padding: "8px 0" }}>No active signal levels</div>
                )}
              </Card>
              <Card>
                <Metric label="Regime" value={regime?.regime || "—"} color={regime?.regime === "TRENDING" ? "#00ff9d" : regime?.regime === "RANGING" ? "#4db8ff" : "#ffd700"} />
                <Metric label="Structure" value={smcData.bosChoch?.bias || "NEUTRAL"} color={smcData.bosChoch?.bias === "BULLISH" ? "#00ff9d" : smcData.bosChoch?.bias === "BEARISH" ? "#ff4566" : "#9ca3af"} />
              </Card>
            </div>
          </div>
        )}

        {/* ── SIGNAL TAB ── */}
        {activeTab === "signal" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, animation: "slideIn 0.3s ease" }}>
            <Card glow={signal?.action === "TRADE" ? (signal.direction === "LONG" ? "#00ff9d" : "#ff4566") : null}>
              <SectionTitle icon="⚡" label="Signal Detail" />
              {signal ? (
                <>
                  <div style={{ marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Badge label={signal.action === "TRADE" ? `● ${signal.direction}` : "◐ WAIT"} color={signal.action === "TRADE" ? (signal.direction === "LONG" ? "green" : "red") : "yellow"} size="md" />
                    {signal.strategy && <Badge label={signal.strategy} color="blue" size="md" />}
                    {signal.confidenceLabel && <Badge label={signal.confidenceLabel} color="purple" size="md" />}
                    {signal.regime && <Badge label={signal.regime} color="gray" size="md" />}
                  </div>
                  {signal.confidence > 0 && <ConfidenceBar value={signal.confidence} />}
                  <Divider />
                  <div style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Factors ({signal.factors?.length || 0})</div>
                  {(signal.factors || []).map((f, i) => (
                    <div key={i} style={{ fontSize: 10, color: "#9ca3af", marginBottom: 5, display: "flex", gap: 6, alignItems: "flex-start", lineHeight: 1.4 }}>
                      <span style={{ color: "#00ff9d44", flexShrink: 0 }}>›</span>{f}
                    </div>
                  ))}
                  {!signal.factors?.length && <div style={{ fontSize: 10, color: "#6b7280" }}>{signal.reason}</div>}
                  <Divider />
                  <div style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Signal ID</div>
                  <div style={{ fontSize: 9, color: "#374151", fontFamily: "'Space Mono', monospace", wordBreak: "break-all", lineHeight: 1.5 }}>{signal.signalId}</div>
                </>
              ) : <div style={{ color: "#374151", fontSize: 11, padding: 20, textAlign: "center" }}>Waiting for signal data...</div>}
            </Card>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Signal Grade */}
              {signalGrade ? (
                <Card glow={signalGrade.gradeColor}>
                  <SectionTitle icon="🏆" label="Signal Quality Grade" />
                  <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 14 }}>
                    <div style={{ fontSize: 52, fontWeight: 700, color: signalGrade.gradeColor, fontFamily: "'Syne', sans-serif", lineHeight: 1 }}>{signalGrade.grade}</div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Quality Score</div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: signalGrade.gradeColor, fontFamily: "'Space Mono', monospace" }}>{signalGrade.score}/100</div>
                    </div>
                  </div>
                  <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginBottom: 12 }}>
                    <div style={{ width: `${signalGrade.score}%`, height: "100%", background: `linear-gradient(90deg, ${signalGrade.gradeColor}66, ${signalGrade.gradeColor})`, borderRadius: 2, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#00ff9d", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Strengths</div>
                      {signalGrade.reasons.map((r, i) => <div key={i} style={{ fontSize: 9, color: "#d1fae5", marginBottom: 3 }}>✓ {r}</div>)}
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#ff4566", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Demerits</div>
                      {signalGrade.demerits.length > 0 ? signalGrade.demerits.map((d, i) => <div key={i} style={{ fontSize: 9, color: "#fca5a5", marginBottom: 3 }}>✕ {d}</div>) : <div style={{ fontSize: 9, color: "#374151" }}>None</div>}
                    </div>
                  </div>
                  <Divider />
                  <div style={{ fontSize: 9, color: "#6b7280" }}>
                    <span style={{ color: "#00ff9d" }}>A+</span> = skip nothing &nbsp;|&nbsp; <span style={{ color: "#4db8ff" }}>A</span> = high quality &nbsp;|&nbsp; <span style={{ color: "#ffd700" }}>B</span> = acceptable &nbsp;|&nbsp; <span style={{ color: "#fb923c" }}>C</span> = marginal &nbsp;|&nbsp; <span style={{ color: "#ff4566" }}>D</span> = avoid
                  </div>
                </Card>
              ) : (
                <Card>
                  <SectionTitle icon="🏆" label="Signal Quality Grade" />
                  <div style={{ textAlign: "center", padding: "30px 0", color: "#374151", fontSize: 11 }}>Waiting for a TRADE signal to grade...</div>
                </Card>
              )}

              {/* Confidence Thresholds */}
              <Card>
                <SectionTitle icon="📊" label="Confidence Thresholds" />
                {[{ label: "EXCEPTIONAL", range: "95–100%", color: "#00ff9d", note: "Top tier — all criteria met" }, { label: "STRONG", range: "85–94%", color: "#4db8ff", note: "High quality setup" }, { label: "WATCH (observe only)", range: "75–84%", color: "#ffd700", note: "Observe only — no paper trade" }, { label: "WAIT", range: "< 75%", color: "#ff4566", note: "Insufficient edge — no entry" }].map(t => (
                  <div key={t.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px", marginBottom: 6, borderRadius: 6, background: signal?.confidenceLabel === t.label ? `${t.color}11` : "rgba(255,255,255,0.02)", border: `1px solid ${signal?.confidenceLabel === t.label ? t.color + "44" : "rgba(255,255,255,0.05)"}` }}>
                    <div>
                      <span style={{ fontSize: 10, color: t.color, fontWeight: 700 }}>{t.label}</span>
                      <div style={{ fontSize: 8, color: "#4b5563", marginTop: 1 }}>{t.note}</div>
                    </div>
                    <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "'Space Mono', monospace" }}>{t.range}</span>
                  </div>
                ))}
              </Card>

              {/* PnL Breakdown */}
              <Card>
                <SectionTitle icon="💰" label="PnL Breakdown (Active)" />
                {latestPaperPosition && latestPaperPnL ? (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                      <Metric label="Gross PnL" value={formatPnL(latestPaperPnL.grossPnL)} color={latestPaperPnL.grossPnL >= 0 ? "#00ff9d" : "#ff4566"} />
                      <Metric label="Net PnL" value={formatPnL(latestPaperPnL.netPnL)} color={latestPaperPnL.netPnL >= 0 ? "#00ff9d" : "#ff4566"} />
                      <Metric label="Fees (est.)" value={formatPnL(-latestPaperPnL.fees)} color="#ff4566" sub="Taker 0.05% × 2" />
                      <Metric label="Funding" value={formatPnL(-latestPaperPnL.funding)} color="#ffd700" sub="8h intervals" />
                      <Metric label="Return %" value={formatPct(latestPaperPnL.returnPct)} color={latestPaperPnL.returnPct >= 0 ? "#00ff9d" : "#ff4566"} sub="Of notional" />
                      <Metric label="ROI %" value={formatPct(latestPaperPnL.roi)} color={latestPaperPnL.roi >= 0 ? "#00ff9d" : "#ff4566"} sub="Of margin" />
                    </div>
                  </>
                ) : (
                  <div style={{ color: "#374151", fontSize: 11, padding: "20px 0", textAlign: "center" }}>No open paper position</div>
                )}
                <Divider />
                <SectionTitle icon="📐" label="PnL Formula Reference" />
                <div style={{ fontSize: 9, color: "#6b7280", lineHeight: 1.8, fontFamily: "'Space Mono', monospace" }}>
                  <div>Gross PnL = (Exit − Entry) × BTC Qty [LONG]</div>
                  <div>Fees = (Entry + Exit) × BTC Qty × 0.05%</div>
                  <div>Funding = Notional × Rate × Intervals</div>
                  <div>Net PnL = Gross − Fees − Funding</div>
                  <div>ROI = Net PnL / Margin × 100</div>
                </div>
              </Card>
            </div>
          </div>
        )}

        {/* ── SMC TAB ── */}
        {activeTab === "smc" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, animation: "slideIn 0.3s ease" }}>
            <Card>
              <SectionTitle icon="🏗️" label="Market Structure" />
              {smcData.bosChoch ? (
                <>
                  <Metric label="Structural Bias" value={smcData.bosChoch.bias} color={smcData.bosChoch.bias === "BULLISH" ? "#00ff9d" : smcData.bosChoch.bias === "BEARISH" ? "#ff4566" : "#9ca3af"} />
                  {smcData.bosChoch.bos && <Metric label="Break of Structure" value={smcData.bosChoch.bos} color="#4db8ff" />}
                  {smcData.bosChoch.choch && <Metric label="CHoCH" value={smcData.bosChoch.choch} color="#c084fc" />}
                  <Divider />
                  <Metric label="Premium/Discount" value={smcData.premiumDiscount || "—"} color={smcData.premiumDiscount === "PREMIUM" ? "#ff4566" : smcData.premiumDiscount === "DISCOUNT" ? "#00ff9d" : "#9ca3af"} />
                  <div style={{ marginTop: 12 }}>
                    <div style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Swing Points</div>
                    <div style={{ color: "#6b7280", fontSize: 9, marginBottom: 3 }}>Highs:</div>
                    {(smcData.swings?.highs || []).slice(-3).map((h, i) => (<div key={i} style={{ fontSize: 10, color: "#ff4566", marginBottom: 2 }}>↑ {formatPrice(h.price)}</div>))}
                    <div style={{ color: "#6b7280", fontSize: 9, marginTop: 6, marginBottom: 3 }}>Lows:</div>
                    {(smcData.swings?.lows || []).slice(-3).map((l, i) => (<div key={i} style={{ fontSize: 10, color: "#00ff9d", marginBottom: 2 }}>↓ {formatPrice(l.price)}</div>))}
                  </div>
                </>
              ) : <div style={{ color: "#374151", fontSize: 11 }}>Calculating structure...</div>}
            </Card>

            <Card>
              <SectionTitle icon="🧱" label="Order Blocks" />
              {(smcData.orderBlocks || []).slice(-4).map((ob, i) => (
                <div key={i} style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 6, background: ob.type === "bullish" ? "rgba(0,255,157,0.05)" : "rgba(255,69,102,0.05)", border: `1px solid ${ob.type === "bullish" ? "rgba(0,255,157,0.15)" : "rgba(255,69,102,0.15)"}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <Badge label={ob.type.toUpperCase()} color={ob.type === "bullish" ? "green" : "red"} />
                    <span style={{ fontSize: 9, color: "#6b7280" }}>{new Date(ob.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#9ca3af" }}>
                    <span style={{ color: "#00ff9d" }}>{formatPrice(ob.high)}</span><span style={{ color: "#6b7280" }}> – </span><span style={{ color: "#ff4566" }}>{formatPrice(ob.low)}</span>
                  </div>
                  {price && price >= ob.low && price <= ob.high && <div style={{ fontSize: 9, color: "#ffd700", marginTop: 4 }}>⚡ Price inside OB</div>}
                </div>
              ))}
              {!(smcData.orderBlocks?.length) && <div style={{ color: "#374151", fontSize: 11 }}>No order blocks detected</div>}
            </Card>

            <Card>
              <SectionTitle icon="💧" label="Liquidity & FVGs" />
              {smcData.sweep ? (
                <div style={{ marginBottom: 12, padding: "8px 10px", borderRadius: 6, background: "rgba(192,132,252,0.06)", border: "1px solid rgba(192,132,252,0.2)" }}>
                  <div style={{ fontSize: 10, color: "#c084fc", marginBottom: 4, fontWeight: 700 }}>Liquidity Sweep</div>
                  <div style={{ fontSize: 10, color: "#9ca3af" }}>Type: <span style={{ color: "#e5e7eb" }}>{smcData.sweep.type}</span></div>
                  <div style={{ fontSize: 10, color: "#9ca3af" }}>Level: <span style={{ color: "#e5e7eb" }}>{formatPrice(smcData.sweep.level)}</span></div>
                </div>
              ) : <div style={{ fontSize: 10, color: "#374151", marginBottom: 12 }}>No liquidity sweep</div>}
              <div style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Fair Value Gaps</div>
              {(smcData.fvgs || []).slice(-4).map((fvg, i) => (
                <div key={i} style={{ marginBottom: 8, padding: "6px 10px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <Badge label={fvg.type.toUpperCase()} color={fvg.type === "bullish" ? "green" : "red"} />
                    <span style={{ fontSize: 9, color: "#6b7280" }}>{new Date(fvg.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4 }}>{formatPrice(fvg.low)} – {formatPrice(fvg.high)}</div>
                </div>
              ))}
              {!(smcData.fvgs?.length) && <div style={{ color: "#374151", fontSize: 11 }}>No FVGs detected</div>}
            </Card>
          </div>
        )}

        {/* ── TRADES TAB ── */}
        {activeTab === "trades" && (
          <div style={{ animation: "slideIn 0.3s ease" }}>
            <div style={{ display: "flex", gap: 14, marginBottom: 14 }}>
              <Card style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: (paperStats?.totalNetPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(paperStats?.totalNetPnL || 0)}</div>
                <div style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.1em", textTransform: "uppercase" }}>Net PnL</div>
              </Card>
              <Card style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#4db8ff" }}>{paperStats?.winRate || 0}%</div>
                <div style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.1em", textTransform: "uppercase" }}>Win Rate</div>
              </Card>
              <Card style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#c084fc" }}>{paperStats?.profitFactor || "—"}</div>
                <div style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.1em", textTransform: "uppercase" }}>Profit Factor</div>
              </Card>
              <Card style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#ffd700" }}>{paperStats?.total || 0}</div>
                <div style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.1em", textTransform: "uppercase" }}>Closed Trades</div>
              </Card>
              <Card style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#00ff9d" }}>{paperPositions.length}</div>
                <div style={{ fontSize: 9, color: "#6b7280", letterSpacing: "0.1em", textTransform: "uppercase" }}>Open Now</div>
              </Card>
            </div>

            {paperPositions.length > 0 && (
              <Card style={{ marginBottom: 14 }}>
                <SectionTitle icon="🔴" label={`Active Paper Positions (${paperPositions.length})`} />
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "'Space Mono', monospace" }}>
                    <thead>
                      <tr>
                        {["Time", "Dir", "Strategy", "Entry", "Current", "Gross", "Fees", "Net PnL", "ROI", "Health", "Phase"].map(h => (
                          <th key={h} style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600, textAlign: "left", letterSpacing: "0.08em", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {paperPositions.map((t) => {
                        const live = price ? calcFuturesPnL({ direction: t.direction, entry: t.entry, exit: price, btcQty: t.btcQty, fundingRate: t.fundingRate, holdHours: (Date.now() - t.entryTime) / 3600000 }) : null;
                        return (
                          <tr key={t.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                            <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{new Date(t.entryTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                            <td style={{ padding: "5px 8px", color: t.direction === "LONG" ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{t.direction}</td>
                            <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{t.strategy}</td>
                            <td style={{ padding: "5px 8px", color: "#e5e7eb" }}>{formatPrice(t.entry)}</td>
                            <td style={{ padding: "5px 8px", color: "#e5e7eb" }}>{formatPrice(price)}</td>
                            <td style={{ padding: "5px 8px", color: (live?.grossPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{live ? formatPnL(live.grossPnL) : "—"}</td>
                            <td style={{ padding: "5px 8px", color: "#ff4566" }}>{live ? formatPnL(-live.fees) : "—"}</td>
                            <td style={{ padding: "5px 8px", color: (live?.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{live ? formatPnL(live.netPnL) : "—"}</td>
                            <td style={{ padding: "5px 8px", color: (live?.roi || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{live ? formatPct(live.roi) : "—"}</td>
                            <td style={{ padding: "5px 8px" }}>{t.health ? <span style={{ color: t.health.score >= 70 ? "#00ff9d" : t.health.score >= 40 ? "#ffd700" : "#ff4566" }}>{t.health.score}</span> : "—"}</td>
                            <td style={{ padding: "5px 8px" }}><Badge label={t.health?.phase || "—"} color={t.health?.phase === "ACTIVE" ? "green" : t.health?.phase === "HOLD" ? "blue" : "yellow"} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            <Card>
              <SectionTitle icon="📋" label="Trade Log (All) — click any row for full replay" />
              {paperTrades.length === 0 ? (
                <div style={{ textAlign: "center", color: "#374151", padding: 30, fontSize: 11 }}>No trades yet. Bot papers every valid signal across all modes.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "'Space Mono', monospace" }}>
                    <thead>
                      <tr>
                        {["Time", "Dir", "Strategy", "Regime", "Entry", "Exit", "Gross", "Fees", "Net PnL", "ROI%", "Conf", "Status", "Exit Reason", "Note"].map(h => (
                          <th key={h} style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600, textAlign: "left", letterSpacing: "0.08em", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...paperTrades].reverse().slice(0, 50).map((t) => (
                        <tr key={t.id}
                          onClick={() => setSelectedTradeId(selectedTradeId === t.id ? null : t.id)}
                          style={{ borderBottom: "1px solid rgba(255,255,255,0.03)", cursor: "pointer", background: selectedTradeId === t.id ? "rgba(77,184,255,0.06)" : "transparent", transition: "background 0.15s" }}
                          onMouseEnter={e => { if (selectedTradeId !== t.id) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                          onMouseLeave={e => { if (selectedTradeId !== t.id) e.currentTarget.style.background = "transparent"; }}>
                          <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{new Date(t.entryTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                          <td style={{ padding: "5px 8px", color: t.direction === "LONG" ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{t.direction}</td>
                          <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{t.strategy}</td>
                          <td style={{ padding: "5px 8px", color: "#6b7280" }}>{t.regime}</td>
                          <td style={{ padding: "5px 8px", color: "#e5e7eb" }}>{formatPrice(t.entry)}</td>
                          <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{t.exit ? formatPrice(t.exit) : "OPEN"}</td>
                          <td style={{ padding: "5px 8px", color: (t.pnl?.grossPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{t.pnl ? formatPnL(t.pnl.grossPnL) : "—"}</td>
                          <td style={{ padding: "5px 8px", color: "#ff4566" }}>{t.pnl ? formatPnL(-t.pnl.fees) : "—"}</td>
                          <td style={{ padding: "5px 8px", color: (t.pnl?.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>
                            {t.status === "open" ? (
                              <span style={{ color: "#ffd700", animation: "blink 1.5s infinite" }}>LIVE</span>
                            ) : t.pnl ? formatPnL(t.pnl.netPnL) : "—"}
                          </td>
                          <td style={{ padding: "5px 8px", color: (t.pnl?.roi || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{t.pnl ? formatPct(t.pnl.roi) : "—"}</td>
                          <td style={{ padding: "5px 8px", color: "#c084fc" }}>{t.confidence}%</td>
                          <td style={{ padding: "5px 8px" }}><Badge label={t.status.toUpperCase()} color={t.status === "open" ? "yellow" : (t.pnl?.netPnL || 0) >= 0 ? "green" : "red"} /></td>
                          <td style={{ padding: "5px 8px", color: "#6b7280", fontSize: 9 }}>{t.exitReason || "—"}</td>
                          <td style={{ padding: "5px 8px", color: "#ffd700", fontSize: 9, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{journalStore.getNote(t.id, paperEngine) || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* v32: Trade Replay Card */}
            {selectedTradeId && (() => {
              const t = paperTrades.find(tr => tr.id === selectedTradeId);
              if (!t) return null;
              const note = journalStore.getNote(t.id, paperEngine);
              const pe = paperEngine.postExitSims[t.id];
              return (
                <Card style={{ marginTop: 14 }} glow={t.direction === "LONG" ? "#00ff9d" : "#ff4566"}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <SectionTitle icon="🔬" label={`Trade Replay — ${t.id.slice(0, 20)}`} />
                    <button onClick={() => setSelectedTradeId(null)}
                      style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#6b7280", fontSize: 10, cursor: "pointer", padding: "3px 8px" }}>
                      ✕ Close
                    </button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 14 }}>
                    <div>
                      <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", marginBottom: 2 }}>Entry Time</div>
                      <div style={{ fontSize: 10, color: "#e5e7eb" }}>{new Date(t.entryTime).toLocaleString()}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", marginBottom: 2 }}>Exit Time</div>
                      <div style={{ fontSize: 10, color: "#e5e7eb" }}>{t.exitTime ? new Date(t.exitTime).toLocaleString() : "OPEN"}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", marginBottom: 2 }}>Direction</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: t.direction === "LONG" ? "#00ff9d" : "#ff4566" }}>{t.direction}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", marginBottom: 2 }}>Strategy</div>
                      <div style={{ fontSize: 10, color: "#4db8ff" }}>{t.strategy}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", marginBottom: 2 }}>Regime</div>
                      <div style={{ fontSize: 10, color: "#c084fc" }}>{t.regime}</div>
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, marginBottom: 14 }}>
                    <Metric label="Entry" value={formatPrice(t.entry)} color="#4db8ff" />
                    <Metric label="Exit" value={t.exit ? formatPrice(t.exit) : (t.status === "open" ? "OPEN" : "—")} color="#9ca3af" />
                    <Metric label="SL" value={formatPrice(t.sl)} color="#ff4566" />
                    <Metric label="TP" value={formatPrice(t.tp)} color="#00ff9d" />
                    <Metric label="Confidence" value={`${t.confidence}%`} color="#c084fc" />
                    <Metric label="Session" value={t.session || "—"} color="#ffd700" />
                  </div>

                  {/* BUG FIX: Additional replay fields — distance, current price, SL/TP hit status, fee */}
                  {(() => {
                    const livePrice = t.status === "open" ? price : t.exit;
                    const liveUnrealPnL = t.status === "open" && price ? calcFuturesPnL({
                      direction: t.direction, entry: t.entry, exit: price,
                      btcQty: t.btcQty, leverage: t.leverage || CONFIG.LEVERAGE,
                      fundingRate: t.fundingRate, holdHours: (Date.now() - t.entryTime) / 3600000,
                      feeRate: t.feeRate || CONFIG.TAKER_FEE,
                    }) : null;
                    const distToSL = livePrice && t.sl ? Math.abs(livePrice - t.sl) : null;
                    const distToTP = livePrice && t.tp ? Math.abs(livePrice - t.tp) : null;
                    const slHit = t.status === "closed" && (t.exitReason === "STOP_LOSS" || t.exitReason?.includes("SL"));
                    const tpHit = t.status === "closed" && (t.exitReason === "TAKE_PROFIT" || t.exitReason?.includes("TP"));
                    const feeEst = t.btcQty && t.entry ? (t.entry * t.btcQty * (t.feeRate || CONFIG.TAKER_FEE) * 2) : null;
                    return (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, marginBottom: 14 }}>
                        <Metric label="Current / Exit Price" value={livePrice ? formatPrice(livePrice) : "—"} color={t.status === "open" ? "#ffd700" : "#9ca3af"} sub={t.status === "open" ? "live" : "closed"} />
                        <Metric label="Dist to SL" value={distToSL != null ? `$${distToSL.toFixed(1)}` : (t.status === "closed" ? "N/A" : "No price")} color="#ff4566" />
                        <Metric label="Dist to TP" value={distToTP != null ? `$${distToTP.toFixed(1)}` : (t.status === "closed" ? "N/A" : "No price")} color="#00ff9d" />
                        <Metric label="SL Hit" value={slHit ? "✓ YES" : t.status === "open" ? "Not yet" : "NO"} color={slHit ? "#ff4566" : "#374151"} />
                        <Metric label="TP Hit" value={tpHit ? "✓ YES" : t.status === "open" ? "Not yet" : "NO"} color={tpHit ? "#00ff9d" : "#374151"} />
                        <Metric label="Fee Estimate" value={feeEst != null ? `$${feeEst.toFixed(4)}` : "—"} color="#ff4566" sub="entry+exit taker" />
                        {t.status === "open" && liveUnrealPnL && (
                          <Metric label="Live Unrealized PnL" value={formatPnL(liveUnrealPnL.netPnL)} color={(liveUnrealPnL.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566"} sub="net of fees" />
                        )}
                        {t.status === "open" && liveUnrealPnL && (
                          <Metric label="Live ROI" value={formatPct(liveUnrealPnL.roi)} color={(liveUnrealPnL.roi || 0) >= 0 ? "#00ff9d" : "#ff4566"} />
                        )}
                      </div>
                    );
                  })()}

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 14 }}>
                    <Metric label="Gross PnL" value={t.pnl ? formatPnL(t.pnl.grossPnL) : "—"} color={(t.pnl?.grossPnL || 0) >= 0 ? "#00ff9d" : "#ff4566"} />
                    <Metric label="Fees" value={t.pnl ? formatPnL(-t.pnl.fees) : "—"} color="#ff4566" />
                    <Metric label="Net PnL" value={t.pnl ? formatPnL(t.pnl.netPnL) : "—"} color={(t.pnl?.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566"} />
                    <Metric label="ROI" value={t.pnl ? formatPct(t.pnl.roi) : "—"} color={(t.pnl?.roi || 0) >= 0 ? "#00ff9d" : "#ff4566"} />
                    <Metric label="Max RR" value={t.maxRR ? `${t.maxRR.toFixed(2)}:1` : "—"} color="#4db8ff" />
                  </div>

                  {/* v34 P10: Net Expectancy at Entry */}
                  {t.netExpectancy && (
                    <div style={{ marginBottom: 14, padding: "12px 14px", borderRadius: 8, background: "rgba(77,184,255,0.05)", border: "1px solid rgba(77,184,255,0.2)" }}>
                      <div style={{ fontSize: 9, color: "#4db8ff", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>v34 Net Expectancy at Entry</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
                        <Metric label="Gross Reward" value={`$${t.netExpectancy.grossReward.toFixed(4)}`} color="#4db8ff" sub="Before fees" />
                        <Metric label="Round-Trip Fee" value={`$${t.netExpectancy.estimatedRoundTripFee.toFixed(4)}`} color="#ff4566" />
                        <Metric label="Net Reward" value={`$${t.netExpectancy.expectedNetReward.toFixed(4)}`} color={t.netExpectancy.expectedNetReward > 0 ? "#00ff9d" : "#ff4566"} sub="After fees" />
                        <Metric label="Net RR" value={`${t.netExpectancy.netRR.toFixed(2)}:1`} color={t.netExpectancy.netRR >= CONFIG.MIN_NET_RR ? "#00ff9d" : "#ff4566"} sub={`Min: ${CONFIG.MIN_NET_RR}`} />
                        <Metric label="Fee Impact" value={`${t.netExpectancy.feeImpactPct.toFixed(1)}%`} color={t.netExpectancy.feeImpactPct < 30 ? "#00ff9d" : t.netExpectancy.feeImpactPct < 60 ? "#ffd700" : "#ff4566"} sub="of gross reward" />
                        <Metric label="Net Risk" value={`$${t.netExpectancy.netRisk.toFixed(4)}`} color="#ff4566" sub="SL loss + fees" />
                      </div>
                      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {t.duplicateSetup && <span style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: "rgba(255,215,0,0.12)", color: "#ffd700", fontWeight: 700 }}>⚠ DUPLICATE SETUP</span>}
                        {t.sessionPenaltyApplied && <span style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: "rgba(255,69,102,0.1)", color: "#ff4566", fontWeight: 700 }}>⚠ SESSION PENALTY</span>}
                        {t.netExpectancy.expectedNetReward <= 0 && <span style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: "rgba(255,69,102,0.1)", color: "#ff4566", fontWeight: 700 }}>⚠ NEG NET EXPECTANCY AT ENTRY</span>}
                        {t.netExpectancy.netRR < CONFIG.MIN_NET_RR && <span style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: "rgba(255,215,0,0.1)", color: "#ffd700", fontWeight: 700 }}>⚠ LOW NET RR</span>}
                        {t.feeEfficiencyWarning && <span style={{ fontSize: 8, padding: "2px 8px", borderRadius: 3, background: "rgba(255,215,0,0.1)", color: "#ffd700", fontWeight: 700 }}>⚠ FEE WEAK</span>}
                      </div>
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
                    <Metric label="MFE" value={t.mfe ? `${(t.mfe * 100).toFixed(3)}%` : "—"} color="#00ff9d" sub="Max favorable excursion" />
                    <Metric label="MAE" value={t.mae ? `${(t.mae * 100).toFixed(3)}%` : "—"} color="#ff4566" sub="Max adverse excursion" />
                    <div>
                      <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>R-Milestones Reached</div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {["1R", "2R", "3R", "5R"].map(r => {
                          const key = `reached${r}`;
                          return <span key={r} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: t[key] ? "rgba(0,255,157,0.15)" : "rgba(255,255,255,0.04)", color: t[key] ? "#00ff9d" : "#374151", fontWeight: t[key] ? 700 : 400 }}>{r}</span>;
                        })}
                      </div>
                    </div>
                    <Metric label="Early Exit?" value={t.wasEarlyExit ? "YES ⚠" : "NO"} color={t.wasEarlyExit ? "#ffd700" : "#9ca3af"} />
                  </div>

                  <Divider />

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>SMC Context</div>
                      <div style={{ fontSize: 9, color: "#9ca3af", lineHeight: 2 }}>
                        <div>SMC Bias: <span style={{ color: t.smcBias === "BULLISH" ? "#00ff9d" : t.smcBias === "BEARISH" ? "#ff4566" : "#9ca3af" }}>{t.smcBias || "—"}</span></div>
                        <div>SMC Opposed: <span style={{ color: t.smcOpposed ? "#ff4566" : "#00ff9d" }}>{t.smcOpposed ? "YES" : "NO"}</span></div>
                        <div>News Risk Score: <span style={{ color: "#ffd700" }}>{t.newsRisk ?? "—"}</span></div>
                        <div>Funding Rate: <span style={{ color: "#4db8ff" }}>{t.fundingRate != null ? (t.fundingRate * 100).toFixed(4) + "%" : "—"}</span></div>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Entry Reasons</div>
                      <div style={{ maxHeight: 80, overflowY: "auto" }}>
                        {(t.factors || []).map((f, i) => (
                          <div key={i} style={{ fontSize: 9, color: "#9ca3af", marginBottom: 3 }}>› {f}</div>
                        ))}
                        {!t.factors?.length && <div style={{ fontSize: 9, color: "#374151" }}>—</div>}
                      </div>
                    </div>
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Exit Reason</div>
                    <div style={{ fontSize: 10, color: "#ffd700" }}>{t.exitReason || "OPEN"}</div>
                  </div>

                  {pe && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Post-Exit Simulation Result</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
                        {[
                          { key: "normal", label: "Normal", pnl: pe.normalExitPnL, color: "#4db8ff" },
                          { key: "sltp", label: "SL/TP", pnl: pe.sims?.sltp?.pnl?.netPnL, color: "#00ff9d" },
                          { key: "trailing", label: "Trailing", pnl: pe.sims?.trailing?.pnl?.netPnL, color: "#c084fc" },
                          { key: "patient", label: "Patient", pnl: pe.sims?.patient?.pnl?.netPnL, color: "#ffd700" },
                          { key: "swing", label: "Swing", pnl: pe.sims?.swing?.pnl?.netPnL, color: "#fb923c" },
                        ].map(({ key, label, pnl, color }) => (
                          <div key={key} style={{ background: `${color}08`, border: `1px solid ${color}22`, borderRadius: 6, padding: 8, textAlign: "center" }}>
                            <div style={{ fontSize: 9, color, marginBottom: 4, fontWeight: 700 }}>{label}</div>
                            <div style={{ fontSize: 10, color: pnl != null ? (pnl >= 0 ? "#00ff9d" : "#ff4566") : "#374151", fontWeight: 700 }}>
                              {pnl != null ? formatPnL(pnl) : "—"}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 9, color: "#6b7280" }}>
                        Later hit TP: <span style={{ color: pe.laterHitTP ? "#00ff9d" : "#374151" }}>{pe.laterHitTP ? "YES" : "NO"}</span>
                        &nbsp;·&nbsp; Later hit 3R: <span style={{ color: pe.laterHit3R ? "#c084fc" : "#374151" }}>{pe.laterHit3R ? "YES" : "NO"}</span>
                        &nbsp;·&nbsp; Best exit: <span style={{ color: "#ffd700" }}>{pe.bestExitStyle || "PENDING"}</span>
                      </div>
                    </div>
                  )}

                  <Divider />
                  {/* v32: Trade Notes */}
                  <div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Trade Note</div>
                    {editingNoteId === t.id ? (
                      <div>
                        <textarea
                          value={noteText}
                          onChange={e => setNoteText(e.target.value)}
                          placeholder="Good entry / Bad exit / Should have held / Avoid this setup..."
                          style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,215,0,0.3)", borderRadius: 6, padding: 10, color: "#e5e7eb", fontSize: 10, fontFamily: "'Space Mono', monospace", minHeight: 60, resize: "vertical", outline: "none", boxSizing: "border-box" }}
                        />
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <button onClick={() => {
                            journalStore.setNote(t.id, noteText, paperEngine);
                            setEditingNoteId(null);
                            setPaperTrades([...paperEngine.trades]);
                            try { syncNote(t.id, noteText); } catch {}
                          }} style={{ padding: "6px 14px", borderRadius: 5, border: "1px solid rgba(0,255,157,0.3)", background: "rgba(0,255,157,0.08)", color: "#00ff9d", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace", fontWeight: 700 }}>
                            💾 Save Note
                          </button>
                          <button onClick={() => { setEditingNoteId(null); setNoteText(""); }}
                            style={{ padding: "6px 14px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        {note ? (
                          <div style={{ fontSize: 10, color: "#ffd700", lineHeight: 1.5, padding: "6px 10px", background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.1)", borderRadius: 5 }}>{note}</div>
                        ) : (
                          <div style={{ fontSize: 9, color: "#374151" }}>No note yet.</div>
                        )}
                        <button onClick={() => { setEditingNoteId(t.id); setNoteText(note); }}
                          style={{ marginTop: 8, padding: "5px 12px", borderRadius: 5, border: "1px solid rgba(255,215,0,0.2)", background: "rgba(255,215,0,0.06)", color: "#ffd700", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                          ✏ {note ? "Edit Note" : "Add Note"}
                        </button>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })()}
          </div>
        )}

        {/* ── ANALYTICS TAB ── */}
        {activeTab === "analytics" && (() => {
          const closedForAnalytics = paperEngine.trades.filter(t => t.status === "closed");
          const extendedAnalytics = calcExtendedAnalytics(closedForAnalytics);
          const stratDist = calcStrategyDistribution(paperEngine.signalLog, closedForAnalytics);
          const sessPerf = calcSessionPerformance(closedForAnalytics);
          // v34 P6: Strategy imbalance warning
          const tradingStrategies = Object.entries(stratDist).filter(([, v]) => v.traded > 0).map(([k]) => k);
          const stratImbalance = tradingStrategies.length === 1;
          const cooldownBlocks = blockedSignalDetails.filter(d => d.reason === "TREND_COOLDOWN").length;
          const negNetExpBlocks = blockedSignalDetails.filter(d => d.reason === "NEGATIVE_NET_EXPECTANCY").length;
          const lowNetRRBlocks = blockedSignalDetails.filter(d => d.reason === "LOW_NET_RR").length;
          return (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, animation: "slideIn 0.3s ease" }}>

            {/* v34 P13: Strategy imbalance warning */}
            {stratImbalance && (
              <div style={{ gridColumn: "1 / -1", padding: "10px 16px", borderRadius: 8, background: "rgba(255,215,0,0.06)", border: "1px solid rgba(255,215,0,0.3)", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16 }}>⚠️</span>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#ffd700", letterSpacing: "0.08em" }}>STRATEGY IMBALANCE DETECTED</div>
                  <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}>
                    Only <strong style={{ color: "#ffd700" }}>{tradingStrategies[0]}</strong> is generating trades. Check regime detection and signal filters — other strategies (RANGE, BREAKOUT, REVERSAL) should contribute.
                  </div>
                </div>
              </div>
            )}

            <Card>
              <SectionTitle icon="📊" label="Overall Performance" />
              {paperStats ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Metric label="Total Trades" value={paperStats.total} />
                  <Metric label="Wins / Losses" value={`${paperStats.wins} / ${paperStats.losses}`} color="#4db8ff" />
                  <Metric label="Win Rate" value={`${paperStats.winRate}%`} color={parseFloat(paperStats.winRate) >= 50 ? "#00ff9d" : "#ff4566"} />
                  <Metric label="Profit Factor" value={paperStats.profitFactor} color={parseFloat(paperStats.profitFactor) >= 1.5 ? "#00ff9d" : "#ff4566"} />
                  <Metric label="Total Gross PnL" value={formatPnL(paperStats.totalGrossPnL)} color={paperStats.totalGrossPnL >= 0 ? "#00ff9d" : "#ff4566"} />
                  <Metric label="Total Fees Paid" value={formatPnL(-paperStats.totalFees)} color="#ff4566" />
                  <Metric label="Total Funding" value={formatPnL(-paperStats.totalFunding)} color="#ffd700" />
                  <Metric label="Net PnL" value={formatPnL(paperStats.totalNetPnL)} color={paperStats.totalNetPnL >= 0 ? "#00ff9d" : "#ff4566"} />
                  <Metric label="Avg Net PnL/Trade" value={formatPnL(paperStats.avgPnL)} color={paperStats.avgPnL >= 0 ? "#00ff9d" : "#ff4566"} />
                  <Metric label="Open Positions" value={paperPositions.length} color="#4db8ff" />
                </div>
              ) : <div style={{ textAlign: "center", color: "#374151", padding: 30, fontSize: 11 }}>Accumulating data...</div>}
            </Card>

            {/* v34 P11: Extended Analytics */}
            <Card>
              <SectionTitle icon="💰" label="v34 Fee Impact Analytics" />
              {extendedAnalytics ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Metric label="Net Winners" value={extendedAnalytics.netWinners} color="#00ff9d" sub="Profitable after fees" />
                  <Metric label="Gross Win / Net Loss" value={extendedAnalytics.grossWinNetLoss} color="#ff4566" sub="Killed by fees" />
                  <Metric label="Avg Fee % of Notional" value={extendedAnalytics.avgFeePct != null ? `${extendedAnalytics.avgFeePct.toFixed(3)}%` : "—"} color="#ffd700" />
                  <Metric label="Avg Net RR" value={extendedAnalytics.avgNetRR != null ? extendedAnalytics.avgNetRR.toFixed(2) : "—"} color={extendedAnalytics.avgNetRR >= CONFIG.MIN_NET_RR ? "#00ff9d" : "#ff4566"} sub={`Min required: ${CONFIG.MIN_NET_RR}`} />
                  <Metric label="Duplicate Setups Traded" value={extendedAnalytics.duplicateSetupCount} color="#ffd700" sub="Confidence penalized" />
                  <Metric label="Total Fees" value={formatPnL(-extendedAnalytics.totalFees)} color="#ff4566" />
                  <Metric label="Gross PnL" value={formatPnL(extendedAnalytics.totalGross)} color={extendedAnalytics.totalGross >= 0 ? "#00ff9d" : "#ff4566"} />
                  <Metric label="Fee Drain Ratio" value={extendedAnalytics.totalGross !== 0 ? `${Math.abs(extendedAnalytics.totalFees / extendedAnalytics.totalGross * 100).toFixed(1)}%` : "—"} color="#ff4566" sub="Fees as % of gross" />
                </div>
              ) : <div style={{ textAlign: "center", color: "#374151", padding: 30, fontSize: 11 }}>Accumulating data...</div>}
            </Card>

            {/* v34 P6: Strategy Distribution Audit */}
            <Card>
              <SectionTitle icon="🎯" label="Strategy Distribution Audit" />
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: "'Space Mono', monospace" }}>
                  <thead>
                    <tr>
                      {["Strategy", "Detected", "Qualified", "Traded", "W/L", "Net PnL", "Expectancy"].map(h => (
                        <th key={h} style={{ padding: "5px 8px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 8 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stratDist).map(([strat, d]) => (
                      <tr key={strat} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                        <td style={{ padding: "5px 8px", fontWeight: 700, color: { TREND: "#00ff9d", RANGE: "#4db8ff", BREAKOUT: "#ffd700", REVERSAL: "#c084fc" }[strat] || "#e5e7eb" }}>{strat}</td>
                        <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{d.detected}</td>
                        <td style={{ padding: "5px 8px", color: "#4db8ff" }}>{d.qualified}</td>
                        <td style={{ padding: "5px 8px", color: d.traded > 0 ? "#00ff9d" : "#374151" }}>{d.traded}</td>
                        <td style={{ padding: "5px 8px" }}>
                          <span style={{ color: "#00ff9d" }}>{d.wins}</span>
                          <span style={{ color: "#4b5563" }}>/</span>
                          <span style={{ color: "#ff4566" }}>{d.losses}</span>
                        </td>
                        <td style={{ padding: "5px 8px", color: d.netPnL >= 0 ? "#00ff9d" : "#ff4566" }}>{d.netPnL !== null ? formatPnL(d.netPnL) : "—"}</td>
                        <td style={{ padding: "5px 8px", color: d.expectancy !== null ? (d.expectancy >= 0 ? "#00ff9d" : "#ff4566") : "#374151" }}>{d.expectancy !== null ? formatPnL(d.expectancy) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {stratImbalance && (
                <div style={{ marginTop: 8, fontSize: 8, color: "#ffd700", padding: "4px 8px", background: "rgba(255,215,0,0.05)", borderRadius: 4 }}>
                  ⚠ IMBALANCE: Only {tradingStrategies[0]} generating trades
                </div>
              )}
            </Card>

            {/* v34 P8: Session Performance Engine */}
            <Card>
              <SectionTitle icon="🕐" label="Session Performance Engine" />
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {Object.entries(sessPerf).map(([sess, sp]) => {
                  const poor = sp.trades >= 3 && sp.winRate !== null && sp.winRate < CONFIG.SESSION_PENALTY_WINRATE;
                  return (
                    <div key={sess} style={{ padding: "10px 12px", borderRadius: 7, background: "rgba(255,255,255,0.02)", border: `1px solid ${poor ? "rgba(255,69,102,0.3)" : "rgba(255,255,255,0.05)"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: { ASIA: "#ffd700", LONDON: "#4db8ff", NEW_YORK: "#00ff9d", OFF: "#6b7280" }[sess] }}>{sess}</span>
                        {poor && <span style={{ fontSize: 8, color: "#ff4566", background: "rgba(255,69,102,0.1)", padding: "2px 6px", borderRadius: 3 }}>⚠ PENALTY ACTIVE (-10 conf)</span>}
                        {!poor && sp.trades > 0 && <span style={{ fontSize: 8, color: "#00ff9d", background: "rgba(0,255,157,0.06)", padding: "2px 6px", borderRadius: 3 }}>OK</span>}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
                        <Metric label="Trades" value={sp.trades} />
                        <Metric label="W/L" value={`${sp.wins}/${sp.losses}`} />
                        <Metric label="Win Rate" value={sp.winRate !== null ? `${sp.winRate.toFixed(0)}%` : "—"} color={sp.winRate !== null ? (sp.winRate >= 50 ? "#00ff9d" : "#ff4566") : "#374151"} />
                        <Metric label="Net PnL" value={formatPnL(sp.pnl)} color={sp.pnl >= 0 ? "#00ff9d" : "#ff4566"} />
                        <Metric label="Expectancy" value={sp.expectancy !== null ? formatPnL(sp.expectancy) : "—"} color={sp.expectancy !== null ? (sp.expectancy >= 0 ? "#00ff9d" : "#ff4566") : "#374151"} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* v34 P4: Cooldown & Filter Summary */}
            <Card>
              <SectionTitle icon="🛡️" label="v34 Trade Filter Summary" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Metric label="Cooldown Blocks" value={cooldownBlocks} color="#ffd700" sub="TREND re-entry prevented" />
                <Metric label="Neg Net Expectancy" value={negNetExpBlocks} color="#ff4566" sub="Net reward ≤ 0" />
                <Metric label="Low Net RR" value={lowNetRRBlocks} color="#ff4566" sub={`Net RR < ${CONFIG.MIN_NET_RR}`} />
                <Metric label="Min Net RR Required" value={CONFIG.MIN_NET_RR} color="#4db8ff" sub="After fees" />
                <Metric label="Trend Cooldown" value={`${CONFIG.TREND_COOLDOWN_CANDLES} candles`} color="#4db8ff" sub="Per direction" />
                <Metric label="Duplicate Window" value={`${CONFIG.DUPLICATE_CANDLE_WINDOW} candles`} color="#ffd700" sub="Lookback" />
              </div>
            </Card>

            <Card>
              <SectionTitle icon="🎯" label="Performance by Strategy (Trades)" />
              {(detailedStats.byStrategy || []).length > 0 ? (detailedStats.byStrategy || []).map(s => (
                <div key={s.name} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: "#e5e7eb", fontWeight: 600 }}>{s.name}</span>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ fontSize: 9, color: "#9ca3af" }}>{s.total}t</span>
                      <span style={{ fontSize: 9, color: "#4db8ff" }}>{s.winRate}%WR</span>
                      <span style={{ fontSize: 9, color: s.profitFactor >= 1.5 ? "#00ff9d" : "#ffd700" }}>PF:{s.profitFactor?.toFixed(2)}</span>
                      <span style={{ fontSize: 9, color: s.expectancy >= 0 ? "#00ff9d" : "#ff4566" }}>E:{formatPnL(s.expectancy)}</span>
                      <span style={{ fontSize: 9, color: s.pnl >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(s.pnl)}</span>
                    </div>
                  </div>
                  <div style={{ height: 3, background: "rgba(255,255,255,0.05)", borderRadius: 2 }}>
                    <div style={{ width: `${s.winRate}%`, height: "100%", background: "#4db8ff", borderRadius: 2 }} />
                  </div>
                </div>
              )) : <div style={{ color: "#374151", fontSize: 11 }}>No data yet</div>}
            </Card>

            <Card>
              <SectionTitle icon="🌡️" label="Performance by Regime" />
              {(detailedStats.byRegime || []).length > 0 ? (detailedStats.byRegime || []).map(r => (
                <div key={r.name} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: "#e5e7eb" }}>{r.name}</span>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ fontSize: 10, color: "#9ca3af" }}>{r.total}t</span>
                      <span style={{ fontSize: 10, color: "#4db8ff" }}>{r.winRate}%</span>
                      <span style={{ fontSize: 10, color: r.pnl >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(r.pnl)}</span>
                    </div>
                  </div>
                  <div style={{ height: 2, background: "rgba(255,255,255,0.04)", borderRadius: 2 }}>
                    <div style={{ width: `${r.winRate}%`, height: "100%", background: "#c084fc", borderRadius: 2 }} />
                  </div>
                </div>
              )) : <div style={{ color: "#374151", fontSize: 11 }}>No data yet</div>}
            </Card>

            <Card style={{ gridColumn: "1 / -1" }}>
              <SectionTitle icon="📡" label="Signal Learning Engine — All Buckets" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
                {[
                  { label: "All Signals", value: signalAnalytics.allSignals, color: "#e5e7eb", sub: "Every candle analyzed" },
                  { label: "Tradable", value: signalAnalytics.tradableSignals, color: "#00ff9d", sub: "Confidence ≥ threshold" },
                  { label: "Filtered", value: signalAnalytics.filteredSignals, color: "#ff4566", sub: "News / Daily limit block" },
                  { label: "Waited", value: signalAnalytics.waitedSignals, color: "#ffd700", sub: "Low confidence / no setup" },
                  { label: "Paper Trades", value: signalAnalytics.paperTradesOpened, color: "#4db8ff", sub: `${signalAnalytics.paperTradesClosed} closed` },
                ].map(b => (
                  <div key={b.label} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 14, textAlign: "center" }}>
                    <div style={{ fontSize: 26, fontWeight: 700, color: b.color, fontFamily: "'Space Mono', monospace" }}>{b.value}</div>
                    <div style={{ fontSize: 9, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 4 }}>{b.label}</div>
                    <div style={{ fontSize: 8, color: "#4b5563", marginTop: 2 }}>{b.sub}</div>
                  </div>
                ))}
              </div>
              {signalAnalytics.signalLog.length > 0 && (
                <div style={{ overflowX: "auto", maxHeight: 200, overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: "'Space Mono', monospace" }}>
                    <thead>
                      <tr>
                        {["Time", "Action", "Strategy", "Direction", "Regime", "Conf", "Filtered By", "Dup?", "Reason"].map(h => (
                          <th key={h} style={{ padding: "5px 8px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 8, position: "sticky", top: 0, background: "#060b14" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...signalAnalytics.signalLog].reverse().slice(0, 100).map((s, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.02)" }}>
                          <td style={{ padding: "3px 8px", color: "#6b7280" }}>{new Date(s.loggedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                          <td style={{ padding: "3px 8px" }}><Badge label={s.action} color={s.action === "TRADE" ? "green" : "yellow"} /></td>
                          <td style={{ padding: "3px 8px", color: "#9ca3af" }}>{s.strategy || "—"}</td>
                          <td style={{ padding: "3px 8px", color: s.direction === "LONG" ? "#00ff9d" : s.direction === "SHORT" ? "#ff4566" : "#6b7280", fontWeight: 700 }}>{s.direction || "—"}</td>
                          <td style={{ padding: "3px 8px", color: "#6b7280" }}>{s.regime || "—"}</td>
                          <td style={{ padding: "3px 8px", color: "#c084fc" }}>{s.confidence > 0 ? `${s.confidence.toFixed(0)}%` : "—"}</td>
                          <td style={{ padding: "3px 8px" }}>{s.filteredBy ? <Badge label={s.filteredBy} color="red" /> : <span style={{ color: "#374151" }}>—</span>}</td>
                          <td style={{ padding: "3px 8px", color: s.duplicateSetup ? "#ffd700" : "#374151" }}>{s.duplicateSetup ? "⚠ DUP" : "—"}</td>
                          <td style={{ padding: "3px 8px", color: "#4b5563", fontSize: 8 }}>{s.reason?.slice(0, 50) || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {signalAnalytics.signalLog.length === 0 && (
                <div style={{ color: "#374151", fontSize: 10, textAlign: "center", padding: 20 }}>Signal log empty — bot will populate this as it analyzes candles.</div>
              )}
            </Card>

            {/* Blocked Signal Forensics */}
            {blockedSignalDetails.length > 0 && (
              <Card style={{ gridColumn: "1 / -1", border: "1px solid rgba(255,69,102,0.3)", background: "rgba(255,69,102,0.04)" }}>
                <SectionTitle icon="🚫" label={`Blocked Signal Forensics (${blockedSignalDetails.length})`} />
                <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>
                  v34: All blocked TRADE signals with net expectancy, net RR, and cooldown details.
                </div>
                <div style={{ overflowX: "auto", maxHeight: 220, overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: "'Space Mono', monospace" }}>
                    <thead>
                      <tr>
                        {["Time", "Reason", "Dir", "Strategy", "Conf", "Fee", "Gross Reward", "Net Reward", "Net RR", "R/F Ratio"].map(h => (
                          <th key={h} style={{ padding: "4px 8px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 8, position: "sticky", top: 0, background: "#060b14", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...blockedSignalDetails].reverse().map((d, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.02)" }}>
                          <td style={{ padding: "3px 8px", color: "#6b7280" }}>{d.timestamp ? new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "—"}</td>
                          <td style={{ padding: "3px 8px" }}><Badge label={d.reason} color={d.reason === "TREND_COOLDOWN" ? "yellow" : "red"} /></td>
                          <td style={{ padding: "3px 8px", color: d.direction === "LONG" ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{d.direction || "—"}</td>
                          <td style={{ padding: "3px 8px", color: "#9ca3af" }}>{d.strategy || "—"}</td>
                          <td style={{ padding: "3px 8px", color: "#c084fc" }}>{d.confidence > 0 ? `${d.confidence.toFixed ? d.confidence.toFixed(0) : d.confidence}%` : "—"}</td>
                          <td style={{ padding: "3px 8px", color: "#ff4566" }}>${d.totalFee}</td>
                          <td style={{ padding: "3px 8px", color: "#ffd700" }}>${d.expectedReward}</td>
                          <td style={{ padding: "3px 8px", color: d.expectedNetReward ? (parseFloat(d.expectedNetReward) > 0 ? "#00ff9d" : "#ff4566") : "#374151" }}>{d.expectedNetReward ? `$${d.expectedNetReward}` : "—"}</td>
                          <td style={{ padding: "3px 8px", color: d.netRR ? (parseFloat(d.netRR) >= CONFIG.MIN_NET_RR ? "#00ff9d" : "#ff4566") : "#374151" }}>{d.netRR ? `${d.netRR}x` : "—"}</td>
                          <td style={{ padding: "3px 8px", color: parseFloat(d.rewardFeeRatio) >= 3 ? "#00ff9d" : "#ff4566" }}>{d.rewardFeeRatio}x</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* Regime Distribution Funnel */}
            <Card style={{ gridColumn: "1 / -1" }}>
              <SectionTitle icon="🔽" label="Regime Distribution Funnel" />
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: "'Space Mono', monospace" }}>
                  <thead>
                    <tr>
                      {["Regime", "Detected", "Qualified (≥75%)", "Traded", "Watch", "Wait", "Win Rate", "Net PnL"].map(h => (
                        <th key={h} style={{ padding: "6px 10px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 8, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(signalAnalytics.regimeFunnel || []).map(r => (
                      <tr key={r.regime} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                        <td style={{ padding: "6px 10px", fontWeight: 700, color: { TRENDING: "#00ff9d", RANGING: "#4db8ff", BREAKOUT: "#ffd700", REVERSAL: "#c084fc", HIGH_VOLATILITY: "#ff4566", UNCERTAIN: "#6b7280" }[r.regime] || "#e5e7eb" }}>{r.regime}</td>
                        <td style={{ padding: "6px 10px", color: "#e5e7eb" }}>{r.detected}</td>
                        <td style={{ padding: "6px 10px", color: "#4db8ff" }}>{r.qualified}</td>
                        <td style={{ padding: "6px 10px", color: "#00ff9d" }}>{r.traded}</td>
                        <td style={{ padding: "6px 10px", color: "#ffd700" }}>{r.watch}</td>
                        <td style={{ padding: "6px 10px", color: "#6b7280" }}>{r.wait}</td>
                        <td style={{ padding: "6px 10px", color: r.winRate !== null ? (parseFloat(r.winRate) >= 50 ? "#00ff9d" : "#ff4566") : "#374151" }}>{r.winRate !== null ? `${r.winRate}%` : "—"}</td>
                        <td style={{ padding: "6px 10px", color: r.netPnL !== null ? (r.netPnL >= 0 ? "#00ff9d" : "#ff4566") : "#374151" }}>{r.netPnL !== null ? formatPnL(r.netPnL) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 8, fontSize: 8, color: "#374151" }}>Detected = all signals for regime · Qualified = conf ≥75% · Traded = opened paper trade · Watch/Wait = blocked or below threshold</div>
            </Card>

            <Card style={{ gridColumn: "1 / -1" }}>
              <SectionTitle icon="⚙️" label="Bot Configuration" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 16 }}>
                <Metric label="Risk/Trade" value={`${CONFIG.RISK_PER_TRADE}%`} />
                <Metric label="Leverage" value={`${CONFIG.LEVERAGE}x`} />
                <Metric label="Min R:R" value={`${CONFIG.MIN_RR}:1`} />
                <Metric label="Min Net RR" value={`${CONFIG.MIN_NET_RR}`} sub="v34 filter" />
                <Metric label="ATR SL" value={`${CONFIG.ATR_MULTIPLIER_SL}x`} />
                <Metric label="ATR TP" value={`${CONFIG.ATR_MULTIPLIER_TP}x`} />
                <Metric label="Taker Fee" value={`${(CONFIG.TAKER_FEE * 100).toFixed(3)}%`} />
                <Metric label="Daily Loss" value={`${CONFIG.DAILY_LOSS_LIMIT}%`} />
                <Metric label="Max Trades" value={CONFIG.MAX_DAILY_TRADES} />
                <Metric label="Consec Loss" value={CONFIG.MAX_CONSECUTIVE_LOSSES} />
                <Metric label="Trend Cooldown" value={`${CONFIG.TREND_COOLDOWN_CANDLES}c`} />
                <Metric label="Conf. Threshold" value={`WATCH ≥75% / TRADE ≥85%`} />
              </div>
            </Card>
          </div>
          );
        })()}

        {/* ── BACKTEST TAB ── */}
        {activeTab === "backtest" && (
          <div style={{ animation: "slideIn 0.3s ease" }}>
            <Card style={{ marginBottom: 14 }}>
              <SectionTitle icon="🔬" label="Backtest Engine v30" />
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
                {/* Strategy */}
                <div>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Strategy</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {["ALL", "TRENDING", "RANGING", "BREAKOUT", "REVERSAL"].map(s => (
                      <button key={s} onClick={() => setBacktestStrategy(s)}
                        style={{ padding: "4px 10px", borderRadius: 4, border: backtestStrategy === s ? "1px solid #4db8ff44" : "1px solid rgba(255,255,255,0.08)", background: backtestStrategy === s ? "rgba(77,184,255,0.1)" : "transparent", color: backtestStrategy === s ? "#4db8ff" : "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Session */}
                <div>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Session</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {["ALL", "ASIA", "LONDON", "NEW_YORK"].map(s => (
                      <button key={s} onClick={() => setBacktestSession(s)}
                        style={{ padding: "4px 10px", borderRadius: 4, border: backtestSession === s ? "1px solid #c084fc44" : "1px solid rgba(255,255,255,0.08)", background: backtestSession === s ? "rgba(192,132,252,0.1)" : "transparent", color: backtestSession === s ? "#c084fc" : "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Min Confidence */}
                <div>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Min Confidence</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[75, 80, 85, 90, 95].map(v => (
                      <button key={v} onClick={() => setBacktestConfidenceMin(v)}
                        style={{ padding: "4px 10px", borderRadius: 4, border: backtestConfidenceMin === v ? "1px solid #ffd70044" : "1px solid rgba(255,255,255,0.08)", background: backtestConfidenceMin === v ? "rgba(255,215,0,0.1)" : "transparent", color: backtestConfidenceMin === v ? "#ffd700" : "#6b7280", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                        {v}%
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ marginLeft: "auto" }}>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 6 }}>{candles.length} candles of Binance OHLC data</div>
                  <button onClick={handleRunBacktest} disabled={backtestRunning || candles.length < 100}
                    style={{ padding: "8px 20px", borderRadius: 6, border: "1px solid rgba(0,255,157,0.3)", background: backtestRunning ? "rgba(255,255,255,0.04)" : "rgba(0,255,157,0.08)", color: backtestRunning ? "#6b7280" : "#00ff9d", fontSize: 11, fontWeight: 700, cursor: backtestRunning ? "not-allowed" : "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    {backtestRunning ? "⏳ RUNNING..." : "▶ RUN BACKTEST"}
                  </button>
                </div>
              </div>
              {candles.length < 100 && <div style={{ marginTop: 10, fontSize: 10, color: "#ff4566" }}>⚠ Need at least 100 candles. Currently: {candles.length}</div>}
              {/* v30: Applied filters display */}
              {backtestResult?.appliedFilters && (
                <div style={{ marginTop: 10, fontSize: 9, color: "#6b7280" }}>
                  Last run: Strategy={backtestResult.appliedFilters.strategy} | Session={backtestResult.appliedFilters.sessionFilter} | MinConf={backtestResult.appliedFilters.confidenceMin}%
                </div>
              )}
            </Card>

            {/* v30: Error boundary */}
            {backtestError && (
              <Card style={{ marginBottom: 14, border: "1px solid rgba(255,69,102,0.3)", background: "rgba(255,69,102,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 18 }}>⚠️</span>
                  <div>
                    <div style={{ fontSize: 11, color: "#ff4566", fontWeight: 700, marginBottom: 4 }}>Backtest Error</div>
                    <div style={{ fontSize: 10, color: "#fca5a5" }}>{backtestError}</div>
                  </div>
                </div>
              </Card>
            )}

            {backtestResult && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 14 }}>
                  <Card style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: "#4db8ff" }}>{backtestResult.totalTrades}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Total Trades</div>
                  </Card>
                  <Card style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: parseFloat(backtestResult.winRate) >= 50 ? "#00ff9d" : "#ff4566" }}>{backtestResult.winRate}%</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Win Rate</div>
                  </Card>
                  <Card style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: parseFloat(backtestResult.profitFactor) >= 1.5 ? "#00ff9d" : "#ff4566" }}>{backtestResult.profitFactor}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Profit Factor</div>
                  </Card>
                  <Card style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: "#ff4566" }}>{backtestResult.maxDrawdown}%</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Max Drawdown</div>
                  </Card>
                  <Card style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: parseFloat(backtestResult.expectancy) >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(parseFloat(backtestResult.expectancy))}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Expectancy / Trade</div>
                  </Card>
                  <Card style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: backtestResult.totalNetPnL >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(backtestResult.totalNetPnL)}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Total Net PnL</div>
                  </Card>
                  <Card style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: "#c084fc" }}>{backtestResult.wins}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Wins</div>
                  </Card>
                  <Card style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: "#ff4566" }}>{backtestResult.losses}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Losses</div>
                  </Card>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {/* Equity Curve */}
                  <Card>
                    <SectionTitle icon="📈" label="Equity Curve" />
                    <div style={{ position: "relative", height: 120 }}>
                      {backtestResult.equityCurve?.length > 1 && (() => {
                        const pts = backtestResult.equityCurve;
                        const minY = Math.min(...pts.map(p => p.y));
                        const maxY = Math.max(...pts.map(p => p.y));
                        const W = 100, H = 100;
                        const scaleX = i => (i / (pts.length - 1)) * W;
                        const scaleY = v => H - ((v - minY) / (maxY - minY || 1)) * H;
                        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${scaleX(i).toFixed(1)},${scaleY(p.y).toFixed(1)}`).join(" ");
                        const fill = `${d} L${W},${H} L0,${H} Z`;
                        const isProfit = pts[pts.length - 1].y >= pts[0].y;
                        return (
                          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
                            <defs>
                              <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={isProfit ? "#00ff9d" : "#ff4566"} stopOpacity="0.25" />
                                <stop offset="100%" stopColor={isProfit ? "#00ff9d" : "#ff4566"} stopOpacity="0.03" />
                              </linearGradient>
                            </defs>
                            <path d={fill} fill="url(#eqGrad)" />
                            <path d={d} stroke={isProfit ? "#00ff9d" : "#ff4566"} strokeWidth="1.5" fill="none" />
                          </svg>
                        );
                      })()}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                      <span style={{ fontSize: 9, color: "#6b7280" }}>${accountBalance.toFixed(0)}</span>
                      <span style={{ fontSize: 9, color: backtestResult.finalBalance >= accountBalance ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>${backtestResult.finalBalance?.toFixed(2)}</span>
                    </div>
                  </Card>

                  {/* Drawdown Curve */}
                  <Card>
                    <SectionTitle icon="📉" label="Drawdown Curve" />
                    <div style={{ position: "relative", height: 120 }}>
                      {backtestResult.drawdownCurve?.length > 1 && (() => {
                        const pts = backtestResult.drawdownCurve;
                        const minY = Math.min(...pts.map(p => p.y));
                        const W = 100, H = 100;
                        const scaleX = i => (i / (pts.length - 1)) * W;
                        const scaleY = v => ((v - 0) / (minY - 0 || -1)) * H;
                        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${scaleX(i).toFixed(1)},${scaleY(p.y).toFixed(1)}`).join(" ");
                        const fill = `${d} L${W},0 L0,0 Z`;
                        return (
                          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
                            <defs>
                              <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#ff4566" stopOpacity="0.05" />
                                <stop offset="100%" stopColor="#ff4566" stopOpacity="0.3" />
                              </linearGradient>
                            </defs>
                            <path d={fill} fill="url(#ddGrad)" />
                            <path d={d} stroke="#ff456688" strokeWidth="1.5" fill="none" />
                          </svg>
                        );
                      })()}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                      <span style={{ fontSize: 9, color: "#6b7280" }}>0%</span>
                      <span style={{ fontSize: 9, color: "#ff4566", fontWeight: 700 }}>Max: -{backtestResult.maxDrawdown}%</span>
                    </div>
                  </Card>
                </div>

                {/* Strategy breakdown */}
                {backtestResult.stratBreakdown?.length > 0 && (
                  <Card>
                    <SectionTitle icon="🎯" label="Backtest — Strategy Breakdown" />
                    <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(4, backtestResult.stratBreakdown.length)}, 1fr)`, gap: 12 }}>
                      {backtestResult.stratBreakdown.map(s => (
                        <div key={s.name} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#e5e7eb", marginBottom: 8 }}>{s.name}</div>
                          <Metric label="Trades" value={s.total} />
                          <Metric label="Win Rate" value={`${s.winRate}%`} color={parseFloat(s.winRate) >= 50 ? "#00ff9d" : "#ff4566"} />
                          <Metric label="Net PnL" value={formatPnL(s.pnl)} color={s.pnl >= 0 ? "#00ff9d" : "#ff4566"} />
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {/* Monthly Performance */}
                {backtestResult.monthlyPerf?.length > 0 && (
                  <Card style={{ marginTop: 14 }}>
                    <SectionTitle icon="📅" label="Monthly Performance" />
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
                      {backtestResult.monthlyPerf.map(m => (
                        <div key={m.month} style={{ background: m.pnl >= 0 ? "rgba(0,255,157,0.04)" : "rgba(255,69,102,0.04)", border: `1px solid ${m.pnl >= 0 ? "rgba(0,255,157,0.12)" : "rgba(255,69,102,0.12)"}`, borderRadius: 7, padding: 10 }}>
                          <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 700, marginBottom: 4 }}>{m.month}</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: m.pnl >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(m.pnl)}</div>
                          <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>{m.trades} trades · {m.winRate}% WR</div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {/* Export backtest results */}
                <Card style={{ marginTop: 14 }}>
                  <SectionTitle icon="💾" label="Export Backtest Results" />
                  <div style={{ display: "flex", gap: 10 }}>
                    <button onClick={() => {
                      if (!backtestResult) return;
                      const csv = ["#,Strategy,Dir,Entry,Exit,Outcome,NetPnL,Conf%,Balance",
                        ...backtestResult.trades.map((t, i) => `${i+1},${t.strategy},${t.direction},${t.entry.toFixed(2)},${t.exit.toFixed(2)},${t.outcome},${t.pnl?.netPnL?.toFixed(4)},${t.confidence?.toFixed(0)},${t.balance.toFixed(2)}`)
                      ].join("\n");
                      const blob = new Blob([csv], { type: "text/csv" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a"); a.href = url; a.download = `alpha_backtest_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
                    }} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid rgba(0,255,157,0.3)", background: "rgba(0,255,157,0.06)", color: "#00ff9d", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                      📥 EXPORT CSV
                    </button>
                    <button onClick={() => {
                      if (!backtestResult) return;
                      const json = JSON.stringify({ ...backtestResult, exportedAt: new Date().toISOString() }, null, 2);
                      const blob = new Blob([json], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a"); a.href = url; a.download = `alpha_backtest_${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
                    }} style={{ padding: "7px 18px", borderRadius: 6, border: "1px solid rgba(77,184,255,0.3)", background: "rgba(77,184,255,0.06)", color: "#4db8ff", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                      📥 EXPORT JSON
                    </button>
                  </div>
                </Card>

                {/* Trade Log */}
                <Card>
                  <SectionTitle icon="📋" label="Backtest Trade Log (Last 50)" />
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "'Space Mono', monospace" }}>
                      <thead>
                        <tr>
                          {["#", "Strategy", "Dir", "Entry", "Exit", "Outcome", "Gross", "Fees", "Net PnL", "Conf%", "Balance"].map(h => (
                            <th key={h} style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 9 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {backtestResult.trades.slice().reverse().map((t, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                            <td style={{ padding: "5px 8px", color: "#6b7280" }}>{t.idx}</td>
                            <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{t.strategy}</td>
                            <td style={{ padding: "5px 8px", color: t.direction === "LONG" ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{t.direction}</td>
                            <td style={{ padding: "5px 8px", color: "#e5e7eb" }}>{formatPrice(t.entry)}</td>
                            <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{formatPrice(t.exit)}</td>
                            <td style={{ padding: "5px 8px" }}>
                              <Badge label={t.outcome} color={t.outcome === "TP" ? "green" : t.outcome === "SL" ? "red" : "gray"} />
                            </td>
                            <td style={{ padding: "5px 8px", color: (t.pnl?.grossPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{t.pnl ? formatPnL(t.pnl.grossPnL) : "—"}</td>
                            <td style={{ padding: "5px 8px", color: "#ff4566" }}>{t.pnl ? formatPnL(-t.pnl.fees) : "—"}</td>
                            <td style={{ padding: "5px 8px", color: (t.pnl?.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{t.pnl ? formatPnL(t.pnl.netPnL) : "—"}</td>
                            <td style={{ padding: "5px 8px", color: "#c084fc" }}>{t.confidence}%</td>
                            <td style={{ padding: "5px 8px", color: t.balance >= accountBalance ? "#00ff9d" : "#ff4566" }}>${t.balance?.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </>
            )}

            {!backtestResult && !backtestRunning && (
              <Card>
                <div style={{ textAlign: "center", padding: 60, color: "#374151" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>🔬</div>
                  <div style={{ fontSize: 12, marginBottom: 6 }}>Backtest Engine Ready</div>
                  <div style={{ fontSize: 10 }}>Select a strategy filter and run to see historical performance on real Binance OHLC data.</div>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ── NEWS TAB ── */}
        {activeTab === "news" && (
          <NewsTab newsData={newsData} dataStatus={dataStatus} manualNewsRisk={manualNewsRisk} setManualNewsRisk={setManualNewsRisk} onRetry={handleNewsRetry} newsRetryLoading={newsRetryLoading} newsLastAttempt={newsLastAttempt} />
        )}

        {/* ── COPILOT TAB ── */}
        {activeTab === "copilot" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, animation: "slideIn 0.3s ease" }}>
            <Card glow={copilotAnalysis?.status === "TRADE" ? "#00ff9d" : copilotAnalysis?.status === "BLOCKED" ? "#ff4566" : "#ffd700"}>
              <SectionTitle icon="🧠" label="AI Copilot — Trade Decision" />
              <div style={{ marginBottom: 14, padding: "14px 16px", borderRadius: 8, background: copilotAnalysis?.status === "TRADE" ? "rgba(0,255,157,0.06)" : copilotAnalysis?.status === "BLOCKED" ? "rgba(255,69,102,0.06)" : "rgba(255,215,0,0.04)", border: `1px solid ${copilotAnalysis?.status === "TRADE" ? "rgba(0,255,157,0.2)" : copilotAnalysis?.status === "BLOCKED" ? "rgba(255,69,102,0.2)" : "rgba(255,215,0,0.15)"}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: copilotAnalysis?.status === "TRADE" ? "#00ff9d" : copilotAnalysis?.status === "BLOCKED" ? "#ff4566" : "#ffd700", marginBottom: 6, letterSpacing: "0.02em" }}>{copilotAnalysis?.headline || "Analyzing..."}</div>
                {copilotAnalysis?.strategy && <div style={{ fontSize: 10, color: "#9ca3af" }}>Strategy: <span style={{ color: "#4db8ff" }}>{copilotAnalysis.strategy}</span> | Regime: <span style={{ color: "#c084fc" }}>{copilotAnalysis.regime}</span></div>}
              </div>

              {copilotAnalysis?.why?.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Why this decision</div>
                  {copilotAnalysis.why.map((w, i) => (
                    <div key={i} style={{ fontSize: 10, color: "#d1fae5", marginBottom: 5, display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.4 }}>
                      <span style={{ color: "#00ff9d", flexShrink: 0, marginTop: 1 }}>▸</span>{w}
                    </div>
                  ))}
                </div>
              )}

              {copilotAnalysis?.missing?.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>What's still missing / needed</div>
                  {copilotAnalysis.missing.map((m, i) => (
                    <div key={i} style={{ fontSize: 10, color: "#fef3c7", marginBottom: 5, display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.4 }}>
                      <span style={{ color: "#ffd700", flexShrink: 0, marginTop: 1 }}>◆</span>{m}
                    </div>
                  ))}
                </div>
              )}

              {copilotAnalysis?.invalidators?.length > 0 && (
                <div>
                  <div style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>What would invalidate this setup</div>
                  {copilotAnalysis.invalidators.map((inv, i) => (
                    <div key={i} style={{ fontSize: 10, color: "#fca5a5", marginBottom: 5, display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.4 }}>
                      <span style={{ color: "#ff4566", flexShrink: 0, marginTop: 1 }}>✕</span>{inv}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {signalGrade && (
                <Card glow={signalGrade.gradeColor}>
                  <SectionTitle icon="🏆" label="Signal Quality Grade" />
                  <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 16 }}>
                    <div style={{ fontSize: 52, fontWeight: 700, color: signalGrade.gradeColor, fontFamily: "'Syne', sans-serif", lineHeight: 1 }}>{signalGrade.grade}</div>
                    <div>
                      <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>Quality Score</div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: signalGrade.gradeColor, fontFamily: "'Space Mono', monospace" }}>{signalGrade.score}/100</div>
                    </div>
                  </div>
                  <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginBottom: 14 }}>
                    <div style={{ width: `${signalGrade.score}%`, height: "100%", background: `linear-gradient(90deg, ${signalGrade.gradeColor}66, ${signalGrade.gradeColor})`, borderRadius: 2, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#00ff9d", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Strengths</div>
                      {signalGrade.reasons.map((r, i) => <div key={i} style={{ fontSize: 9, color: "#d1fae5", marginBottom: 3 }}>✓ {r}</div>)}
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#ff4566", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Demerits</div>
                      {signalGrade.demerits.length > 0 ? signalGrade.demerits.map((d, i) => <div key={i} style={{ fontSize: 9, color: "#fca5a5", marginBottom: 3 }}>✕ {d}</div>) : <div style={{ fontSize: 9, color: "#374151" }}>None</div>}
                    </div>
                  </div>
                  <Divider />
                  <div style={{ fontSize: 9, color: "#6b7280" }}>
                    <span style={{ color: "#00ff9d" }}>A+</span> = skip nothing &nbsp;|&nbsp; <span style={{ color: "#4db8ff" }}>A</span> = high quality &nbsp;|&nbsp; <span style={{ color: "#ffd700" }}>B</span> = acceptable &nbsp;|&nbsp; <span style={{ color: "#fb923c" }}>C</span> = marginal &nbsp;|&nbsp; <span style={{ color: "#ff4566" }}>D</span> = avoid
                  </div>
                </Card>
              )}
              {!signalGrade && (
                <Card>
                  <SectionTitle icon="🏆" label="Signal Quality Grade" />
                  <div style={{ textAlign: "center", padding: "30px 0", color: "#374151", fontSize: 11 }}>Waiting for a TRADE signal to grade...</div>
                </Card>
              )}

              <Card>
                <SectionTitle icon="📡" label="Live Context Snapshot" />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Metric label="Regime" value={regime?.regime || "—"} color="#c084fc" />
                  <Metric label="Session" value={session || "—"} color="#4db8ff" />
                  <Metric label="BOS" value={smcData.bosChoch?.bos || "None"} color={smcData.bosChoch?.bos === "BULLISH" ? "#00ff9d" : smcData.bosChoch?.bos === "BEARISH" ? "#ff4566" : "#6b7280"} />
                  <Metric label="CHoCH" value={smcData.bosChoch?.choch || "None"} color={smcData.bosChoch?.choch ? "#c084fc" : "#6b7280"} />
                  <Metric label="Structure Bias" value={smcData.bosChoch?.bias || "NEUTRAL"} color={smcData.bosChoch?.bias === "BULLISH" ? "#00ff9d" : smcData.bosChoch?.bias === "BEARISH" ? "#ff4566" : "#9ca3af"} />
                  <Metric label="Zone" value={smcData.premiumDiscount || "NEUTRAL"} color={smcData.premiumDiscount === "DISCOUNT" ? "#00ff9d" : smcData.premiumDiscount === "PREMIUM" ? "#ff4566" : "#9ca3af"} />
                  <Metric label="Liquidity Sweep" value={smcData.sweep?.type || "None"} color={smcData.sweep ? "#c084fc" : "#6b7280"} />
                  <Metric label="News Risk" value={`${newsRisk.score}/100`} color={newsRisk.score > 60 ? "#ff4566" : newsRisk.score > 30 ? "#ffd700" : "#00ff9d"} />
                </div>
              </Card>
            </div>

            {/* v30: Trade Outcome Learning */}
            {outcomeLearning && (
              <Card>
                <SectionTitle icon="🧠" label="Trade Outcome Learning (v31)" />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 14 }}>
                  {[
                    { label: "Reached 1R", val: outcomeLearning.reached1R, pct: outcomeLearning.pctReached1R, color: "#00ff9d" },
                    { label: "Reached 3R", val: outcomeLearning.reached3R, pct: outcomeLearning.pctReached3R, color: "#4db8ff" },
                    { label: "Reached 5R", val: outcomeLearning.reached5R, pct: outcomeLearning.pctReached5R, color: "#c084fc" },
                    { label: "Early Exits", val: outcomeLearning.earlyExitsCount, pct: null, color: "#ff4566" },
                  ].map(({ label, val, pct, color }) => (
                    <div key={label} style={{ background: `${color}08`, border: `1px solid ${color}20`, borderRadius: 8, padding: 12, textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color }}>{val}</div>
                      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 3 }}>{label}{pct ? ` (${pct}%)` : ""}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 10 }}>
                  <Metric label="Avg MFE" value={`${outcomeLearning.avgMFEPct}%`} color="#00ff9d" sub="Max favorable excursion" />
                  <Metric label="Avg MAE" value={`${outcomeLearning.avgMAEPct}%`} color="#ff4566" sub="Max adverse excursion" />
                  <Metric label="Avg Max RR" value={`${outcomeLearning.avgMaxRR}:1`} color="#4db8ff" sub="Best RR reached per trade" />
                </div>
                {outcomeLearning.earlyExitMissedCount > 0 && (
                  <div style={{ padding: "8px 12px", borderRadius: 6, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.15)", fontSize: 9, color: "#ffd700" }}>
                    ⚠ {outcomeLearning.earlyExitMissedCount} health exit(s) may have been premature — SL/TP sim shows better outcome. Consider Patient or Swing Test mode.
                  </div>
                )}
              </Card>
            )}

            {/* v31: Exit Style Comparison — now includes Swing */}
            {exitStyleComparison && (
              <Card>
                <SectionTitle icon="🎭" label="Exit Style Performance (In-Trade Sims)" />
                <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12 }}>Parallel simulations run during trade. Shows how each exit method performs on the same entries.</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
                  {[
                    { key: "normal", label: "Normal", sub: "Bot health exit", color: "#4db8ff" },
                    { key: "sltp", label: "SL/TP Only", sub: "No health exits", color: "#00ff9d" },
                    { key: "trailing", label: "Trailing", sub: "1.5x ATR trail", color: "#c084fc" },
                    { key: "patient", label: "Patient", sub: "Major inval. only", color: "#ffd700" },
                    { key: "swing", label: "Swing Test", sub: "SL/TP only, full hold", color: "#fb923c" },
                  ].map(({ key, label, sub, color }) => {
                    const d = exitStyleComparison[key];
                    return (
                      <div key={key} style={{ background: `${color}08`, border: `1px solid ${color}22`, borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 8 }}>{sub}</div>
                        {d ? (
                          <>
                            <Metric label="Trades" value={d.trades} />
                            <Metric label="Win Rate" value={`${d.winRate}%`} color={parseFloat(d.winRate) >= 50 ? "#00ff9d" : "#ff4566"} />
                            <Metric label="Total PnL" value={formatPnL(parseFloat(d.totalPnL))} color={parseFloat(d.totalPnL) >= 0 ? "#00ff9d" : "#ff4566"} />
                          </>
                        ) : <div style={{ fontSize: 9, color: "#374151" }}>No data yet</div>}
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* v31: Post-Exit Simulation Analytics */}
            {postExitAnalytics && (
              <Card style={{ gridColumn: "1 / -1" }}>
                <SectionTitle icon="🔭" label="Post-Exit Simulation Tracker (v31)" />
                <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 14, lineHeight: 1.6 }}>
                  After the bot closes a trade, simulations continue tracking whether price later hit TP, reached higher R-multiples, or if the exit was premature.
                  Sims expire after {CONFIG.POST_EXIT_MAX_CANDLES} candles or {CONFIG.POST_EXIT_MAX_HOURS}h.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
                  {[
                    { label: "Tracked", value: postExitAnalytics.totalTracked, color: "#4db8ff", sub: "All post-exit records" },
                    { label: "Active Sims", value: postExitAnalytics.totalActive, color: "#ffd700", sub: "Still running" },
                    { label: "Early Exits", value: postExitAnalytics.earlyExitsCount, color: "#ff4566", sub: "Health-exited before TP" },
                    { label: "Later Hit TP", value: postExitAnalytics.earlyHitTPCount, color: "#00ff9d", sub: postExitAnalytics.earlyHitTPPct ? `${postExitAnalytics.earlyHitTPPct}% of early exits` : "of early exits" },
                  ].map(({ label, value, color, sub }) => (
                    <div key={label} style={{ background: `${color}08`, border: `1px solid ${color}20`, borderRadius: 8, padding: 12, textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "'Space Mono', monospace" }}>{value}</div>
                      <div style={{ fontSize: 9, color: "#9ca3af", textTransform: "uppercase", marginTop: 3 }}>{label}</div>
                      <div style={{ fontSize: 8, color: "#4b5563", marginTop: 2 }}>{sub}</div>
                    </div>
                  ))}
                </div>

                {/* Later R-milestones reached */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 16 }}>
                  <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12 }}>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Early Exits That Later Reached R-Milestones</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <Metric label="Later hit 3R" value={`${postExitAnalytics.earlyHit3RCount}${postExitAnalytics.earlyHit3RPct ? ` (${postExitAnalytics.earlyHit3RPct}%)` : ""}`} color="#c084fc" />
                      <Metric label="Later hit 5R" value={postExitAnalytics.earlyHit5RCount} color="#fb923c" />
                    </div>
                  </div>
                  <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12 }}>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Best Exit Method Overall</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#00ff9d", fontFamily: "'Space Mono', monospace" }}>{postExitAnalytics.bestExitStyle}</div>
                    <div style={{ fontSize: 8, color: "#4b5563", marginTop: 4 }}>Won most often across all tracked trades</div>
                    <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {Object.entries(postExitAnalytics.styleCounts).filter(([, v]) => v > 0).map(([k, v]) => (
                        <span key={k} style={{ fontSize: 8, background: "rgba(255,255,255,0.04)", padding: "2px 6px", borderRadius: 3, color: "#9ca3af" }}>{k}: {v}</span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Per-style post-exit PnL comparison */}
                {postExitAnalytics.styleStats && (
                  <div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Post-Exit Style Comparison (including continued simulations)</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
                      {[
                        { key: "normal", label: "Normal", color: "#4db8ff" },
                        { key: "sltp", label: "SL/TP", color: "#00ff9d" },
                        { key: "trailing", label: "Trailing", color: "#c084fc" },
                        { key: "patient", label: "Patient", color: "#ffd700" },
                        { key: "swing", label: "Swing", color: "#fb923c" },
                      ].map(({ key, label, color }) => {
                        const s = postExitAnalytics.styleStats[key];
                        return (
                          <div key={key} style={{ background: `${color}08`, border: `1px solid ${color}22`, borderRadius: 8, padding: 10 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color, marginBottom: 6 }}>{label}</div>
                            {s ? (
                              <>
                                <div style={{ fontSize: 9, color: "#9ca3af" }}>{s.trades} trades</div>
                                <div style={{ fontSize: 9, color: parseFloat(s.winRate) >= 50 ? "#00ff9d" : "#ff4566" }}>{s.winRate}% WR</div>
                                <div style={{ fontSize: 9, fontWeight: 700, color: parseFloat(s.totalPnL) >= 0 ? "#00ff9d" : "#ff4566", marginTop: 4 }}>{formatPnL(parseFloat(s.totalPnL))}</div>
                                <div style={{ fontSize: 8, color: "#4b5563" }}>avg {formatPnL(parseFloat(s.avgPnL))}</div>
                              </>
                            ) : <div style={{ fontSize: 9, color: "#374151" }}>No data</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Recent post-exit entries */}
                {postExitAnalytics.recent && postExitAnalytics.recent.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Recent Post-Exit Records</div>
                    <div style={{ overflowX: "auto", maxHeight: 180, overflowY: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: "'Space Mono', monospace" }}>
                        <thead>
                          <tr>
                            {["Dir", "Normal Exit", "Normal PnL", "SL/TP", "Trailing", "Patient", "Swing", "Later TP", "Best", "Status"].map(h => (
                              <th key={h} style={{ padding: "4px 8px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 8, position: "sticky", top: 0, background: "#060b14" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {postExitAnalytics.recent.slice(0, 15).map((pe, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.02)" }}>
                              <td style={{ padding: "3px 8px", color: pe.direction === "LONG" ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{pe.direction}</td>
                              <td style={{ padding: "3px 8px", color: "#9ca3af", fontSize: 8 }}>{pe.normalExitReason?.slice(0, 18) || "—"}</td>
                              <td style={{ padding: "3px 8px", color: (pe.normalExitPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{pe.normalExitPnL != null ? formatPnL(pe.normalExitPnL) : "—"}</td>
                              <td style={{ padding: "3px 8px", color: (pe.sims?.sltp?.pnl?.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{pe.sims?.sltp?.pnl ? formatPnL(pe.sims.sltp.pnl.netPnL) : pe.sims?.sltp?.active ? <span style={{ color: "#ffd700" }}>LIVE</span> : "—"}</td>
                              <td style={{ padding: "3px 8px", color: (pe.sims?.trailing?.pnl?.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{pe.sims?.trailing?.pnl ? formatPnL(pe.sims.trailing.pnl.netPnL) : pe.sims?.trailing?.active ? <span style={{ color: "#ffd700" }}>LIVE</span> : "—"}</td>
                              <td style={{ padding: "3px 8px", color: (pe.sims?.patient?.pnl?.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{pe.sims?.patient?.pnl ? formatPnL(pe.sims.patient.pnl.netPnL) : pe.sims?.patient?.active ? <span style={{ color: "#ffd700" }}>LIVE</span> : "—"}</td>
                              <td style={{ padding: "3px 8px", color: (pe.sims?.swing?.pnl?.netPnL || 0) >= 0 ? "#00ff9d" : "#ff4566" }}>{pe.sims?.swing?.pnl ? formatPnL(pe.sims.swing.pnl.netPnL) : pe.sims?.swing?.active ? <span style={{ color: "#ffd700" }}>LIVE</span> : "—"}</td>
                              <td style={{ padding: "3px 8px" }}>{pe.laterHitTP ? <Badge label="YES" color="green" /> : <span style={{ color: "#374151" }}>—</span>}</td>
                              <td style={{ padding: "3px 8px" }}>{pe.bestExitStyle ? <Badge label={pe.bestExitStyle} color="blue" /> : <span style={{ color: "#374151" }}>PENDING</span>}</td>
                              <td style={{ padding: "3px 8px" }}>{pe.expired ? <Badge label="DONE" color="gray" /> : <Badge label="TRACKING" color="yellow" />}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {postExitAnalytics.earlyHitTPCount > 0 && (
                  <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.15)", fontSize: 9, color: "#ffd700", lineHeight: 1.6 }}>
                    ⚠ {postExitAnalytics.earlyHitTPCount} early exit(s) ({postExitAnalytics.earlyHitTPPct}%) saw price later hit TP after the bot closed the position.
                    {postExitAnalytics.earlyHit3RCount > 0 && ` ${postExitAnalytics.earlyHit3RCount} even reached 3R.`}
                    {" "}Consider switching to Patient or Swing Test patience mode to capture more of these moves.
                  </div>
                )}
              </Card>
            )}

          </div>
        )}

        {/* ── LEADERBOARD TAB ── */}
        {activeTab === "leaderboard" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "slideIn 0.3s ease" }}>
            {!leaderboard ? (
              <Card><div style={{ textAlign: "center", padding: 40, color: "#374151", fontSize: 11 }}>No closed trades yet. Leaderboard builds as the bot accumulates data.</div></Card>
            ) : (
              <>
                {/* Strategy Leaderboard */}
                <Card glow="#4db8ff">
                  <SectionTitle icon="🎯" label="Strategy Leaderboard" />
                  <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                    <Badge label={`Best: ${leaderboard.bestStrategy}`} color="green" size="md" />
                    <Badge label={`Worst: ${leaderboard.worstStrategy}`} color="red" size="md" />
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "'Space Mono', monospace" }}>
                      <thead>
                        <tr>
                          {["Strategy", "Trades", "W/L", "Win Rate", "Gross PnL", "Fees", "Net PnL", "Expectancy", "Profit Factor", "Avg RR", "Avg Hold (min)"].map(h => (
                            <th key={h} style={{ padding: "6px 10px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9, whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {["TREND", "RANGE", "BREAKOUT", "REVERSAL"].map(strat => {
                          const d = leaderboard.strategies[strat];
                          if (!d) return (
                            <tr key={strat} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                              <td style={{ padding: "7px 10px", color: "#4db8ff", fontWeight: 700 }}>{strat}</td>
                              <td colSpan={10} style={{ padding: "7px 10px", color: "#374151", fontSize: 9 }}>No trades</td>
                            </tr>
                          );
                          const isBest = leaderboard.bestStrategy === strat;
                          const isWorst = leaderboard.worstStrategy === strat;
                          return (
                            <tr key={strat} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)", background: isBest ? "rgba(0,255,157,0.03)" : isWorst ? "rgba(255,69,102,0.03)" : "transparent" }}>
                              <td style={{ padding: "7px 10px", fontWeight: 700, color: isBest ? "#00ff9d" : isWorst ? "#ff4566" : "#4db8ff" }}>{strat} {isBest ? "⭐" : isWorst ? "⚠" : ""}</td>
                              <td style={{ padding: "7px 10px", color: "#e5e7eb" }}>{d.trades}</td>
                              <td style={{ padding: "7px 10px", color: "#9ca3af" }}>{d.wins}/{d.losses}</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.winRate) >= 50 ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{d.winRate}%</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.grossPnL) >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(parseFloat(d.grossPnL))}</td>
                              <td style={{ padding: "7px 10px", color: "#ff4566" }}>{formatPnL(-parseFloat(d.fees))}</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.netPnL) >= 0 ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{formatPnL(parseFloat(d.netPnL))}</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.expectancy) >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(parseFloat(d.expectancy))}</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.profitFactor) >= 1.5 ? "#00ff9d" : "#ffd700" }}>{d.profitFactor}</td>
                              <td style={{ padding: "7px 10px", color: "#4db8ff" }}>{d.avgRR}</td>
                              <td style={{ padding: "7px 10px", color: "#9ca3af" }}>{d.avgHold}m</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {/* Session Leaderboard */}
                <Card glow="#c084fc">
                  <SectionTitle icon="🌐" label="Session Leaderboard" />
                  <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                    <Badge label={`Best: ${leaderboard.bestSession}`} color="green" size="md" />
                    <Badge label={`Worst: ${leaderboard.worstSession}`} color="red" size="md" />
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "'Space Mono', monospace" }}>
                      <thead>
                        <tr>
                          {["Session", "Trades", "W/L", "Win Rate", "Gross PnL", "Fees", "Net PnL", "Expectancy", "Profit Factor", "Avg RR", "Avg Hold (min)"].map(h => (
                            <th key={h} style={{ padding: "6px 10px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9, whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {["ASIA", "LONDON", "NEW_YORK", "OFF"].map(sess => {
                          const d = leaderboard.sessions[sess];
                          if (!d) return (
                            <tr key={sess} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                              <td style={{ padding: "7px 10px", color: "#c084fc", fontWeight: 700 }}>{sess}</td>
                              <td colSpan={10} style={{ padding: "7px 10px", color: "#374151", fontSize: 9 }}>No trades</td>
                            </tr>
                          );
                          const isBest = leaderboard.bestSession === sess;
                          const isWorst = leaderboard.worstSession === sess;
                          return (
                            <tr key={sess} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)", background: isBest ? "rgba(0,255,157,0.03)" : isWorst ? "rgba(255,69,102,0.03)" : "transparent" }}>
                              <td style={{ padding: "7px 10px", fontWeight: 700, color: isBest ? "#00ff9d" : isWorst ? "#ff4566" : "#c084fc" }}>{sess} {isBest ? "⭐" : isWorst ? "⚠" : ""}</td>
                              <td style={{ padding: "7px 10px", color: "#e5e7eb" }}>{d.trades}</td>
                              <td style={{ padding: "7px 10px", color: "#9ca3af" }}>{d.wins}/{d.losses}</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.winRate) >= 50 ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{d.winRate}%</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.grossPnL) >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(parseFloat(d.grossPnL))}</td>
                              <td style={{ padding: "7px 10px", color: "#ff4566" }}>{formatPnL(-parseFloat(d.fees))}</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.netPnL) >= 0 ? "#00ff9d" : "#ff4566", fontWeight: 700 }}>{formatPnL(parseFloat(d.netPnL))}</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.expectancy) >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(parseFloat(d.expectancy))}</td>
                              <td style={{ padding: "7px 10px", color: parseFloat(d.profitFactor) >= 1.5 ? "#00ff9d" : "#ffd700" }}>{d.profitFactor}</td>
                              <td style={{ padding: "7px 10px", color: "#4db8ff" }}>{d.avgRR}</td>
                              <td style={{ padding: "7px 10px", color: "#9ca3af" }}>{d.avgHold}m</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {/* Fee Impact Analytics */}
                {feeImpact && (
                  <Card glow="#ff4566">
                    <SectionTitle icon="💸" label="Fee Impact Analytics" />
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 14 }}>
                      <div style={{ background: "rgba(0,255,157,0.06)", border: "1px solid rgba(0,255,157,0.15)", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>Gross Profit</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#00ff9d", fontFamily: "'Space Mono', monospace" }}>{formatPnL(parseFloat(feeImpact.grossProfit))}</div>
                      </div>
                      <div style={{ background: "rgba(255,69,102,0.06)", border: "1px solid rgba(255,69,102,0.15)", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>Gross Loss</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#ff4566", fontFamily: "'Space Mono', monospace" }}>{formatPnL(parseFloat(feeImpact.grossLoss))}</div>
                      </div>
                      <div style={{ background: "rgba(255,69,102,0.08)", border: "1px solid rgba(255,69,102,0.2)", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>Total Fees</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#ff4566", fontFamily: "'Space Mono', monospace" }}>{formatPnL(-parseFloat(feeImpact.totalFees))}</div>
                      </div>
                      <div style={{ background: parseFloat(feeImpact.netProfit) >= 0 ? "rgba(0,255,157,0.06)" : "rgba(255,69,102,0.06)", border: `1px solid rgba(${parseFloat(feeImpact.netProfit) >= 0 ? "0,255,157" : "255,69,102"},0.15)`, borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>Net Profit</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: parseFloat(feeImpact.netProfit) >= 0 ? "#00ff9d" : "#ff4566", fontFamily: "'Space Mono', monospace" }}>{formatPnL(parseFloat(feeImpact.netProfit))}</div>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                      <Metric label="Fees as % of Gross Profit" value={`${feeImpact.feePct}%`} color="#ff4566" sub="Lower = better" />
                      <Metric label="Average Fee per Trade" value={formatPnL(-parseFloat(feeImpact.avgFee))} color="#ff4566" />
                      <div>
                        <div style={{ fontSize: 9, color: "#ff4566", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4, fontWeight: 700 }}>Fees Destroyed Profit</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: feeImpact.feesDestroyedCount > 0 ? "#ff4566" : "#00ff9d", fontFamily: "'Space Mono', monospace" }}>{feeImpact.feesDestroyedCount}</div>
                        <div style={{ fontSize: 9, color: "#6b7280", marginTop: 2 }}>Gross &gt; 0 but Net ≤ 0 — fees ate the win</div>
                      </div>
                    </div>
                  </Card>
                )}

                {/* Regime Accuracy */}
                {regimeStats && (
                  <Card glow="#ffd700">
                    <SectionTitle icon="🧭" label="Market Regime Accuracy" />
                    <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 14, lineHeight: 1.6 }}>
                      Tracks whether regime predictions (TRENDING/RANGING/BREAKOUT/REVERSAL) at entry matched what the market actually did. A win = regime was accurate.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
                      <div style={{ background: "rgba(255,215,0,0.06)", border: "1px solid rgba(255,215,0,0.2)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: "#ffd700" }}>{regimeStats.overall}%</div>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 3 }}>Overall Accuracy</div>
                        <div style={{ fontSize: 8, color: "#4b5563", marginTop: 1 }}>{regimeStats.totalRecords} trades</div>
                      </div>
                      <Metric label="Best Regime" value={regimeStats.bestRegime} color="#00ff9d" />
                      <Metric label="Worst Regime" value={regimeStats.worstRegime} color="#ff4566" />
                      <div>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 6 }}>False Signals</div>
                        <div style={{ fontSize: 9, color: "#9ca3af", lineHeight: 1.8 }}>
                          <div>False Trend: <span style={{ color: "#ff4566" }}>{regimeStats.falseTrend}</span></div>
                          <div>False Breakout: <span style={{ color: "#ff4566" }}>{regimeStats.falseBreakout}</span></div>
                          <div>Range Fail: <span style={{ color: "#ffd700" }}>{regimeStats.rangeFail}</span></div>
                        </div>
                      </div>
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "'Space Mono', monospace" }}>
                        <thead>
                          <tr>
                            {["Regime", "Total", "Correct", "Accuracy"].map(h => (
                              <th key={h} style={{ padding: "6px 10px", color: "#6b7280", fontWeight: 600, textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 9 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {regimeStats.regimeStats.map(r => (
                            <tr key={r.label} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                              <td style={{ padding: "7px 10px", color: "#ffd700", fontWeight: 700 }}>{r.label}</td>
                              <td style={{ padding: "7px 10px", color: "#e5e7eb" }}>{r.total}</td>
                              <td style={{ padding: "7px 10px", color: "#9ca3af" }}>{r.correct}</td>
                              <td style={{ padding: "7px 10px", fontWeight: 700 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <span style={{ color: parseFloat(r.accuracy) >= 50 ? "#00ff9d" : "#ff4566" }}>{r.accuracy}%</span>
                                  <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2 }}>
                                    <div style={{ width: `${r.accuracy}%`, height: "100%", background: parseFloat(r.accuracy) >= 50 ? "#00ff9d" : "#ff4566", borderRadius: 2 }} />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </>
            )}
          </div>
        )}

        {/* ── JOURNAL TAB ── */}
        {activeTab === "journal" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "slideIn 0.3s ease" }}>
            <Card glow="#4db8ff">
              <SectionTitle icon="📓" label="Persistent Trade Journal" />
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 16, lineHeight: 1.7 }}>
                All trades, signals, and post-exit simulations are automatically saved to your browser's localStorage on every close.
                Data persists across page reloads. API secrets are never saved. Use the controls below to manage your journal.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
                <div style={{ background: "rgba(0,255,157,0.06)", border: "1px solid rgba(0,255,157,0.15)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#00ff9d" }}>{paperTrades.filter(t => t.status === "closed").length}</div>
                  <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 2 }}>Saved Trades</div>
                </div>
                <div style={{ background: "rgba(77,184,255,0.06)", border: "1px solid rgba(77,184,255,0.15)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#4db8ff" }}>{signalLogCount}</div>
                  <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 2 }}>Signal Log Entries</div>
                </div>
                <div style={{ background: "rgba(192,132,252,0.06)", border: "1px solid rgba(192,132,252,0.15)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#c084fc" }}>{Object.values(paperEngine._notes || {}).filter(n => n).length}</div>
                  <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 2 }}>Trade Notes</div>
                </div>
                <div style={{ background: "rgba(255,215,0,0.06)", border: "1px solid rgba(255,215,0,0.15)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#ffd700" }}>{Object.keys(paperEngine.postExitSims).length}</div>
                  <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 2 }}>Post-Exit Sims</div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {/* Backup JSON */}
                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(77,184,255,0.04)", border: "1px solid rgba(77,184,255,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#4db8ff", marginBottom: 6 }}>🗂 Backup Full Journal — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Exports trades, signal log, post-exit sims, and trade notes. Use to backup before clearing or share between devices.</div>
                  <button onClick={() => {
                    const data = JSON.stringify({
                      exportedAt: new Date().toISOString(),
                      version: CONFIG.VERSION,
                      trades: paperEngine.trades.map(t => { const { deltaApiSecret, apiSecret, secret, ...safe } = t; return safe; }),
                      signalLog: paperEngine.signalLog,
                      postExitSims: paperEngine.postExitSims,
                      notes: paperEngine._notes || {},
                    }, null, 2);
                    const blob = new Blob([data], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_journal_backup_${Date.now()}.json`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(77,184,255,0.3)", background: "rgba(77,184,255,0.08)", color: "#4db8ff", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ BACKUP JSON
                  </button>
                </div>

                {/* Import JSON */}
                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(192,132,252,0.04)", border: "1px solid rgba(192,132,252,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#c084fc", marginBottom: 6 }}>📥 Import Journal — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Merge a backup JSON into the current journal. Duplicate trade/signal IDs are skipped automatically.</div>
                  <input type="file" accept=".json" id="journal_import_input" style={{ display: "none" }}
                    onChange={e => {
                      const file = e.target.files[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (ev) => {
                        const result = journalStore.importJSON(ev.target.result, paperEngine);
                        if (result.ok) {
                          setJournalImportResult(result);
                          setJournalImportError(null);
                          setPaperTrades([...paperEngine.trades]);
                          setSignalLogCount(paperEngine.signalLog.length);
                        } else {
                          setJournalImportError(result.error);
                          setJournalImportResult(null);
                        }
                      };
                      reader.readAsText(file);
                      e.target.value = "";
                    }}
                  />
                  <button onClick={() => document.getElementById("journal_import_input").click()}
                    style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(192,132,252,0.3)", background: "rgba(192,132,252,0.08)", color: "#c084fc", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    📂 IMPORT JSON
                  </button>
                  {journalImportResult && (
                    <div style={{ marginTop: 10, fontSize: 9, color: "#00ff9d" }}>✓ Imported {journalImportResult.importedTrades} trades, {journalImportResult.importedSignals} signals.</div>
                  )}
                  {journalImportError && (
                    <div style={{ marginTop: 10, fontSize: 9, color: "#ff4566" }}>✕ Import error: {journalImportError}</div>
                  )}
                </div>

                {/* Export CSV */}
                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(0,255,157,0.04)", border: "1px solid rgba(0,255,157,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#00ff9d", marginBottom: 6 }}>📊 Export Trades — CSV</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>All closed trades as CSV for spreadsheet analysis. Includes all columns plus notes column.</div>
                  <button onClick={() => {
                    const closed = paperEngine.trades.filter(t => t.status === "closed");
                    if (closed.length === 0) { alert("No closed trades to export."); return; }
                    const headers = ["id","direction","strategy","regime","confidence","entry","exit","sl","tp","session","grossPnL","fees","netPnL","roi","mfe","mae","maxRR","reached1R","reached2R","reached3R","reached5R","wasEarlyExit","exitReason","entryTime","exitTime","smcBias","note"];
                    const rows = closed.map(t => [
                      t.id, t.direction, t.strategy, t.regime, t.confidence,
                      t.entry, t.exit, t.sl, t.tp, t.session,
                      t.pnl?.grossPnL?.toFixed(4), t.pnl?.fees?.toFixed(4), t.pnl?.netPnL?.toFixed(4), t.pnl?.roi?.toFixed(4),
                      t.mfe?.toFixed(6), t.mae?.toFixed(6), (t.maxRR||0).toFixed(2),
                      t.reached1R?"YES":"NO", t.reached2R?"YES":"NO", t.reached3R?"YES":"NO", t.reached5R?"YES":"NO",
                      t.wasEarlyExit?"YES":"NO", t.exitReason||"",
                      new Date(t.entryTime).toISOString(), t.exitTime ? new Date(t.exitTime).toISOString() : "",
                      t.smcBias,
                      `"${(journalStore.getNote(t.id, paperEngine)||"").replace(/"/g,"'")}"`,
                    ]);
                    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_journal_${Date.now()}.csv`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(0,255,157,0.3)", background: "rgba(0,255,157,0.08)", color: "#00ff9d", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ EXPORT CSV
                  </button>
                </div>

                {/* Clear journal */}
                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(255,69,102,0.04)", border: "1px solid rgba(255,69,102,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#ff4566", marginBottom: 6 }}>🗑 Clear Journal</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Clears all closed trade history, signal log, post-exit sims, and notes from localStorage. Open positions are preserved. This cannot be undone — backup first.</div>
                  <button onClick={() => {
                    if (!window.confirm("Clear all journal data? This cannot be undone. Backup first!")) return;
                    journalStore.clearAll(paperEngine);
                    regimeAccuracy.clear();
                    setPaperTrades([...paperEngine.trades]);
                    setSignalLogCount(0);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(255,69,102,0.3)", background: "rgba(255,69,102,0.08)", color: "#ff4566", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    🗑 CLEAR JOURNAL
                  </button>
                </div>
              </div>
            </Card>

            {/* Trade notes quick view */}
            {Object.entries(paperEngine._notes || {}).filter(([, v]) => v).length > 0 && (
              <Card>
                <SectionTitle icon="✏️" label="All Trade Notes" />
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {Object.entries(paperEngine._notes || {}).filter(([, v]) => v).slice(0, 30).map(([id, note]) => {
                    const trade = paperEngine.trades.find(t => t.id === id);
                    return (
                      <div key={id} style={{ padding: "8px 12px", borderRadius: 6, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.1)" }}>
                        <div style={{ display: "flex", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                          {trade && <Badge label={trade.direction} color={trade.direction === "LONG" ? "green" : "red"} />}
                          {trade && <Badge label={trade.strategy || "?"} color="blue" />}
                          <span style={{ fontSize: 8, color: "#4b5563", alignSelf: "center" }}>{trade ? new Date(trade.entryTime).toLocaleDateString() : id.slice(0, 20)}</span>
                        </div>
                        <div style={{ fontSize: 10, color: "#ffd700", lineHeight: 1.4 }}>{note}</div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ── DAILY REPORT TAB ── */}
        {activeTab === "dailyreport" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "slideIn 0.3s ease" }}>
            {!dailyReports || dailyReports.length === 0 ? (
              <Card><div style={{ textAlign: "center", padding: 40, color: "#374151", fontSize: 11 }}>No closed trades yet. Daily reports appear as trades accumulate.</div></Card>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {dailyReports.map(r => (
                    <button key={r.day} onClick={() => setSelectedReportDay(selectedReportDay === r.day ? null : r.day)}
                      style={{ padding: "7px 14px", borderRadius: 6, border: selectedReportDay === r.day ? "1px solid rgba(77,184,255,0.5)" : "1px solid rgba(255,255,255,0.08)", background: selectedReportDay === r.day ? "rgba(77,184,255,0.1)" : "rgba(255,255,255,0.02)", color: selectedReportDay === r.day ? "#4db8ff" : "#9ca3af", fontSize: 10, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                      {r.day} <span style={{ color: parseFloat(r.netPnL) >= 0 ? "#00ff9d" : "#ff4566" }}>({formatPnL(parseFloat(r.netPnL))})</span>
                    </button>
                  ))}
                </div>

                {(selectedReportDay ? dailyReports.filter(r => r.day === selectedReportDay) : dailyReports.slice(0, 1)).map(r => (
                  <div key={r.day} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <Card glow={parseFloat(r.netPnL) >= 0 ? "#00ff9d" : "#ff4566"}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                        <SectionTitle icon="📅" label={`Daily Report — ${r.day}`} />
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={() => {
                            const data = JSON.stringify({ ...r, generatedAt: new Date().toISOString(), version: CONFIG.VERSION }, null, 2);
                            const blob = new Blob([data], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a"); a.href = url; a.download = `daily_report_${r.day}.json`; a.click();
                            URL.revokeObjectURL(url);
                          }} style={{ padding: "5px 12px", borderRadius: 5, border: "1px solid rgba(77,184,255,0.3)", background: "rgba(77,184,255,0.08)", color: "#4db8ff", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                            ⬇ JSON
                          </button>
                          <button onClick={() => {
                            const lines = [
                              `Date,${r.day}`, `Trades,${r.tradesCount}`, `Wins,${r.wins}`, `Losses,${r.losses}`,
                              `Win Rate,${r.winRate}%`, `Gross PnL,${r.grossPnL}`, `Fees,${r.fees}`, `Net PnL,${r.netPnL}`,
                              `Best Strategy,${r.bestStrategy}`, `Worst Strategy,${r.worstStrategy}`,
                              `Early Exits,${r.earlyExits}`, `Later Hit TP,${r.laterHitTP}`, `Later 3R,${r.later3R}`,
                              `Signals Generated,${r.signalsGenerated}`,
                            ].join("\n");
                            const blob = new Blob([lines], { type: "text/csv" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a"); a.href = url; a.download = `daily_report_${r.day}.csv`; a.click();
                            URL.revokeObjectURL(url);
                          }} style={{ padding: "5px 12px", borderRadius: 5, border: "1px solid rgba(0,255,157,0.3)", background: "rgba(0,255,157,0.08)", color: "#00ff9d", fontSize: 9, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                            ⬇ CSV
                          </button>
                        </div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
                        <div style={{ background: "rgba(77,184,255,0.06)", border: "1px solid rgba(77,184,255,0.15)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "#4db8ff" }}>{r.signalsGenerated}</div>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 2 }}>Signals Generated</div>
                        </div>
                        <div style={{ background: "rgba(192,132,252,0.06)", border: "1px solid rgba(192,132,252,0.15)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "#c084fc" }}>{r.tradesOpened}</div>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 2 }}>Trades Opened</div>
                        </div>
                        <div style={{ background: "rgba(0,255,157,0.06)", border: "1px solid rgba(0,255,157,0.15)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "#00ff9d" }}>{r.winRate}%</div>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 2 }}>Win Rate ({r.wins}W / {r.losses}L)</div>
                        </div>
                        <div style={{ background: parseFloat(r.netPnL) >= 0 ? "rgba(0,255,157,0.06)" : "rgba(255,69,102,0.06)", border: `1px solid rgba(${parseFloat(r.netPnL) >= 0 ? "0,255,157" : "255,69,102"},0.15)`, borderRadius: 8, padding: 12, textAlign: "center" }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: parseFloat(r.netPnL) >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(parseFloat(r.netPnL))}</div>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginTop: 2 }}>Net PnL</div>
                        </div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
                        <Metric label="Gross PnL" value={formatPnL(parseFloat(r.grossPnL))} color={parseFloat(r.grossPnL) >= 0 ? "#00ff9d" : "#ff4566"} />
                        <Metric label="Total Fees" value={formatPnL(-parseFloat(r.fees))} color="#ff4566" />
                        <div>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 6 }}>Strategy Performance</div>
                          <div style={{ fontSize: 9, color: "#9ca3af" }}>Best: <span style={{ color: "#00ff9d" }}>{r.bestStrategy}</span></div>
                          <div style={{ fontSize: 9, color: "#9ca3af" }}>Worst: <span style={{ color: "#ff4566" }}>{r.worstStrategy}</span></div>
                        </div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
                        <div style={{ background: r.earlyExits > 0 ? "rgba(255,215,0,0.06)" : "rgba(0,255,157,0.04)", border: `1px solid rgba(${r.earlyExits > 0 ? "255,215,0" : "0,255,157"},0.12)`, borderRadius: 8, padding: 12 }}>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>Early Exits</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: r.earlyExits > 0 ? "#ffd700" : "#00ff9d" }}>{r.earlyExits}</div>
                        </div>
                        <div style={{ background: "rgba(0,255,157,0.04)", border: "1px solid rgba(0,255,157,0.12)", borderRadius: 8, padding: 12 }}>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>Later Hit TP</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: r.laterHitTP > 0 ? "#ffd700" : "#374151" }}>{r.laterHitTP}</div>
                          <div style={{ fontSize: 8, color: "#4b5563" }}>of early exits</div>
                        </div>
                        <div style={{ background: "rgba(192,132,252,0.04)", border: "1px solid rgba(192,132,252,0.12)", borderRadius: 8, padding: 12 }}>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 }}>Later Hit 3R</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: r.later3R > 0 ? "#c084fc" : "#374151" }}>{r.later3R}</div>
                        </div>
                      </div>

                      {/* Session breakdown */}
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Session Breakdown</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {Object.entries(r.sessStats).map(([sess, stats]) => (
                            <div key={sess} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: "6px 10px" }}>
                              <div style={{ fontSize: 9, color: "#4db8ff", fontWeight: 700 }}>{sess}</div>
                              <div style={{ fontSize: 9, color: "#9ca3af" }}>{stats.trades}t &nbsp; {formatPnL(stats.netPnL)}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Confidence band performance */}
                      <div>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Confidence Band Performance</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          {Object.entries(r.confBands).filter(([, d]) => d.trades > 0).map(([band, data]) => (
                            <div key={band} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, padding: "6px 12px" }}>
                              <div style={{ fontSize: 9, color: band === "EXCEPTIONAL" ? "#00ff9d" : band === "STRONG" ? "#4db8ff" : "#ffd700", fontWeight: 700 }}>{band}</div>
                              <div style={{ fontSize: 9, color: "#9ca3af" }}>{data.trades}t · {data.trades > 0 ? (data.wins / data.trades * 100).toFixed(0) : 0}% WR</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </Card>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* ── CALIBRATION TAB ── */}
        {activeTab === "calibration" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "slideIn 0.3s ease" }}>
            <Card>
              <SectionTitle icon="🎯" label="Confidence Calibration Engine" />
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 16, lineHeight: 1.6 }}>
                Checks whether stated confidence scores match actual win rates. Identifies systematic overconfidence (inflation) that leads to unexpected losses.
              </div>
              {calibration.every(b => b.count === 0) ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#374151", fontSize: 11 }}>
                  Accumulating trade data... Need closed trades in each confidence band to calibrate.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                  {calibration.map(band => (
                    <div key={band.label} style={{ background: band.inflated ? "rgba(255,69,102,0.06)" : "rgba(255,255,255,0.03)", border: `1px solid ${band.inflated ? "rgba(255,69,102,0.2)" : "rgba(255,255,255,0.08)"}`, borderRadius: 10, padding: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: band.color, letterSpacing: "0.06em" }}>{band.label}</span>
                        {band.inflated && <Badge label="INFLATED" color="red" />}
                        {band.count > 0 && !band.inflated && band.actual !== null && <Badge label="CALIBRATED" color="green" />}
                      </div>
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Confidence Range</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: band.color, fontFamily: "'Space Mono', monospace" }}>{band.min}–{band.max}%</div>
                      </div>
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Expected Win Rate</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#9ca3af", fontFamily: "'Space Mono', monospace" }}>≥{band.expected}%</div>
                      </div>
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Actual Win Rate</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: band.actual !== null ? (band.actual >= band.expected ? "#00ff9d" : "#ff4566") : "#374151", fontFamily: "'Space Mono', monospace" }}>
                          {band.actual !== null ? `${band.actual.toFixed(1)}%` : `— (${band.count} trades)`}
                        </div>
                      </div>
                      {band.count > 0 && band.actual !== null && (
                        <>
                          <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, marginBottom: 4, position: "relative" }}>
                            <div style={{ width: `${Math.min(100, band.actual)}%`, height: "100%", background: band.actual >= band.expected ? "#00ff9d" : "#ff4566", borderRadius: 2 }} />
                            <div style={{ position: "absolute", top: -4, left: `${band.expected}%`, width: 1, height: 11, background: "#ffd700" }} />
                          </div>
                          <div style={{ fontSize: 8, color: "#6b7280" }}>Yellow marker = expected threshold</div>
                        </>
                      )}
                      <Divider />
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 9, color: "#6b7280" }}>{band.count} trades</span>
                        <span style={{ fontSize: 9, color: band.pnl >= 0 ? "#00ff9d" : "#ff4566" }}>{formatPnL(band.pnl)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <SectionTitle icon="📊" label="Calibration Notes" />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ padding: "10px 14px", borderRadius: 7, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.12)", fontSize: 10, color: "#d1d5db", lineHeight: 1.7 }}>
                  <span style={{ color: "#ffd700", fontWeight: 700 }}>What is confidence inflation?</span><br />
                  If trades marked 95%+ confidence are only winning 40% of the time, the scoring is inflated. The bot's confidence model is not aligned with reality. This does NOT auto-change anything — it is informational only.
                </div>
                <div style={{ padding: "10px 14px", borderRadius: 7, background: "rgba(77,184,255,0.04)", border: "1px solid rgba(77,184,255,0.1)", fontSize: 10, color: "#d1d5db", lineHeight: 1.7 }}>
                  <span style={{ color: "#4db8ff", fontWeight: 700 }}>Minimum sample sizes:</span><br />
                  Calibration requires at least 10-20 trades per band for statistical significance. Results with &lt;10 trades are directional only, not conclusive.
                </div>
                <div style={{ padding: "10px 14px", borderRadius: 7, background: "rgba(0,255,157,0.04)", border: "1px solid rgba(0,255,157,0.1)", fontSize: 10, color: "#d1d5db", lineHeight: 1.7 }}>
                  <span style={{ color: "#00ff9d", fontWeight: 700 }}>Action never automated:</span><br />
                  Risk settings, thresholds, and confidence weights are never auto-modified by this engine. Manual review only.
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* ── DIAGNOSTICS TAB ── */}
        {activeTab === "diagnostics" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "slideIn 0.3s ease" }}>
            <Card glow={diagnosticsReport.issues.some(i => i.level === "WARN") ? "#ff4566" : "#00ff9d"}>
              <SectionTitle icon="🔍" label="System Diagnostics Report" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 16 }}>
                {[
                  { label: "Total Signals", value: diagnosticsReport.summary.totalSignals, color: "#e5e7eb" },
                  { label: "Tradable Signals", value: diagnosticsReport.summary.tradableSignals, color: "#00ff9d" },
                  { label: "Filtered Out", value: diagnosticsReport.summary.filteredSignals, color: "#ff4566" },
                  { label: "Duplicate Signal IDs", value: diagnosticsReport.summary.duplicateSignalIds, color: diagnosticsReport.summary.duplicateSignalIds > 0 ? "#ff4566" : "#00ff9d" },
                  { label: "Open Positions", value: diagnosticsReport.summary.openPositions, color: diagnosticsReport.summary.openPositions > 3 ? "#ffd700" : "#4db8ff" },
                  { label: "Closed Trades", value: diagnosticsReport.summary.closedTrades, color: "#c084fc" },
                  { label: "Win Rate", value: diagnosticsReport.summary.winRate ? `${diagnosticsReport.summary.winRate}%` : "—", color: parseFloat(diagnosticsReport.summary.winRate) >= 50 ? "#00ff9d" : "#ff4566" },
                  { label: "Stuck Trades (>4h)", value: diagnosticsReport.summary.stuckTrades, color: diagnosticsReport.summary.stuckTrades > 0 ? "#ff4566" : "#00ff9d" },
                ].map(item => (
                  <div key={item.label} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: item.color, fontFamily: "'Space Mono', monospace", marginBottom: 4 }}>{item.value ?? "—"}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>{item.label}</div>
                  </div>
                ))}
              </div>

              <div>
                <div style={{ color: "#6b7280", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Issues Found</div>
                {diagnosticsReport.issues.length === 0 ? (
                  <div style={{ padding: "12px 14px", borderRadius: 7, background: "rgba(0,255,157,0.05)", border: "1px solid rgba(0,255,157,0.15)", fontSize: 10, color: "#00ff9d" }}>
                    ✅ No issues detected — system is operating cleanly
                  </div>
                ) : (
                  diagnosticsReport.issues.map((issue, i) => (
                    <div key={i} style={{ marginBottom: 8, padding: "10px 14px", borderRadius: 7, background: issue.level === "WARN" ? "rgba(255,69,102,0.06)" : "rgba(255,215,0,0.04)", border: `1px solid ${issue.level === "WARN" ? "rgba(255,69,102,0.2)" : "rgba(255,215,0,0.12)"}` }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 12 }}>{issue.level === "WARN" ? "⚠️" : "ℹ️"}</span>
                        <span style={{ fontSize: 10, color: issue.level === "WARN" ? "#fca5a5" : "#fef3c7", lineHeight: 1.5 }}>{issue.msg}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Card>
                <SectionTitle icon="🌐" label="Data Source Health" />
                {[
                  { label: "1m Candles (Binance REST)", ok: dataStatus.candles, detail: `${candles.length} candles loaded` },
                  { label: "WebSocket Stream", ok: dataStatus.ws, detail: "Live 1m updates" },
                  { label: "Order Book (L2, 20 levels)", ok: dataStatus.orderBook, detail: `${orderBook.bids?.length || 0} bids / ${orderBook.asks?.length || 0} asks` },
                  { label: "Funding Rate (Binance Futures)", ok: dataStatus.fundingRate, detail: fundingRate !== null ? `${(fundingRate * 100).toFixed(4)}%` : "Unavailable" },
                  { label: "Open Interest (Binance Futures)", ok: dataStatus.openInterest, detail: openInterest !== null ? `${(openInterest / 1000).toFixed(1)}K BTC` : "Unavailable" },
                  { label: "Economic Calendar (FF)", ok: dataStatus.news, detail: `${newsData.length} events` },
                ].map(item => (
                  <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "7px 10px", borderRadius: 6, background: item.ok ? "rgba(0,255,157,0.03)" : "rgba(255,69,102,0.04)", border: `1px solid ${item.ok ? "rgba(0,255,157,0.1)" : "rgba(255,69,102,0.15)"}` }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: item.ok ? "#00ff9d" : "#ff4566", flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: item.ok ? "#d1d5db" : "#fca5a5" }}>{item.label}</div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginTop: 1 }}>{item.detail}</div>
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, color: item.ok ? "#00ff9d" : "#ff4566", fontFamily: "'Space Mono', monospace" }}>{item.ok ? "OK" : "FAIL"}</span>
                  </div>
                ))}
                {Object.entries(dataStatus.errors || {}).map(([k, v]) => (
                  <div key={k} style={{ fontSize: 9, color: "#ff4566", marginBottom: 2 }}>Error [{k}]: {v}</div>
                ))}
              </Card>

              <Card>
                <SectionTitle icon="⚙️" label="Engine Status" />
                {[
                  { label: "Market Data Engine", ok: true, detail: "Binance REST + WS" },
                  { label: "Indicators Engine", ok: candles.length >= 60, detail: `${candles.length >= 60 ? "All indicators active" : "Need 60+ candles"}` },
                  { label: "SMC Engine", ok: !!(smcData.bosChoch), detail: `BOS: ${smcData.bosChoch?.bos || "none"} | OB: ${smcData.orderBlocks?.length || 0} | FVG: ${smcData.fvgs?.length || 0}` },
                  { label: "Regime Brain", ok: !!(regime?.regime && regime.regime !== "UNCERTAIN"), detail: regime?.regime || "Detecting..." },
                  { label: "Signal Engine", ok: !!(signal), detail: signal ? `${signal.action} — ${signal.reason?.slice(0, 40)}` : "Waiting" },
                  { label: "Paper Trade Engine", ok: true, detail: `${paperTrades.length} trades | ${paperPositions.length} open` },
                  { label: "Signal Dedup Guard", ok: true, detail: `${paperEngine.seenSignalIds.size} unique IDs tracked` },
                  { label: "Trade Health Engine", ok: true, detail: `3-phase: OBSERVE → HOLD → ACTIVE` },
                ].map(item => (
                  <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "7px 10px", borderRadius: 6, background: item.ok ? "rgba(0,255,157,0.03)" : "rgba(255,69,102,0.04)", border: `1px solid ${item.ok ? "rgba(0,255,157,0.1)" : "rgba(255,69,102,0.15)"}` }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: item.ok ? "#00ff9d" : "#ff4566", flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: "#d1d5db" }}>{item.label}</div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginTop: 1 }}>{item.detail}</div>
                    </div>
                  </div>
                ))}
              </Card>
            </div>

            <Card>
              <SectionTitle icon="🏗️" label="Live Trading Architecture (Phase 12 — Prepared, NOT Active)" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                {[
                  { label: "Exchange Adapter Layer", status: "READY", note: "Interface defined. Delta Exchange adapter stub prepared.", color: "#ffd700" },
                  { label: "Order Manager", status: "STUB", note: "Order lifecycle: NEW → FILLED → CANCELLED. Backend required.", color: "#ffd700" },
                  { label: "Execution Manager", status: "STUB", note: "Bracket order logic prepared. Awaiting backend Node.js server.", color: "#ffd700" },
                  { label: "Reconciliation Manager", status: "STUB", note: "Position reconciliation between bot state and exchange state.", color: "#ffd700" },
                ].map(layer => (
                  <div key={layer.label} style={{ background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.12)", borderRadius: 8, padding: 12 }}>
                    <Badge label={layer.status} color="yellow" />
                    <div style={{ fontSize: 10, color: "#e5e7eb", fontWeight: 600, marginTop: 8, marginBottom: 6 }}>{layer.label}</div>
                    <div style={{ fontSize: 9, color: "#6b7280", lineHeight: 1.5 }}>{layer.note}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, padding: "8px 12px", background: "rgba(255,69,102,0.06)", border: "1px solid rgba(255,69,102,0.15)", borderRadius: 6, fontSize: 10, color: "#fca5a5" }}>
                ⛔ Live trading NOT enabled. Real order placement requires: verified API keys + Node.js backend server + explicit live mode toggle. All stubs are read-only.
              </div>
            </Card>
          </div>
        )}

        {/* ── EXPORTS TAB ── */}
        {activeTab === "exports" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, animation: "slideIn 0.3s ease" }}>
            <Card>
              <SectionTitle icon="💾" label="Export Trade Journal" />
              <div style={{ marginBottom: 16, fontSize: 10, color: "#9ca3af", lineHeight: 1.7 }}>
                Export your paper trading history for external analysis. API secrets are never included in any export.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(0,255,157,0.04)", border: "1px solid rgba(0,255,157,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#00ff9d", marginBottom: 6 }}>📊 Trades — CSV</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>All closed paper trades including entry/exit, PnL breakdown (gross, fees, funding, net), ROI, confidence, session, strategy, regime, and exit reason.</div>
                  <button onClick={() => {
                    const csv = paperEngine.exportCSV();
                    if (!csv) { alert("No closed trades to export."); return; }
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_trades_${Date.now()}.csv`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(0,255,157,0.3)", background: "rgba(0,255,157,0.08)", color: "#00ff9d", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ DOWNLOAD CSV
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(77,184,255,0.04)", border: "1px solid rgba(77,184,255,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#4db8ff", marginBottom: 6 }}>🗂 Full Journal — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Complete export: all trades, full signal log, analytics summary. Suitable for programmatic analysis or archival.</div>
                  <button onClick={() => {
                    const json = paperEngine.exportJSON();
                    const blob = new Blob([json], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_journal_${Date.now()}.json`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(77,184,255,0.3)", background: "rgba(77,184,255,0.08)", color: "#4db8ff", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ DOWNLOAD JSON
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(192,132,252,0.04)", border: "1px solid rgba(192,132,252,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#c084fc", marginBottom: 6 }}>📡 Signal Log — CSV</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>All {signalAnalytics.allSignals} logged signals as CSV including action, direction, confidence, filteredBy, tradedAs, blockedDetails.</div>
                  <button onClick={() => {
                    const log = paperEngine.signalLog;
                    if (!log.length) { alert("Signal log is empty."); return; }
                    const headers = ["signalId","action","direction","strategy","regime","confidence","confidenceLabel","filteredBy","tradedAs","smcOpposed","feeEfficiencyWarning","loggedAt","candleOpenTime","reason"];
                    const rows = log.map(s => [
                      s.signalId, s.action, s.direction||"", s.strategy||"", s.regime||"", s.confidence||0, s.confidenceLabel||"",
                      s.filteredBy||"", s.tradedAs||"", s.smcOpposed?"YES":"NO", s.feeEfficiencyWarning?"YES":"NO",
                      s.loggedAt ? new Date(s.loggedAt).toISOString() : "", s.candleOpenTime ? new Date(s.candleOpenTime).toISOString() : "",
                      `"${(s.reason||"").replace(/"/g,"'")}"`,
                    ]);
                    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_signals_${Date.now()}.csv`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(192,132,252,0.3)", background: "rgba(192,132,252,0.08)", color: "#c084fc", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ SIGNAL LOG CSV
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(192,132,252,0.04)", border: "1px solid rgba(192,132,252,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#c084fc", marginBottom: 6 }}>📡 Signal Log — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>All {signalAnalytics.allSignals} logged signals including WAIT, TRADE, and filtered. Useful for studying signal quality and bot behavior.</div>
                  <button onClick={() => {
                    const settingsSnap = { sizingMode, manualLots, manualLeverage, feeGateMode, patienceMode, paperTradeWatchSignals, unlimitedPaperLearning };
                    const data = JSON.stringify({ exportedAt: new Date().toISOString(), settings: settingsSnap, signals: paperEngine.signalLog }, null, 2);
                    const blob = new Blob([data], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_signals_${Date.now()}.json`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(192,132,252,0.3)", background: "rgba(192,132,252,0.08)", color: "#c084fc", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ SIGNAL LOG JSON
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(255,69,102,0.04)", border: "1px solid rgba(255,69,102,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#ff4566", marginBottom: 6 }}>🚫 Blocked Signals — CSV</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>All TRADE signals that were blocked (PAPER_MODE_OFF, FEE_EFFICIENCY_FAIL, DUPLICATE_SIGNAL, etc.) with full sizing and fee details.</div>
                  <button onClick={() => {
                    const blocked = blockedSignalDetails;
                    if (!blocked.length) { alert("No blocked signals recorded."); return; }
                    const headers = ["signalId","reason","direction","strategy","regime","confidence","lots","leverage","btcQty","entry","sl","tp","notional","totalFee","expectedReward","rewardFeeRatio","timestamp"];
                    const rows = blocked.map(d => [
                      d.signalId, d.reason, d.direction||"", d.strategy||"", d.regime||"", d.confidence||0,
                      d.lots, d.leverage, d.btcQty, d.entry, d.sl||"", d.tp||"",
                      d.notional, d.totalFee, d.expectedReward, d.rewardFeeRatio,
                      d.timestamp ? new Date(d.timestamp).toISOString() : "",
                    ]);
                    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_blocked_${Date.now()}.csv`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(255,69,102,0.3)", background: "rgba(255,69,102,0.08)", color: "#ff4566", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ BLOCKED CSV
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(255,69,102,0.04)", border: "1px solid rgba(255,69,102,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#ff4566", marginBottom: 6 }}>🚫 Blocked Signals — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Blocked signal forensics with settings snapshot. Includes direction, strategy, regime, fee estimate, reward estimate, and exact block reason.</div>
                  <button onClick={() => {
                    const settingsSnap = { sizingMode, manualLots, manualLeverage, feeGateMode, patienceMode, paperTradeWatchSignals, unlimitedPaperLearning, takerFee: CONFIG.TAKER_FEE, makerFee: CONFIG.MAKER_FEE };
                    const data = JSON.stringify({ exportedAt: new Date().toISOString(), settings: settingsSnap, blockedSignals: blockedSignalDetails, allBlockedFromLog: paperEngine.signalLog.filter(s => s.tradedAs === "BLOCKED") }, null, 2);
                    const blob = new Blob([data], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_blocked_${Date.now()}.json`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(255,69,102,0.3)", background: "rgba(255,69,102,0.08)", color: "#ff4566", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ BLOCKED JSON
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#ffd700", marginBottom: 6 }}>📅 Daily Report — CSV</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Per-day breakdown: trades, wins, losses, win rate, gross/net PnL, fees, best/worst strategy. One row per trading day.</div>
                  <button onClick={() => {
                    const reports = paperEngine.getDailyReport();
                    if (!reports || !reports.length) { alert("No daily report data yet."); return; }
                    const headers = ["day","tradesCount","wins","losses","winRate","grossPnL","fees","netPnL","bestStrategy","worstStrategy","earlyExits","laterHitTP","signalsGenerated"];
                    const rows = reports.map(r => [
                      r.day, r.tradesCount, r.wins, r.losses, r.winRate, r.grossPnL, r.fees, r.netPnL,
                      r.bestStrategy||"", r.worstStrategy||"", r.earlyExits||0, r.laterHitTP||0, r.signalsGenerated||0,
                    ]);
                    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_daily_${Date.now()}.csv`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(255,215,0,0.3)", background: "rgba(255,215,0,0.08)", color: "#ffd700", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ DAILY CSV
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#ffd700", marginBottom: 6 }}>📅 Daily Report — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Full daily breakdown with session stats, confidence band performance, and strategy breakdown per day.</div>
                  <button onClick={() => {
                    const reports = paperEngine.getDailyReport();
                    const settingsSnap = { sizingMode, manualLots, manualLeverage, feeGateMode, patienceMode, paperTradeWatchSignals, unlimitedPaperLearning };
                    const data = JSON.stringify({ exportedAt: new Date().toISOString(), settings: settingsSnap, dailyReports: reports }, null, 2);
                    const blob = new Blob([data], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_daily_${Date.now()}.json`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(255,215,0,0.3)", background: "rgba(255,215,0,0.08)", color: "#ffd700", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ DAILY JSON
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(0,255,157,0.04)", border: "1px solid rgba(0,255,157,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#00ff9d", marginBottom: 6 }}>📊 Analytics Summary — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Full analytics: stats, signal analytics, leaderboard, fee impact, confidence calibration, exit style comparison, settings snapshot.</div>
                  <button onClick={() => {
                    const settingsSnap = { sizingMode, manualLots, manualLeverage, feeGateMode, patienceMode, paperTradeWatchSignals, unlimitedPaperLearning, takerFee: CONFIG.TAKER_FEE, makerFee: CONFIG.MAKER_FEE, version: CONFIG.VERSION };
                    const closed = paperEngine.trades.filter(t => t.status === "closed");
                    const data = JSON.stringify({
                      exportedAt: new Date().toISOString(),
                      settings: settingsSnap,
                      stats: paperEngine.getStats(),
                      detailedStats: paperEngine.getDetailedStats(),
                      signalAnalytics: paperEngine.getSignalAnalytics(),
                      leaderboard: paperEngine.getLeaderboard(),
                      feeImpact: paperEngine.getFeeImpact(),
                      calibration: calcConfidenceCalibration(closed),
                      exitStyleComparison: paperEngine.getExitStyleComparison(),
                      postExitAnalytics: paperEngine.getPostExitAnalytics(),
                      dailyReports: paperEngine.getDailyReport(),
                    }, null, 2);
                    const blob = new Blob([data], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_analytics_${Date.now()}.json`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(0,255,157,0.3)", background: "rgba(0,255,157,0.08)", color: "#00ff9d", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ ANALYTICS JSON
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(255,69,102,0.04)", border: "1px solid rgba(255,69,102,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#ff4566", marginBottom: 6 }}>🔍 Diagnostics — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>System diagnostics report: signal dedup checks, stuck trade detection, win rate warnings, engine health summary. No API secrets.</div>
                  <button onClick={() => {
                    const data = JSON.stringify({
                      exportedAt: new Date().toISOString(),
                      version: CONFIG.VERSION,
                      diagnostics: paperEngine.getDiagnosticsReport(),
                      signalAnalytics: paperEngine.getSignalAnalytics(),
                    }, null, 2);
                    const blob = new Blob([data], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_diagnostics_${Date.now()}.json`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(255,69,102,0.3)", background: "rgba(255,69,102,0.08)", color: "#ff4566", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ DOWNLOAD DIAGNOSTICS
                  </button>
                </div>

                <div style={{ padding: "14px 16px", borderRadius: 8, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.15)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#ffd700", marginBottom: 6 }}>🎯 Calibration — JSON</div>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.5 }}>Confidence calibration data: actual vs expected win rates per confidence band. Useful for tuning confidence thresholds. No API secrets.</div>
                  <button onClick={() => {
                    const closed = paperEngine.trades.filter(t => t.status === "closed");
                    const calData = calcConfidenceCalibration(closed);
                    const data = JSON.stringify({
                      exportedAt: new Date().toISOString(),
                      version: CONFIG.VERSION,
                      calibration: calData,
                      closedTradeCount: closed.length,
                    }, null, 2);
                    const blob = new Blob([data], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = `alpha_bot_calibration_${Date.now()}.json`; a.click();
                    URL.revokeObjectURL(url);
                  }} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid rgba(255,215,0,0.3)", background: "rgba(255,215,0,0.08)", color: "#ffd700", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    ⬇ DOWNLOAD CALIBRATION
                  </button>
                </div>
              </div>
            </Card>

            <Card>
              <SectionTitle icon="📋" label="Export Summary" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                <Metric label="Closed Trades" value={paperStats?.total || 0} color="#00ff9d" />
                <Metric label="Signal Log Entries" value={signalAnalytics.allSignals} color="#4db8ff" />
                <Metric label="Total Net PnL" value={formatPnL(paperStats?.totalNetPnL || 0)} color={(paperStats?.totalNetPnL || 0) >= 0 ? "#00ff9d" : "#ff4566"} />
                <Metric label="Win Rate" value={paperStats ? `${paperStats.winRate}%` : "—"} color="#c084fc" />
                <Metric label="Diagnostics Issues" value={diagnosticsReport.issues.length} color={diagnosticsReport.issues.some(i => i.level === "WARN") ? "#ff4566" : "#00ff9d"} />
                <Metric label="Calibration Bands" value={calibration.filter(b => b.count > 0).length + " / 3 active"} color="#ffd700" />
              </div>
              <Divider />
              <div style={{ padding: "10px 12px", background: "rgba(255,69,102,0.05)", border: "1px solid rgba(255,69,102,0.12)", borderRadius: 6 }}>
                <div style={{ fontSize: 9, color: "#fca5a5", lineHeight: 1.7 }}>
                  🔒 <strong>Security guarantee:</strong> API keys and secrets are <strong>never</strong> included in any export. Secret keys are held in memory only and never written to disk or localStorage. All export files contain only trade data, signal metadata, diagnostics, and calibration — zero credentials.
                </div>
              </div>
            </Card>

            {/* ── v34.EL: Cloud Bot Status Panel ── */}
            {cloudConfigured && (
              <Card glow="#4db8ff">
                <SectionTitle icon="☁️" label="Cloud Bot Status" />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginBottom: 12 }}>
                  {[
                    { label: "Bot Status",      value: cloudBotStatus || "UNKNOWN",     color: cloudBotStatus === "RUNNING" ? "#00ff9d" : cloudBotStatus === "PAUSED" ? "#ffd700" : "#ff4566" },
                    { label: "Server Online",   value: cloudBotDetail?.server_online ? "YES" : "OFFLINE", color: cloudBotDetail?.server_online ? "#00ff9d" : "#ff4566" },
                    { label: "Open Positions",  value: cloudBotDetail?.open_positions ?? "—",  color: "#4db8ff" },
                    { label: "Current Regime",  value: cloudBotDetail?.current_regime  || "—", color: "#ffd700" },
                    { label: "Last Analysis",   value: cloudBotDetail?.last_analysis_time ? new Date(cloudBotDetail.last_analysis_time).toLocaleTimeString() : "—", color: "#9ca3af" },
                    { label: "Last Candle",     value: cloudBotDetail?.last_candle_time  ? new Date(cloudBotDetail.last_candle_time).toLocaleTimeString()  : "—", color: "#9ca3af" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontSize: 8, color: "#6b7280", letterSpacing: "0.08em", marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color }}>{String(value)}</div>
                    </div>
                  ))}
                </div>
                {cloudBotDetail?.error_status && (
                  <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(255,69,102,0.08)", border: "1px solid rgba(255,69,102,0.2)", fontSize: 9, color: "#ff4566", marginBottom: 10 }}>
                    ⚠ Backend error: {cloudBotDetail.error_status}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {[{ action: "start", label: "▶ START", color: "#00ff9d" }, { action: "stop", label: "⏹ STOP", color: "#ff4566" }, { action: "pause", label: "⏸ PAUSE", color: "#ffd700" }, { action: "resume", label: "⏵ RESUME", color: "#4db8ff" }].map(btn => (
                    <button key={btn.action} onClick={() => controlCloudBot(btn.action)}
                      style={{ padding: "8px 14px", borderRadius: 6, border: `1px solid ${btn.color}33`, background: `${btn.color}10`, color: btn.color, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.06em" }}>
                      {btn.label}
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {/* ── v34.EL: Engine Logs Panel ── */}
            {cloudConfigured && engineLogs.length > 0 && (
              <Card glow="#374151">
                <SectionTitle icon="📋" label="Engine Logs" />
                <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {engineLogs.map((log, i) => {
                    const levelColor = log.level === "ERROR" ? "#ff4566" : log.level === "TRADE" ? "#00ff9d" : log.level === "WARN" ? "#ffd700" : "#6b7280";
                    return (
                      <div key={log.id || i} style={{ padding: "5px 8px", borderRadius: 4, background: "rgba(255,255,255,0.02)", border: `1px solid ${levelColor}22`, display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ fontSize: 8, fontWeight: 700, color: levelColor, flexShrink: 0, letterSpacing: "0.08em", paddingTop: 1 }}>{log.level}</span>
                        <span style={{ fontSize: 8, color: "#4b5563", flexShrink: 0 }}>{log.created_at ? new Date(log.created_at).toLocaleTimeString() : ""}</span>
                        <span style={{ fontSize: 8, color: "#9ca3af", lineHeight: 1.5 }}>{log.message}</span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ── SETTINGS TAB ── */}
        {activeTab === "settings" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "slideIn 0.3s ease", maxWidth: 900 }}>

            {/* Mode Status Banner */}
            <Card glow="#4db8ff">
              <SectionTitle icon="🖥️" label="System Mode" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                <div style={{ background: "rgba(0,255,157,0.06)", border: "1px solid rgba(0,255,157,0.2)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#00ff9d", marginBottom: 4 }}>PAPER ONLY</div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>Live trading disabled</div>
                </div>
                <div style={{ background: "rgba(255,69,102,0.06)", border: "1px solid rgba(255,69,102,0.2)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#ff4566", marginBottom: 4 }}>LIVE BLOCKED</div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>No real orders</div>
                </div>
                <div style={{ background: "rgba(77,184,255,0.06)", border: "1px solid rgba(77,184,255,0.2)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#4db8ff", marginBottom: 4 }}>v{CONFIG.VERSION}</div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>Phase 5</div>
                </div>
              </div>
            </Card>

            {/* ─── Delta BTCUSD Position Sizing ─── */}
            <Card glow="#4db8ff">
              <SectionTitle icon="📐" label="Delta BTCUSD Position Sizing" />
              <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 10, lineHeight: 1.7 }}>
                1 lot = 0.001 BTC · Notional = lots × 0.001 × BTC price · Leverage only affects margin and ROI, not PnL.
                <span style={{ color: "#ff4566", fontWeight: 700 }}> Leverage does NOT multiply gross PnL.</span>
              </div>

              {/* Pending-change warning */}
              {!settingsApplied && (
                <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6, background: "rgba(255,215,0,0.08)", border: "1px solid rgba(255,215,0,0.35)", fontSize: 9, color: "#ffd700", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14 }}>⚠</span>
                  <span>Changes are <strong>not active</strong> until you click <strong>Apply Settings</strong>. Bot is still using the previously applied values.</span>
                </div>
              )}

              {/* Validation error */}
              {settingsError && (
                <div style={{ marginBottom: 10, padding: "7px 12px", borderRadius: 6, background: "rgba(255,69,102,0.08)", border: "1px solid rgba(255,69,102,0.35)", fontSize: 9, color: "#ff4566" }}>
                  ✕ {settingsError}
                </div>
              )}

              {/* Sizing Mode Toggle — edits draft */}
              <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6, fontWeight: 700 }}>Sizing Mode (draft)</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {[{ id: "auto", label: "Auto (ATR-based)", color: "#00ff9d" }, { id: "manual", label: "Manual Lots", color: "#4db8ff" }].map(m => (
                  <button key={m.id} onClick={() => { setDraftSizingMode(m.id); setSettingsApplied(false); setSettingsError(null); }}
                    style={{ flex: 1, padding: "9px 0", borderRadius: 6, border: draftSizingMode === m.id ? `1px solid ${m.color}55` : "1px solid rgba(255,255,255,0.08)", background: draftSizingMode === m.id ? `${m.color}11` : "transparent", color: draftSizingMode === m.id ? m.color : "#6b7280", fontSize: 10, fontWeight: draftSizingMode === m.id ? 700 : 400, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.06em" }}>
                    {m.label}
                  </button>
                ))}
              </div>

              {draftSizingMode === "manual" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                  {/* Lots — draft */}
                  <div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Lots (integer ≥ 1) — draft</div>
                    <input
                      type="number" min={1} step={1}
                      value={draftLots}
                      onChange={e => { setDraftLots(Math.max(1, Math.floor(Number(e.target.value)))); setSettingsApplied(false); setSettingsError(null); }}
                      style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(77,184,255,0.3)", borderRadius: 6, padding: "8px 10px", color: "#4db8ff", fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono', monospace", outline: "none" }}
                    />
                  </div>
                  {/* Leverage — draft */}
                  <div>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Leverage (1×–200×) — draft</div>
                    <input
                      type="number" min={1} max={200} step={1}
                      value={draftLeverage}
                      onChange={e => { setDraftLeverage(Math.min(200, Math.max(1, Math.floor(Number(e.target.value))))); setSettingsApplied(false); setSettingsError(null); }}
                      style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: `1px solid ${draftLeverage > 100 ? "rgba(255,69,102,0.5)" : draftLeverage > 50 ? "rgba(255,215,0,0.4)" : "rgba(77,184,255,0.3)"}`, borderRadius: 6, padding: "8px 10px", color: draftLeverage > 100 ? "#ff4566" : draftLeverage > 50 ? "#ffd700" : "#4db8ff", fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono', monospace", outline: "none" }}
                    />
                    {draftLeverage > 100 && <div style={{ fontSize: 9, color: "#ff4566", marginTop: 4, fontWeight: 700 }}>🔴 DANGER: Above 100× — extreme liquidation risk.</div>}
                    {draftLeverage > 50 && draftLeverage <= 100 && <div style={{ fontSize: 9, color: "#ffd700", marginTop: 4 }}>⚠ WARNING: Above 50× — high liquidation risk.</div>}
                  </div>
                </div>
              )}

              {/* Apply Settings button */}
              <button
                onClick={handleApplySettings}
                style={{ width: "100%", marginBottom: 8, padding: "11px 0", borderRadius: 7, border: settingsApplied ? "1px solid rgba(0,255,157,0.2)" : "1px solid rgba(0,255,157,0.5)", background: settingsApplied ? "rgba(0,255,157,0.04)" : "rgba(0,255,157,0.12)", color: settingsApplied ? "#6b7280" : "#00ff9d", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", transition: "all 0.15s" }}>
                {settingsApplied ? "✓ SETTINGS APPLIED" : "▶ APPLY SETTINGS"}
              </button>
              <button
                onClick={handleResetBehaviorSettings}
                style={{ width: "100%", marginBottom: 16, padding: "9px 0", borderRadius: 7, border: "1px solid rgba(255,69,102,0.25)", background: "rgba(255,69,102,0.05)", color: "#ff4566", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                ↺ RESET ALL SETTINGS TO DEFAULTS
              </button>

              {/* ── v26: Push Notification Settings ── */}
              <div style={{ marginBottom: 16, padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.08em", marginBottom: 10 }}>🔔 PUSH NOTIFICATIONS</div>
                {notifications.permission !== "granted" ? (
                  <button onClick={() => notifications.requestPermission()}
                    style={{ width: "100%", padding: "9px 0", borderRadius: 6, border: "1px solid rgba(0,255,157,0.3)", background: "rgba(0,255,157,0.08)", color: "#00ff9d", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em", marginBottom: 10 }}>
                    🔔 ENABLE NOTIFICATIONS
                  </button>
                ) : (
                  <div style={{ fontSize: 9, color: "#00ff9d", marginBottom: 10 }}>✓ Notifications enabled</div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {[
                    { key: "tradeOpened",   label: "Trade Opened" },
                    { key: "tradeClosed",   label: "Trade Closed" },
                    { key: "tpHit",         label: "TP Hit" },
                    { key: "slHit",         label: "SL Hit" },
                    { key: "botStopped",    label: "Bot Stopped" },
                    { key: "signalAlert",   label: "Signal Alert" },
                    { key: "criticalError", label: "Errors" },
                  ].map(({ key, label }) => (
                    <div key={key} onClick={() => notifications.setPref(key, !notifications.prefs[key])}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 5, background: "rgba(255,255,255,0.02)", border: `1px solid ${notifications.prefs[key] ? "rgba(0,255,157,0.2)" : "rgba(255,255,255,0.05)"}`, cursor: "pointer" }}>
                      <div style={{ width: 28, height: 16, borderRadius: 8, background: notifications.prefs[key] ? "#00ff9d" : "rgba(255,255,255,0.1)", position: "relative", flexShrink: 0, transition: "background 0.2s" }}>
                        <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff", position: "absolute", top: 1, left: notifications.prefs[key] ? 13 : 1, transition: "left 0.2s" }} />
                      </div>
                      <span style={{ fontSize: 8, color: notifications.prefs[key] ? "#d1fae5" : "#6b7280", letterSpacing: "0.06em" }}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: 14, padding: "6px 10px", borderRadius: 5, background: "rgba(77,184,255,0.04)", border: "1px solid rgba(77,184,255,0.1)", fontSize: 8, color: "#4b5563" }}>
                Settings source: <span style={{ color: "#4db8ff" }}>localStorage ({CONFIG.LS_SIZING} · {CONFIG.LS_BEHAVIOR})</span>
              </div>

              {/* Applied config display */}
              <div style={{ background: "rgba(0,255,157,0.04)", border: "1px solid rgba(0,255,157,0.15)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 9, color: "#00ff9d", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10, fontWeight: 700 }}>⚡ Active Bot Configuration</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                  {[
                    { l: "Sizing Mode",    v: sizingMode.toUpperCase(),    c: sizingMode === "manual" ? "#4db8ff" : "#00ff9d" },
                    { l: "Applied Lots",   v: sizingMode === "manual" ? manualLots : "ATR-auto",    c: "#4db8ff" },
                    { l: "Applied Leverage", v: sizingMode === "manual" ? `${manualLeverage}×` : `${CONFIG.LEVERAGE}× (default)`, c: manualLeverage > 100 ? "#ff4566" : manualLeverage > 50 ? "#ffd700" : "#4db8ff" },
                  ].map(({ l, v, c }) => (
                    <div key={l} style={{ background: "rgba(255,255,255,0.025)", borderRadius: 6, padding: "8px 10px" }}>
                      <div style={{ fontSize: 8, color: "#6b7280", marginBottom: 3 }}>{l}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: c, fontFamily: "'Space Mono', monospace" }}>{v}</div>
                    </div>
                  ))}
                </div>
                {sizingMode === "manual" && sizingPreview && (
                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                    {[
                      { l: "BTC Qty",      v: `${sizingPreview.btcQty.toFixed(5)} BTC`,  c: "#e5e7eb", note: `= ${manualLots} lots × 0.001` },
                      { l: "Notional",     v: `$${sizingPreview.notionalUSDT.toFixed(2)}`, c: "#e5e7eb", note: "= btcQty × price" },
                      { l: "Margin",       v: `$${sizingPreview.marginUsed.toFixed(2)}`,   c: "#ffd700", note: `= notional / ${manualLeverage}×` },
                      { l: "Entry Fee",    v: `$${sizingPreview.entryFee.toFixed(4)}`,      c: "#ff4566", note: "taker" },
                      { l: "Exit Fee",     v: `$${sizingPreview.exitFee.toFixed(4)}`,       c: "#ff4566", note: "taker" },
                      { l: "Round-Trip Fee", v: `$${sizingPreview.totalFee.toFixed(4)}`,   c: "#ff4566", note: "entry + exit" },
                    ].map(({ l, v, c, note }) => (
                      <div key={l} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 5, padding: "7px 9px" }}>
                        <div style={{ fontSize: 8, color: "#6b7280", marginBottom: 1 }}>{l}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: c, fontFamily: "'Space Mono', monospace" }}>{v}</div>
                        {note && <div style={{ fontSize: 7, color: "#374151", marginTop: 1 }}>{note}</div>}
                      </div>
                    ))}
                  </div>
                )}
                {sizingMode === "auto" && sizingPreview && (
                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                    {[
                      { l: "BTC Qty",     v: `${sizingPreview.btcQty.toFixed(5)} BTC`,    c: "#e5e7eb" },
                      { l: "Notional",    v: `$${sizingPreview.notionalUSDT.toFixed(2)}`,  c: "#e5e7eb" },
                      { l: "Margin",      v: `$${sizingPreview.marginUsed.toFixed(2)}`,    c: "#ffd700" },
                      { l: "Entry Fee",   v: `$${sizingPreview.entryFee.toFixed(4)}`,      c: "#ff4566" },
                      { l: "Exit Fee",    v: `$${sizingPreview.exitFee.toFixed(4)}`,       c: "#ff4566" },
                      { l: "Round-Trip",  v: `$${sizingPreview.totalFee.toFixed(4)}`,      c: "#ff4566" },
                    ].map(({ l, v, c }) => (
                      <div key={l} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 5, padding: "7px 9px" }}>
                        <div style={{ fontSize: 8, color: "#6b7280", marginBottom: 1 }}>{l}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: c, fontFamily: "'Space Mono', monospace" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                )}
                {!sizingPreview && (
                  <div style={{ marginTop: 8, fontSize: 9, color: "#374151" }}>Fee preview appears when a trade signal is active.</div>
                )}
              </div>

              {/* Old live preview removed — now shown inside Applied Config above */}

            </Card>

            {/* ─── v34.EL: Strategy Enable/Disable Toggles ─── */}
            <Card glow="#ff4566">
              <SectionTitle icon="🔒" label="Strategy Auto-Trading Locks" />
              <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 7, background: "rgba(255,69,102,0.07)", border: "1px solid rgba(255,69,102,0.25)", fontSize: 9, color: "#fca5a5", lineHeight: 1.7 }}>
                ⚠ <strong>EMERGENCY LOCK ACTIVE</strong> — TREND is disabled by default (47 trades, 6.4% WR).
                Disabled strategies become <strong>WATCH-only</strong>; signals are still logged but no paper trade opens.
                Re-enable only after performance recovers.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                {[
                  { key: "TREND",    label: "TREND",    icon: "📈", desc: "EMA stack + MACD + ADX + BOS",      dangerColor: "#ff4566" },
                  { key: "RANGE",    label: "RANGE",    icon: "↔️",  desc: "RSI mean-reversion + BB band",      dangerColor: "#4db8ff" },
                  { key: "BREAKOUT", label: "BREAKOUT", icon: "⚡", desc: "Swing high/low break + volume",    dangerColor: "#ffd700" },
                  { key: "REVERSAL", label: "REVERSAL", icon: "🔄", desc: "Liquidity sweep + CHoCH + OB/FVG", dangerColor: "#c084fc" },
                ].map(({ key, label, icon, desc, dangerColor }) => {
                  const isOn = strategyToggles[key];
                  return (
                    <div key={key} style={{ padding: "12px 14px", borderRadius: 8, background: isOn ? `${dangerColor}0d` : "rgba(255,69,102,0.05)", border: `1px solid ${isOn ? dangerColor + "44" : "rgba(255,69,102,0.2)"}`, display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: isOn ? dangerColor : "#6b7280" }}>{icon} {label}</div>
                          <div style={{ fontSize: 8, color: "#6b7280", marginTop: 2 }}>{desc}</div>
                        </div>
                        <div
                          onClick={() => {
                            const next = { ...strategyToggles, [key]: !isOn };
                            setStrategyToggles(next);
                            strategyTogglesRef.current = next;
                            try { localStorage.setItem(CONFIG.LS_STRATEGY_TOGGLES, JSON.stringify(next)); } catch {}
                            try { syncSetting("strategyToggles", next); } catch {}
                          }}
                          style={{ width: 40, height: 22, borderRadius: 11, background: isOn ? dangerColor : "rgba(255,255,255,0.1)", cursor: "pointer", position: "relative", transition: "background 0.2s", border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 }}>
                          <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 1, left: isOn ? 19 : 1, transition: "left 0.2s" }} />
                        </div>
                      </div>
                      <div style={{ fontSize: 9, fontWeight: 700, color: isOn ? dangerColor : "#ff4566", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        {isOn ? "🟢 AUTO-TRADING ON" : "🔴 WATCH ONLY"}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ padding: "8px 12px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", fontSize: 9, color: "#6b7280", lineHeight: 1.6 }}>
                Auto-blocked strategies: signals are still generated and logged. They appear as WATCH with reason
                <span style={{ color: "#ffd700" }}> STRATEGY_DISABLED</span>.
                Signals resume trading automatically when toggled back ON.
              </div>
            </Card>

            {/* ─── v34.EL: Performance-Based Auto-Blocks (read-only status) ─── */}
            <Card>
              <SectionTitle icon="📊" label="Auto-Block Status (Performance Gates)" />
              <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 10, lineHeight: 1.6 }}>
                These blocks are <strong>automatic</strong> and cannot be toggled. They activate when data meets the threshold.
              </div>
              {(() => {
                const closed = paperEngine.trades.filter(t => t.status === "closed");
                const strategies = ["TREND", "RANGE", "BREAKOUT", "REVERSAL"];
                const sessions = ["ASIA", "LONDON", "NEW_YORK", "OFF"];
                const stratBlocks = strategies.map(s => ({ name: s, ...checkStrategyPerformanceBlock(s, closed) }));
                const sessBlocks = sessions.map(s => ({ name: s, ...checkSessionAutoBlock(s, closed) }));
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                      Strategy Performance ({CONFIG.STRATEGY_POOR_WR_TRADES}+ trades, WR &lt; {CONFIG.STRATEGY_POOR_WR_THRESHOLD}%)
                    </div>
                    {stratBlocks.map(b => (
                      <div key={b.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", borderRadius: 6, background: b.blocked ? "rgba(255,69,102,0.06)" : "rgba(0,255,157,0.04)", border: `1px solid ${b.blocked ? "rgba(255,69,102,0.2)" : "rgba(0,255,157,0.1)"}` }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: b.blocked ? "#ff4566" : "#00ff9d", flexShrink: 0 }} />
                        <span style={{ fontSize: 10, color: b.blocked ? "#ff4566" : "#9ca3af", fontWeight: b.blocked ? 700 : 400, flex: 1 }}>
                          {b.name} {b.blocked ? `— ${b.reason}` : "— OK"}
                        </span>
                      </div>
                    ))}
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 6, marginBottom: 4 }}>
                      Session Performance ({CONFIG.SESSION_POOR_TRADES}+ trades, WR &lt; {CONFIG.SESSION_POOR_WR_THRESHOLD}%)
                    </div>
                    {sessBlocks.map(b => (
                      <div key={b.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", borderRadius: 6, background: b.blocked ? "rgba(255,69,102,0.06)" : "rgba(0,255,157,0.04)", border: `1px solid ${b.blocked ? "rgba(255,69,102,0.2)" : "rgba(0,255,157,0.1)"}` }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: b.blocked ? "#ff4566" : "#00ff9d", flexShrink: 0 }} />
                        <span style={{ fontSize: 10, color: b.blocked ? "#ff4566" : "#9ca3af", fontWeight: b.blocked ? 700 : 400, flex: 1 }}>
                          {b.name} {b.blocked ? `— ${b.reason}` : "— OK"}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </Card>

            {/* Paper Trade Patience */}
            <Card>
              <SectionTitle icon="⏳" label="Paper Trade Patience Mode" />
              <div style={{ marginBottom: 10, fontSize: 10, color: "#6b7280", lineHeight: 1.6 }}>
                Controls how long the bot holds paper trades before allowing health-based exits.
                Patient mode requires 5+ closed candles. Swing Test never exits on health.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                {[
                  { id: "CONSERVATIVE", label: "Conservative", sub: "3 candles", color: "#ff4566" },
                  { id: "NORMAL", label: "Normal", sub: "3 candles", color: "#ffd700" },
                  { id: "PATIENT", label: "Patient ★", sub: "5 candles", color: "#00ff9d" },
                  { id: "SWING_TEST", label: "Swing Test", sub: "SL/TP only", color: "#c084fc" },
                ].map(p => (
                  <button key={p.id} onClick={() => { setPatienceMode(p.id); patienceModeRef.current = p.id; saveBehaviorSettings({ patienceMode: p.id }); }}
                    style={{ padding: "10px 8px", borderRadius: 7, border: patienceMode === p.id ? `1px solid ${p.color}44` : "1px solid rgba(255,255,255,0.08)", background: patienceMode === p.id ? `${p.color}11` : "transparent", cursor: "pointer", textAlign: "center" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: patienceMode === p.id ? p.color : "#9ca3af", marginBottom: 3 }}>{p.label}</div>
                    <div style={{ fontSize: 9, color: "#6b7280" }}>{p.sub}</div>
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, background: "rgba(255,255,255,0.02)", fontSize: 9, color: "#6b7280" }}>
                Active: <span style={{ color: "#c084fc", fontWeight: 700 }}>{patienceMode}</span> —
                {patienceMode === "CONSERVATIVE" && " Health exit after 3 candles on any significant weakness signal."}
                {patienceMode === "NORMAL" && " Health exit after 3 candles on moderate/strong signals."}
                {patienceMode === "PATIENT" && " Health exit only after 5 closed candles with strong evidence (ATR-filtered)."}
                {patienceMode === "SWING_TEST" && " No health exit — runs until SL or TP only. Best for learning true RR potential."}
              </div>
            </Card>

            {/* Unlimited Paper Learning */}
            <Card>
              <SectionTitle icon="📚" label="Paper Learning Limits" />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#e5e7eb", fontWeight: 700, marginBottom: 3 }}>Unlimited Paper Learning</div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>When ON: no daily trade limit, no consecutive loss lock, no daily loss lock in paper mode.</div>
                </div>
                <div onClick={() => { const v = !unlimitedPaperLearning; setUnlimitedPaperLearning(v); unlimitedPaperLearningRef.current = v; saveBehaviorSettings({ unlimitedPaperLearning: v }); }}
                  style={{ width: 40, height: 22, borderRadius: 11, background: unlimitedPaperLearning ? "#00ff9d" : "rgba(255,255,255,0.1)", cursor: "pointer", position: "relative", transition: "background 0.2s", border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 }}>
                  <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 1, left: unlimitedPaperLearning ? 19 : 1, transition: "left 0.2s" }} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div style={{ padding: "8px 12px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>Paper Risk Locks</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: unlimitedPaperLearning ? "#00ff9d" : "#ffd700" }}>{unlimitedPaperLearning ? "OFF" : "ON"}</div>
                </div>
                <div style={{ padding: "8px 12px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>Live Risk Locks</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#ff4566" }}>ALWAYS ON</div>
                </div>
              </div>
            </Card>

            {/* Watch Signal Paper Trading */}
            <Card>
              <SectionTitle icon="👁️" label="Watch Signal Paper Trading" />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#e5e7eb", fontWeight: 700, marginBottom: 3 }}>Trade WATCH Signals (75–84% conf)</div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>Default OFF. When ON: 75–84% signals open paper trades tagged WATCH_PAPER. NOT counted in main performance.</div>
                </div>
                <div onClick={() => { const v = !paperTradeWatchSignals; setPaperTradeWatchSignals(v); paperTradeWatchSignalsRef.current = v; saveBehaviorSettings({ paperTradeWatchSignals: v }); }}
                  style={{ width: 40, height: 22, borderRadius: 11, background: paperTradeWatchSignals ? "#ffd700" : "rgba(255,255,255,0.1)", cursor: "pointer", position: "relative", transition: "background 0.2s", border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 }}>
                  <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 1, left: paperTradeWatchSignals ? 19 : 1, transition: "left 0.2s" }} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, fontSize: 9, color: "#6b7280" }}>
                {[["Main Tradable", "≥85% conf"], ["Watch Paper", "75–84% (opt)"], ["Filtered Signals", "Blocked"], ["All Signals", "Full log"]].map(([k,v]) => (
                  <div key={k} style={{ padding: "6px 8px", borderRadius: 5, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                    <div style={{ color: "#9ca3af", marginBottom: 2 }}>{k}</div>
                    <div style={{ color: "#4db8ff", fontWeight: 700 }}>{v}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Health Exit Mode summary */}
            <Card>
              <SectionTitle icon="💚" label="Health Exit Mode" />
              <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.7 }}>
                <div style={{ marginBottom: 6 }}>ATR candle significance filter (v30):</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                  {[["< 0.25 ATR", "Ignore", "#6b7280"], ["0.25–0.50 ATR", "Minor warn", "#ffd700"], ["0.50–1.0 ATR", "Moderate", "#fb923c"], ["> 1.0 ATR", "Strong", "#ff4566"]].map(([r, l, c]) => (
                    <div key={r} style={{ padding: "6px 8px", borderRadius: 5, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", textAlign: "center" }}>
                      <div style={{ color: c, fontSize: 10, fontWeight: 700, marginBottom: 2 }}>{l}</div>
                      <div style={{ color: "#6b7280", fontSize: 9 }}>{r}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", fontSize: 9 }}>
                  Health exit requires: 2–3 confirmed weakness signals, OR 2 consecutive opposite candles (confirmed), OR major structural invalidation (opposite BOS/CHoCH + EMA21 loss + 2x ATR adverse).
                </div>
              </div>
            </Card>

            {/* Fee Efficiency Gate Mode */}
            <Card>
              <SectionTitle icon="💸" label="Fee Efficiency Gate" />
              <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 12, lineHeight: 1.7 }}>
                Checks whether expected reward covers at least 3× the round-trip taker fee.
                <span style={{ color: "#4db8ff" }}> Fees are always included in final PnL regardless of this setting.</span>
                {" "}This gate is a <em>quality filter</em> — not mandatory for paper trading.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
                {[
                  { id: "OFF",        label: "OFF",        sub: "Skip fee check",          color: "#6b7280" },
                  { id: "WARN_ONLY",  label: "WARN ONLY",  sub: "Trade + warn badge ★",    color: "#ffd700" },
                  { id: "HARD_BLOCK", label: "HARD BLOCK", sub: "Block trade entirely",     color: "#ff4566" },
                ].map(m => (
                  <button key={m.id} onClick={() => { setFeeGateMode(m.id); feeGateModeRef.current = m.id; saveBehaviorSettings({ feeGateMode: m.id }); }}
                    style={{ padding: "10px 8px", borderRadius: 7, border: feeGateMode === m.id ? `1px solid ${m.color}55` : "1px solid rgba(255,255,255,0.08)", background: feeGateMode === m.id ? `${m.color}14` : "transparent", cursor: "pointer", textAlign: "center" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: feeGateMode === m.id ? m.color : "#9ca3af", marginBottom: 3 }}>{m.label}</div>
                    <div style={{ fontSize: 9, color: "#6b7280" }}>{m.sub}</div>
                  </button>
                ))}
              </div>
              <div style={{ padding: "8px 12px", borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", fontSize: 9, color: "#9ca3af", lineHeight: 1.6 }}>
                Active: <span style={{ fontWeight: 700, color: feeGateMode === "OFF" ? "#6b7280" : feeGateMode === "WARN_ONLY" ? "#ffd700" : "#ff4566" }}>{feeGateMode}</span>
                {feeGateMode === "OFF"        && " — No fee check. All TRADE signals execute regardless of fee efficiency."}
                {feeGateMode === "WARN_ONLY"  && " — Default. Paper trade opens normally. A 'Fee efficiency weak' badge appears on the signal and the trade record carries feeEfficiencyWarning=true."}
                {feeGateMode === "HARD_BLOCK" && " — Signal is downgraded to WATCH and paper trade is blocked. tradedAs = BLOCKED. Use only when you want strict fee filtering."}
              </div>
              <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, background: "rgba(77,184,255,0.05)", border: "1px solid rgba(77,184,255,0.15)", fontSize: 9, color: "#9ca3af", lineHeight: 1.6 }}>
                ℹ️ <span style={{ color: "#4db8ff", fontWeight: 700 }}>Why fees don't need to be gated:</span> All paper trades already deduct entry + exit taker fees ({(CONFIG.TAKER_FEE * 100).toFixed(2)}% each side) from final net PnL. A fee-inefficient trade still shows its true result — it just has a smaller reward-to-fee ratio.
              </div>
            </Card>

            {/* WebSocket Status */}
            <Card>
              <SectionTitle icon="🔌" label="WebSocket / Data Status" />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 6, background: dataStatus.ws ? "rgba(0,255,157,0.04)" : "rgba(255,69,102,0.04)", border: `1px solid ${dataStatus.ws ? "rgba(0,255,157,0.1)" : "rgba(255,69,102,0.2)"}` }}>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>WebSocket</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: dataStatus.ws ? "#00ff9d" : "#ff4566" }}>{dataStatus.wsStatus || "UNKNOWN"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 6, background: "rgba(0,255,157,0.04)", border: "1px solid rgba(0,255,157,0.1)" }}>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>REST Fallback</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#00ff9d" }}>ACTIVE</span>
                </div>
                {dataStatus.wsReconnectAttempts > 0 && (
                  <div style={{ padding: "6px 12px", borderRadius: 6, background: "rgba(255,215,0,0.04)", border: "1px solid rgba(255,215,0,0.15)", fontSize: 9, color: "#ffd700" }}>
                    Reconnect attempts: {dataStatus.wsReconnectAttempts} / {20}
                  </div>
                )}
                {lastCandleTime && (
                  <div style={{ fontSize: 9, color: "#6b7280" }}>Last candle update: {new Date(lastCandleTime).toLocaleTimeString()}</div>
                )}
              </div>
            </Card>

          </div>
        )}

        {/* ── EXCHANGE TAB ── */}
        {activeTab === "exchange" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, animation: "slideIn 0.3s ease" }}>

            {/* Delta API Settings */}
            <Card>
              <SectionTitle icon="🔑" label="Delta Exchange API Settings" />
              <div style={{ marginBottom: 16 }}>
                <div style={{ background: "rgba(255,165,0,0.06)", border: "1px solid rgba(255,165,0,0.15)", borderRadius: 6, padding: 12, marginBottom: 16, fontSize: 9, color: "#fbbf24", lineHeight: 1.7 }}>
                  ⚠ API Secret is never logged, exported, or displayed in the UI. It is held in memory only unless "Remember Keys" is enabled, in which case only the API Key (not Secret) is stored locally.<br />
                  <span style={{ color: "#fb923c", fontWeight: 700 }}>🔒 BROWSER LIMITATION: Real API verification requires the Node.js backend server. This browser app cannot directly call Delta Exchange due to CORS + HMAC constraints.</span>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>API Key</div>
                  <input
                    type="text"
                    value={deltaApiKey}
                    onChange={e => setDeltaApiKey(e.target.value)}
                    placeholder="Paste your Delta API key here"
                    style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "8px 12px", color: "#e5e7eb", fontSize: 10, fontFamily: "'Space Mono', monospace", outline: "none" }}
                  />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>API Secret</div>
                  <input
                    type="password"
                    value={deltaApiSecret}
                    onChange={e => setDeltaApiSecret(e.target.value)}
                    placeholder="••••••••••••••••••••••••"
                    style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "8px 12px", color: "#e5e7eb", fontSize: 10, fontFamily: "'Space Mono', monospace", outline: "none" }}
                  />
                  <div style={{ fontSize: 8, color: "#4b5563", marginTop: 4 }}>Secret is masked and never exposed in logs or exports.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: "#6b7280", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Product</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {["BTCUSD", "ETHUSD"].map(p => (
                      <button key={p} onClick={() => setDeltaProduct(p)}
                        style={{ padding: "5px 14px", borderRadius: 4, border: deltaProduct === p ? "1px solid #4db8ff44" : "1px solid rgba(255,255,255,0.08)", background: deltaProduct === p ? "rgba(77,184,255,0.1)" : "transparent", color: deltaProduct === p ? "#4db8ff" : "#6b7280", fontSize: 10, cursor: "pointer", fontFamily: "'Space Mono', monospace", fontWeight: deltaProduct === p ? 700 : 400 }}>
                        {p} {p === "BTCUSD" ? "(default)" : ""}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <div
                    onClick={() => setDeltaRememberKeys(!deltaRememberKeys)}
                    style={{ width: 32, height: 18, borderRadius: 9, background: deltaRememberKeys ? "#4db8ff" : "rgba(255,255,255,0.1)", cursor: "pointer", position: "relative", transition: "background 0.2s", border: "1px solid rgba(255,255,255,0.1)" }}>
                    <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff", position: "absolute", top: 1, left: deltaRememberKeys ? 15 : 1, transition: "left 0.2s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>Remember API Key (Secret never stored)</span>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={handleDeltaTestConnection} disabled={deltaTestLoading}
                    style={{ flex: 1, padding: "9px 0", borderRadius: 6, border: "1px solid rgba(77,184,255,0.3)", background: deltaTestLoading ? "rgba(255,255,255,0.03)" : "rgba(77,184,255,0.08)", color: deltaTestLoading ? "#6b7280" : "#4db8ff", fontSize: 10, fontWeight: 700, cursor: deltaTestLoading ? "not-allowed" : "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    {deltaTestLoading ? "⏳ TESTING..." : "🔗 TEST CONNECTION (BACKEND REQUIRED)"}
                  </button>
                  <button onClick={handleSaveDeltaSettings}
                    style={{ flex: 1, padding: "9px 0", borderRadius: 6, border: "1px solid rgba(0,255,157,0.2)", background: "rgba(0,255,157,0.06)", color: "#00ff9d", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em" }}>
                    💾 SAVE
                  </button>
                  <button onClick={handleClearDeltaSettings}
                    style={{ padding: "9px 14px", borderRadius: 6, border: "1px solid rgba(255,69,102,0.2)", background: "rgba(255,69,102,0.06)", color: "#ff4566", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "'Space Mono', monospace" }}>
                    🗑
                  </button>
                </div>
              </div>
            </Card>

            {/* Connection Status + Live Mode Safety */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Card>
                <SectionTitle icon="📡" label="Connection Status" />
                {deltaConnectionStatus ? (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "10px 14px", borderRadius: 6, background: deltaConnectionStatus.ok ? "rgba(0,255,157,0.06)" : "rgba(255,69,102,0.06)", border: `1px solid ${deltaConnectionStatus.ok ? "rgba(0,255,157,0.2)" : "rgba(255,69,102,0.2)"}` }}>
                      <span style={{ fontSize: 16 }}>{deltaConnectionStatus.ok ? "✅" : "❌"}</span>
                      <span style={{ color: deltaConnectionStatus.ok ? "#00ff9d" : "#ff4566", fontSize: 11, fontWeight: 700 }}>
                        {deltaConnectionStatus.ok ? "CONNECTED" : "CONNECTION FAILED"}
                      </span>
                    </div>
                    {deltaConnectionStatus.error && (
                      <div style={{ fontSize: 10, color: "#ff4566", marginBottom: 12, lineHeight: 1.6 }}>{deltaConnectionStatus.error}</div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Metric label="API Status" value={deltaConnectionStatus.apiStatus || "UNVERIFIED"} color={deltaConnectionStatus.ok ? "#00ff9d" : "#ff4566"} />
                      <Metric label="Balance" value={deltaConnectionStatus.balance !== null ? `$${deltaConnectionStatus.balance}` : "N/A"} />
                      <Metric label="Product ID" value={deltaConnectionStatus.productId || deltaProduct} color="#4db8ff" />
                      <Metric label="Positions" value={deltaConnectionStatus.positions !== null ? String(deltaConnectionStatus.positions) : "N/A"} />
                      <Metric label="Funding" value={deltaConnectionStatus.funding !== null ? deltaConnectionStatus.funding : "N/A"} />
                    </div>
                  </div>
                ) : (
                  <div style={{ color: "#374151", fontSize: 11, padding: "30px 0", textAlign: "center" }}>
                    Enter credentials and click Test Connection.
                  </div>
                )}
              </Card>

              {/* Live Mode Safety Panel */}
              <Card glow={apiVerified ? "#00ff9d" : "#ff4566"}>
                <SectionTitle icon="🛡️" label="Live Mode Safety" />
                <div style={{ marginBottom: 14 }}>
                  {!apiVerified ? (
                    <div style={{ background: "rgba(255,69,102,0.08)", border: "1px solid rgba(255,69,102,0.2)", borderRadius: 8, padding: 16 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#ff4566", letterSpacing: "0.05em", marginBottom: 8 }}>⛔ LIVE MODE BLOCKED</div>
                      <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.7 }}>API NOT VERIFIED</div>
                      <div style={{ fontSize: 10, color: "#6b7280", marginTop: 6, lineHeight: 1.7 }}>
                        Live trading will remain disabled until:<br />
                        ✗ API test passes<br />
                        ✗ Product validation passes<br /><br />
                        Bot is currently running in Paper mode.
                      </div>
                    </div>
                  ) : (
                    <div style={{ background: "rgba(0,255,157,0.06)", border: "1px solid rgba(0,255,157,0.2)", borderRadius: 8, padding: 16 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#00ff9d", letterSpacing: "0.05em", marginBottom: 8 }}>✅ LIVE TRADING ENABLED</div>
                      <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.7 }}>
                        API verified. Product: {deltaProduct}.<br />
                        Orders will be submitted to Delta Exchange India.
                      </div>
                    </div>
                  )}
                </div>
                <Divider />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Metric label="Paper Mode" value="ACTIVE" color="#00ff9d" sub="Always running" />
                  <Metric label="Live Mode" value={apiVerified ? "ACTIVE" : "BLOCKED"} color={apiVerified ? "#00ff9d" : "#ff4566"} />
                  <Metric label="Execution" value={apiVerified ? `Delta (${deltaProduct})` : "Paper Only"} color={apiVerified ? "#4db8ff" : "#6b7280"} />
                  <Metric label="Backend" value="Required for live" color="#ffd700" sub="Node.js server" />
                </div>
              </Card>

              {/* Execution Source Status */}
              <Card>
                <SectionTitle icon="🌐" label="Execution Source" />
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {[
                    { label: "Chart Source", value: "TradingView", color: "#4db8ff" },
                    { label: "Market Data", value: "Binance", color: "#00ff9d" },
                    { label: "Execution", value: apiVerified ? "Delta Exchange" : "Paper Only", color: apiVerified ? "#00ff9d" : "#6b7280" },
                  ].map(row => (
                    <div key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.05)" }}>
                      <span style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em" }}>{row.label}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: row.color, fontFamily: "'Space Mono', monospace" }}>{row.value}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
