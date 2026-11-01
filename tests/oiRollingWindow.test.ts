/**
 * Strict rolling 5m/15m OI window tests (Test A–I from the specification).
 *
 * ROOT CAUSE UNDER TEST: `MATCH_TOLERANCE_MS` was 150_000 ms (2.5 minutes) with
 * NO lower bound, so a 3-minute-old observation was accepted as a "5-minute"
 * baseline and its difference was labelled a 5-minute change.
 */
import { describe, it, expect } from "vitest";
import {
  OiHistory, OiObservation, StrikeObservation, buildWindow, BASELINE_TOLERANCE_MS,
} from "../src/lib/market/oiIntelligence";

const BASE = Date.parse("2026-10-28T09:00:00+05:30");
const LADDER = [25000, 25100];
const EXPIRY = "2026-10-29";

function obs(tMs: number, ceOi: number, peOi = ceOi, spot = 25100, expiry = EXPIRY): OiObservation {
  const strikes = new Map<number, StrikeObservation>();
  for (const strike of LADDER) {
    strikes.set(strike, { strike, ceOi, peOi, ceLtp: 100, peLtp: 100, ceVol: 10, peVol: 10 });
  }
  return { t: BASE + tMs, spot, expiry, strikes };
}
const clock = (ms: number) => new Date(BASE + ms + 5.5 * 3_600_000).toISOString().slice(11, 19);

/** Build a 5m/15m window exactly the way the engine does. */
function windowFor(h: OiHistory, windowMs: number, nowMs: number, obsCount: number) {
  return buildWindow(
    `${Math.round(windowMs / 60000)}m`,
    windowMs,
    h.latest("A", EXPIRY),
    h.baselineFor("A", EXPIRY, windowMs, BASE + nowMs),
    LADDER, 2, obsCount, BASE + nowMs
  );
}

describe("strict tolerance configuration", () => {
  it("defaults to ±30 seconds — NOT the previous 150-second tolerance", () => {
    expect(BASELINE_TOLERANCE_MS).toBe(30_000);
    expect(BASELINE_TOLERANCE_MS).toBeLessThan(60_000);
  });
});

describe("Test A: exact 5-minute rolling window", () => {
  it("09:28:00 vs 09:23:00 → +2,000 VALID", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(0, 9_000));        // 09:00:00
    h.record("A", EXPIRY, obs(23 * 60_000, 10_000)); // 09:23:00 baseline
    h.record("A", EXPIRY, obs(28 * 60_000, 12_000)); // 09:28:00 current
    const w = windowFor(h, 5 * 60_000, 28 * 60_000, 3);
    expect(w.status).toBe("VALID");
    expect(w.rows[0].ceChange).toBe(2_000);
    expect(w.baselineAt).toBe(BASE + 23 * 60_000);
    expect(w.currentAt).toBe(BASE + 28 * 60_000);
    expect(w.actualSpanMs).toBe(5 * 60_000);
  });
});

describe("Test B: 30-second rolling update", () => {
  it("09:28:30 vs 09:23:30 → +2,000 VALID (window advances with each observation)", () => {
    const h = new OiHistory();
    // dense 30s observations so a 23:30 baseline exists
    for (let s = 0; s <= 28.5 * 60; s += 30) {
      h.record("A", EXPIRY, obs(s * 1000, s <= 23.5 * 60 ? 10_500 : 12_500));
    }
    const w = windowFor(h, 5 * 60_000, 28.5 * 60_000, h.all("A", EXPIRY).length);
    expect(w.status).toBe("VALID");
    expect(w.rows[0].ceChange).toBe(2_000);
    expect(w.baselineAt).toBe(BASE + 23.5 * 60_000); // 09:23:30
    expect(w.currentAt).toBe(BASE + 28.5 * 60_000);  // 09:28:30
    expect(w.actualSpanMs).toBe(5 * 60_000);
  });
});

describe("Test C: invalid SHORT baseline must not be labelled 5-minute", () => {
  it("current 09:28, only baseline at 09:25 → INSUFFICIENT_HISTORY, no value", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(0, 9_000));          // 09:00 (makes history reach back)
    h.record("A", EXPIRY, obs(25 * 60_000, 10_500)); // 09:25 — only 3 minutes old
    h.record("A", EXPIRY, obs(28 * 60_000, 12_000)); // 09:28
    const w = windowFor(h, 5 * 60_000, 28 * 60_000, 3);
    // Under the OLD 150s tolerance 09:25 was accepted (09:25 <= 09:23+2.5m).
    expect(w.status).not.toBe("VALID");
    expect(["INSUFFICIENT_HISTORY", "INVALID_BASELINE", "COLLECTING"]).toContain(w.status);
    expect(w.rows).toHaveLength(0);          // no value is produced
    expect(w.baselineAt).toBeNull();         // and no baseline is claimed
  });
});

