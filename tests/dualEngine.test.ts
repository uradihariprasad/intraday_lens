/**
 * Dual-engine tests: Momentum Scanner (discovery) vs Buyer/Seller Dominance
 * (pressure confirmation), plus their independence and Trade Finder gating.
 *
 * PHASE 1 AUDIT FINDINGS under test:
 *  - The scanner had NO OI factors at all.
 *  - Neither engine had 5m/15m price change or acceleration.
 *  - Liquidity eligibility differed between the engines.
 *  - Both engines could return near-identical rankings because they shared the
 *    same few factors (price + RVOL + structure + RS).
 */
import { describe, it, expect } from "vitest";
import { classifyMomentum, DEFAULT_MOMENTUM_WEIGHTS } from "../src/lib/market/momentum";
import { classifyDominance, DEFAULT_DOMINANCE_WEIGHTS } from "../src/lib/market/dominanceV2";
import type { MarketSnapshot, OiConfirmation } from "../src/lib/market/snapshot";

const NOW = Date.parse("2026-10-28T11:00:00+05:30");

const OI_VALID = (bias: number, ce = 0, pe = 0): OiConfirmation => ({
  status: "VALID", bias, ceChange: ce, peChange: pe, reason: `CE ${ce}, PE ${pe}`,
});
const OI_MISSING = (status: OiConfirmation["status"] = "INSUFFICIENT_HISTORY"): OiConfirmation => ({
  status, bias: null, ceChange: null, peChange: null, reason: "not enough history",
});

function snap(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const base: MarketSnapshot = {
    instrumentKey: "NSE_EQ|TEST",
    symbol: "TEST",
    ltp: 100,
    changePct: 0,
    changeExact: true,
    changeBasis: "provider net_change",
    change5mPct: null,
    change15mPct: null,
    priceAcceleration: null,
    atrPct: 2,
    atrMove: 0,
    rvol: null,
    rvolStatus: "MISSING_DATA",
    turnoverCr: 500,
    volumeExpansion: null,
    rsVsIndex: null,
    vwapPosition: null,
    flow: {
      available: false, status: "COLLECTING", deltaRatio: null, cvdSlope: null,
      cvdNow: null, attributionPct: 0, sameSource: true, reason: "insufficient observations",
    },
    oi5m: OI_MISSING(),
    oi15m: OI_MISSING(),
    oiSession: OI_MISSING(),
    totalCeOi: null,
    totalPeOi: null,
    futures: { interpretation: null, priceChangePct: null, oiChangePct: null, note: "unavailable" },
    structure: { trend: "NEUTRAL", lastEvent: null, available: true },
    nearestSupport: 96,
    nearestResistance: 106,
    zoneAcceptance: "TESTING",
    eligibility: {
      eligibleForRanking: true, eligibleForActionableTrade: true,
      liquidityStatus: "HIGH", dataQualityStatus: "VALID", exclusionReasons: [],
    },
    quoteAt: NOW,
    dataAgeMs: 1000,
    dataQuality: "VALID",
  };
  return { ...base, ...over };
}

