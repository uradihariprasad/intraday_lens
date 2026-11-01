/**
 * MOMENTUM DISCOVERY ENGINE (Phase 2).
 *
 * Purpose: discover stocks with genuine DIRECTIONAL momentum — and whether it
 * is accelerating, continuing or fading. This is deliberately a momentum
 * engine, not a pressure engine: it says nothing about which side is
 * dominating order flow.
 *
 * INDEPENDENCE (Phase 4): this module never reads a dominance score, and its
 * output is never used as one. It consumes the shared raw `MarketSnapshot`
 * facts only.
 *
 * 100-point allocation (configurable):
 *   directional price movement + acceleration   25
 *   ATR-normalised momentum strength            15
 *   relative volume / participation             15
 *   5-minute OI confirmation                    10
 *   15-minute OI confirmation                   10
 *   session OI confirmation                      5
 *   relative strength vs the reference index    10
 *   futures price/volume confirmation            5
 *   liquidity and turnover suitability           5
 *
 * Anti-false-signal rules (tested):
 *  - High volume with no directional price movement scores ZERO direction.
 *  - A single price spike is not momentum: acceleration requires BOTH the 5m
 *    and 15m windows, and the 5m must not be an isolated spike.
 *  - OI is confirmation only. It can never create direction.
 *  - An unavailable OI window reduces available evidence and is reported as
 *    such — never treated as neutral agreement.
 */

import { round4 } from "./types";
import type { MarketSnapshot, FactStatus } from "./snapshot";

export type MomentumClass =
  | "STRONG_BULLISH"
  | "BULLISH"
  | "BULLISH_CANDIDATE"
  | "NEUTRAL"
  | "BEARISH_CANDIDATE"
  | "BEARISH"
  | "STRONG_BEARISH"
  | "MOMENTUM_WEAKENING";

export interface MomentumWeights {
  directional: number;
  atrStrength: number;
  volume: number;
  oi5m: number;
  oi15m: number;
  oiSession: number;
  relativeStrength: number;
  futures: number;
  liquidity: number;
}

export const DEFAULT_MOMENTUM_WEIGHTS: MomentumWeights = {
  directional: 25, atrStrength: 15, volume: 15,
  oi5m: 10, oi15m: 10, oiSession: 5,
  relativeStrength: 10, futures: 5, liquidity: 5,
};

export interface MomentumResult {
  instrumentKey: string;
  symbol: string;
  score: number;                 // 0..100 magnitude
  direction: 1 | -1 | 0;
  classification: MomentumClass;
  accelerating: boolean | null;   // null when both windows are unavailable
  decelerating: boolean | null;
  breakdown: { k: string; v: number; status: FactStatus }[];
  confirmations: string[];
  conflicts: string[];
  pending: string[];
  /** Number of independent evidence groups that agreed with the direction. */
  confirmationCount: number;
  /** Evidence groups that materially opposed the direction. */
  conflictCount: number;
  oiStatus: FactStatus;
  eligibleForRanking: boolean;
  eligibleForActionableTrade: boolean;
}

export interface MomentumThresholds {
  /** Minimum |ATR-normalised move| for genuine direction. */
  minAtrMove: number;
  /** Minimum |session change %| for direction. */
  minChangePct: number;
  /** Score bands for classification. */
  strongScore: number;
  score: number;
  candidateScore: number;
  /** Confirmation counts. */
  confirmationsForStrong: number;
  confirmationsForClass: number;
  /** Conflicts that force a downgrade. */
  conflictsForDowngrade: number;
}

export const DEFAULT_MOMENTUM_THRESHOLDS: MomentumThresholds = {
  minAtrMove: 0.2,
  minChangePct: 0.25,
  strongScore: 70,
  score: 50,
  candidateScore: 28,
  confirmationsForStrong: 3,
  confirmationsForClass: 2,
  conflictsForDowngrade: 2,
};

