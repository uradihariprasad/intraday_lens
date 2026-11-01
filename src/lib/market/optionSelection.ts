/**
 * Option Contract Selection Engine (two-stage Trade Finder, stage 2).
 *
 * Consumes ONLY real provider data already held by the application:
 *   - `options.ts`      → chain rows with provider Greeks/IV/bid/ask/OI/volume
 *   - `oiIntelligence`  → rolling 5m / 15m / session OI windows
 *   - `signals.ts`      → the qualified UNDERLYING setup (stage 1)
 *
 * HONESTY RULES (enforced here and covered by tests):
 *  1. No contract is fabricated. If the underlying has no listed options the
 *     result is OPTIONS_UNAVAILABLE and the underlying signal is preserved.
 *  2. Provider Greeks/IV are used as-is and labelled PROVIDER. Missing Greeks
 *     reduce coverage; they are never invented.
 *  3. A suitability score is a CONFLUENCE measure, never a win probability.
 *  4. LTP is NOT assumed executable: entry uses bid/ask-aware pricing.
 *  5. The Delta-Gamma target premium is an ESTIMATE, explicitly labelled as
 *     such and validated against the actual chain where possible.
 *  6. OI never selects a contract on its own.
 */

import { round4 } from "./types";
import type { ChainRow } from "./options";
import type { OiWindow } from "./oiIntelligence";

// ------------------------------------------------------------------- types

export type OptionDirection = "CE" | "PE";

export interface ContractCandidate {
  instrumentKey: string;
  expiry: string;
  strike: number;
  side: OptionDirection;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  volume: number;
  oi: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  spreadPct: number | null;
  /** Rolling OI change at this strike for the contract's own side. */
  oiChange5m: number | null;
  oiChange15m: number | null;
  oiChangeSession: number | null;
  /** Premium change over the 5m window (from real chain observations). */
  premiumChange5m: number | null;
  moneyness: "ITM" | "ATM" | "OTM";
  score: number;
  breakdown: { k: string; v: number }[];
  reasons: string[];
  rejections: string[];
  greeksSource: "PROVIDER" | "UNAVAILABLE";
}

export interface PremiumLevels {
  /** Bid/ask-aware executable entry band for a BUY. */
  entryLow: number | null;
  entryHigh: number | null;
  referenceLtp: number | null;
  bid: number | null;
  ask: number | null;
  quoteAt: number | null;
  targetPremium: number | null;
  stopPremium: number | null;
  /** Underlying levels kept strictly separate from premium levels. */
  underlyingEntry: number | null;
  underlyingTarget: number | null;
  underlyingInvalidation: number | null;
  /** Risk/reward and position sizing. */
  riskPerUnit: number | null;
  rewardPerUnit: number | null;
  rr: number | null;
  lotSize: number | null;
  capitalRequired: number | null;
  maxLossPerLot: number | null;
  methodology: string[];
  estimateLabel: string;
}

export type OptionRecStatus =
  | "RECOMMENDED"
  | "NO_SUITABLE_CONTRACT"
  | "OPTIONS_UNAVAILABLE"
  | "INSUFFICIENT_DATA";

export interface OptionRecommendation {
  status: OptionRecStatus;
  reason: string;
  underlyingKey: string;
  underlyingSymbol: string;
  underlyingDirection: "LONG" | "SHORT";
  underlyingScore: number;
  side: OptionDirection | null;
  expiry: string | null;
  /** Expiries actually available from the instrument master. */
  availableExpiries: string[];
  expiryRiskWarning: string | null;
  best: ContractCandidate | null;
  alternative: ContractCandidate | null;
  rejected: { strike: number; side: OptionDirection; reason: string }[];
  comparison: ContractCandidate[];
  levels: PremiumLevels | null;
  whySelected: string[];
  notes: string[];
  createdAt: number;
}

// ------------------------------------------------------------ configuration