// ------------------------------------------- scenarios 1–5: direction + volume + OI
describe("scenarios 1–5: price / volume / OI combinations", () => {
  it("1. rising price + rising volume + rising OI → strong bullish momentum", () => {
    const s = snap({
      changePct: 3, atrMove: 1.4, rvol: 2.5,
      change5mPct: 0.9, change15mPct: 2.0, priceAcceleration: 0.1,
      oi5m: OI_VALID(0.6), oi15m: OI_VALID(0.5), oiSession: OI_VALID(0.4),
      rsVsIndex: 1.5,
      futures: { interpretation: "LONG_BUILDUP_CANDIDATE", priceChangePct: 3, oiChangePct: 4, note: "" },
    });
    const m = classifyMomentum(s);
    expect(m.direction).toBe(1);
    expect(["STRONG_BULLISH", "BULLISH"]).toContain(m.classification);
    expect(m.score).toBeGreaterThan(50);
    expect(m.confirmationCount).toBeGreaterThanOrEqual(3);
  });

  it("2. falling price + rising volume + rising OI → strong bearish momentum", () => {
    const s = snap({
      changePct: -3, atrMove: -1.4, rvol: 2.5,
      change5mPct: -0.9, change15mPct: -2.0,
      oi5m: OI_VALID(-0.6), oi15m: OI_VALID(-0.5), oiSession: OI_VALID(-0.4),
      rsVsIndex: -1.5,
      futures: { interpretation: "SHORT_BUILDUP_CANDIDATE", priceChangePct: -3, oiChangePct: 4, note: "" },
    });
    const m = classifyMomentum(s);
    expect(m.direction).toBe(-1);
    expect(["STRONG_BEARISH", "BEARISH"]).toContain(m.classification);
    expect(m.score).toBeGreaterThan(50);
  });

  it("3. rising price + falling OI → momentum without OI confirmation", () => {
    const s = snap({
      changePct: 2.5, atrMove: 1.2, rvol: 1.8,
      oi5m: OI_VALID(-0.4), oi15m: OI_VALID(-0.3), oiSession: OI_VALID(-0.2),
    });
    const m = classifyMomentum(s);
    expect(m.direction).toBe(1);
    // OI opposes: never allowed to be STRONG
    expect(m.classification).not.toBe("STRONG_BULLISH");
    expect(m.conflicts.some((c) => /OI/.test(c))).toBe(true);
    // dominance must also record the conflict
    const d = classifyDominance(s);
    expect(d.dominantSide).toBe("BUYER");
    expect(d.conflicts.length).toBeGreaterThan(0);
  });

  it("4. falling price + falling OI → bearish momentum, dominance balanced/absorption", () => {
    const s = snap({
      changePct: -2, atrMove: -0.9, rvol: 1.2,
      oi5m: OI_VALID(-0.5), oi15m: OI_VALID(-0.4),
    });
    const m = classifyMomentum(s);
    expect(m.direction).toBe(-1);
    const d = classifyDominance(s);
    expect(d.dominantSide).not.toBe("BUYER");
  });

  it("5. high volume WITHOUT directional movement → no momentum, no dominance side", () => {
    const s = snap({ changePct: 0, atrMove: 0, rvol: 5, changeExact: true });
    const m = classifyMomentum(s);
    expect(m.direction).toBe(0);
    expect(m.classification).toBe("NEUTRAL");
    expect(m.score).toBeLessThan(30);
    expect(m.pending.some((p) => /participation is not momentum/i.test(p))).toBe(true);
    const d = classifyDominance(s);
    expect(d.dominantSide).toBe("NEITHER");
    expect(["BALANCED", "ABSORPTION_WATCH"]).toContain(d.classification);
  });
});

// ---------------------------------------------- scenarios 6–7: engine disagreement
describe("scenarios 6–7: momentum vs pressure divergence", () => {
  it("6. strong momentum but weakening CVD → dominance weakens", () => {
    const s = snap({
      changePct: 3, atrMove: 1.4, rvol: 2, change15mPct: 2.0, change5mPct: 0.8,
      flow: { available: true, status: "ESTIMATED", deltaRatio: -0.3, cvdSlope: -500, cvdNow: -1200, attributionPct: 80, sameSource: true, reason: "est" },
      oi5m: OI_VALID(0.4),
    });
    const m = classifyMomentum(s);
    const d = classifyDominance(s);
    expect(m.direction).toBe(1); // momentum still bullish
    expect(d.classification).not.toBe("STRONG_BUYER_DOMINANCE");
    // the divergence is detected and labelled
    expect(d.divergence.detected).toBe(true);
    expect(d.divergence.bearish).toBe(true);
  });

  it("7. weak momentum but improving buyer pressure → dominance builds", () => {
    const s = snap({
      changePct: 0.4, atrMove: 0.15, rvol: 1.6,
      flow: { available: true, status: "ESTIMATED", deltaRatio: 0.6, cvdSlope: 800, cvdNow: 900, attributionPct: 85, sameSource: true, reason: "est" },
      oi5m: OI_VALID(0.5), oi15m: OI_VALID(0.3),
    });
    const m = classifyMomentum(s);
    const d = classifyDominance(s);
    expect(m.classification).not.toBe("STRONG_BULLISH"); // momentum is modest
    expect(d.dominantSide).toBe("BUYER");
    expect(["BUYING_PRESSURE_BUILDING", "BUYER_DOMINANCE"]).toContain(d.classification);
  });
});

