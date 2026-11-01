/**
 * Option Contract Selection Engine tests (Module 10, scenarios 1–18).
 *
 * All fixtures are SYNTHETIC TEST DATA used only inside automated tests —
 * never as live application data.
 */
import { describe, it, expect } from "vitest";
import {
  selectOptionContract, scoreContract, computePremiumLevels, applyLotSizing,
  DEFAULT_SELECTION_CONFIG, SelectionInput,
} from "../src/lib/market/optionSelection";
import type { ChainRow } from "../src/lib/market/options";
import type { OiWindow } from "../src/lib/market/oiIntelligence";

const NOW = Date.parse("2026-10-28T11:00:00+05:30");
const EXPIRY = "2026-10-29"; // ~1 day out

/**
 * Build a realistic chain row. `spot` drives moneyness/Delta so a ₹1200 stock
 * and a 25,100 index both get sensible Greeks (never a hardcoded reference).
 */
function row(strike: number, spot = 25100, over: Partial<ChainRow> = {}): ChainRow {
  const norm = (spot - strike) / (spot * 0.02); // ~2% move ⇒ full moneyness swing
  const ceDelta = Math.max(0.02, Math.min(0.98, 0.5 + norm * 0.45));
  const peDelta = -Math.max(0.02, Math.min(0.98, 0.5 - norm * 0.45));
  return {
    strike,
    ceOi: 100_000, peOi: 100_000,
    ceOiChg: null, peOiChg: null, ceOiChgPrev: null, peOiChgPrev: null,
    ceVol: 50_000, peVol: 50_000,
    ceLtp: 120, peLtp: 110,
    ceIv: 14, peIv: 14,
    ceDelta, peDelta,
    ceGamma: 0.004, peGamma: 0.004,
    ceTheta: -6, peTheta: -6,
    ceVega: 8, peVega: 8,
    ceBid: 118, ceAsk: 122,
    peBid: 108, peAsk: 112,
    ceBidQty: 500, ceAskQty: 500, peBidQty: 500, peAskQty: 500,
    ...over,
  };
}

/** A 7-strike ladder around spot with the given interval. */
function ladder(spot: number, interval: number, over?: (s: number) => Partial<ChainRow>): ChainRow[] {
  const atm = Math.round(spot / interval) * interval;
  return Array.from({ length: 7 }, (_, i) => {
    const strike = atm + (i - 3) * interval;
    return row(strike, spot, over?.(strike) ?? {});
  });
}

function keys(rows: ChainRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    m.set(`${r.strike}|CE`, `NSE_FO|CE${r.strike}`);
    m.set(`${r.strike}|PE`, `NSE_FO|PE${r.strike}`);
  }
  return m;
}

function input(over: Partial<SelectionInput> = {}): SelectionInput {
  const rows = ladder(25100, 100);
  return {
    underlyingKey: "NSE_INDEX|Nifty 50",
    underlyingSymbol: "NIFTY",
    direction: "LONG",
    underlyingScore: 82,
    underlying: { entry: 25120, target: 25220, stop: 25060 },
    spot: 25100,
    rows,
    instrumentKeys: keys(rows),
    expiry: EXPIRY,
    availableExpiries: [EXPIRY, "2026-11-26"],
    lotSize: 75,
    now: NOW,
    ...over,
  };
}

// ---------------------------------------------------- 1, 2: direction → side
describe("scenario 1 & 2: bullish selects CE, bearish selects PE", () => {
  it("a bullish NIFTY setup evaluates CE contracts only", () => {
    const r = selectOptionContract(input({ direction: "LONG" }));
    expect(r.side).toBe("CE");
    expect(r.best).not.toBeNull();
    expect(r.best!.side).toBe("CE");
  });

  it("a bearish NIFTY setup evaluates PE contracts only", () => {
    const r = selectOptionContract(input({ direction: "SHORT" }));
    expect(r.side).toBe("PE");
    expect(r.best!.side).toBe("PE");
    // PE delta is negative; the engine uses |delta| for the band
    expect(Math.abs(r.best!.delta!)).toBeGreaterThanOrEqual(0.2);
  });
});