export function classifyMomentum(
  snap: MarketSnapshot,
  weights: MomentumWeights = DEFAULT_MOMENTUM_WEIGHTS,
  th: MomentumThresholds = DEFAULT_MOMENTUM_THRESHOLDS
): MomentumResult {
  const W = weights;
  const total = Object.values(W).reduce((a, b) => a + b, 0) || 100;
  const breakdown: MomentumResult["breakdown"] = [];
  const confirmations: string[] = [];
  const conflicts: string[] = [];
  const pending: string[] = [];

  // ---------- direction: price must actually move
  const atrMove = snap.atrMove;
  const hasDirection =
    Math.abs(snap.changePct) >= th.minChangePct &&
    (atrMove === null || Math.abs(atrMove) >= th.minAtrMove) &&
    snap.changeExact;
  const dir: 1 | -1 | 0 = hasDirection ? (snap.changePct > 0 ? 1 : -1) : 0;

  if (!hasDirection) {
    if (!snap.changeExact) pending.push(`price change indeterminate (${snap.changeBasis})`);
    else pending.push(`no meaningful directional move: ${snap.changePct.toFixed(2)}% (needs ≥${th.minChangePct}%)${atrMove !== null ? ` / ${atrMove.toFixed(2)}×ATR (needs ≥${th.minAtrMove})` : ""}`);
  }

  // ---------- 1. directional movement + acceleration (25)
  const absChange = Math.abs(snap.changePct);
  const strength = !hasDirection ? 0 : Math.min(1, atrMove !== null ? Math.abs(atrMove) / 1.5 : absChange / 3);
  // Sustained momentum requires the 15m window to agree in direction; a lone
  // 5m spike is explicitly discounted so it cannot masquerade as momentum.
  const sustained =
    hasDirection &&
    snap.change15mPct !== null &&
    Math.sign(snap.change15mPct) === dir;
  const accel = snap.priceAcceleration;
  const accelerating = hasDirection && accel !== null && Math.sign(accel) === dir && sustained;
  const decelerating = hasDirection && accel !== null && Math.sign(accel) === -dir;

  let dirScore = strength * 0.7;
  if (sustained) dirScore += 0.2;
  if (accelerating) dirScore += 0.1;
  if (hasDirection && snap.change15mPct !== null && Math.sign(snap.change15mPct) !== dir) {
    dirScore -= 0.25;
    conflicts.push(`15-minute price change ${snap.change15mPct.toFixed(2)}% opposes the session direction — not sustained momentum`);
  }
  dirScore = Math.max(0, Math.min(1, dirScore));
  breakdown.push({ k: "directional movement & acceleration", v: round4(W.directional * (hasDirection ? dirScore : 0)), status: hasDirection ? "VALID" : "MISSING_DATA" });
  if (accelerating) confirmations.push(`price accelerating: 5m rate exceeds the 15m rate in the ${dir > 0 ? "bullish" : "bearish"} direction`);
  if (decelerating) conflicts.push("5-minute price rate is below the 15-minute rate — momentum decelerating");

  // ---------- 2. ATR-normalised strength (15)
  const atrNorm = strength;
  breakdown.push({ k: "ATR-normalised strength", v: round4(W.atrStrength * atrNorm), status: atrMove === null ? "MISSING_DATA" : "VALID" });
  if (hasDirection && atrMove !== null && Math.abs(atrMove) >= 0.8) {
    confirmations.push(`${Math.abs(atrMove).toFixed(2)}× ATR move — strong for this instrument's volatility`);
  }

  // ---------- 3. volume participation (15)
  // Volume is UNSIGNED participation: it can only amplify an existing move.
  const participation = snap.rvol === null ? 0 : Math.min(1, Math.max(0, (snap.rvol - 1) / 2));
  const volConfirms = hasDirection && participation > 0;
  breakdown.push({
    k: "volume participation",
    v: round4(W.volume * (hasDirection ? participation : 0)),
    status: snap.rvol === null ? snap.rvolStatus : "VALID",
  });
  if (snap.rvol === null) {
    pending.push(`relative volume unavailable (${snap.rvolStatus}) — volume evidence not counted`);
  } else if (volConfirms) {
    confirmations.push(`RVOL ${snap.rvol.toFixed(1)}× confirms the move`);
  } else if (hasDirection && snap.rvol < 0.8) {
    conflicts.push(`RVOL ${snap.rvol.toFixed(1)}× is below normal — thin participation behind the move`);
  }
  if (!hasDirection && snap.rvol !== null && snap.rvol >= 2) {
    pending.push(`high RVOL ${snap.rvol.toFixed(1)}× with no directional price movement — participation is not momentum`);
  }

  // ---------- 4–6. OI confirmation (25 total, confirmation only)
  const oiWindow = (label: string, weight: number, oi: MarketSnapshot["oi5m"]): { v: number; agree: boolean | null } => {
    if (oi.status !== "VALID" || oi.bias === null) {
      breakdown.push({ k: `${label} OI confirmation`, v: 0, status: oi.status });
      pending.push(`${label} OI unavailable: ${oi.reason}`);
      return { v: 0, agree: null };
    }
    // OI bias is a magnitude-scaled direction; it can only confirm.
    const agrees = hasDirection && Math.sign(oi.bias) === dir && Math.abs(oi.bias) > 0.1;
    const opposes = hasDirection && Math.sign(oi.bias) === -dir && Math.abs(oi.bias) > 0.25;
    const v = agrees ? Math.min(1, Math.abs(oi.bias) * 1.6) : 0;
    breakdown.push({ k: `${label} OI confirmation`, v: round4(weight * v), status: "VALID" });
    if (agrees) confirmations.push(`${label} OI positioning confirms the direction (bias ${oi.bias.toFixed(2)}; ${oi.reason})`);
    if (opposes) conflicts.push(`${label} OI positioning (bias ${oi.bias.toFixed(2)}) opposes the price direction`);
    return { v, agree: agrees };
  };
  const o5 = oiWindow("5-minute", W.oi5m, snap.oi5m);
  const o15 = oiWindow("15-minute", W.oi15m, snap.oi15m);
  const oS = oiWindow("session", W.oiSession, snap.oiSession);

  // Conflicting 5m vs 15m OI is surfaced, never averaged away.
  if (snap.oi5m.status === "VALID" && snap.oi15m.status === "VALID" &&
      snap.oi5m.bias !== null && snap.oi15m.bias !== null &&
      Math.abs(snap.oi5m.bias) > 0.15 && Math.abs(snap.oi15m.bias) > 0.15 &&
      Math.sign(snap.oi5m.bias) !== Math.sign(snap.oi15m.bias)) {
    conflicts.push(`5m OI (bias ${snap.oi5m.bias.toFixed(2)}) and 15m OI (bias ${snap.oi15m.bias.toFixed(2)}) point in opposite directions`);
  }
  const oiStatus: FactStatus =
    snap.oi5m.status === "VALID" || snap.oi15m.status === "VALID" ? "VALID"
    : snap.oi5m.status === "COLLECTING" || snap.oi15m.status === "COLLECTING" ? "COLLECTING"
    : snap.oi5m.status === "INSUFFICIENT_HISTORY" || snap.oi15m.status === "INSUFFICIENT_HISTORY" ? "INSUFFICIENT_HISTORY"
    : snap.oi5m.status;

  // ---------- 7. relative strength (10)
  const rs = snap.rsVsIndex;
  const rsAgrees = hasDirection && rs !== null && Math.sign(rs) === dir;
  const rsOpposes = hasDirection && rs !== null && Math.abs(rs) > 0.5 && Math.sign(rs) === -dir;
  const rsNorm = rsAgrees ? Math.min(1, Math.abs(rs) / 2) : 0;
  breakdown.push({ k: "relative strength vs index", v: round4(W.relativeStrength * rsNorm), status: rs === null ? "MISSING_DATA" : "VALID" });
  if (rsAgrees && Math.abs(rs) >= 0.5) confirmations.push(`outperforming the index by ${rs.toFixed(2)} pts`);
  if (rsOpposes) conflicts.push(`underperforming the index by ${Math.abs(rs).toFixed(2)} pts against the session direction`);
  if (rs === null) pending.push("relative strength unavailable (no index reference)");

  // ---------- 8. futures confirmation (5)
  const fut = snap.futures;
  const bullishFut = fut.interpretation === "LONG_BUILDUP_CANDIDATE" || fut.interpretation === "SHORT_COVERING_CANDIDATE";
  const bearishFut = fut.interpretation === "SHORT_BUILDUP_CANDIDATE" || fut.interpretation === "LONG_UNWINDING_CANDIDATE";
  const futAgrees = hasDirection && ((dir > 0 && bullishFut) || (dir < 0 && bearishFut));
  const futOpposes = hasDirection && ((dir > 0 && bearishFut) || (dir < 0 && bullishFut));
  breakdown.push({ k: "futures positioning", v: round4(W.futures * (futAgrees ? 1 : 0)), status: fut.interpretation === null ? "MISSING_DATA" : "VALID" });
  if (futAgrees) confirmations.push(`futures ${fut.interpretation!.replace(/_/g, " ").toLowerCase()} aligns with the move`);
  if (futOpposes) conflicts.push(`futures ${fut.interpretation!.replace(/_/g, " ").toLowerCase()} conflicts with the move`);
  if (fut.interpretation === null) pending.push(`futures positioning unavailable: ${fut.note}`);

  // ---------- 9. liquidity (5)
  const liq = snap.eligibility.liquidityStatus;
  const liqScore = liq === "HIGH" ? 1 : liq === "MODERATE" ? 0.7 : liq === "LOW" ? 0.4 : 0;
  breakdown.push({ k: "liquidity & turnover", v: round4(W.liquidity * liqScore), status: liq === "UNKNOWN" ? "MISSING_DATA" : "VALID" });
  if (liq === "INSUFFICIENT") pending.push("low liquidity: visible in rankings but NOT_ACTIONABLE");

  // ---------- total
  const raw = breakdown.reduce((a, b) => a + b.v, 0);
  const score = round4(Math.max(0, Math.min(100, (raw / total) * 100)));
  const confirmationCount = confirmations.length;
  const conflictCount = conflicts.length;

  // ---------- classification
  let classification: MomentumClass;
  if (dir === 0) {
    classification = "NEUTRAL";
  } else if (conflictCount >= th.conflictsForDowngrade) {
    classification = "MOMENTUM_WEAKENING";
  } else if (decelerating && conflictCount >= 1) {
    classification = "MOMENTUM_WEAKENING";
  } else if (score >= th.strongScore && confirmationCount >= th.confirmationsForStrong && conflictCount === 0) {
    classification = dir > 0 ? "STRONG_BULLISH" : "STRONG_BEARISH";
  } else if (score >= th.score && confirmationCount >= th.confirmationsForClass) {
    classification = dir > 0 ? "BULLISH" : "BEARISH";
  } else if (score >= th.candidateScore) {
    classification = dir > 0 ? "BULLISH_CANDIDATE" : "BEARISH_CANDIDATE";
  } else {
    classification = dir > 0 ? "BULLISH_CANDIDATE" : "BEARISH_CANDIDATE";
  }

  return {
    instrumentKey: snap.instrumentKey,
    symbol: snap.symbol,
    score,
    direction: dir,
    classification,
    accelerating,
    decelerating,
    breakdown,
    confirmations,
    conflicts,
    pending,
    confirmationCount,
    conflictCount,
    oiStatus,
    eligibleForRanking: snap.eligibility.eligibleForRanking,
    eligibleForActionableTrade: snap.eligibility.eligibleForActionableTrade,
  };
}