// ------------------------------------- scenarios 8–11: zones and OI confirmation
describe("scenarios 8–11: zone behaviour and OI confirmation", () => {
  it("8. resistance rejection with increasing seller pressure", () => {
    const s = snap({
      changePct: -0.6, atrMove: -0.3, rvol: 2.2,
      zoneAcceptance: "REJECTED_AT_RESISTANCE", nearestResistance: 100.2,
      flow: { available: true, status: "ESTIMATED", deltaRatio: -0.5, cvdSlope: -700, cvdNow: -400, attributionPct: 80, sameSource: true, reason: "est" },
      oi5m: OI_VALID(-0.5), oi15m: OI_VALID(-0.4),
    });
    const d = classifyDominance(s);
    expect(d.dominantSide).toBe("SELLER");
    expect(d.evidence.some((e) => /rejected at resistance/i.test(e))).toBe(true);
  });

  it("9. resistance breakout with sustained buying pressure", () => {
    const s = snap({
      changePct: 2.2, atrMove: 1.1, rvol: 2.4, ltp: 106.5,
      zoneAcceptance: "ACCEPTED_ABOVE", nearestResistance: 106,
      change5mPct: 1.0, change15mPct: 1.8,
      flow: { available: true, status: "ESTIMATED", deltaRatio: 0.55, cvdSlope: 900, cvdNow: 1500, attributionPct: 85, sameSource: true, reason: "est" },
      oi5m: OI_VALID(0.5), oi15m: OI_VALID(0.45),
    });
    const d = classifyDominance(s);
    expect(d.dominantSide).toBe("BUYER");
    expect(["STRONG_BUYER_DOMINANCE", "BUYER_DOMINANCE"]).toContain(d.classification);
  });

  it("10. support breakdown with increasing selling pressure", () => {
    const s = snap({
      changePct: -2.0, atrMove: -1.0, rvol: 2.3, ltp: 95.5,
      zoneAcceptance: "ACCEPTED_BELOW", nearestSupport: 96,
      flow: { available: true, status: "ESTIMATED", deltaRatio: -0.5, cvdSlope: -800, cvdNow: -900, attributionPct: 80, sameSource: true, reason: "est" },
      oi5m: OI_VALID(-0.5), oi15m: OI_VALID(-0.4),
    });
    const d = classifyDominance(s);
    expect(d.dominantSide).toBe("SELLER");
    expect(d.evidence.some((e) => /accepted below/i.test(e))).toBe(true);
  });

  it("11. price breakout WITHOUT OI confirmation is not strong momentum", () => {
    const s = snap({
      changePct: 2.0, atrMove: 1.0, rvol: 1.5,
      zoneAcceptance: "ACCEPTED_ABOVE", ltp: 106.5, nearestResistance: 106,
      oi5m: OI_MISSING(), oi15m: OI_MISSING(),
    });
    const m = classifyMomentum(s);
    expect(m.classification).not.toBe("STRONG_BULLISH");
    expect(m.oiStatus).not.toBe("VALID");
    expect(m.pending.some((p) => /OI unavailable/i.test(p))).toBe(true);
  });
});

