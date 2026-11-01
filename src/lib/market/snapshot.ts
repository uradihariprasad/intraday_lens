/**
 * Shared raw market-data snapshot for the two independent analytical engines.
 *
 * PHASE 1 AUDIT FINDINGS this addresses:
 *  - The Momentum Scanner used NO OI at all (no 5m/15m/session OI factors).
 *  - Neither engine had 5m/15m price-change or acceleration measures, so
 *    "momentum" was inferred from a single session change.
 *  - Liquidity eligibility was evaluated with different rules in each engine
 *    (scanner excluded INSUFFICIENT from boards; dominance ranked them), so the
 *    same stock could vanish from one board and rank on the other.
 *  - There was no shared, typed statement of raw observations, which is what
 *    allowed labelling and staleness to drift between modules.
 *
 * This module is deliberately a *fact layer only* — it computes no directional
 * opinion. Each engine scores these facts with its OWN weights and its OWN
 * classification rules, so neither score can be derived from the other.
 *
 * HONESTY RULES:
 *  - Every optional fact is `null` when unavailable, never 0 or "neutral".
 *  - Estimated flow carries an explicit ESTIMATED marker and its provenance.
 *  - OI windows carry their own validation status; an unavailable window is
 *    reported as such and never substituted with another timeframe.
 */

import { round4 } from "./types";
import type { OiWindow } from "./oiIntelligence";

// ---------------------------------------------------------------- statuses

/** Explicit validity statuses shared by both engines and the UI. */
export type FactStatus =
  | "VALID"
  | "COLLECTING"
  | "INSUFFICIENT_HISTORY"
  | "STALE_DATA"
  | "MISSING_DATA"
  | "API_ERROR"
  | "INVALID_BASELINE"
  | "ESTIMATED";

export interface Eligibility {
  eligibleForRanking: boolean;
  eligibleForActionableTrade: boolean;
  liquidityStatus: "HIGH" | "MODERATE" | "LOW" | "INSUFFICIENT" | "UNKNOWN";
  dataQualityStatus: FactStatus;
  exclusionReasons: string[];
}

export interface OiConfirmation {
  status: FactStatus;
  /** Net option OI change for the window (PE minus CE, normalised -1..1). */
  bias: number | null;
  ceChange: number | null;
  peChange: number | null;
  reason: string;
}

export interface FuturesPositioning {
  interpretation: "LONG_BUILDUP_CANDIDATE" | "SHORT_BUILDUP_CANDIDATE" | "SHORT_COVERING_CANDIDATE" | "LONG_UNWINDING_CANDIDATE" | null;
  priceChangePct: number | null;
  oiChangePct: number | null;
  note: string;
}

export interface MarketSnapshot {
  instrumentKey: string;
  symbol: string;
  ltp: number;
  /** Session change, resolved from the provider's own change field. */
  changePct: number;
  changeExact: boolean;
  changeBasis: string;
  /** Rolling price changes from real candles. */
  change5mPct: number | null;
  change15mPct: number | null;
  /** 5m vs 15m rate → acceleration (positive = building). */
  priceAcceleration: number | null;
  atrPct: number | null;
  atrMove: number | null;
  /** Volume participation. */
  rvol: number | null;
  rvolStatus: FactStatus;
  turnoverCr: number | null;
  volumeExpansion: number | null;
  /** Relative strength vs the reference index. */
  rsVsIndex: number | null;
  vwapPosition: "ABOVE" | "BELOW" | null;
  /** ESTIMATED order-flow evidence (never exchange-confirmed). */
  flow: {
    available: boolean;
    status: FactStatus;
    deltaRatio: number | null;
    cvdSlope: number | null;
    cvdNow: number | null;
    attributionPct: number;
    /** Delta and CVD come from the SAME observation stream. */
    sameSource: true;
    reason: string;
  };
  /** Rolling OI windows, each independently validated. */
  oi5m: OiConfirmation;
  oi15m: OiConfirmation;
  oiSession: OiConfirmation;
  /** Total current CE/PE OI, where a chain exists. */
  totalCeOi: number | null;
  totalPeOi: number | null;
  futures: FuturesPositioning;
  /** Market structure, from the existing structure engine. */
  structure: {
    trend: "UP" | "DOWN" | "NEUTRAL" | "UNKNOWN";
    lastEvent: string | null;
    available: boolean;
  };
  /** Nearest zones from the existing S/R engine (shared, unscored). */
  nearestSupport: number | null;
  nearestResistance: number | null;
  zoneAcceptance: "ACCEPTED_ABOVE" | "ACCEPTED_BELOW" | "REJECTED_AT_RESISTANCE" | "HELD_AT_SUPPORT" | "TESTING" | "UNKNOWN";
  eligibility: Eligibility;
  /** Data freshness. */
  quoteAt: number | null;
  dataAgeMs: number | null;
  dataQuality: FactStatus;
}

// ------------------------------------------------------------ helpers

