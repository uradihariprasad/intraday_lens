"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Target, ChevronDown, ChevronUp, Ban, Radar, Layers, Loader2 } from "lucide-react";
import type { SignalPayload, TerminalPayload } from "../ui";
import { fmtNum, fmtCnt, CapTag, fmtIst, NoteList } from "../ui";

interface ContractCandidateView {
  instrumentKey: string; expiry: string; strike: number; side: "CE" | "PE";
  ltp: number | null; bid: number | null; ask: number | null; bidQty: number | null; askQty: number | null;
  volume: number; oi: number; delta: number | null; gamma: number | null; theta: number | null;
  vega: number | null; iv: number | null; spreadPct: number | null;
  oiChange5m: number | null; oiChange15m: number | null; oiChangeSession: number | null;
  moneyness: string; score: number; breakdown: { k: string; v: number }[];
  reasons: string[]; rejections: string[]; greeksSource: string;
}
interface PremiumLevelsView {
  entryLow: number | null; entryHigh: number | null; referenceLtp: number | null;
  bid: number | null; ask: number | null; quoteAt: number | null;
  targetPremium: number | null; stopPremium: number | null;
  underlyingEntry: number | null; underlyingTarget: number | null; underlyingInvalidation: number | null;
  riskPerUnit: number | null; rewardPerUnit: number | null; rr: number | null;
  lotSize: number | null; capitalRequired: number | null; maxLossPerLot: number | null;
  methodology: string[]; estimateLabel: string;
}
interface OptionRecView {
  status: string; reason: string; underlyingKey: string; underlyingSymbol: string;
  underlyingDirection: "LONG" | "SHORT"; underlyingScore: number;
  side: "CE" | "PE" | null; expiry: string | null; availableExpiries: string[];
  expiryRiskWarning: string | null; best: ContractCandidateView | null;
  alternative: ContractCandidateView | null;
  rejected: { strike: number; side: string; reason: string }[];
  comparison: ContractCandidateView[]; levels: PremiumLevelsView | null;
  whySelected: string[]; notes: string[]; createdAt: number;
}