// ------------------------------------------ scenarios 12–14: data-quality gating
describe("scenarios 12–14: conflicting and missing OI, stale data", () => {
  it("12. conflicting 5m and 15m OI is surfaced, not averaged", () => {
    const s = snap({
      changePct: 2, atrMove: 1, rvol: 1.8,
      oi5m: OI_VALID(0.6), oi15m: OI_VALID(-0.5),
    });
    const m = classifyMomentum(s);
    expect(m.conflicts.some((c) => /opposite directions/i.test(c))).toBe(true);
    expect(m.classification).toBe("MOMENTUM_WEAKENING");
  });

  it("13. missing 5m/15m OI history → OI unavailable, never neutral", () => {
    const s = snap({
      changePct: 2, atrMove: 1, rvol: 1.8,
      oi5m: OI_MISSING("COLLECTING"), oi15m: OI_MISSING("INSUFFICIENT_HISTORY"),
    });
    const m = classifyMomentum(s);
    expect(m.oiStatus).not.toBe("VALID");
    expect(m.pending.some((p) => /5-minute OI unavailable/i.test(p))).toBe(true);
    expect(m.pending.some((p) => /15-minute OI unavailable/i.test(p))).toBe(true);
    // and the breakdown records zero contribution with the real status
    const o5 = m.breakdown.find((b) => b.k.includes("5-minute OI"));
    expect(o5!.v).toBe(0);
    expect(o5!.status).toBe("COLLECTING");
  });

  it("14. stale market data is excluded from ranking", () => {
    const s = snap({
      changePct: 3, atrMove: 1.4, rvol: 2.5,
      dataQuality: "STALE_DATA", dataAgeMs: 300_000,
      eligibility: {
        eligibleForRanking: false, eligibleForActionableTrade: false,
        liquidityStatus: "HIGH", dataQualityStatus: "STALE_DATA",
        exclusionReasons: ["market data is stale"],
      },
    });
    const m = classifyMomentum(s);
    const d = classifyDominance(s);
    expect(m.eligibleForRanking).toBe(false);
    expect(d.eligibleForRanking).toBe(false);
    expect(m.eligibleForActionableTrade).toBe(false);
  });
});

// ------------------------------------------------- scenario 15: low liquidity
describe("scenario 15: low liquidity consistency across both engines", () => {
  it("a low-liquidity stock stays visible but is NOT_ACTIONABLE in BOTH engines", () => {
    const elig = {
      eligibleForRanking: true, eligibleForActionableTrade: false,
      liquidityStatus: "INSUFFICIENT" as const, dataQualityStatus: "VALID" as const,
      exclusionReasons: ["turnover ₹3 Cr below the ₹25 Cr actionable floor — visible in rankings but NOT_ACTIONABLE"],
    };
    const s = snap({ changePct: 3, atrMove: 1.4, rvol: 2, turnoverCr: 3, eligibility: elig });
    const m = classifyMomentum(s);
    const d = classifyDominance(s);
    // consistent: BOTH keep it visible
    expect(m.eligibleForRanking).toBe(true);
    expect(d.eligibleForRanking).toBe(true);
    // and BOTH mark it not actionable
    expect(m.eligibleForActionableTrade).toBe(false);
    expect(d.eligibleForActionableTrade).toBe(false);
    expect(m.pending.some((p) => /NOT_ACTIONABLE/i.test(p))).toBe(true);
  });
});