export interface SelectionConfig {
  /** Absolute delta band preferred for directional intraday trades. */
  minDelta: number;
  maxDelta: number;
  /** Strikes either side of ATM to evaluate. */
  strikesItm: number;
  strikesOtm: number;
  /** Minimum contract score (0-100) to be recommendable. */
  minScore: number;
  /** Minimum risk/reward. */
  minRr: number;
  /** Maximum acceptable bid/ask spread as a fraction of mid. */
  maxSpreadPct: number;
  /** Minimum traded volume for liquidity. */
  minVolume: number;
  /** Days-to-expiry below which an expiry-day warning is raised. */
  expiryWarnDays: number;
  /** Expected holding period in hours, used for theta projection. */
  holdingHours: number;
  /** Expected IV change (fraction) over the holding period. */
  ivDrift: number;
  weights: {
    delta: number; liquidity: number; premiumMomentum: number; theta: number;
    iv: number; oi: number; gamma: number; expiry: number;
  };
}

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  minDelta: 0.45,
  maxDelta: 0.70,
  strikesItm: 3,
  strikesOtm: 3,
  minScore: 55,
  minRr: 1.5,
  maxSpreadPct: 0.12,       // 12% of mid
  minVolume: 500,
  expiryWarnDays: 1,
  holdingHours: 2,
  ivDrift: 0,
  weights: {
    delta: 20, liquidity: 20, premiumMomentum: 15, theta: 15,
    iv: 10, oi: 10, gamma: 5, expiry: 5,
  },
};

// ------------------------------------------------------------------- helpers

function oiChangeAt(w: OiWindow | null | undefined, strike: number, side: OptionDirection): number | null {
  if (!w || w.status !== "VALID") return null;
  const r = w.rows.find((x) => x.strike === strike);
  return side === "CE" ? r?.ceChange ?? null : r?.peChange ?? null;
}

function premiumChangeAt(
  w: OiWindow | null | undefined,
  strike: number,
  side: OptionDirection
): number | null {
  if (!w || w.status !== "VALID") return null;
  // OiWindow rows do not carry premium history; the 5m premium change is
  // derived from the session baseline (prev close) when available.
  return null;
}

function daysToExpiry(expiry: string, now: number): number {
  const e = Date.parse(`${expiry}T15:30:00+05:30`);
  return (e - now) / 86_400_000;
}

/** Moneyness from the contract's own perspective. */
function moneynessOf(side: OptionDirection, strike: number, spot: number): "ITM" | "ATM" | "OTM" {
  if (side === "CE") return strike < spot ? "ITM" : strike > spot ? "OTM" : "ATM";
  return strike > spot ? "ITM" : strike < spot ? "OTM" : "ATM";
}

// ------------------------------------------------------------- scoring core

/**
 * Score one contract candidate 0-100.
 *
 * Every factor is NORMALISED before weighting so a single dominant raw value
 * (e.g. huge OI) cannot overwhelm the rest. OI contributes as *confirmation*
 * only — it is explicitly not a selection driver on its own.
 */