describe("Test D: invalid LONG baseline is rejected", () => {
  it("current 09:28, only baseline at 09:22 → rejected outside ±30s", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(0, 9_000));
    h.record("A", EXPIRY, obs(22 * 60_000, 9_500));  // 09:22 — 6 minutes old
    h.record("A", EXPIRY, obs(28 * 60_000, 12_000)); // 09:28
    const w = windowFor(h, 5 * 60_000, 28 * 60_000, 3);
    expect(w.status).not.toBe("VALID");
    expect(w.rows).toHaveLength(0);
  });
});

describe("Test E: exact 15-minute calculation", () => {
  it("09:28:00 vs 09:13:00 → +4,000 VALID, independent of the 5m baseline", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(0, 8_000));
    h.record("A", EXPIRY, obs(13 * 60_000, 11_000)); // 09:13 baseline
    h.record("A", EXPIRY, obs(23 * 60_000, 10_000)); // 09:23 (5m baseline)
    h.record("A", EXPIRY, obs(28 * 60_000, 15_000)); // 09:28 current
    const w15 = windowFor(h, 15 * 60_000, 28 * 60_000, 4);
    const w5 = windowFor(h, 5 * 60_000, 28 * 60_000, 4);
    expect(w15.status).toBe("VALID");
    expect(w15.rows[0].ceChange).toBe(4_000);
    expect(w15.baselineAt).toBe(BASE + 13 * 60_000);
    // the two windows use DIFFERENT baselines — never reused
    expect(w15.baselineAt).not.toBe(w5.baselineAt);
    expect(w5.rows[0].ceChange).toBe(5_000);
  });

  it("a 5m baseline is never accepted for the 15m window", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(0, 8_000));
    h.record("A", EXPIRY, obs(23 * 60_000, 10_000)); // only a 5m-old point
    h.record("A", EXPIRY, obs(28 * 60_000, 15_000));
    const w15 = windowFor(h, 15 * 60_000, 28 * 60_000, 3);
    expect(w15.status).not.toBe("VALID");
    expect(w15.rows).toHaveLength(0);
  });
});

describe("Test F: missing historical data", () => {
  it("current OI available but no baselines → COLLECTING, nothing fabricated", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(28 * 60_000, 12_000)); // only one observation
    const w5 = windowFor(h, 5 * 60_000, 28 * 60_000, 1);
    const w15 = windowFor(h, 15 * 60_000, 28 * 60_000, 1);
    expect(["COLLECTING", "INSUFFICIENT_HISTORY"]).toContain(w5.status);
    expect(["COLLECTING", "INSUFFICIENT_HISTORY"]).toContain(w15.status);
    expect(w5.rows).toHaveLength(0);
    expect(w15.rows).toHaveLength(0);
    // no zero substitution anywhere
    expect(w5.rows.length === 0 && w15.rows.length === 0).toBe(true);
  });
});

describe("Test G: server restart restores history", () => {
  it("restored observations allow rolling windows to continue, not restart", () => {
    // ---- before restart: 20 minutes of dense history
    const before = new OiHistory();
    for (let s = 0; s <= 20 * 60; s += 30) before.record("A", EXPIRY, obs(s * 1000, 10_000 + s));

    // ---- simulate persistence: export observations
    const persisted = before.all("A", EXPIRY);

    // ---- restart: brand-new in-memory history, then restore
    const after = new OiHistory();
    expect(after.all("A", EXPIRY)).toHaveLength(0);
    after.restore("A", EXPIRY, persisted);
    expect(after.all("A", EXPIRY).length).toBe(persisted.length);

    // ---- windows still compute correctly after restoration
    const nowMs = 20 * 60_000;
    const w5 = windowFor(after, 5 * 60_000, nowMs, after.all("A", EXPIRY).length);
    const w15 = windowFor(after, 15 * 60_000, nowMs, after.all("A", EXPIRY).length);
    expect(w5.status).toBe("VALID");
    expect(w15.status).toBe("VALID");
    // the fixture grows OI by 1 per second: 5 minutes ⇒ +300, 15 minutes ⇒ +900
    expect(w5.rows[0].ceChange).toBe(300);
    expect(w15.rows[0].ceChange).toBe(900);
  });

  it("restore keeps the newest observation on duplicate timestamps", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(60_000, 10_000));
    h.restore("A", EXPIRY, [obs(60_000, 99_999)]); // same t, different OI
    expect(h.all("A", EXPIRY)).toHaveLength(1);
    expect([...h.all("A", EXPIRY)[0].strikes.values()][0].ceOi).toBe(99_999);
  });
});