export default function Signals({ payload, onPick }: { payload: TerminalPayload; onPick: (key: string) => void }) {
  const [expandedRec, setExpandedRec] = useState<string | null>(null);
  const [showTable, setShowTable] = useState<string | null>(null);
  const seq = useRef(0);

  /**
   * Option recommendations arrive on the SAME terminal payload as the signals
   * (single source of truth), so a new chain fetch is reflected immediately and
   * no second request can desynchronise the cards from the shortlist. Derived
   * directly from props — no mirrored state, so it can never go stale.
   */
  const recs = (payload.optionRecs ?? []) as unknown as OptionRecView[];
  const recError =
    recs.length > 0 ? null
    : payload.status.tokenStatus !== "VALID"
      ? "Option recommendations need live option-chain data: connect an Upstox access token."
      : "No option recommendation yet — stage 2 runs once the Trade Finder has shortlisted an underlying and its chain is loaded.";
  const recLoading = false;

  const live = payload.signals.filter((s) => s.status === "WATCH" || s.status === "ACTIVE");
  const expired = payload.signals.filter((s) => s.status === "EXPIRED" || s.status === "INVALIDATED");
  const nameFor = (key: string) =>
    [...payload.instruments.indices, ...payload.instruments.futures, ...payload.instruments.stocks].find((i) => i.instrumentKey === key)?.label ?? key;

  return (
    <div className="fade-in space-y-4">
      <div className="panel border-slate-700/60 p-4">
        <div className="flex items-start gap-3">
          <Radar size={16} className="mt-0.5 shrink-0 text-cyan-300" />
          <div className="text-[12px] leading-relaxed text-slate-400">
            Trade candidates appear only when a defined scenario (breakout-retest, rejection reversal, failed break) satisfies every rule on a
            confirmed structure/zone with acceptable data quality. Pending confirmations are always shown. Scores are deterministic confluence
            aggregates — they are <b className="text-slate-200">not</b> calibrated win probabilities, and nothing here guarantees profitability.
          </div>
        </div>
      </div>

      {/* coverage first — an empty board must be explainable, never just blank */}
      {payload.analysisCoverage && (
        <div className="panel flex flex-wrap items-center gap-x-5 gap-y-2 p-3 text-[11px]">
          <span className="font-bold uppercase tracking-wider text-slate-400">Trade Finder coverage</span>
          <span className="mono text-slate-300">eligible {payload.analysisCoverage.eligibleStocks}</span>
          <span className="mono text-emerald-300">analysed {payload.analysisCoverage.analysedStocks}</span>
          <span className="mono text-amber-300">skipped {payload.analysisCoverage.skipped}</span>
          <span className="mono text-slate-500">{payload.analysisCoverage.perCycle} stocks/cycle + indices</span>
          <span className={`mono ${payload.analysisCoverage.freshAnalyses < payload.analysisCoverage.eligibleStocks ? "text-amber-300" : "text-emerald-300"}`}>
            {payload.analysisCoverage.fullCoverage ? "full coverage" : "rotating (partial)"}
          </span>
          <span className="mono ml-auto text-slate-500">last scan {payload.status.scanAt ? fmtIst(payload.status.scanAt) : "—"}</span>
        </div>
      )}

      {live.length === 0 && (
        <div className="panel grid place-items-center p-14 text-center">
          <Ban size={22} className="mb-3 text-slate-600" />
          <p className="text-sm font-semibold text-slate-300">No qualifying setups right now</p>
          <div className="mt-2 max-w-lg space-y-1.5 text-[12px] text-slate-500">
            <p>
              The engine does not force a trade. A candidate requires a confirmed structure/zone, a defined invalidation level and
              sufficient reward-to-risk on <b className="text-slate-300">closed</b> 5-minute bars.
            </p>
            {payload.analysisCoverage && payload.analysisCoverage.analysedStocks < payload.analysisCoverage.eligibleStocks && (
              <p className="text-amber-200/80">
                Note: only {payload.analysisCoverage.analysedStocks} of {payload.analysisCoverage.eligibleStocks} eligible stocks have
                been analysed so far (rotating {payload.analysisCoverage.perCycle} per cycle). An empty board may simply mean the
                scheduler has not reached an instrument yet — it does not mean the whole universe was checked and rejected.
              </p>
            )}
            {payload.status.tokenStatus !== "VALID" && (
              <p className="text-amber-200/80">
                No Upstox token is connected, so analysis runs on prior-session candles and every signal is labelled{" "}
                <span className="tag estimated">HISTORICAL</span>. Connect a token for live intraday scanning.
              </p>
            )}
            {expired.length > 0 && (
              <p>{expired.length} earlier setup(s) expired or were invalidated — listed below.</p>
            )}
          </div>
        </div>
      )}

      {/* chain-fetch coverage — real freshness, never a claim of 30s universality */}
      {payload.chainQueue && (
        <div className="panel flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-[11px]">
          <span className="font-bold uppercase tracking-wider text-slate-400">Option-chain fetching</span>
          <span className="mono text-slate-300">registered {payload.chainQueue.registered}</span>
          <span className="mono text-cyan-300">shortlisted {payload.chainQueue.shortlisted}</span>
          <span className="mono text-emerald-300">fresh {payload.chainQueue.freshChains}</span>
          <span className="mono text-amber-300">stale {payload.chainQueue.staleChains}</span>
          <span className="mono text-rose-300">failed {payload.chainQueue.failed}</span>
          <span className="mono ml-auto text-slate-600">shortlist-first priority · rotation backfill</span>
        </div>
      )}

      {/* ---------------- BEST OPTION CONTRACT (stage 2) ---------------- */}
      <div className="panel p-4 lg:col-span-2">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Layers size={15} className="text-violet-300" />
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">Best Option Contract</h2>
          <span className="text-[10px] text-slate-500">stage 2 — contract selection from the shortlist above</span>
          {recLoading && <Loader2 size={13} className="animate-spin text-slate-500" />}
          {recs.length > 0 && <span className="mono ml-auto text-[10px] text-slate-500">{recs.length} underlying(s) · updated {new Date(recs[0].createdAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}</span>}
          <span className="mono text-[10px] text-slate-600">auto-refreshes with the terminal payload</span>
        </div>

        {recError && (
          <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/90">
            {recError}
          </div>
        )}

        {recs.length === 0 && !recError && !recLoading && (
          <p className="text-[12px] text-slate-600">
            No option recommendation yet — stage 2 runs once the Trade Finder has shortlisted an underlying and its option chain is loaded.
          </p>
        )}

        <div className="space-y-3">
          {recs.map((r) => {
            const isOpen = expandedRec === r.underlyingKey;
            const L = r.levels;
            return (
              <div key={r.underlyingKey} className="rounded-xl border border-slate-800 bg-slate-900/40">
                <button onClick={() => setExpandedRec(isOpen ? null : r.underlyingKey)} className="w-full p-3 text-left">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mono text-[13px] font-bold text-slate-100">{r.underlyingSymbol}</span>
                    <span className={`tag ${r.underlyingDirection === "LONG" ? "exact" : "unavailable"}`}>{r.underlyingDirection === "LONG" ? "bullish" : "bearish"}</span>
                    <span className="mono text-[10px] text-slate-500">underlying {r.underlyingScore.toFixed(0)}/100</span>
                    {r.status === "RECOMMENDED" && r.best ? (
                      <>
                        <span className="tag structural">{r.best.strike} {r.best.side}</span>
                        <span className="mono text-[10px] text-slate-500">{r.expiry}</span>
                        <span className="tag exact">contract {r.best.score.toFixed(0)}/100</span>
                        {L?.rr != null && <span className="tag approximate">R:R 1:{L.rr.toFixed(2)}</span>}
                      </>
                    ) : (
                      <span className={`tag ${r.status === "OPTIONS_UNAVAILABLE" ? "provider" : "unavailable"}`}>{r.status.replace(/_/g, " ").toLowerCase()}</span>
                    )}
                    <span className="ml-auto text-[10px] text-slate-600">{r.reason.slice(0, 70)}{r.reason.length > 70 ? "…" : ""}</span>
                    <ChevronDown size={14} className={`shrink-0 text-slate-600 transition ${isOpen ? "rotate-180" : ""}`} />
                  </div>
                </button>

                {isOpen && (
                  <div className="space-y-3 border-t border-slate-800 p-3">
                    {r.status !== "RECOMMENDED" || !r.best ? (
                      <p className="text-[11px] text-slate-400">{r.reason}</p>
                    ) : (
                      <>
                        {/* the six required levels, kept strictly separate */}
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                          <Cell k="Underlying entry" v={L?.underlyingEntry != null ? fmtNum(L.underlyingEntry) : "—"} />
                          <Cell k="Underlying target" v={L?.underlyingTarget != null ? fmtNum(L.underlyingTarget) : "—"} />
                          <Cell k="Underlying invalidation" v={L?.underlyingInvalidation != null ? fmtNum(L.underlyingInvalidation) : "—"} tone="text-rose-300" />
                          <Cell k="Entry premium" v={L?.entryLow != null && L.entryHigh != null ? `${fmtNum(L.entryLow)}–${fmtNum(L.entryHigh)}` : "—"} tone="text-cyan-300" />
                          <Cell k="Target premium" v={L?.targetPremium != null ? fmtNum(L.targetPremium) : "—"} tone="text-emerald-300" />
                          <Cell k="Stop-loss premium" v={L?.stopPremium != null ? fmtNum(L.stopPremium) : "—"} tone="text-rose-300" />
                        </div>

                        {/* contract metrics */}
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                          <Cell k="Delta" v={r.best.delta != null ? r.best.delta.toFixed(3) : "—"} />
                          <Cell k="Gamma" v={r.best.gamma != null ? r.best.gamma.toFixed(4) : "—"} />
                          <Cell k="Theta" v={r.best.theta != null ? r.best.theta.toFixed(2) : "—"} />
                          <Cell k="Vega" v={r.best.vega != null ? r.best.vega.toFixed(2) : "—"} />
                          <Cell k="IV" v={r.best.iv != null ? `${r.best.iv.toFixed(1)}%` : "—"} />
                          <Cell k="Spread" v={r.best.spreadPct != null ? `${(r.best.spreadPct * 100).toFixed(1)}%` : "—"} />
                          <Cell k="OI" v={fmtCnt(r.best.oi)} />
                          <Cell k="5m ΔOI" v={r.best.oiChange5m != null ? fmtCnt(r.best.oiChange5m) : "—"} />
                          <Cell k="15m ΔOI" v={r.best.oiChange15m != null ? fmtCnt(r.best.oiChange15m) : "—"} />
                          <Cell k="Volume" v={fmtCnt(r.best.volume)} />
                          <Cell k="Lot size" v={L?.lotSize != null ? String(L.lotSize) : "—"} />
                          <Cell k="Max loss / lot" v={L?.maxLossPerLot != null ? `₹${fmtCnt(L.maxLossPerLot)}` : "—"} tone="text-rose-300" />
                        </div>

                        {r.expiryRiskWarning && (
                          <p className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-2.5 py-1.5 text-[11px] text-amber-200/90">{r.expiryRiskWarning}</p>
                        )}

                        {/* WHY THIS CONTRACT */}
                        <div>
                          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Why this contract was selected</p>
                          {r.whySelected.map((w, i) => (<p key={i} className="text-[11px] text-slate-400">▸ {w}</p>))}
                        </div>

                        {/* methodology + estimates */}
                        {L?.methodology && L.methodology.length > 0 && (
                          <details className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
                            <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-slate-500">calculation methodology</summary>
                            {L.methodology.map((m, i) => (<p key={i} className="mt-1 text-[10px] leading-relaxed text-slate-500">▸ {m}</p>))}
                            <p className="mt-1 text-[10px] text-amber-200/80">{L.estimateLabel}</p>
                          </details>
                        )}

                        {/* alternative + rejected */}
                        {r.alternative && (
                          <p className="text-[11px] text-slate-500">
                            Alternative: <b className="text-slate-300">{r.alternative.strike} {r.alternative.side}</b> (suitability {r.alternative.score.toFixed(0)}/100)
                            {r.alternative.rejections.length > 0 ? ` — ${r.alternative.rejections.join("; ")}` : ""}
                          </p>
                        )}
                        {r.rejected.length > 0 && (
                          <details className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
                            <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-slate-500">rejected strikes ({r.rejected.length})</summary>
                            {r.rejected.map((x, i) => (
                              <p key={i} className="mt-1 text-[10px] text-slate-500">
                                <span className="mono text-slate-400">{x.strike} {x.side}</span> — {x.reason}
                              </p>
                            ))}
                          </details>
                        )}

                        {/* full comparison table */}
                        <button onClick={() => setShowTable(showTable === r.underlyingKey ? null : r.underlyingKey)} className="text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:text-cyan-200">
                          {showTable === r.underlyingKey ? "hide" : "show"} full strike comparison
                        </button>
                        {showTable === r.underlyingKey && (
                          <div className="scroll-thin overflow-x-auto">
                            <table className="tbl mono">
                              <thead><tr>
                                <th>Strike</th><th>M/S</th><th>LTP</th><th>Bid/Ask</th><th>Spread</th>
                                <th>Δ</th><th>Γ</th><th>Θ</th><th>IV</th>
                                <th>Vol</th><th>OI</th><th>5m ΔOI</th><th>15m ΔOI</th><th className="text-right">Score</th>
                              </tr></thead>
                              <tbody>
                                {r.comparison.map((c) => (
                                  <tr key={c.strike} className={c.strike === r.best?.strike ? "bg-cyan-400/[0.07]" : undefined}>
                                    <td className="font-bold text-slate-100">{c.strike}</td>
                                    <td className="text-slate-500">{c.moneyness.toLowerCase()}</td>
                                    <td className="text-slate-300">{fmtNum(c.ltp)}</td>
                                    <td className="text-slate-500">{fmtNum(c.bid)} / {fmtNum(c.ask)}</td>
                                    <td className={c.spreadPct != null && c.spreadPct > 0.12 ? "text-rose-300" : "text-slate-400"}>{c.spreadPct != null ? `${(c.spreadPct * 100).toFixed(1)}%` : "—"}</td>
                                    <td className="text-slate-300">{c.delta != null ? c.delta.toFixed(2) : "—"}</td>
                                    <td className="text-slate-500">{c.gamma != null ? c.gamma.toFixed(3) : "—"}</td>
                                    <td className="text-slate-500">{c.theta != null ? c.theta.toFixed(1) : "—"}</td>
                                    <td className="text-slate-500">{c.iv != null ? c.iv.toFixed(1) : "—"}</td>
                                    <td className="text-slate-500">{fmtCnt(c.volume)}</td>
                                    <td className="text-slate-500">{fmtCnt(c.oi)}</td>
                                    <td className="text-slate-500">{c.oiChange5m != null ? fmtCnt(c.oiChange5m) : "—"}</td>
                                    <td className="text-slate-500">{c.oiChange15m != null ? fmtCnt(c.oiChange15m) : "—"}</td>
                                    <td className="text-right text-cyan-300">{c.score.toFixed(0)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
                          {r.notes.map((n, i) => (<p key={i} className="text-[10px] text-slate-600">▸ {n}</p>))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {live.map((s) => (
          <SignalCard key={s.id} s={s} name={nameFor(s.instrumentKey)} onPick={() => onPick(s.instrumentKey)} />
        ))}
      </div>

      {expired.length > 0 && (
        <details className="panel p-4">
          <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
            Expired / invalidated ({expired.length})
          </summary>
          <div className="mt-3 space-y-1">
            {expired.slice(0, 8).map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-[11px] text-slate-500">
                <span className="tag unavailable">{s.status}</span>
                <span className="mono">{nameFor(s.instrumentKey)}</span>
                <span>{s.scenario} {s.direction}</span>
                <span className="mono ml-auto">{fmtIst(s.updatedAt)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function SignalCard({ s, name, onPick }: { s: SignalPayload; name: string; onPick: () => void }) {
  const [open, setOpen] = useState(false);
  const long = s.direction === "LONG";
  return (
    <div className={`panel panel-hover p-5 ${long ? "border-emerald-400/20" : "border-rose-400/20"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Target size={14} className={long ? "text-emerald-400" : "text-rose-400"} />
            <span className="text-[13px] font-bold tracking-wide text-slate-100">{s.scenario.replace(/_/g, " ")}</span>
            <span className={`tag ${long ? "exact" : "unavailable"}`}>{s.direction}</span>
            {s.grade && (
              <span className={`tag ${s.grade === "GOOD_TRADE" ? "exact" : "estimated"}`} title="Rule-defined decision-support category — never a win probability">
                {s.grade.replace(/_/g, " ")}
              </span>
            )}
            <span className={`tag ${s.status === "ACTIVE" ? "exact" : "estimated"}`}>{s.status}</span>
          </div>
          <button onClick={onPick} className="mt-1 text-[12px] text-cyan-300/90 underline-offset-2 hover:underline mono">{name} · {s.timeframeMin}m</button>
        </div>
        <div className="text-right">
          <div className="mono text-xl font-semibold text-slate-100">{s.score.toFixed(1)}</div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500">confluence</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        <StatCell label="Entry trigger" value={s.entry !== null ? fmtNum(s.entry) : "—"} tone={long ? "text-emerald-300" : "text-rose-300"} />
        <StatCell label="Invalidation" value={s.stop !== null ? fmtNum(s.stop) : "—"} tone="text-slate-300" />
        <StatCell label="Target 1" value={s.targets[0] !== undefined ? fmtNum(s.targets[0]) : "—"} tone="text-cyan-300" />
        <StatCell label="R:R" value={s.rr !== null ? s.rr.toFixed(2) : "—"} tone="text-slate-300" />
      </div>
      {s.targets[1] !== undefined && (
        <div className="mono mt-1 text-right text-[10px] text-slate-500">extended target {fmtNum(s.targets[1])}</div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {s.capabilityTags.map((t) => (
          <CapTag key={t} status={t.includes("ESTIMATED") ? "estimated" : t.includes("UNAVAILABLE") ? "unavailable" : "exact"} />
        ))}
        <CapTag status={s.dataQuality === "LIVE" ? "exact" : s.dataQuality === "STALE" ? "estimated" : "provider"} />
        <span className="tag">{s.dataQuality}</span>
        <span className="mono ml-auto text-[10px] text-slate-600">valid until {fmtIst(s.validUntil)}</span>
      </div>

      <div className="mt-3 space-y-1.5">
        {s.confirmations.map((c, i) => (
          <div key={i} className="flex items-start gap-2 text-[11px] text-slate-400">
            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
            <span>{c}</span>
          </div>
        ))}
        {s.pending.map((c, i) => (
          <div key={i} className="flex items-start gap-2 text-[11px] text-amber-200/80">
            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
            <span>pending: {c}</span>
          </div>
        ))}
      </div>

      <p className="mt-3 border-t border-slate-800 pt-2 text-[10px] text-slate-500">
        Invalidation: {s.invalidationRule}
      </p>

      <button onClick={() => setOpen((o) => !o)} className="mt-2 flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300">
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />} full trace & score breakdown
      </button>
      {open && (
        <div className="mt-2 grid gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Score components</p>
            {s.breakdown.map((b, i) => (
              <div key={i} className="flex justify-between text-[11px] text-slate-400">
                <span>{b.k}</span>
                <span className="mono text-slate-200">{b.v > 0 ? "+" : ""}{b.v.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Trace inputs</p>
            <pre className="scroll-thin mono max-h-40 overflow-auto text-[10px] leading-relaxed text-slate-400">
              {JSON.stringify(s.trace.inputs, null, 1)}
            </pre>
          </div>
          <div className="sm:col-span-2">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Rules evaluated</p>
            {s.trace.rules.map((r, i) => (
              <p key={i} className="text-[11px] text-slate-400">▸ {r}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className={`mono truncate ${tone ?? "text-slate-100"}`}>{v}</div>
    </div>
  );
}

function StatCell({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mono text-[13px] font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