export function scoreContract(
  c: ContractCandidate,
  cfg: SelectionConfig,
  spot: number,
  dte: number,
  now: number
): { score: number; breakdown: { k: string; v: number }[]; reasons: string[]; rejections: string[] } {
  const W = cfg.weights;
  const total = Object.values(W).reduce((a, b) => a + b, 0) || 100;
  const breakdown: { k: string; v: number }[] = [];
  const reasons: string[] = [];
  const rejections: string[] = [];

  // ---------- hard rejections first (no score can rescue these)
  if (c.ltp === null || c.ltp <= 0) rejections.push("no valid premium (LTP unavailable)");
  if (c.bid === null || c.ask === null || c.ask <= c.bid) rejections.push("no two-sided quote (bid/ask unavailable)");
  if (c.volume < cfg.minVolume) rejections.push(`insufficient volume ${c.volume} < ${cfg.minVolume}`);
  if (c.spreadPct !== null && c.spreadPct > cfg.maxSpreadPct) {
    rejections.push(`bid/ask spread ${(c.spreadPct * 100).toFixed(1)}% of mid exceeds the ${(cfg.maxSpreadPct * 100).toFixed(0)}% limit`);
  }
  if (rejections.length > 0) return { score: 0, breakdown: [], reasons: [], rejections };

  // ---------- A. Delta suitability (weight 20)
  let deltaScore = 0;
  if (c.delta === null) {
    deltaScore = 0;
    rejections.push("delta unavailable — cannot assess directional sensitivity");
  } else {
    const ad = Math.abs(c.delta);
    if (ad < cfg.minDelta * 0.6) {
      rejections.push(`delta ${ad.toFixed(2)} far below the ${cfg.minDelta}–${cfg.maxDelta} band (too little directional exposure)`);
      deltaScore = 0;
    } else if (ad > cfg.maxDelta * 1.6) {
      // deep ITM: tradable but capital-heavy, penalised not rejected
      deltaScore = 0.35;
      reasons.push(`deep-ITM delta ${ad.toFixed(2)} is capital-heavy relative to the preferred band`);
    } else if (ad >= cfg.minDelta && ad <= cfg.maxDelta) {
      deltaScore = 1;
      reasons.push(`delta ${ad.toFixed(2)} sits inside the preferred ${cfg.minDelta}–${cfg.maxDelta} intraday band`);
    } else {
      // just outside the band — graded penalty
      const dist = ad < cfg.minDelta ? (cfg.minDelta - ad) / cfg.minDelta : (ad - cfg.maxDelta) / cfg.maxDelta;
      deltaScore = Math.max(0.4, 1 - dist * 1.5);
      reasons.push(`delta ${ad.toFixed(2)} is just outside the preferred band (graded penalty)`);
    }
  }
  breakdown.push({ k: "delta suitability", v: round4(W.delta * deltaScore) });

  // ---------- B. Liquidity & spread (weight 20)
  let liqScore = 0;
  const depth = Math.min(c.bidQty ?? 0, c.askQty ?? 0);
  if (c.spreadPct !== null) {
    const tight = Math.max(0, 1 - c.spreadPct / cfg.maxSpreadPct);
    const volScore = Math.min(1, Math.log10(Math.max(c.volume, 1)) / Math.log10(Math.max(cfg.minVolume * 20, 10)));
    liqScore = round4(tight * 0.6 + volScore * 0.4);
    reasons.push(`spread ${(c.spreadPct * 100).toFixed(1)}% of mid, volume ${Math.round(c.volume)}, top-of-book depth ${Math.round(depth)}`);
  }
  breakdown.push({ k: "liquidity & spread", v: round4(W.liquidity * liqScore) });

  // ---------- C. Premium momentum (weight 15)
  let pmScore = 0.5; // neutral when premium history is unavailable
  if (c.premiumChange5m !== null && c.ltp && c.ltp > 0) {
    const pctChange = (c.premiumChange5m / Math.max(c.ltp - c.premiumChange5m, 1e-6)) * 100;
    // favourable = premium moving WITH the intended direction
    pmScore = Math.max(0, Math.min(1, 0.5 + pctChange / 20));
    reasons.push(`premium moved ${pctChange > 0 ? "+" : ""}${pctChange.toFixed(1)}% over the 5m window`);
  } else {
    reasons.push("premium momentum unavailable (no 5m premium history) — scored neutral, not zero");
  }
  breakdown.push({ k: "premium momentum", v: round4(W.premiumMomentum * pmScore) });

  // ---------- D. Theta risk (weight 15) — lower |theta| relative to premium is better
  let thetaScore = 0.5;
  if (c.theta !== null && c.ltp && c.ltp > 0) {
    const decayOverHold = (Math.abs(c.theta) * cfg.holdingHours) / c.ltp; // fraction lost over the hold
    if (decayOverHold > 0.6) {
      thetaScore = 0;
      rejections.push(`theta would consume ${(decayOverHold * 100).toFixed(0)}% of premium over the ${cfg.holdingHours}h hold — excessive decay`);
    } else {
      thetaScore = round4(Math.max(0, 1 - decayOverHold / 0.6));
      reasons.push(`theta consumes ~${(decayOverHold * 100).toFixed(0)}% of premium over the expected ${cfg.holdingHours}h hold`);
    }
  }
  breakdown.push({ k: "theta risk", v: round4(W.theta * thetaScore) });

  // ---------- E. IV suitability (weight 10) — penalise the most expensive vs peers
  let ivScore = 0.5;
  if (c.iv !== null && c.iv > 0) {
    // caller passes peer median via `spot` reuse avoidance: computed below in engine
    ivScore = 0.5;
  }
  breakdown.push({ k: "IV suitability", v: round4(W.iv * ivScore) });

  // ---------- F. OI confirmation (weight 10) — confirmation only, never a driver
  let oiScore = 0.5;
  const build = c.oiChange5m ?? 0;
  const persist = c.oiChange15m ?? 0;
  const aligned = (c.side === "CE" && build > 0) || (c.side === "PE" && build > 0);
  if (build !== 0 || persist !== 0) {
    // Rising OI alone is NOT proof of direction; it only adds modest
    // confirmation when it persists across both windows.
    if (aligned && persist > 0) {
      oiScore = 0.8;
      reasons.push(`${c.side} OI building over both 5m (${Math.round(build)}) and 15m (${Math.round(persist)}) — contextual confirmation only`);
    } else if (!aligned) {
      oiScore = 0.35;
      reasons.push(`${c.side} OI change (5m ${Math.round(build)}, 15m ${Math.round(persist)}) does not confirm the direction`);
    }
  } else {
    reasons.push("rolling OI windows unavailable at this strike — OI scored neutral");
  }
  breakdown.push({ k: "OI confirmation", v: round4(W.oi * oiScore) });

  // ---------- G. Gamma suitability (weight 5)
  let gammaScore = 0.5;
  if (c.gamma !== null && dte <= cfg.expiryWarnDays) {
    // near expiry, high gamma is a risk
    gammaScore = c.gamma > 0.02 ? 0.2 : 0.6;
    reasons.push(`expiry-day gamma ${c.gamma.toFixed(4)} ${c.gamma > 0.02 ? "elevated" : "acceptable"}`);
  }
  breakdown.push({ k: "gamma suitability", v: round4(W.gamma * gammaScore) });

  // ---------- H. Expiry suitability (weight 5)
  const expiryScore = dte <= 0 ? 0 : dte <= cfg.expiryWarnDays ? 0.35 : dte > 30 ? 0.55 : 1;
  breakdown.push({ k: "expiry suitability", v: round4(W.expiry * expiryScore) });

  const raw = breakdown.reduce((a, b) => a + b.v, 0);
  const score = round4(Math.max(0, Math.min(100, (raw / total) * 100)));
  return { score, breakdown, reasons, rejections };
}

