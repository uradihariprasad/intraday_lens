/**
 * BUYER / SELLER DOMINANCE ENGINE (Phase 3).
 *
 * Purpose: identify which SIDE is exerting stronger pressure on the current
 * move, whether that pressure is building or fading, and whether absorption or
 * exhaustion is present. This is a PRESSURE engine, not a momentum ranking —
 * it must be able to disagree with momentum (e.g. price still rising while
 * buying pressure is fading), which is exactly the diagnostic value the
 * application needs.
 *
 * INDEPENDENCE (Phase 4): this module never reads a momentum score and its
 * score is never copied into momentum. It consumes shared raw
 * `MarketSnapshot` facts with its OWN weights and its OWN classifications.
 *
 * 100-point allocation (configurable), evaluated for EACH side:
 *   price response / directional confirmation      20
 *   estimated Delta / order-flow evidence         20
 *   CVD direction and acceleration                 10
 *   volume participation                          10
 *   5-minute OI confirmation                      10
 *   15-minute OI confirmation                     10
 *   session OI confirmation                        5
 *   market structure (BOS / CHoCH)                 5
 *   support/resistance acceptance or rejection     5
 *   relative strength                              5
 *
 * Because Delta and CVD derive from the SAME observation stream, they are
 * scored as one correlated group (Delta primary, CVD a bounded agreement
 * bonus) rather than as independent confirmations.
 *
 * Anti-false-claim rules (tested):
 *  - Estimated flow is always labelled ESTIMATED; it is never described as
 *    exchange-confirmed aggressor volume.
 *  - OI can never create a dominance side on its own.
 *  - A possible reversal requires actual divergent evidence, not merely price
 *    sitting near a zone.
 */

import { round4 } from "./types";
import type { MarketSnapshot, FactStatus } from "./snapshot";

export type DominanceClass =
  | "STRONG_BUYER_DOMINANCE"
  | "BUYER_DOMINANCE"
  | "BUYING_PRESSURE_BUILDING"
  | "BUYING_PRESSURE_WEAKENING"
  | "BALANCED"
  | "SELLING_PRESSURE_BUILDING"
  | "SELLING_PRESSURE_WEAKENING"
  | "SELLER_DOMINANCE"
  | "STRONG_SELLER_DOMINANCE"
  | "ABSORPTION_WATCH"
  | "POSSIBLE_REVERSAL";

export interface DominanceWeights {
  priceResponse: number;
  flow: number;
  cvd: number;
  volume: number;
  oi5m: number;
  oi15m: number;
  oiSession: number;
  structure: number;
  zone: number;
  relativeStrength: number;
}

export const DEFAULT_DOMINANCE_WEIGHTS: DominanceWeights = {
  priceResponse: 20, flow: 20, cvd: 10, volume: 10,
  oi5m: 10, oi15m: 10, oiSession: 5,
  structure: 5, zone: 5, relativeStrength: 5,
};

export interface DominanceResult {
  instrumentKey: string;
  symbol: string;
  /** Winning side's dominance score, 0..100. */
  dominanceScore: number;
  buyerScore: number;
  sellerScore: number;
  dominantSide: "BUYER" | "SELLER" | "NEITHER";
  classification: DominanceClass;
  /** Pressure direction of travel: building or fading. */
  pressureTrend: "BUILDING" | "FADING" | "STABLE" | "UNKNOWN";
  breakdown: { k: string; v: number; status: FactStatus }[];
  evidence: string[];
  conflicts: string[];
  pending: string[];
  /** Absorption / divergence diagnostics. */
  absorption: { detected: boolean; side: "BUYER" | "SELLER" | null; note: string };
  divergence: { detected: boolean; bearish: boolean; note: string };
  reversalEvidence: { detected: boolean; note: string };
  deltaRatio: number | null;
  deltaStatus: FactStatus;
  cvdSlope: number | null;
  cvdNow: number | null;
  oi5mChange: number | null;
  oi15mChange: number | null;
  oiSessionChange: number | null;
  futuresInterpretation: string | null;
  structureTrend: string;
  nearestSupport: number | null;
  nearestResistance: number | null;
  zoneAcceptance: string;
  eligibleForRanking: boolean;
  eligibleForActionableTrade: boolean;
  dataQuality: FactStatus;
}

export interface DominanceThresholds {
  strongScore: number;
  score: number;
  buildingScore: number;
  /** Minimum dominance edge (buyer − seller) for a clear winner. */
  minEdge: number;
  /** Conflicting-evidence threshold that forces BALANCED/ABSORPTION_WATCH. */
  conflictsForBalanced: number;
}

