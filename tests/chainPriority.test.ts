/**
 * Shortlist-priority option-chain fetching tests (scenarios 1–18).
 *
 * ROOT CAUSE UNDER TEST: the chain scheduler fetched 3 indices + 1 focused
 * instrument + 2 alphabetically-rotated stocks and NEVER consulted the Trade
 * Finder shortlist, so a shortlisted stock had only a ~0.94% chance of a chain
 * per cycle (~53 minutes for a full rotation).
 *
 * All fixtures are synthetic test data used only inside automated tests.
 */
import { describe, it, expect } from "vitest";
import { ChainPriorityQueue, CHAIN_STALE_MS } from "../src/lib/market/chainQueue";

const NIFTY = "NSE_INDEX|Nifty 50";
const BANKNIFTY = "NSE_INDEX|Nifty Bank";
const SENSEX = "BSE_INDEX|SENSEX";
const REL = "NSE_EQ|INE002A01018";
const TCS = "NSE_EQ|INE467B01029";
const INFY = "NSE_EQ|INE009A01024";
const ICICI = "NSE_EQ|INE051A01039";
const HDFC = "NSE_EQ|INE040A01034";
const LT = "NSE_EQ|INE018A01042";
const KAYNES = "NSE_EQ|INE549U01010";

const sym = (k: string) => k.split("|")[1]?.slice(0, 8) ?? k;

function queue(): ChainPriorityQueue {
  const q = new ChainPriorityQueue();
  q.registerIndices([
    { key: NIFTY, symbol: "NIFTY" },
    { key: BANKNIFTY, symbol: "BANKNIFTY" },
    { key: SENSEX, symbol: "SENSEX" },
  ]);
  return q;
}

describe("scenarios 1–3: indices are always fetched at highest priority", () => {
  it("NIFTY, BANKNIFTY and SENSEX are all registered and fetched first", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    const list = q.fetchList(10);
    const first3 = list.slice(0, 3).map((e) => e.underlyingKey);
    expect(first3).toEqual(expect.arrayContaining([NIFTY, BANKNIFTY, SENSEX]));
    for (const e of list.slice(0, 3)) expect(e.priority).toBe("INDEX");
  });

  it("indices are fetched even when nothing is shortlisted", () => {
    const q = queue();
    const list = q.fetchList(10);
    expect(list.map((e) => e.priority)).toEqual(["INDEX", "INDEX", "INDEX"]);
  });
});

describe("scenario 4–5: shortlisted stocks are fetched automatically", () => {
  it("an eligible F&O stock on the shortlist is registered and fetched", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    const list = q.fetchList(10);
    const rel = list.find((e) => e.underlyingKey === REL);
    expect(rel).toBeDefined();
    expect(rel!.priority).toBe("NEW_SHORTLIST");
  });

  it("multiple shortlisted stocks each appear exactly once", () => {
    const q = queue();
    q.syncShortlist([REL, TCS, INFY, ICICI], sym);
    const list = q.fetchList(20);
    const keys = list.map((e) => e.underlyingKey);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
    for (const k of [REL, TCS, INFY, ICICI]) expect(keys).toContain(k);
  });

  it("each shortlisted stock keeps its own queue entry (no shared data)", () => {
    const q = queue();
    q.syncShortlist([REL, TCS], sym);
    const a = q.entry(REL)!;
    const b = q.entry(TCS)!;
    expect(a.underlyingKey).not.toBe(b.underlyingKey);
    expect(a.symbol).not.toBe(b.symbol);
    // independent fetch timestamps
    q.recordAttempt(REL, true, "20 strikes", 1000);
    expect(q.entry(REL)!.lastSuccessfulFetchAt).toBe(1000);
    expect(q.entry(TCS)!.lastSuccessfulFetchAt).toBeNull();
  });
});