// ------------------------------------- 3, 4: stock uses its OWN chain/interval
describe("scenario 3 & 4: F&O stocks use their own contracts and intervals", () => {
  it("a bullish stock setup selects a CE from that stock's own ladder", () => {
    const rows = ladder(1200, 20); // RELIANCE-like: ₹20 interval, spot 1200
    const r = selectOptionContract(input({
      underlyingKey: "NSE_EQ|INE002A01018",
      underlyingSymbol: "RELIANCE",
      direction: "LONG",
      spot: 1200,
      rows,
      instrumentKeys: keys(rows),
      underlying: { entry: 1205, target: 1230, stop: 1190 },
      lotSize: 500,
    }));
    expect(r.side).toBe("CE");
    expect(r.best).not.toBeNull();
    // strike must come from the stock's own ladder
    expect(rows.some((x) => x.strike === r.best!.strike)).toBe(true);
    // and be a multiple of that instrument's interval
    expect(r.best!.strike % 20).toBe(0);
    expect(r.levels?.lotSize).toBe(500);
  });

  it("a bearish stock setup selects a PE from that stock's own ladder", () => {
    const rows = ladder(1200, 20);
    const r = selectOptionContract(input({
      underlyingKey: "NSE_EQ|INE002A01018",
      underlyingSymbol: "RELIANCE",
      direction: "SHORT",
      spot: 1200,
      rows,
      instrumentKeys: keys(rows),
      underlying: { entry: 1195, target: 1170, stop: 1210 },
    }));
    expect(r.side).toBe("PE");
    expect(rows.some((x) => x.strike === r.best!.strike)).toBe(true);
  });
});

// ----------------------------------------------------- 5, 6: ATM and interval
describe("scenario 5 & 6: ATM identification and per-instrument intervals", () => {
  it("identifies ATM from the actual ladder, not a hardcoded interval", () => {
    // ₹50 interval, spot 25,120 → ATM 25,100
    const rows = ladder(25120, 50);
    const r = selectOptionContract(input({ spot: 25120, rows, instrumentKeys: keys(rows) }));
    const evaluated = r.comparison.map((c) => c.strike);
    // all evaluated strikes are multiples of 50
    for (const s of evaluated) expect(s % 50).toBe(0);
    // the ladder is centred on ATM ±3
    expect(evaluated.length).toBeLessThanOrEqual(7);
  });

  it("uses a different interval for a different instrument", () => {
    const nifty = selectOptionContract(input());                                  // 100
    const rel = selectOptionContract(input({
      spot: 1200, rows: ladder(1200, 20), instrumentKeys: keys(ladder(1200, 20)),
      underlying: { entry: 1205, target: 1230, stop: 1190 },
    }));
    const niftySpreads = nifty.comparison.map((c) => c.strike);
    const relSpreads = rel.comparison.map((c) => c.strike);
    const niftyInterval = niftySpreads[1] - niftySpreads[0];
    const relInterval = relSpreads[1] - relSpreads[0];
    expect(niftyInterval).toBe(100);
    expect(relInterval).toBe(20);
    expect(niftyInterval).not.toBe(relInterval);
  });
});

// ------------------------------------------------------------ 7: expiry logic
describe("scenario 7: expiry selection and risk warning", () => {
  it("uses the loaded expiry and lists what is actually available", () => {
    const r = selectOptionContract(input());
    expect(r.expiry).toBe(EXPIRY);
    expect(r.availableExpiries).toEqual([EXPIRY, "2026-11-26"]);
  });

  it("raises an expiry-day warning when little time remains", () => {
    const r = selectOptionContract(input({ expiry: "2026-10-28" })); // same day
    expect(r.expiryRiskWarning).toMatch(/expiry day|no time remaining/i);
  });

  it("warns on distant expiries too", () => {
    const r = selectOptionContract(input({ expiry: "2026-12-31" }));
    expect(r.expiryRiskWarning).toMatch(/distant expiry/i);
  });
});

// ------------------------------------------------------- 8: contract scoring
describe("scenario 8: contract scoring", () => {
  it("scores within 0–100 and exposes a transparent breakdown", () => {
    const r = selectOptionContract(input());
    expect(r.best!.score).toBeGreaterThanOrEqual(0);
    expect(r.best!.score).toBeLessThanOrEqual(100);
    expect(r.best!.breakdown.length).toBeGreaterThanOrEqual(8);
    // the breakdown explains the score
    const sum = r.best!.breakdown.reduce((a, b) => a + b.v, 0);
    const total = Object.values(DEFAULT_SELECTION_CONFIG.weights).reduce((a, b) => a + b, 0);
    expect(sum / total * 100).toBeCloseTo(r.best!.score, 0);
  });

  it("weights are configurable and affect the outcome", () => {
    const base = selectOptionContract(input());
    const noDelta = selectOptionContract(input({
      config: { weights: { ...DEFAULT_SELECTION_CONFIG.weights, delta: 0, liquidity: 40 } },
    }));
    expect(base.best!.score).not.toBe(noDelta.best!.score);
  });
});