export const DEFAULT_DOMINANCE_THRESHOLDS: DominanceThresholds = {
  strongScore: 68,
  score: 50,
  buildingScore: 32,
  minEdge: 6,
  conflictsForBalanced: 2,
};

/**
 * Score one side of the pressure contest.
 * Every factor is signed by `side`, so evidence favouring the other side can
 * never inflate this one.
 */
function scoreSide(
  snap: MarketSnapshot,
  side: "BUYER" | "SELLER",
  W: DominanceWeights
): { score: number; breakdown: { k: string; v: number; status: FactStatus }[]; evidence: string[]; conflicts: string[]; pending: string[]; flowAgrees: boolean | null; cvdAgrees: boolean | null; oiAgrees: boolean | null } {
  const s = side === "BUYER" ? 1 : -1;
  const breakdown: { k: string; v: number; status: FactStatus }[] = [];
  const evidence: string[] = [];
  const conflicts: string[] = [];
  const pending: string[] = [];

  // ---------- 1. price response (20)
  const priceDir = snap.changePct === 0 ? 0 : Math.sign(snap.changePct);
  const priceAgrees = priceDir === s && snap.changeExact;
  const magnitude = Math.min(1, snap.atrMove !== null ? Math.abs(snap.atrMove) / 1.5 : Math.abs(snap.changePct) / 3);
  breakdown.push({
    k: "price response",
    v: round4(W.priceResponse * (priceAgrees ? magnitude : 0)),
    status: snap.changeExact ? "VALID" : "MISSING_DATA",
  });
  if (priceAgrees) evidence.push(`price responding ${s > 0 ? "up" : "down"} ${snap.changePct.toFixed(2)}%${snap.atrMove !== null ? ` (${Math.abs(snap.atrMove).toFixed(2)}×ATR)` : ""}`);
  else if (priceDir === -s && Math.abs(snap.changePct) > 0.25) conflicts.push(`price is moving ${s > 0 ? "down" : "up"} ${Math.abs(snap.changePct).toFixed(2)}% against ${side.toLowerCase()} pressure`);
  if (!snap.changeExact) pending.push(`price change indeterminate (${snap.changeBasis})`);

  // ---------- 2 + 3. flow group: Delta primary, CVD bounded bonus (30 total)
  let flowAgrees: boolean | null = null;
  let cvdAgrees: boolean | null = null;
  if (!snap.flow.available || snap.flow.deltaRatio === null) {
    breakdown.push({ k: "estimated Delta (order flow)", v: 0, status: snap.flow.status });
    breakdown.push({ k: "CVD direction", v: 0, status: snap.flow.status });
    pending.push(`order-flow evidence unavailable: ${snap.flow.reason} — ESTIMATED flow, never exchange-confirmed`);
  } else {
    const dr = snap.flow.deltaRatio;
    const agrees = Math.sign(dr) === s && Math.abs(dr) > 0.1;
    const opposes = Math.sign(dr) === -s && Math.abs(dr) > 0.25;
    // attribution coverage bounds how much credit ESTIMATED flow can earn
    const credit = Math.max(0, Math.min(1, Math.abs(dr))) * Math.min(1, snap.flow.attributionPct / 60);
    breakdown.push({
      k: "estimated Delta (order flow)",
      v: round4(W.flow * (agrees ? credit : 0)),
      status: "ESTIMATED",
    });
    flowAgrees = agrees;
    if (agrees) evidence.push(`ESTIMATED delta ${dr.toFixed(2)} of attributable volume supports ${side.toLowerCase()}s (${snap.flow.attributionPct.toFixed(0)}% attributed)`);
    if (opposes) conflicts.push(`ESTIMATED delta ${dr.toFixed(2)} opposes ${side.toLowerCase()} pressure`);

    // CVD comes from the SAME observation stream, so it is a bounded agreement
    // bonus rather than an independent confirmation.
    const slope = snap.flow.cvdSlope;
    if (slope !== null) {
      cvdAgrees = Math.sign(slope) === s;
      breakdown.push({
        k: "CVD direction (correlated with Delta)",
        v: round4(W.cvd * (cvdAgrees && agrees ? 0.5 * Math.min(1, snap.flow.attributionPct / 60) : 0)),
        status: "ESTIMATED",
      });
      if (cvdAgrees && agrees) evidence.push(`ESTIMATED CVD ${slope > 0 ? "rising" : "falling"} in the ${side.toLowerCase()}'s direction (correlated with the same volume stream)`);
      if (!cvdAgrees && agrees) conflicts.push(`ESTIMATED CVD ${slope > 0 ? "rising" : "falling"} while delta favours ${side.toLowerCase()}s — flow evidence disagrees internally`);
    } else {
      breakdown.push({ k: "CVD direction (correlated with Delta)", v: 0, status: "MISSING_DATA" });
      pending.push("CVD slope unavailable");
    }
  }

  // ---------- 4. volume participation (10) — amplifies, never directs
  const participation = snap.rvol === null ? 0 : Math.min(1, Math.max(0, (snap.rvol - 1) / 2));
  breakdown.push({
    k: "volume participation",
    v: round4(W.volume * (priceAgrees ? participation : 0)),
    status: snap.rvol === null ? snap.rvolStatus : "VALID",
  });
  if (snap.rvol === null) pending.push(`relative volume unavailable (${snap.rvolStatus})`);

  // ---------- 5–7. OI confirmation (25) — confirmation only
  let oiAgrees: boolean | null = null;
  const oiFactor = (label: string, weight: number, oi: MarketSnapshot["oi5m"]): number => {
    if (oi.status !== "VALID" || oi.bias === null) {
      breakdown.push({ k: `${label} OI`, v: 0, status: oi.status });
      pending.push(`${label} OI unavailable: ${oi.reason}`);
      return 0;
    }
    const agrees = Math.sign(oi.bias) === s && Math.abs(oi.bias) > 0.1;
    const opposes = Math.sign(oi.bias) === -s && Math.abs(oi.bias) > 0.25;
    const v = agrees ? Math.min(1, Math.abs(oi.bias) * 1.5) : 0;
    breakdown.push({ k: `${label} OI`, v: round4(weight * v), status: "VALID" });
    if (agrees) {
      evidence.push(`${label} OI positioning supports ${side.toLowerCase()}s (${oi.reason})`);
      oiAgrees = true;
    }
    if (opposes) conflicts.push(`${label} OI positioning (bias ${oi.bias.toFixed(2)}) opposes ${side.toLowerCase()} pressure`);
    return v;
  };
  oiFactor("5-minute", W.oi5m, snap.oi5m);
  oiFactor("15-minute", W.oi15m, snap.oi15m);
  oiFactor("session", W.oiSession, snap.oiSession);

  // ---------- 8. market structure (5)
  const structAgrees = snap.structure.available && ((side === "BUYER" && snap.structure.trend === "UP") || (side === "SELLER" && snap.structure.trend === "DOWN"));
  breakdown.push({ k: "market structure", v: round4(W.structure * (structAgrees ? 1 : 0)), status: snap.structure.available ? "VALID" : "MISSING_DATA" });
  if (structAgrees) evidence.push(`structure ${snap.structure.trend}${snap.structure.lastEvent ? ` (${snap.structure.lastEvent})` : ""}`);
  if (!snap.structure.available) pending.push("market structure not yet analysed");

  // ---------- 9. zone acceptance / rejection (5)
  const zoneFavour =
    side === "BUYER"
      ? snap.zoneAcceptance === "ACCEPTED_ABOVE" || snap.zoneAcceptance === "HELD_AT_SUPPORT"
      : snap.zoneAcceptance === "ACCEPTED_BELOW" || snap.zoneAcceptance === "REJECTED_AT_RESISTANCE";
  breakdown.push({ k: "zone acceptance/rejection", v: round4(W.zone * (zoneFavour ? 1 : 0)), status: snap.nearestSupport === null && snap.nearestResistance === null ? "MISSING_DATA" : "VALID" });
  if (zoneFavour) evidence.push(`${snap.zoneAcceptance.replace(/_/g, " ").toLowerCase()} at a relevant zone`);
  if (snap.nearestSupport === null && snap.nearestResistance === null) pending.push("no S/R zone available for acceptance analysis");

  // ---------- 10. relative strength (5)
  const rs = snap.rsVsIndex;
  const rsAgrees = rs !== null && Math.sign(rs) === s && Math.abs(rs) > 0.3;
  breakdown.push({ k: "relative strength", v: round4(W.relativeStrength * (rsAgrees ? Math.min(1, Math.abs(rs) / 2) : 0)), status: rs === null ? "MISSING_DATA" : "VALID" });
  if (rs === null) pending.push("relative strength unavailable");

  const total = Object.values(W).reduce((a, b) => a + b, 0) || 100;
  const raw = breakdown.reduce((a, b) => a + b.v, 0);
  return {
    score: round4(Math.max(0, Math.min(100, (raw / total) * 100))),
    breakdown, evidence, conflicts, pending, flowAgrees, cvdAgrees, oiAgrees,
  };
}