describe("scenario 6: six shortlisted stocks all registered despite the old 2-stock rotation", () => {
  it("all six are registered for priority fetching in one cycle", () => {
    const q = queue();
    const six = [REL, TCS, INFY, ICICI, HDFC, LT];
    q.syncShortlist(six, sym);
    const list = q.fetchList(20);
    const shortlisted = list.filter((e) => e.priority === "NEW_SHORTLIST" || e.priority === "ACTIVE_CANDIDATE");
    expect(shortlisted).toHaveLength(6);
    for (const k of six) expect(shortlisted.some((e) => e.underlyingKey === k)).toBe(true);
  });

  it("the fetch budget still bounds the number of requests", () => {
    const q = queue();
    q.syncShortlist([REL, TCS, INFY, ICICI, HDFC, LT, KAYNES, NIFTY], sym);
    const list = q.fetchList(6);
    expect(list).toHaveLength(6);
    // indices win the first slots, then newly shortlisted stocks
    expect(list.slice(0, 3).every((e) => e.priority === "INDEX")).toBe(true);
  });
});

describe("scenario 7–8: priority ageing and duplicate prevention", () => {
  it("a newly shortlisted stock outranks an existing candidate", () => {
    const q = queue();
    q.syncShortlist([REL], sym);          // REL shortlisted in cycle 0
    q.nextCycle();
    q.agePriorities();                   // REL ages to ACTIVE_CANDIDATE
    q.syncShortlist([REL, TCS], sym);    // TCS is the newcomer
    const list = q.fetchList(10);
    const rel = list.find((e) => e.underlyingKey === REL)!;
    const tcs = list.find((e) => e.underlyingKey === TCS)!;
    expect(rel.priority).toBe("ACTIVE_CANDIDATE");
    expect(tcs.priority).toBe("NEW_SHORTLIST");
    expect(list.indexOf(tcs)).toBeLessThan(list.indexOf(rel)); // newcomer first
  });

  it("an existing candidate is refreshed without creating a duplicate entry", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    q.recordAttempt(REL, true, "20 strikes", 1000);
    // same shortlist next cycle
    q.nextCycle();
    const { added } = q.syncShortlist([REL], sym);
    expect(added).toEqual([]);              // nothing re-added
    expect(q.all().filter((e) => e.underlyingKey === REL)).toHaveLength(1);
    expect(q.entry(REL)!.lastSuccessfulFetchAt).toBe(1000); // data preserved
  });
});

describe("scenario 9: removed candidate is demoted, data preserved", () => {
  it("removing a stock from the shortlist demotes it but keeps its chain", () => {
    const q = queue();
    q.syncShortlist([REL, TCS], sym);
    q.recordAttempt(REL, true, "20 strikes", 5000);
    q.nextCycle();
    const { demoted } = q.syncShortlist([TCS], sym); // REL removed
    expect(demoted).toEqual([REL]);
    expect(q.entry(REL)!.priority).toBe("ROTATION");
    expect(q.entry(REL)!.lastSuccessfulFetchAt).toBe(5000); // NOT wiped
    expect(q.entry(TCS)!.priority).not.toBe("ROTATION");
  });
});

describe("scenarios 10–11: availability statuses", () => {
  it("missing option contracts → OPTIONS_UNAVAILABLE", () => {
    const q = queue();
    q.markUnavailable("NSE_EQ|NOOPTIONS", "no listed option contracts in the instrument master", 1);
    expect(q.statusOf("NSE_EQ|NOOPTIONS", 2)).toBe("OPTIONS_UNAVAILABLE");
  });

  it("invalid instrument key → INVALID_INSTRUMENT", () => {
    const q = queue();
    q.markInvalid("NSE_EQ|BOGUS", "instrument key not present in the master", 1);
    expect(q.statusOf("NSE_EQ|BOGUS", 2)).toBe("INVALID_INSTRUMENT");
  });

  it("successful fetch → OPTIONS_AVAILABLE", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    q.markFetching(REL, 1000);
    expect(q.statusOf(REL, 1001)).toBe("FETCHING");
    q.recordAttempt(REL, true, "25 strikes", 2000);
    expect(q.statusOf(REL, 2001)).toBe("OPTIONS_AVAILABLE");
  });

  it("an empty provider response is NOT a success", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    q.recordAttempt(REL, false, "provider returned an empty chain", 1000);
    expect(q.statusOf(REL, 1001)).toBe("FETCH_FAILED");
    expect(q.entry(REL)!.lastSuccessfulFetchAt).toBeNull();
  });
});