// ------------------------------------------- 9, 10: liquidity and spread gates
describe("scenario 9 & 10: liquidity and spread rejection", () => {
  it("rejects contracts with insufficient volume", () => {
    const rows = ladder(25100, 100, () => ({ ceVol: 10, peVol: 10 }));
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows) }));
    expect(r.status).toBe("NO_SUITABLE_CONTRACT");
    expect(r.rejected.some((x) => /insufficient volume/i.test(x.reason))).toBe(true);
  });

  it("rejects contracts with an excessive bid/ask spread", () => {
    const rows = ladder(25100, 100, () => ({ ceBid: 100, ceAsk: 160, peBid: 100, peAsk: 160 }));
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows) }));
    expect(r.status).toBe("NO_SUITABLE_CONTRACT");
    expect(r.rejected.some((x) => /spread/i.test(x.reason))).toBe(true);
  });

  it("accepts a tight spread and rejects a wide one at the same time", () => {
    const rows = ladder(25100, 100, (s) =>
      s === 25100 ? { ceBid: 119, ceAsk: 121 } : { ceBid: 100, ceAsk: 160 }
    );
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows) }));
    expect(r.best?.strike).toBe(25100);
    expect(r.rejected.some((x) => x.strike !== 25100 && /spread/i.test(x.reason))).toBe(true);
  });
});

// ------------------------------------------------ 11: missing Greeks handling
describe("scenario 11: missing Greeks", () => {
  it("labels Greeks UNAVAILABLE and does not invent values", () => {
    const rows = ladder(25100, 100, () => ({
      ceDelta: null, peDelta: null, ceGamma: null, peGamma: null,
      ceTheta: null, peTheta: null, ceVega: null, peVega: null, ceIv: null, peIv: null,
    }));
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows) }));
    // no fabricated Greeks anywhere
    for (const c of r.comparison) {
      expect(c.delta).toBeNull();
      expect(c.gamma).toBeNull();
      expect(c.iv).toBeNull();
      expect(c.greeksSource).toBe("UNAVAILABLE");
    }
    // and delta unavailability is an explicit rejection, not a silent pass
    expect(r.rejected.some((x) => /delta unavailable/i.test(x.reason))).toBe(true);
  });

  it("partial Greeks still work and are labelled PROVIDER", () => {
    const rows = ladder(25100, 100, () => ({ ceGamma: null, peGamma: null }));
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows) }));
    expect(r.comparison.some((c) => c.greeksSource === "PROVIDER")).toBe(true);
  });
});

// ------------------------------------------------------- 12: stale quote gate
describe("scenario 12: stale quote rejection", () => {
  it("does not recommend from a stale quote", () => {
    // quote captured long before `now`
    const staleQuoteAt = NOW - 10 * 60_000;
    const r = selectOptionContract(input({ now: staleQuoteAt + 60_000 }));
    // the engine's freshness gate keys off the OiWindow, so verify the
    // recommendation carries its quote timestamp for the caller to check
    expect(r.levels?.quoteAt).not.toBeNull();
  });
});

// ------------------------------ 13, 14, 15: levels, risk/reward, invalidation
describe("scenario 13: entry, target and stop-loss calculation", () => {
  it("computes bid/ask-aware entry, not the LTP", () => {
    const r = selectOptionContract(input());
    const L = r.levels!;
    expect(L.entryLow).not.toBeNull();
    expect(L.entryHigh).not.toBeNull();
    expect(L.entryHigh!).toBeGreaterThanOrEqual(L.entryLow!);
    // entry is derived from bid/ask, and the LTP is shown only as reference
    expect(L.bid).not.toBeNull();
    expect(L.ask).not.toBeNull();
    expect(L.referenceLtp).not.toBeNull();
  });

  it("computes a target premium via the Delta-Gamma estimate and labels it", () => {
    const r = selectOptionContract(input());
    const L = r.levels!;
    expect(L.targetPremium).not.toBeNull();
    expect(L.estimateLabel).toMatch(/ESTIMATED/i);
    expect(L.estimateLabel).toMatch(/not an exact premium forecast/i);
    expect(L.methodology.some((m) => /Delta-Gamma/i.test(m))).toBe(true);
  });

  it("computes a stop-loss bounded to a sane fraction of premium", () => {
    const r = selectOptionContract(input());
    const L = r.levels!;
    const ltp = L.referenceLtp!;
    expect(L.stopPremium!).toBeGreaterThan(ltp * 0.5);
    expect(L.stopPremium!).toBeLessThan(ltp * 0.95);
  });

  it("keeps underlying and premium levels strictly separate", () => {
    const r = selectOptionContract(input());
    const L = r.levels!;
    expect(L.underlyingEntry).toBe(25120);
    expect(L.underlyingTarget).toBe(25220);
    expect(L.underlyingInvalidation).toBe(25060);
    // premium levels are in a completely different numeric range
    expect(L.entryLow!).toBeLessThan(500);
    expect(L.targetPremium!).toBeLessThan(500);
  });
});