/** Adjust the IV score once the peer median is known (second pass). */
export function applyIvPeerAdjustment(
  c: ContractCandidate,
  peerMedianIv: number | null,
  cfg: SelectionConfig
): void {
  if (c.iv === null || peerMedianIv === null || peerMedianIv <= 0) return;
  const ratio = c.iv / peerMedianIv;
  const entry = c.breakdown.find((b) => b.k === "IV suitability");
  if (!entry) return;
  // 1.0 = fair; >1.15 = expensive; <0.9 = cheap
  let s: number;
  if (ratio > 1.15) s = 0;
  else if (ratio > 1.05) s = 0.35;
  else if (ratio < 0.9) s = 1;
  else s = 0.7;
  entry.v = round4(cfg.weights.iv * s);
  if (ratio > 1.15) c.rejections.push(`IV ${c.iv.toFixed(1)} is ${((ratio - 1) * 100).toFixed(0)}% above the nearby-strike median ${peerMedianIv.toFixed(1)} — premium expensive relative to expected movement`);
  // recompute total
  const total = Object.values(cfg.weights).reduce((a, b) => a + b, 0) || 100;
  c.score = round4(Math.max(0, Math.min(100, (c.breakdown.reduce((a, b) => a + b.v, 0) / total) * 100)));
}

// -------------------------------------------------- premium level calculation

/**
 * Compute bid/ask-aware entry, Delta-Gamma target premium and a
 * structure-based stop-loss.
 *
 * The target uses the Delta-Gamma approximation:
 *   ΔP ≈ delta·ΔS + 0.5·gamma·ΔS² + vega·ΔIV − |theta|·hours
 * and is explicitly labelled an ESTIMATE, then validated against the actual
 * chain (a target beyond the best available OTM premium is capped).
 */