export function classifyDominance(
  snap: MarketSnapshot,
  W: DominanceWeights = DEFAULT_DOMINANCE_WEIGHTS,
  th: DominanceThresholds = DEFAULT_DOMINANCE_THRESHOLDS
): DominanceResult {
  const buyer = scoreSide(snap, "BUYER", W);
  const seller = scoreSide(snap, "SELLER", W);

  const edge = buyer.score - seller.score;
  const dominantSide: "BUYER" | "SELLER" | "NEITHER" =
    Math.abs(edge) < th.minEdge ? "NEITHER" : edge > 0 ? "BUYER" : "SELLER";
  const win = dominantSide === "BUYER" ? buyer : dominantSide === "SELLER" ? seller : null;
  const dominanceScore = win ? win.score : Math.max(buyer.score, seller.score);

  const evidence = win ? win.evidence : [...buyer.evidence, ...seller.evidence];
  // Result conflicts = the winner's conflicts (what gates it), plus
  // cross-side context the UI should still show.
  const conflicts = win ? [...win.conflicts] : [...buyer.conflicts, ...seller.conflicts];
  const pending = [...new Set([...buyer.pending, ...seller.pending])];

  // ---------- pressure trend (building vs fading)
  // Building = the short window supports the side while the longer window has
  // not yet peaked against it; fading = short evidence weakening.
  let pressureTrend: DominanceResult["pressureTrend"] = "UNKNOWN";
  if (win) {
    const shortAgrees = win.oiAgrees === true || win.flowAgrees === true;
    const fading =
      (snap.oi5m.status === "VALID" && snap.oi15m.status === "VALID" &&
        snap.oi5m.bias !== null && snap.oi15m.bias !== null &&
        Math.abs(snap.oi5m.bias) < Math.abs(snap.oi15m.bias) * 0.5) ||
      (snap.flow.available && snap.flow.deltaRatio !== null &&
        Math.sign(snap.flow.deltaRatio) !== (dominantSide === "BUYER" ? 1 : -1));
    if (fading) pressureTrend = "FADING";
    else if (shortAgrees) pressureTrend = "BUILDING";
    else pressureTrend = "STABLE";
  }

  // ---------- absorption / divergence diagnostics
  const divergence = ((): DominanceResult["divergence"] => {
    if (!snap.flow.available || snap.flow.deltaRatio === null || !snap.changeExact) {
      return { detected: false, bearish: false, note: "divergence assessment requires flow evidence and a confirmed price direction" };
    }
    const priceUp = snap.changePct > 0.25;
    const priceDn = snap.changePct < -0.25;
    const flowUp = snap.flow.deltaRatio > 0.1;
    const flowDn = snap.flow.deltaRatio < -0.1;
    if (priceUp && flowDn) {
      return { detected: true, bearish: true, note: `price rising while ESTIMATED delta is ${snap.flow.deltaRatio.toFixed(2)} — potential bearish divergence (warning only)` };
    }
    if (priceDn && flowUp) {
      return { detected: true, bearish: false, note: `price falling while ESTIMATED delta is ${snap.flow.deltaRatio.toFixed(2)} — potential bullish divergence (warning only)` };
    }
    return { detected: false, bearish: false, note: "price and ESTIMATED flow are aligned; no divergence candidate" };
  })();

  const absorption = ((): DominanceResult["absorption"] => {
    // Absorption requires HIGH participation with LIMITED price progress.
    const highVol = (snap.rvol ?? 0) >= 2;
    const limitedProgress = snap.atrMove !== null ? Math.abs(snap.atrMove) < 0.35 : Math.abs(snap.changePct) < 0.5;
    if (!highVol || !limitedProgress) {
      return { detected: false, side: null, note: highVol ? "volume is being translated into price movement" : "participation not high enough to assess absorption" };
    }
    const nearSupport = snap.nearestSupport !== null && Math.abs(snap.ltp - snap.nearestSupport) / snap.ltp < 0.004;
    const nearResistance = snap.nearestResistance !== null && Math.abs(snap.ltp - snap.nearestResistance) / snap.ltp < 0.004;
    if (nearSupport && snap.flow.available && (snap.flow.deltaRatio ?? 0) < -0.1) {
      return { detected: true, side: "BUYER", note: "high volume near support with limited downside progress and negative ESTIMATED delta — possible BUYING ABSORPTION (requires follow-through confirmation)" };
    }
    if (nearResistance && snap.flow.available && (snap.flow.deltaRatio ?? 0) > 0.1) {
      return { detected: true, side: "SELLER", note: "high volume near resistance with limited upside progress and positive ESTIMATED delta — possible SELLING ABSORPTION (requires follow-through confirmation)" };
    }
    if (nearSupport || nearResistance) {
      return { detected: true, side: (nearSupport ? "BUYER" : "SELLER") as "BUYER" | "SELLER", note: `high volume with limited price progress near ${nearSupport ? "support" : "resistance"} — ABSORPTION WATCH; flow evidence is inconclusive` };
    }
    return { detected: false, side: null, note: "high volume with little price progress, but not adjacent to a reference zone" };
  })();

  // ---------- possible reversal requires actual evidence
  const reversalEvidence = ((): DominanceResult["reversalEvidence"] => {
    if (!divergence.detected && !absorption.detected) {
      return { detected: false, note: "no divergent evidence — a reversal is not asserted merely because price is near a zone" };
    }
    const opposing =
      dominantSide === "BUYER"
        ? (snap.oi5m.status === "VALID" && (snap.oi5m.bias ?? 0) < -0.2)
        : dominantSide === "SELLER"
          ? (snap.oi5m.status === "VALID" && (snap.oi5m.bias ?? 0) > 0.2)
          : false;
    if (divergence.detected || opposing) {
      return {
        detected: true,
        note: `POSSIBLE_REVERSAL evidence: ${divergence.detected ? divergence.note : "5m OI has flipped against the dominant side"}${opposing && divergence.detected ? "; OI also flipped" : ""}. Requires price-structure confirmation.`,
      };
    }
    return { detected: false, note: "divergence present but OI has not flipped against the dominant side" };
  })();

  // ---------- classification
  let classification: DominanceClass;
  // Only the WINNING side's conflicts gate its classification; the losing
  // side's conflicts are, by definition, evidence for the winner.
  const winConflictCount = win ? win.conflicts.length : conflicts.length;
  const conflictCount = winConflictCount;
  if (dominantSide === "NEITHER") {
    classification = absorption.detected ? "ABSORPTION_WATCH" : "BALANCED";
  } else if (reversalEvidence.detected) {
    classification = "POSSIBLE_REVERSAL";
  } else if (conflictCount >= th.conflictsForBalanced) {
    classification = absorption.detected ? "ABSORPTION_WATCH" : "BALANCED";
  } else if (pressureTrend === "FADING") {
    classification = dominantSide === "BUYER" ? "BUYING_PRESSURE_WEAKENING" : "SELLING_PRESSURE_WEAKENING";
  } else if (dominanceScore >= th.strongScore && conflictCount === 0) {
    classification = dominantSide === "BUYER" ? "STRONG_BUYER_DOMINANCE" : "STRONG_SELLER_DOMINANCE";
  } else if (dominanceScore >= th.score) {
    classification = dominantSide === "BUYER" ? "BUYER_DOMINANCE" : "SELLER_DOMINANCE";
  } else if (pressureTrend === "BUILDING") {
    classification = dominantSide === "BUYER" ? "BUYING_PRESSURE_BUILDING" : "SELLING_PRESSURE_BUILDING";
  } else if (dominanceScore >= th.buildingScore) {
    classification = dominantSide === "BUYER" ? "BUYING_PRESSURE_BUILDING" : "SELLING_PRESSURE_BUILDING";
  } else {
    classification = "BALANCED";
  }

  return {
    instrumentKey: snap.instrumentKey,
    symbol: snap.symbol,
    dominanceScore,
    buyerScore: buyer.score,
    sellerScore: seller.score,
    dominantSide,
    classification,
    pressureTrend,
    breakdown: (win ? win.breakdown : buyer.breakdown).map((b) => ({ ...b, k: `${b.k}` })),
    evidence,
    conflicts,
    pending,
    absorption,
    divergence,
    reversalEvidence,
    deltaRatio: snap.flow.deltaRatio,
    deltaStatus: snap.flow.available ? "ESTIMATED" : snap.flow.status,
    cvdSlope: snap.flow.cvdSlope,
    cvdNow: snap.flow.cvdNow,
    oi5mChange: snap.oi5m.status === "VALID" ? snap.oi5m.ceChange : null,
    oi15mChange: snap.oi15m.status === "VALID" ? snap.oi15m.ceChange : null,
    oiSessionChange: snap.oiSession.status === "VALID" ? snap.oiSession.ceChange : null,
    futuresInterpretation: snap.futures.interpretation,
    structureTrend: snap.structure.trend,
    nearestSupport: snap.nearestSupport,
    nearestResistance: snap.nearestResistance,
    zoneAcceptance: snap.zoneAcceptance,
    eligibleForRanking: snap.eligibility.eligibleForRanking,
    eligibleForActionableTrade: snap.eligibility.eligibleForActionableTrade,
    dataQuality: snap.dataQuality,
  };
}