/** Normalised OI bias (PE build minus CE build) for one validated window. */
export function oiConfirmationFromWindow(w: OiWindow | null | undefined): OiConfirmation {
  if (!w) {
    return { status: "MISSING_DATA", bias: null, ceChange: null, peChange: null, reason: "no OI window supplied" };
  }
  if (w.status !== "VALID") {
    // Map the OI engine's statuses onto the shared fact statuses.
    const map: Record<string, FactStatus> = {
      COLLECTING: "COLLECTING",
      INSUFFICIENT_HISTORY: "INSUFFICIENT_HISTORY",
      STALE_DATA: "STALE_DATA",
      INVALID_BASELINE: "INVALID_BASELINE",
      API_ERROR: "API_ERROR",
    };
    return {
      status: map[w.status] ?? "MISSING_DATA",
      bias: null, ceChange: null, peChange: null,
      reason: w.reason,
    };
  }
  const ce = w.rows.reduce((a, r) => a + (r.ceChange ?? 0), 0);
  const pe = w.rows.reduce((a, r) => a + (r.peChange ?? 0), 0);
  const scale = Math.max(Math.abs(ce) + Math.abs(pe), 1);
  return {
    status: "VALID",
    bias: round4((pe - ce) / scale),
    ceChange: round4(ce),
    peChange: round4(pe),
    reason: `CE ${Math.round(ce)}, PE ${Math.round(pe)} over ${Math.round((w.actualSpanMs ?? 0) / 1000)}s (baseline ${new Date(w.baselineAt ?? 0).toISOString().slice(11, 19)})`,
  };
}

/**
 * Acceleration = 5m rate of change versus the 15m rate of change.
 * Positive means the move is building; negative means it is fading.
 * Returns null unless BOTH windows are genuinely available.
 */
export function priceAcceleration(change5mPct: number | null, change15mPct: number | null): number | null {
  if (change5mPct === null || change15mPct === null) return null;
  const r5 = change5mPct / 5;   // % per minute
  const r15 = change15mPct / 15;
  if (!Number.isFinite(r5) || !Number.isFinite(r15)) return null;
  return round4(r5 - r15);
}

/** Futures quadrant, from real futures price and OI changes. */
export function futuresQuadrant(
  futPriceChangePct: number | null,
  futOiChangePct: number | null
): FuturesPositioning {
  if (futPriceChangePct === null || futOiChangePct === null) {
    return {
      interpretation: null, priceChangePct: futPriceChangePct, oiChangePct: futOiChangePct,
      note: "futures price or OI change unavailable",
    };
  }
  const up = futPriceChangePct > 0.05;
  const dn = futPriceChangePct < -0.05;
  const oiUp = futOiChangePct > 0.5;
  const oiDn = futOiChangePct < -0.5;
  let interpretation: FuturesPositioning["interpretation"] = null;
  if (up && oiUp) interpretation = "LONG_BUILDUP_CANDIDATE";
  else if (dn && oiUp) interpretation = "SHORT_BUILDUP_CANDIDATE";
  else if (up && oiDn) interpretation = "SHORT_COVERING_CANDIDATE";
  else if (dn && oiDn) interpretation = "LONG_UNWINDING_CANDIDATE";
  return {
    interpretation,
    priceChangePct: round4(futPriceChangePct),
    oiChangePct: round4(futOiChangePct),
    // Positioning is a candidate interpretation, never proof of aggressor side.
    note: interpretation
      ? `${interpretation.replace(/_/g, " ").toLowerCase()} — a futures positioning interpretation, NOT proof of buyer/seller aggressor dominance`
      : "futures price and OI do not form a clear positioning quadrant",
  };
}

/** Common eligibility, applied identically by both engines. */
export function eligibility(args: {
  turnoverCr: number | null;
  tiers: { high: number; moderate: number; low: number };
  dataQuality: FactStatus;
  hasValidPrice: boolean;
}): Eligibility {
  const { turnoverCr, tiers } = args;
  const liquidityStatus: Eligibility["liquidityStatus"] =
    turnoverCr === null ? "UNKNOWN"
    : turnoverCr >= tiers.high ? "HIGH"
    : turnoverCr >= tiers.moderate ? "MODERATE"
    : turnoverCr >= tiers.low ? "LOW"
    : "INSUFFICIENT";

  const exclusionReasons: string[] = [];
  if (!args.hasValidPrice) exclusionReasons.push("no valid price observation");
  if (liquidityStatus === "INSUFFICIENT") {
    exclusionReasons.push(`turnover ₹${(turnoverCr ?? 0).toFixed(0)} Cr below the ₹${tiers.low} Cr actionable floor — visible in rankings but NOT_ACTIONABLE`);
  }
  if (args.dataQuality === "STALE_DATA") exclusionReasons.push("market data is stale");

  return {
    // Poor liquidity does NOT erase a valid observation from rankings.
    eligibleForRanking: args.hasValidPrice && args.dataQuality !== "STALE_DATA" && args.dataQuality !== "MISSING_DATA",
    eligibleForActionableTrade:
      args.hasValidPrice &&
      args.dataQuality === "VALID" &&
      (liquidityStatus === "HIGH" || liquidityStatus === "MODERATE" || liquidityStatus === "LOW"),
    liquidityStatus,
    dataQualityStatus: args.dataQuality,
    exclusionReasons,
  };
}

/** Zone acceptance/rejection from price versus the shared zones. */
export function zoneAcceptanceOf(
  ltp: number,
  nearestSupport: number | null,
  nearestResistance: number | null,
  atr: number | null
): MarketSnapshot["zoneAcceptance"] {
  if (nearestResistance === null && nearestSupport === null) return "UNKNOWN";
  const band = atr && atr > 0 ? atr * 0.5 : ltp * 0.002;
  if (nearestResistance !== null && ltp > nearestResistance + band) return "ACCEPTED_ABOVE";
  if (nearestSupport !== null && ltp < nearestSupport - band) return "ACCEPTED_BELOW";
  if (nearestResistance !== null && Math.abs(ltp - nearestResistance) <= band) return "REJECTED_AT_RESISTANCE";
  if (nearestSupport !== null && Math.abs(ltp - nearestSupport) <= band) return "HELD_AT_SUPPORT";
  return "TESTING";
}