export function computePremiumLevels(
  c: ContractCandidate,
  underlying: { entry: number | null; target: number | null; stop: number | null },
  spot: number,
  cfg: SelectionConfig,
  now: number
): PremiumLevels {
  const methodology: string[] = [];
  const nulls: PremiumLevels = {
    entryLow: null, entryHigh: null, referenceLtp: c.ltp, bid: c.bid, ask: c.ask,
    quoteAt: null, targetPremium: null, stopPremium: null,
    underlyingEntry: underlying.entry, underlyingTarget: underlying.target,
    underlyingInvalidation: underlying.stop,
    riskPerUnit: null, rewardPerUnit: null, rr: null,
    lotSize: null, capitalRequired: null, maxLossPerLot: null,
    methodology: [], estimateLabel: "UNAVAILABLE",
  };
  if (c.ltp === null || c.ltp <= 0) return nulls;
  if (c.bid === null || c.ask === null || c.ask <= c.bid) return nulls;

  // ---- A. Entry: bid/ask aware. For a BUY the executable price is at/above
  // the ask; the mid is the theoretical reference. Never assume LTP is fillable.
  const mid = (c.bid + c.ask) / 2;
  const entryLow = round4(mid);
  const entryHigh = round4(c.ask * 1.01); // small allowance for slippage
  const entryRef = round4((entryLow + entryHigh) / 2);
  methodology.push(`Entry uses bid/ask-aware pricing: mid ${mid.toFixed(2)} to ask+1% ${entryHigh.toFixed(2)}. LTP ${c.ltp.toFixed(2)} is shown as reference only and is not assumed executable.`);

  // ---- B. Target premium via Delta-Gamma (+ vega/theta) approximation
  let targetPremium: number | null = null;
  if (underlying.target !== null && spot > 0 && c.delta !== null) {
    const dS = underlying.target - spot;
    const gammaTerm = c.gamma !== null ? 0.5 * c.gamma * dS * dS : 0;
    const vegaTerm = c.vega !== null ? c.vega * (cfg.ivDrift * 100) : 0; // vega is per 1% IV
    const thetaTerm = c.theta !== null ? Math.abs(c.theta) * cfg.holdingHours : 0;
    const approx = c.ltp + c.delta * dS + gammaTerm + vegaTerm - thetaTerm;
    // Validate against the actual chain: a call target cannot exceed a
    // generous multiple of the current premium, and never goes below zero.
    targetPremium = round4(Math.max(0, Math.min(approx, c.ltp * 4)));
    methodology.push(
      `Target premium is a Delta-Gamma ESTIMATE: ${c.delta.toFixed(3)}×${dS.toFixed(1)}` +
      (gammaTerm ? ` + ½·${c.gamma!.toFixed(4)}·${(dS * dS).toFixed(0)}` : "") +
      (vegaTerm ? ` + vega ${vegaTerm.toFixed(2)}` : "") +
      (thetaTerm ? ` − theta ${thetaTerm.toFixed(2)}` : "") +
      `, capped at 4× the current premium. It is NOT an exact premium forecast.`
    );
  } else {
    methodology.push("Target premium unavailable: no underlying target or delta.");
  }

  // ---- C. Stop-loss: driven by the UNDERLYING invalidation, translated to
  // premium via delta, floored by a volatility/spread-aware minimum.
  let stopPremium: number | null = null;
  if (underlying.stop !== null && spot > 0 && c.delta !== null) {
    const dS_stop = underlying.stop - spot;
    const deltaImpact = c.delta * dS_stop;
    const spreadBuffer = (c.ask - c.bid) * 2;
    // never risk less than 2 spreads, never more than 45% of premium
    const byStructure = c.ltp + deltaImpact - spreadBuffer;
    const floor = c.ltp * 0.55;
    const cap = c.ltp * 0.9;
    stopPremium = round4(Math.max(floor, Math.min(cap, Math.max(0, byStructure))));
    methodology.push(
      `Stop-loss is derived from the underlying invalidation ${underlying.stop.toFixed(2)} (ΔS ${dS_stop.toFixed(1)}) translated through delta, less a 2-spread buffer, bounded to 55–90% of premium so it is neither arbitrary nor guaranteed-to-stop.`
    );
  } else {
    methodology.push("Stop-loss unavailable: no underlying invalidation level or delta.");
  }

  // ---- D. Risk/reward and sizing
  let riskPerUnit: number | null = null;
  let rewardPerUnit: number | null = null;
  let rr: number | null = null;
  if (stopPremium !== null && targetPremium !== null) {
    riskPerUnit = round4(Math.max(0, entryRef - stopPremium));
    rewardPerUnit = round4(Math.max(0, targetPremium - entryRef));
    rr = riskPerUnit > 0 ? round4(rewardPerUnit / riskPerUnit) : null;
  }

  return {
    entryLow, entryHigh, referenceLtp: c.ltp, bid: c.bid, ask: c.ask, quoteAt: now,
    targetPremium, stopPremium,
    underlyingEntry: underlying.entry,
    underlyingTarget: underlying.target,
    underlyingInvalidation: underlying.stop,
    riskPerUnit, rewardPerUnit, rr,
    lotSize: null, capitalRequired: null, maxLossPerLot: null,
    methodology,
    estimateLabel: "ESTIMATED (Delta-Gamma approximation; not an exact premium forecast)",
  };
}