describe("Test H: instrument isolation", () => {
  it("different underlying, expiry, strike and option type never share baselines", () => {
    const h = new OiHistory();
    h.record("A", "2026-10-29", obs(23 * 60_000, 10_000)); // underlying A
    h.record("B", "2026-10-29", obs(23 * 60_000, 20_000)); // underlying B
    h.record("A", "2026-11-26", obs(23 * 60_000, 30_000)); // different expiry
    h.record("A", "2026-10-29", obs(28 * 60_000, 12_000));

    // A/2026-10-29 gets its OWN baseline
    const a = h.baselineFor("A", "2026-10-29", 5 * 60_000, BASE + 28 * 60_000);
    expect(a!.obs.strikes.get(25000)!.ceOi).toBe(10_000);
    // B has no current observation at all
    expect(h.baselineFor("B", "2026-10-29", 5 * 60_000, BASE + 28 * 60_000)).toBeNull();
    // different expiry is a separate series
    expect(h.all("A", "2026-11-26")).toHaveLength(1);

    // clearing one expiry leaves the other intact
    h.clear("A", "2026-11-26");
    expect(h.all("A", "2026-11-26")).toHaveLength(0);
    expect(h.all("A", "2026-10-29").length).toBeGreaterThan(0);
  });

  it("CE and PE are tracked independently within one observation", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(23 * 60_000, 10_000, 50_000));
    h.record("A", EXPIRY, obs(28 * 60_000, 12_000, 45_000));
    const w = windowFor(h, 5 * 60_000, 28 * 60_000, 2);
    expect(w.rows[0].ceChange).toBe(2_000);
    expect(w.rows[0].peChange).toBe(-5_000);
    expect(w.rows[0].ceOiBaseline).toBe(10_000);
    expect(w.rows[0].peOiBaseline).toBe(50_000);
  });
});

describe("Test I: stale / duplicate API responses", () => {
  it("a duplicate observation does not create a new history point", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(60_000, 10_000));
    const n = h.all("A", EXPIRY).length;
    h.record("A", EXPIRY, obs(60_000, 10_000)); // identical timestamp
    expect(h.all("A", EXPIRY).length).toBe(n);
  });

  it("an out-of-order (older) observation is rejected, not inserted", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(120_000, 10_000));
    h.record("A", EXPIRY, obs(60_000, 5_000)); // older than the newest
    expect(h.all("A", EXPIRY)).toHaveLength(1);
    expect(h.all("A", EXPIRY)[0].t).toBe(BASE + 120_000);
  });

  it("a stale CURRENT observation yields STALE_DATA, not a fabricated window", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(0, 9_000));
    h.record("A", EXPIRY, obs(23 * 60_000, 10_000));
    h.record("A", EXPIRY, obs(28 * 60_000, 12_000));
    // evaluate 10 minutes later → the current observation is stale
    const w = windowFor(h, 5 * 60_000, 38 * 60_000, 3);
    expect(w.status).toBe("STALE_DATA");
    expect(w.rows).toHaveLength(0);
    expect(w.reason).toMatch(/old/i);
  });

  it("the strict tolerance is honoured in both directions", () => {
    const h = new OiHistory();
    const now = BASE + 28 * 60_000; // target 09:23:00
    // 29s off → accepted (a current observation must also exist)
    h.record("A", EXPIRY, obs(23 * 60_000 - 29_000, 10_000));
    h.record("A", EXPIRY, obs(28 * 60_000, 12_000));
    expect(h.baselineFor("A", EXPIRY, 5 * 60_000, now)).not.toBeNull();
    // 31s off → rejected
    const h2 = new OiHistory();
    h2.record("A", EXPIRY, obs(23 * 60_000 - 31_000, 10_000));
    h2.record("A", EXPIRY, obs(28 * 60_000, 12_000));
    expect(h2.baselineFor("A", EXPIRY, 5 * 60_000, now)).toBeNull();
  });
});

describe("session vs rolling windows stay conceptually separate", () => {
  it("session change, 5m change and total OI are distinct measures", () => {
    const h = new OiHistory();
    h.record("A", EXPIRY, obs(0, 5_000));          // session start
    h.record("A", EXPIRY, obs(13 * 60_000, 7_000));
    h.record("A", EXPIRY, obs(23 * 60_000, 10_000));
    const current = obs(28 * 60_000, 12_000);
    h.record("A", EXPIRY, current);

    const w5 = windowFor(h, 5 * 60_000, 28 * 60_000, 4);
    const w15 = windowFor(h, 15 * 60_000, 28 * 60_000, 4);
    const session = buildWindow("session", 28 * 60_000, current, { obs: h.all("A", EXPIRY)[0], gapMs: 0 }, LADDER, 2, 4, BASE + 28 * 60_000);

    expect(w5.rows[0].ceChange).toBe(2_000);       // 12,000 - 10,000
    expect(w15.rows[0].ceChange).toBe(5_000);      // 12,000 - 7,000
    expect(session.rows[0].ceChange).toBe(7_000);  // 12,000 - 5,000
    expect(current.strikes.get(25000)!.ceOi).toBe(12_000); // total OI
    // all four values are genuinely different measures
    expect(new Set([w5.rows[0].ceChange, w15.rows[0].ceChange, session.rows[0].ceChange, 12_000]).size).toBe(4);
  });
});