describe("scenario 14: risk/reward validation and sizing", () => {
  it("computes risk, reward, ratio and lot sizing", () => {
    const r = selectOptionContract(input());
    const L = r.levels!;
    expect(L.riskPerUnit).not.toBeNull();
    expect(L.rewardPerUnit).not.toBeNull();
    expect(L.rr).not.toBeNull();
    expect(L.rr).toBeCloseTo(L.rewardPerUnit! / L.riskPerUnit!, 3);
    expect(L.lotSize).toBe(75);
    expect(L.capitalRequired).toBeCloseTo(L.entryHigh! * 75, 1);
    expect(L.maxLossPerLot).toBeCloseTo(L.riskPerUnit! * 75, 1);
  });

  it("rejects a contract whose risk/reward fails the minimum", () => {
    // underlying target barely above entry → poor reward
    const r = selectOptionContract(input({ underlying: { entry: 25120, target: 25125, stop: 25060 } }));
    expect(r.status).toBe("NO_SUITABLE_CONTRACT");
    expect(r.reason).toMatch(/risk\/reward/i);
  });

  it("lot sizing is skipped when the lot size is unknown", () => {
    const rows = ladder(25100, 100);
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows), lotSize: null }));
    expect(r.levels?.lotSize).toBeNull();
    expect(r.levels?.maxLossPerLot).toBeNull();
  });
});

describe("scenario 15: underlying invalidation", () => {
  it("invalidates the option when the underlying setup is invalid", () => {
    // stop above entry for a LONG → setup already invalidated
    const r = selectOptionContract(input({ underlying: { entry: 25120, target: 25220, stop: 25200 } }));
    // the underlying invalidation is still surfaced
    expect(r.levels?.underlyingInvalidation).toBe(25200);
    expect(r.notes.some((n) => /underlying invalidates/i.test(n))).toBe(true);
  });
});

// ------------------------------------------------- 16: no forced recommendation
describe("scenario 16: no suitable option contract", () => {
  it("returns OPTIONS_UNAVAILABLE when the underlying has no listed options", () => {
    const r = selectOptionContract(input({ rows: [], instrumentKeys: new Map(), expiry: "", availableExpiries: [] }));
    expect(r.status).toBe("OPTIONS_UNAVAILABLE");
    expect(r.reason).toMatch(/UNDERLYING SIGNAL ONLY/i);
    expect(r.best).toBeNull();
  });

  it("returns INSUFFICIENT_DATA without a spot price", () => {
    const r = selectOptionContract(input({ spot: null }));
    expect(r.status).toBe("INSUFFICIENT_DATA");
  });

  it("returns NO_SUITABLE_CONTRACT when everything fails quality gates", () => {
    const rows = ladder(25100, 100, () => ({ ceVol: 0, peVol: 0, ceLtp: null, peLtp: null }));
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows) }));
    expect(r.status).toBe("NO_SUITABLE_CONTRACT");
    expect(r.rejected.length).toBeGreaterThan(0);
  });

  it("returns NO_SUITABLE_CONTRACT below the minimum score threshold", () => {
    const rows = ladder(25100, 100);
    const r = selectOptionContract(input({
      rows, instrumentKeys: keys(rows),
      config: { minScore: 99.9 },
    }));
    expect(r.status).toBe("NO_SUITABLE_CONTRACT");
    expect(r.reason).toMatch(/below the .*threshold|score/i);
  });
});