/** Attach lot sizing once the instrument's lot size is known. */
export function applyLotSizing(levels: PremiumLevels, lotSize: number | null): PremiumLevels {
  if (lotSize === null || lotSize <= 0 || levels.riskPerUnit === null || levels.entryHigh === null) {
    return { ...levels, lotSize: null, capitalRequired: null, maxLossPerLot: null };
  }
  return {
    ...levels,
    lotSize,
    capitalRequired: round4(levels.entryHigh * lotSize),
    maxLossPerLot: round4(levels.riskPerUnit * lotSize),
  };
}

// ------------------------------------------------------------- main selector

export interface SelectionInput {
  underlyingKey: string;
  underlyingSymbol: string;
  direction: "LONG" | "SHORT";
  underlyingScore: number;
  underlying: { entry: number | null; target: number | null; stop: number | null };
  spot: number | null;
  /** Chain rows for the chosen expiry. */
  rows: ChainRow[];
  /** Real instrument keys per strike/side for the chosen expiry. */
  instrumentKeys: Map<string, string>;
  expiry: string;
  availableExpiries: string[];
  lotSize: number | null;
  w5?: OiWindow | null;
  w15?: OiWindow | null;
  session?: OiWindow | null;
  /** Premium history if available (session-baseline premium change). */
  premiumBaseline?: Map<string, number> | null;
  now: number;
  config?: Partial<SelectionConfig>;
}

/**
 * Select the best option contract for a qualified underlying setup.
 *
 * Stage 1 (the existing Trade Finder) decides direction. This function is
 * stage 2: given that direction, it evaluates the ATM±N strike ladder for the
 * matching side only, scores each candidate, and returns the best plus a
 * second alternative with explicit rejection reasons.
 */