// ------------------------- Phase 4: independence and no double-counting
describe("Phase 4: engine independence and no double-counting", () => {
  it("momentum and dominance produce DIFFERENT scores from the same facts", () => {
    const s = snap({
      changePct: 2.5, atrMove: 1.2, rvol: 2,
      change5mPct: 0.9, change15mPct: 2.0,
      flow: { available: true, status: "ESTIMATED", deltaRatio: 0.5, cvdSlope: 400, cvdNow: 600, attributionPct: 80, sameSource: true, reason: "est" },
      oi5m: OI_VALID(0.4), oi15m: OI_VALID(0.3),
    });
    const m = classifyMomentum(s);
    const d = classifyDominance(s);
    expect(m.score).not.toBe(d.dominanceScore);
    // they use different factor sets, so the numbers must differ
    expect(m.breakdown.map((b) => b.k)).not.toEqual(d.breakdown.map((b) => b.k));
  });

  it("momentum score never appears inside the dominance breakdown, and vice versa", () => {
    const s = snap({ changePct: 2, atrMove: 1, rvol: 2 });
    const m = classifyMomentum(s);
    const d = classifyDominance(s);
    for (const b of d.breakdown) expect(b.k.toLowerCase()).not.toContain("momentum");
    for (const b of m.breakdown) expect(b.k.toLowerCase()).not.toContain("dominance");
  });

  it("Delta and CVD from the same stream are NOT independent confirmations", () => {
    const s = snap({
      changePct: 2, atrMove: 1, rvol: 2,
      flow: { available: true, status: "ESTIMATED", deltaRatio: 0.5, cvdSlope: 500, cvdNow: 700, attributionPct: 80, sameSource: true, reason: "est" },
    });
    const d = classifyDominance(s);
    const cvd = d.breakdown.find((b) => /CVD/.test(b.k))!;
    expect(cvd.k).toMatch(/correlated with Delta/i); // labelled as correlated
    // CVD weight is a bounded bonus, not the full 10
    expect(cvd.v).toBeLessThanOrEqual(DEFAULT_DOMINANCE_WEIGHTS.cvd * 0.5);
  });

  it("estimated flow is labelled ESTIMATED, never exchange-confirmed", () => {
    const s = snap({
      flow: { available: true, status: "ESTIMATED", deltaRatio: 0.5, cvdSlope: 500, cvdNow: 700, attributionPct: 80, sameSource: true, reason: "est" },
    });
    const d = classifyDominance(s);
    expect(d.deltaStatus).toBe("ESTIMATED");
    expect(d.evidence.some((e) => /ESTIMATED/i.test(e))).toBe(true);
    expect(d.evidence.some((e) => /exchange-confirmed/i.test(e))).toBe(false);
  });

  it("a stock cannot be strongly buyer- and seller-dominant simultaneously", () => {
    const s = snap({ changePct: 2, atrMove: 1, rvol: 2 });
    const d = classifyDominance(s);
    expect(d.buyerScore).not.toBe(d.sellerScore); // sides are contested
    expect(d.dominantSide).not.toBe("NEITHER");
    // only one side can win
    expect(d.classification).not.toMatch(/SELLER/);
  });
});

// ------------------------------ dominance classification breadth
describe("dominance classifications", () => {
  it("covers building, weakening, balanced and absorption states", () => {
    const building = classifyDominance(snap({
      changePct: 0.5, atrMove: 0.2, rvol: 1.5,
      flow: { available: true, status: "ESTIMATED", deltaRatio: 0.6, cvdSlope: 900, cvdNow: 400, attributionPct: 85, sameSource: true, reason: "est" },
      oi5m: OI_VALID(0.5),
    }));
    expect(["BUYING_PRESSURE_BUILDING", "BUYER_DOMINANCE"]).toContain(building.classification);

    const balanced = classifyDominance(snap({ changePct: 0.1, atrMove: 0.05, rvol: 1 }));
    expect(["BALANCED", "ABSORPTION_WATCH"]).toContain(balanced.classification);

    const absorption = classifyDominance(snap({
      changePct: 0.05, atrMove: 0.1, rvol: 3, ltp: 96.1, nearestSupport: 96,
      zoneAcceptance: "HELD_AT_SUPPORT",
      flow: { available: true, status: "ESTIMATED", deltaRatio: -0.3, cvdSlope: -100, cvdNow: -50, attributionPct: 80, sameSource: true, reason: "est" },
    }));
    expect(absorption.absorption.detected).toBe(true);
    expect(absorption.absorption.side).toBe("BUYER");
  });

  it("a reversal requires actual evidence, not just proximity to a zone", () => {
    // near resistance but nothing divergent
    const nearZone = classifyDominance(snap({
      changePct: 0.4, atrMove: 0.2, rvol: 1.2, ltp: 105.9, nearestResistance: 106,
      zoneAcceptance: "TESTING",
    }));
    expect(nearZone.reversalEvidence.detected).toBe(false);

    // same proximity but WITH divergent flow → reversal candidate
    const withEvidence = classifyDominance(snap({
      changePct: 0.4, atrMove: 0.2, rvol: 1.2, ltp: 105.9, nearestResistance: 106,
      zoneAcceptance: "TESTING",
      flow: { available: true, status: "ESTIMATED", deltaRatio: -0.35, cvdSlope: -600, cvdNow: -300, attributionPct: 80, sameSource: true, reason: "est" },
    }));
    expect(withEvidence.reversalEvidence.detected).toBe(true);
    expect(withEvidence.classification).toBe("POSSIBLE_REVERSAL");
  });
});