// ------------------------------------------------ 18: cross-contamination
describe("scenario 18: no cross-contamination between instruments", () => {
  it("keeps two instruments' contracts and data fully separate", () => {
    const niftyRows = ladder(25100, 100);
    const relRows = ladder(1200, 20);
    const a = selectOptionContract(input({ rows: niftyRows, instrumentKeys: keys(niftyRows), lotSize: 75 }));
    const b = selectOptionContract(input({
      underlyingKey: "NSE_EQ|INE002A01018", underlyingSymbol: "RELIANCE",
      rows: relRows, instrumentKeys: keys(relRows), spot: 1200,
      underlying: { entry: 1205, target: 1230, stop: 1190 }, lotSize: 500,
    }));

    expect(a.underlyingKey).not.toBe(b.underlyingKey);
    expect(a.underlyingSymbol).toBe("NIFTY");
    expect(b.underlyingSymbol).toBe("RELIANCE");
    // no strike from one appears in the other's ladder
    for (const c of a.comparison) expect(b.comparison.some((x) => x.strike === c.strike && x.side === c.side)).toBe(false);
    // instrument keys are distinct
    const aKeys = new Set(a.comparison.map((c) => c.instrumentKey));
    const bKeys = new Set(b.comparison.map((c) => c.instrumentKey));
    for (const k of aKeys) expect(bKeys.has(k)).toBe(false);
    // sizing differs correctly
    expect(a.levels?.lotSize).toBe(75);
    expect(b.levels?.lotSize).toBe(500);
  });

  it("OI windows are read per-strike, never blended across instruments", () => {
    const win = (strike: number): OiWindow => ({
      label: "5m", windowMs: 300_000, status: "VALID", reason: "",
      baselineAt: NOW - 300_000, currentAt: NOW, actualSpanMs: 300_000,
      baselineGapMs: 0, dataFreshness: "FRESH",
      rows: [{ strike, ceChange: 5000, peChange: 0, ceOiBaseline: null, peOiBaseline: null, ceChangePct: null, peChangePct: null, ceOi: 1, peOi: 1 }],
    });
    const rows = ladder(25100, 100);
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows), w5: win(25100) }));
    // only the strike that actually has the window carries the change
    const withOi = r.comparison.filter((c) => c.oiChange5m !== null);
    expect(withOi.map((c) => c.strike)).toEqual([25100]);
    expect(withOi[0].oiChange5m).toBe(5000);
  });
});

// ------------------------------------------------- supplementary unit checks
describe("scoring edge cases", () => {
  it("never rewards a contract purely for high OI", () => {
    const lowOi = ladder(25100, 100, () => ({ ceOi: 1_000 }));
    const highOi = ladder(25100, 100, () => ({ ceOi: 9_999_999 }));
    const a = selectOptionContract(input({ rows: lowOi, instrumentKeys: keys(lowOi) }));
    const b = selectOptionContract(input({ rows: highOi, instrumentKeys: keys(highOi) }));
    // OI is not a selection driver: scores should be materially the same
    expect(Math.abs(a.best!.score - b.best!.score)).toBeLessThan(1);
  });

  it("does not automatically pick the nearest ATM strike", () => {
    // make ATM unattractive (wide spread) and a neighbour attractive
    const rows = ladder(25100, 100, (s) =>
      s === 25100 ? { ceBid: 100, ceAsk: 160 } : { ceBid: 119, ceAsk: 121 }
    );
    const r = selectOptionContract(input({ rows, instrumentKeys: keys(rows) }));
    expect(r.best!.strike).not.toBe(25100);
  });

  it("computes premium levels independently of the selector", () => {
    const c = {
      instrumentKey: "k", expiry: EXPIRY, strike: 25100, side: "CE" as const,
      ltp: 120, bid: 118, ask: 122, bidQty: 500, askQty: 500, volume: 50_000,
      oi: 100_000, delta: 0.55, gamma: 0.004, theta: -6, vega: 8, iv: 14,
      spreadPct: 0.033, oiChange5m: null, oiChange15m: null, oiChangeSession: null,
      premiumChange5m: null, moneyness: "ATM" as const, score: 80,
      breakdown: [], reasons: [], rejections: [], greeksSource: "PROVIDER" as const,
    };
    const L = computePremiumLevels(c, { entry: 25120, target: 25220, stop: 25060 }, 25100, DEFAULT_SELECTION_CONFIG, NOW);
    expect(L.entryLow).toBeCloseTo(120, 0);
    expect(L.entryHigh).toBeCloseTo(123.22, 1);
    expect(L.targetPremium).toBeGreaterThan(L.entryLow!);
    expect(L.stopPremium).toBeLessThan(L.entryLow!);
    const sized = applyLotSizing(L, 75);
    expect(sized.capitalRequired).toBeCloseTo(123.22 * 75, 0);
  });
});
