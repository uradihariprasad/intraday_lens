/** Shared synthetic chain fixtures for automated tests only — never live data. */
import type { ChainRow } from "../src/lib/market/options";

export function row(strike: number, spot: number, over: Partial<ChainRow> = {}): ChainRow {
  const norm = (spot - strike) / (spot * 0.02);
  return {
    strike,
    ceOi: 100_000, peOi: 100_000,
    ceOiChg: null, peOiChg: null, ceOiChgPrev: null, peOiChgPrev: null,
    ceVol: 50_000, peVol: 50_000,
    ceLtp: 120, peLtp: 110,
    ceIv: 14, peIv: 14,
    ceDelta: Math.max(0.02, Math.min(0.98, 0.5 + norm * 0.45)),
    peDelta: -Math.max(0.02, Math.min(0.98, 0.5 - norm * 0.45)),
    ceGamma: 0.004, peGamma: 0.004,
    ceTheta: -6, peTheta: -6,
    ceVega: 8, peVega: 8,
    ceBid: 118, ceAsk: 122,
    peBid: 108, peAsk: 112,
    ceBidQty: 500, ceAskQty: 500, peBidQty: 500, peAskQty: 500,
    ...over,
  };
}

export function ladder(spot: number, interval: number, over?: (s: number) => Partial<ChainRow>): ChainRow[] {
  const atm = Math.round(spot / interval) * interval;
  return Array.from({ length: 7 }, (_, i) => {
    const strike = atm + (i - 3) * interval;
    return row(strike, spot, over?.(strike) ?? {});
  });
}

export function keys(rows: ChainRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    m.set(`${r.strike}|CE`, `NSE_FO|CE${r.strike}`);
    m.set(`${r.strike}|PE`, `NSE_FO|PE${r.strike}`);
  }
  return m;
}