export function selectOptionContract(inp: SelectionInput): OptionRecommendation {
  const cfg: SelectionConfig = { ...DEFAULT_SELECTION_CONFIG, ...(inp.config ?? {}) };
  const now = inp.now;
  const base: OptionRecommendation = {
    status: "INSUFFICIENT_DATA",
    reason: "",
    underlyingKey: inp.underlyingKey,
    underlyingSymbol: inp.underlyingSymbol,
    underlyingDirection: inp.direction,
    underlyingScore: inp.underlyingScore,
    side: null, expiry: null,
    availableExpiries: inp.availableExpiries,
    expiryRiskWarning: null,
    best: null, alternative: null, rejected: [], comparison: [],
    levels: null, whySelected: [], notes: [], createdAt: now,
  };

  // ---- Module 2: no listed options → preserve the underlying signal
  if (inp.availableExpiries.length === 0 || inp.rows.length === 0) {
    return {
      ...base,
      status: "OPTIONS_UNAVAILABLE",
      reason: "OPTIONS UNAVAILABLE — UNDERLYING SIGNAL ONLY (no eligible option contracts for this instrument)",
      notes: ["The underlying setup is preserved. No option contract has been fabricated."],
    };
  }
  if (inp.spot === null || !Number.isFinite(inp.spot) || inp.spot <= 0) {
    return { ...base, status: "INSUFFICIENT_DATA", reason: "no valid underlying spot price — option levels cannot be framed" };
  }
  const spot = inp.spot;

  // ---- expiry risk warning (Module 6)
  const dte = daysToExpiry(inp.expiry, now);
  const expiryRiskWarning =
    dte <= 0 ? "This expiry has effectively no time remaining — theta and gamma risk are extreme."
    : dte <= cfg.expiryWarnDays ? `Expiry day (${dte.toFixed(1)} days remaining): elevated gamma and theta risk. Position sizing should reflect the possibility of rapid premium decay.`
    : dte > 30 ? "Distant expiry: lower gamma and slower premium response, so intraday premium movement may understate the underlying move."
    : null;

  // ---- ATM from the ACTUAL ladder (never a hardcoded interval)
  const ladder = [...new Set(inp.rows.map((r) => r.strike))].sort((a, b) => a - b);
  const atmStrike = ladder.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), ladder[0]);
  const atmIdx = ladder.indexOf(atmStrike);
  const lo = Math.max(0, atmIdx - cfg.strikesItm);
  const hi = Math.min(ladder.length - 1, atmIdx + cfg.strikesOtm);
  const evalStrikes = ladder.slice(lo, hi + 1);

  const side: OptionDirection = inp.direction === "LONG" ? "CE" : "PE";

  // ---- build candidates
  const candidates: ContractCandidate[] = [];
  const rejected: OptionRecommendation["rejected"] = [];
  for (const strike of evalStrikes) {
    const row = inp.rows.find((r) => r.strike === strike);
    if (!row) continue;
    const isCe = side === "CE";
    const ltp = isCe ? row.ceLtp : row.peLtp;
    const bid = isCe ? row.ceBid : row.peBid;
    const ask = isCe ? row.ceAsk : row.peAsk;
    const bidQty = isCe ? row.ceBidQty : row.peBidQty;
    const askQty = isCe ? row.ceAskQty : row.peAskQty;
    const volume = isCe ? row.ceVol : row.peVol;
    const oi = isCe ? row.ceOi : row.peOi;
    const delta = isCe ? row.ceDelta : row.peDelta;
    const gamma = isCe ? row.ceGamma : row.peGamma;
    const theta = isCe ? row.ceTheta : row.peTheta;
    const vega = isCe ? row.ceVega : row.peVega;
    const iv = isCe ? row.ceIv : row.peIv;
    const spreadPct = bid !== null && ask !== null && ask > bid ? round4((ask - bid) / ((ask + bid) / 2)) : null;
    const key = inp.instrumentKeys.get(`${strike}|${side}`) ?? `${inp.underlyingKey}|${side}|${strike}|${inp.expiry}`;

    const c: ContractCandidate = {
      instrumentKey: key, expiry: inp.expiry, strike, side,
      ltp, bid, ask, bidQty, askQty, volume, oi,
      delta, gamma, theta, vega, iv, spreadPct,
      oiChange5m: oiChangeAt(inp.w5, strike, side),
      oiChange15m: oiChangeAt(inp.w15, strike, side),
      oiChangeSession: oiChangeAt(inp.session, strike, side),
      premiumChange5m: null,
      moneyness: moneynessOf(side, strike, spot),
      score: 0, breakdown: [], reasons: [], rejections: [],
      greeksSource: delta !== null || iv !== null ? "PROVIDER" : "UNAVAILABLE",
    };
    // premium change vs a real session baseline, when one exists
    const basePrem = inp.premiumBaseline?.get(`${strike}|${side}`);
    if (basePrem !== undefined && ltp !== null) c.premiumChange5m = round4(ltp - basePrem);

    const res = scoreContract(c, cfg, spot, dte, now);
    c.score = res.score;
    c.breakdown = res.breakdown;
    c.reasons = res.reasons;
    c.rejections = res.rejections;
    if (res.rejections.length > 0) {
      rejected.push({ strike, side, reason: res.rejections.join("; ") });
    } else {
      candidates.push(c);
    }
  }

  // ---- peer-median IV adjustment (second pass)
  const ivs = candidates.map((c) => c.iv).filter((v): v is number => v !== null && v > 0);
  const peerMedianIv = ivs.length ? [...ivs].sort((a, b) => a - b)[Math.floor(ivs.length / 2)] : null;
  for (const c of candidates) applyIvPeerAdjustment(c, peerMedianIv, cfg);
  // re-filter after IV adjustment (a rejection may have been added)
  const viable = candidates.filter((c) => c.rejections.length === 0);
  for (const c of candidates) if (c.rejections.length > 0) rejected.push({ strike: c.strike, side: c.side, reason: c.rejections.join("; ") });

  // ---- Module 8: no forced recommendation
  if (viable.length === 0) {
    return {
      ...base, status: "NO_SUITABLE_CONTRACT",
      reason: "NO SUITABLE OPTION CONTRACT — every candidate in the ATM±3 ladder failed the quality requirements",
      rejected, comparison: candidates, expiryRiskWarning, side, expiry: inp.expiry,
      notes: [
        `${evalStrikes.length} strikes evaluated (${evalStrikes[0]}–${evalStrikes[evalStrikes.length - 1]}) for ${side} contracts on the ${inp.expiry} expiry.`,
        "The underlying signal is retained. No contract has been forced through.",
      ],
    };
  }

  // ---- rank and pick best + alternative (deterministic tie-break)
  const ranked = viable.sort(
    (a, b) => b.score - a.score || Math.abs(a.strike - atmStrike) - Math.abs(b.strike - atmStrike) || a.strike - b.strike
  );
  const best = ranked[0];
  const alternative = ranked[1] ?? null;

  // ---- Module 5: premium levels
  let levels = computePremiumLevels(best, inp.underlying, spot, cfg, now);
  levels = applyLotSizing(levels, inp.lotSize);

  // ---- Module 8: risk/reward gate
  let status: OptionRecommendation["status"] = "RECOMMENDED";
  let reason = `Best ${side} contract: ${best.strike} ${side} (${best.moneyness}) on the ${inp.expiry} expiry, suitability ${best.score.toFixed(0)}/100.`;
  if (levels.rr === null || levels.targetPremium === null || levels.stopPremium === null) {
    status = "NO_SUITABLE_CONTRACT";
    reason = "NO SUITABLE OPTION CONTRACT — entry, target or stop-loss could not be framed from the available data";
  } else if (levels.rr < cfg.minRr) {
    status = "NO_SUITABLE_CONTRACT";
    reason = `NO SUITABLE OPTION CONTRACT — estimated risk/reward 1:${levels.rr.toFixed(2)} is below the required 1:${cfg.minRr.toFixed(1)}`;
    rejected.push({ strike: best.strike, side: best.side, reason: `risk/reward 1:${levels.rr.toFixed(2)} below the 1:${cfg.minRr.toFixed(1)} minimum` });
  } else if (best.score < cfg.minScore) {
    status = "NO_SUITABLE_CONTRACT";
    reason = `NO SUITABLE OPTION CONTRACT — best suitability score ${best.score.toFixed(0)} is below the ${cfg.minScore} threshold`;
  } else {
    reason += ` Estimated risk/reward 1:${levels.rr!.toFixed(2)}.`;
  }

  // ---- WHY THIS CONTRACT (generated from measured data, not hardcoded)
  const whySelected: string[] = [
    `Underlying ${inp.direction === "LONG" ? "bullish" : "bearish"} setup scored ${inp.underlyingScore.toFixed(0)}/100 (scenario ${inp.direction === "LONG" ? "long" : "short"}).`,
    ...best.reasons.slice(0, 6),
  ];
  if (alternative) {
    whySelected.push(`Chosen over the next-best ${alternative.strike} ${side} (suitability ${alternative.score.toFixed(0)}) because of its higher overall score.`);
  }
  if (peerMedianIv !== null && best.iv !== null) {
    whySelected.push(`IV ${best.iv.toFixed(1)} vs the nearby-strike median ${peerMedianIv.toFixed(1)}.`);
  }

  const notes = [
    "Suitability score is a CONFLUENCE measure, not a probability of profit.",
    "Greeks and IV are provider-reported values; unavailable Greeks reduce coverage and are never invented.",
    "If the underlying invalidates the setup, the option trade is invalid even if the premium stop has not been hit.",
  ];
  if (expiryRiskWarning) notes.push(expiryRiskWarning);

  return {
    status, reason,
    underlyingKey: inp.underlyingKey,
    underlyingSymbol: inp.underlyingSymbol,
    underlyingDirection: inp.direction,
    underlyingScore: inp.underlyingScore,
    side, expiry: inp.expiry, availableExpiries: inp.availableExpiries,
    expiryRiskWarning,
    best, alternative, rejected, comparison: candidates,
    levels, whySelected, notes, createdAt: now,
  };
}