describe("scenarios 12–13: failures, backoff and recovery", () => {
  it("a network failure records FETCH_FAILED and counts consecutive failures", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    q.recordAttempt(REL, false, "network error", 1000);
    q.recordAttempt(REL, false, "network error", 2000);
    expect(q.entry(REL)!.consecutiveFailures).toBe(2);
    expect(q.statusOf(REL, 2001)).toBe("FETCH_FAILED");
  });

  it("a later success clears the failure state (safe recovery)", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    q.recordAttempt(REL, false, "HTTP 429", 1000);
    q.recordAttempt(REL, true, "25 strikes", 3000);
    expect(q.entry(REL)!.consecutiveFailures).toBe(0);
    expect(q.statusOf(REL, 3001)).toBe("OPTIONS_AVAILABLE");
    expect(q.entry(REL)!.lastSuccessfulFetchAt).toBe(3000);
  });

  it("a failure never overwrites an older successful fetch timestamp", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    q.recordAttempt(REL, true, "25 strikes", 1000);
    q.recordAttempt(REL, false, "network error", 9000);
    expect(q.entry(REL)!.lastSuccessfulFetchAt).toBe(1000); // preserved
  });
});

describe("scenario 14: staleness", () => {
  it("a successfully fetched chain older than the freshness window is STALE_CHAIN", () => {
    const q = queue();
    q.syncShortlist([REL], sym);
    q.recordAttempt(REL, true, "25 strikes", 1000);
    expect(q.statusOf(REL, 1000 + CHAIN_STALE_MS - 1)).toBe("OPTIONS_AVAILABLE");
    expect(q.statusOf(REL, 1000 + CHAIN_STALE_MS + 1)).toBe("STALE_CHAIN");
  });
});

describe("scenario 15: mapping integrity", () => {
  it("queue entries are keyed by underlying and never blend instruments", () => {
    const q = queue();
    q.syncShortlist([REL, NIFTY], sym);
    const rel = q.entry(REL)!;
    const nifty = q.entry(NIFTY)!;
    expect(rel.underlyingKey).not.toBe(nifty.underlyingKey);
    // the index keeps INDEX priority even while shortlisted
    expect(nifty.priority).toBe("INDEX");
    expect(rel.priority).toBe("NEW_SHORTLIST");
  });

  it("recording an outcome for one instrument never touches another", () => {
    const q = queue();
    q.syncShortlist([REL, TCS], sym);
    q.recordAttempt(REL, true, "20 strikes", 1234);
    expect(q.entry(TCS)!.lastSuccessfulFetchAt).toBeNull();
    expect(q.entry(TCS)!.status).toBe("OPTIONS_UNAVAILABLE");
  });
});