// --------------------------- momentum classification breadth
describe("momentum classifications", () => {
  it("distinguishes strong, plain, candidate and weakening", () => {
    const strong = classifyMomentum(snap({
      changePct: 3.5, atrMove: 1.6, rvol: 2.8,
      change5mPct: 1.2, change15mPct: 2.2, priceAcceleration: 0.1,
      oi5m: OI_VALID(0.6), oi15m: OI_VALID(0.5), oiSession: OI_VALID(0.4),
      rsVsIndex: 2,
    }));
    expect(strong.classification).toBe("STRONG_BULLISH");

    const candidate = classifyMomentum(snap({ changePct: 0.5, atrMove: 0.22, rvol: 1.1 }));
    expect(candidate.classification).toBe("BULLISH_CANDIDATE");

    const weakening = classifyMomentum(snap({
      changePct: 2, atrMove: 1, rvol: 1.8,
      oi5m: OI_VALID(0.6), oi15m: OI_VALID(-0.5),
    }));
    expect(weakening.classification).toBe("MOMENTUM_WEAKENING");
  });

  it("a single 5m spike is not treated as sustained momentum", () => {
    const s = snap({
      changePct: 1.2, atrMove: 0.5, rvol: 1.5,
      change5mPct: 1.1, change15mPct: -0.3, // 15m disagrees
    });
    const m = classifyMomentum(s);
    expect(m.classification).not.toBe("STRONG_BULLISH");
    expect(m.conflicts.some((c) => /15-minute price change.*opposes/i.test(c))).toBe(true);
    expect(m.accelerating).toBeFalsy();
  });
});

// ------------------------------- scenario 16: rate-limit behaviour
describe("scenario 16: API rate-limit response", () => {
  it("a rate-limited OI window is reported as API_ERROR, not zero", () => {
    const s = snap({ changePct: 2, atrMove: 1, oi5m: OI_MISSING("API_ERROR") });
    const m = classifyMomentum(s);
    const o5 = m.breakdown.find((b) => b.k.includes("5-minute OI"))!;
    expect(o5.status).toBe("API_ERROR");
    expect(o5.v).toBe(0);
    expect(m.oiStatus).not.toBe("VALID");
  });

  it("rate-limited flow is not counted as confirmation", () => {
    const s = snap({
      changePct: 2, atrMove: 1,
      flow: { available: false, status: "API_ERROR", deltaRatio: null, cvdSlope: null, cvdNow: null, attributionPct: 0, sameSource: true, reason: "HTTP 429" },
    });
    const d = classifyDominance(s);
    const f = d.breakdown.find((b) => /Delta/.test(b.k))!;
    expect(f.status).toBe("API_ERROR");
    expect(d.pending.some((p) => /order-flow evidence unavailable/i.test(p))).toBe(true);
  });
});