describe("scenario 16: CE/PE mapping via the selection engine", () => {
  it("bullish shortlist analyses CE and bearish analyses PE (contract side mapping)", async () => {
    const { selectOptionContract, DEFAULT_SELECTION_CONFIG } = await import("../src/lib/market/optionSelection");
    const { ladder, keys } = await import("./_chainFixtures");
    const base = {
      underlyingKey: REL, underlyingSymbol: "RELIANCE",
      underlyingScore: 80, spot: 1200,
      rows: ladder(1200, 20), instrumentKeys: keys(ladder(1200, 20)),
      expiry: "2026-10-29", availableExpiries: ["2026-10-29"], lotSize: 500,
      now: Date.now(),
    };
    const bull = selectOptionContract({ ...base, direction: "LONG", underlying: { entry: 1205, target: 1230, stop: 1190 } });
    const bear = selectOptionContract({ ...base, direction: "SHORT", underlying: { entry: 1195, target: 1170, stop: 1210 } });
    expect(bull.side).toBe("CE");
    expect(bear.side).toBe("PE");
    expect(bull.best!.side).toBe("CE");
    expect(bear.best!.side).toBe("PE");
    void DEFAULT_SELECTION_CONFIG;
  });
});

describe("scenario 17–18: frontend mapping and no fabricated recommendations", () => {
  it("each recommendation carries its own underlying identifier", async () => {
    const { selectOptionContract } = await import("../src/lib/market/optionSelection");
    const { ladder, keys } = await import("./_chainFixtures");
    const a = selectOptionContract({
      underlyingKey: REL, underlyingSymbol: "RELIANCE", direction: "LONG", underlyingScore: 80,
      underlying: { entry: 1205, target: 1230, stop: 1190 }, spot: 1200,
      rows: ladder(1200, 20), instrumentKeys: keys(ladder(1200, 20)),
      expiry: "2026-10-29", availableExpiries: ["2026-10-29"], lotSize: 500, now: Date.now(),
    });
    const b = selectOptionContract({
      underlyingKey: TCS, underlyingSymbol: "TCS", direction: "SHORT", underlyingScore: 75,
      underlying: { entry: 3500, target: 3450, stop: 3540 }, spot: 3500,
      rows: ladder(3500, 50), instrumentKeys: keys(ladder(3500, 50)),
      expiry: "2026-10-29", availableExpiries: ["2026-10-29"], lotSize: 175, now: Date.now(),
    });
    expect(a.underlyingKey).toBe(REL);
    expect(b.underlyingKey).toBe(TCS);
    expect(a.underlyingSymbol).toBe("RELIANCE");
    expect(b.underlyingSymbol).toBe("TCS");
  });

  it("no contract is fabricated when the chain is missing", async () => {
    const { selectOptionContract } = await import("../src/lib/market/optionSelection");
    const r = selectOptionContract({
      underlyingKey: REL, underlyingSymbol: "RELIANCE", direction: "LONG", underlyingScore: 80,
      underlying: { entry: 1205, target: 1230, stop: 1190 }, spot: 1200,
      rows: [], instrumentKeys: new Map(), expiry: "", availableExpiries: [],
      lotSize: null, now: Date.now(),
    });
    expect(r.status).toBe("OPTIONS_UNAVAILABLE");
    expect(r.best).toBeNull();
    expect(r.levels).toBeNull();
    expect(r.reason).toMatch(/UNDERLYING SIGNAL ONLY/);
  });
});

describe("queue statistics", () => {
  it("reports real coverage rather than claiming universal freshness", () => {
    const q = queue();
    q.syncShortlist([REL, TCS, INFY], sym);
    const t = 1000;
    q.recordAttempt(REL, true, "20 strikes", t);
    q.recordAttempt(TCS, true, "20 strikes", t - CHAIN_STALE_MS - 5000); // stale
    q.recordAttempt(INFY, false, "network error", t);
    const st = q.stats(t + 1);
    expect(st.registered).toBe(6);  // 3 indices + 3 stocks
    expect(st.shortlisted).toBe(3); // REL, TCS, INFY
    // Only REL was successfully fetched and is still fresh.
    expect(st.freshChains).toBe(1);
    expect(st.staleChains).toBe(1); // TCS
    // 3 never-fetched indices + INFY's network failure
    expect(st.failed).toBe(4);
    // Registered ≠ fresh: the stats never claim universal coverage.
    expect(st.freshChains).toBeLessThan(st.registered);
  });
});
