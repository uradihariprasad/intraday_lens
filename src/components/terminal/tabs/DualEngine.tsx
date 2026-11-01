"use client";

import { useMemo, useState } from "react";
import { Gauge, TrendingUp, TrendingDown, Activity, AlertTriangle, ChevronRight } from "lucide-react";
import type { TerminalPayload } from "../ui";
import { Color, fmtCnt, fmtNum, fmtIst } from "../ui";

/**
 * Dual-engine view: Momentum (discovery) and Dominance (pressure confirmation)
 * rendered as SEPARATE rankings, with a cross-engine explanation for each
 * shortlisted instrument. Both read the same server snapshot, so the two
 * boards can never disagree about raw facts — only about interpretation,
 * which is the point.
 */
export default function DualEngine({ payload, onPick }: { payload: TerminalPayload; onPick: (key: string) => void }) {
  const [openM, setOpenM] = useState<string | null>(null);
  const [openD, setOpenD] = useState<string | null>(null);
  const m = useMemo(() => payload.momentum?.momentum ?? [], [payload.momentum]);
  const d = useMemo(() => payload.momentum?.dominance ?? [], [payload.momentum]);
  const cross = useMemo(() => payload.crossEngine ?? [], [payload.crossEngine]);

  const bull = useMemo(() => m.filter((x) => x.direction > 0 && x.classification !== "MOMENTUM_WEAKENING").sort((a, b) => b.score - a.score).slice(0, 10), [m]);
  const bear = useMemo(() => m.filter((x) => x.direction < 0 && x.classification !== "MOMENTUM_WEAKENING").sort((a, b) => b.score - a.score).slice(0, 10), [m]);
  const accel = useMemo(() => m.filter((x) => x.accelerating === true).sort((a, b) => b.score - a.score).slice(0, 10), [m]);
  const weakening = useMemo(() => m.filter((x) => x.decelerating === true || x.classification === "MOMENTUM_WEAKENING").slice(0, 10), [m]);

  const buyers = useMemo(() => d.filter((x) => x.dominantSide === "BUYER").sort((a, b) => b.buyerScore - a.buyerScore).slice(0, 10), [d]);
  const sellers = useMemo(() => d.filter((x) => x.dominantSide === "SELLER").sort((a, b) => b.sellerScore - a.sellerScore).slice(0, 10), [d]);
  const building = useMemo(() => d.filter((x) => x.pressureTrend === "BUILDING").slice(0, 10), [d]);
  const fading = useMemo(() => d.filter((x) => x.pressureTrend === "FADING" || x.reversalEvidence.detected || x.absorption.detected).slice(0, 10), [d]);
  const balanced = useMemo(() => d.filter((x) => x.dominantSide === "NEITHER").slice(0, 10), [d]);

  return (
    <div className="fade-in space-y-4">
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Gauge size={15} className="text-cyan-300" />
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">Momentum &amp; Dominance</h2>
          <span className="text-[10px] text-slate-500">two independent engines, one shared fact layer</span>
          <span className="mono ml-auto text-[10px] text-slate-500">{m.length} momentum · {d.length} dominance evaluated</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          <b className="text-slate-300">Momentum</b> discovers directional price movement and whether it is accelerating or fading.
          <b className="text-slate-300"> Dominance</b> confirms which side exerts stronger pressure using flow, OI and structure.
          They consume the same raw observations but score them independently, so they can — and sometimes should — disagree.
        </p>
      </div>

      {/* cross-engine explanation for shortlisted instruments */}
      {cross.length > 0 && (
        <div className="panel p-4">
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Engine agreement (shortlisted)</h3>
          <div className="space-y-2">
            {cross.map((c) => {
              const inst = [...payload.instruments.indices, ...payload.instruments.futures, ...payload.instruments.stocks].find((i) => i.instrumentKey === c.instrumentKey);
              return (
                <div key={c.instrumentKey} className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <button onClick={() => onPick(c.instrumentKey)} className="mono font-semibold text-cyan-300 hover:underline">{inst?.label ?? c.instrumentKey}</button>
                    <span className="tag structural">momentum {c.momentum?.replace(/_/g, " ").toLowerCase()}</span>
                    <span className="tag oi_candidate">dominance {c.dominance?.replace(/_/g, " ").toLowerCase()}</span>
                    {c.agree === true && <span className="tag exact">aligned</span>}
                    {c.agree === false && <span className="tag unavailable">conflict</span>}
                    {c.agree === null && <span className="tag estimated">inconclusive</span>}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{c.explanation}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* MOMENTUM BOARDS */}
      <div className="grid gap-4 xl:grid-cols-2">
        <MomentumBoard title="Top Bullish Momentum" icon={<TrendingUp size={14} className="text-emerald-400" />} rows={bull} open={openM} setOpen={setOpenM} onPick={onPick} tone="bull" />
        <MomentumBoard title="Top Bearish Momentum" icon={<TrendingDown size={14} className="text-rose-400" />} rows={bear} open={openM} setOpen={setOpenM} onPick={onPick} tone="bear" />
        <MomentumBoard title="Momentum Accelerating" icon={<Activity size={14} className="text-cyan-400" />} rows={accel} open={openM} setOpen={setOpenM} onPick={onPick} tone="bull" />
        <MomentumBoard title="Momentum Weakening" icon={<AlertTriangle size={14} className="text-amber-400" />} rows={weakening} open={openM} setOpen={setOpenM} onPick={onPick} tone="warn" />
      </div>

      {/* DOMINANCE BOARDS */}
      <div className="grid gap-4 xl:grid-cols-2">
        <DominanceBoard title="Top Buyer Dominance" icon={<TrendingUp size={14} className="text-emerald-400" />} rows={buyers} open={openD} setOpen={setOpenD} onPick={onPick} side="BUYER" />
        <DominanceBoard title="Top Seller Dominance" icon={<TrendingDown size={14} className="text-rose-400" />} rows={sellers} open={openD} setOpen={setOpenD} onPick={onPick} side="SELLER" />
        <DominanceBoard title="Pressure Building" icon={<Activity size={14} className="text-cyan-400" />} rows={building} open={openD} setOpen={setOpenD} onPick={onPick} side="BUYER" />
        <DominanceBoard title="Weakening / Possible Reversal" icon={<AlertTriangle size={14} className="text-amber-400" />} rows={fading} open={openD} setOpen={setOpenD} onPick={onPick} side="warn" />
      </div>
      {balanced.length > 0 && (
        <div className="panel p-3">
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-400">Balanced / No Clear Dominance ({balanced.length})</h3>
          <div className="flex flex-wrap gap-1.5">
            {balanced.map((b) => (
              <button key={b.instrumentKey} onClick={() => onPick(b.instrumentKey)} className="tag hover:border-cyan-400/40">
                {b.symbol} · buyer {b.buyerScore.toFixed(0)} / seller {b.sellerScore.toFixed(0)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MomentumBoard({
  title, icon, rows, open, setOpen, onPick, tone,
}: {
  title: string; icon: React.ReactNode;
  rows: TerminalPayload["momentum"] extends undefined ? never : NonNullable<TerminalPayload["momentum"]>["momentum"];
  open: string | null; setOpen: (s: string | null) => void; onPick: (k: string) => void;
  tone: "bull" | "bear" | "warn";
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-800 p-3">
        {icon}
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">{title}</h3>
        <span className="mono ml-auto text-[10px] text-slate-600">{rows.length}</span>
      </div>
      {rows.length === 0 && <div className="p-4 text-[12px] text-slate-600">No qualifying instruments. Empty is reported rather than padded.</div>}
      {rows.map((r) => {
        const isOpen = open === r.instrumentKey;
        return (
          <div key={r.instrumentKey}>
            <button onClick={() => setOpen(isOpen ? null : r.instrumentKey)} className="w-full border-b border-slate-800/60 px-3 py-2 text-left transition hover:bg-slate-800/20">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono w-20 truncate text-[12px] font-semibold text-slate-100">{r.symbol}</span>
                <span className={`tag ${tone === "bull" ? "exact" : tone === "bear" ? "unavailable" : "estimated"}`}>{r.classification.replace(/_/g, " ").toLowerCase()}</span>
                {r.accelerating && <span className="tag approximate">accelerating</span>}
                {r.decelerating && <span className="tag estimated">decelerating</span>}
                {r.oiStatus !== "VALID" && <span className="tag unavailable" title={r.pending.find((p) => /OI/.test(p)) ?? "OI unavailable"}>OI {r.oiStatus.toLowerCase()}</span>}
                <span className="mono ml-auto text-[13px] font-bold text-cyan-300">{r.score.toFixed(0)}</span>
                <ChevronRight size={12} className={`text-slate-600 transition ${isOpen ? "rotate-90" : ""}`} />
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {r.confirmationCount > 0 && <span className="tag exact">{r.confirmationCount} confirmation{r.confirmationCount > 1 ? "s" : ""}</span>}
                {r.conflictCount > 0 && <span className="tag unavailable">{r.conflictCount} conflict{r.conflictCount > 1 ? "s" : ""}</span>}
                {!r.eligibleForActionableTrade && <span className="tag estimated">not actionable</span>}
              </div>
            </button>
            {isOpen && (
              <div className="space-y-2 border-t border-slate-800 bg-slate-900/40 p-3">
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Score breakdown (0-100)</p>
                  {r.breakdown.map((b, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="text-slate-400">{b.k} <span className={`tag ${b.status === "VALID" ? "exact" : b.status === "ESTIMATED" ? "estimated" : "unavailable"}`}>{b.status.toLowerCase()}</span></span>
                      <span className="mono text-slate-200">{b.v > 0 ? "+" : ""}{b.v.toFixed(1)}</span>
                    </div>
                  ))}
                </div>
                {r.confirmations.length > 0 && (
                  <div><p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Confirmations</p>
                  {r.confirmations.map((c, i) => <p key={i} className="text-[11px] text-emerald-300/80">▸ {c}</p>)}</div>
                )}
                {r.conflicts.length > 0 && (
                  <div><p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Conflicts</p>
                  {r.conflicts.map((c, i) => <p key={i} className="text-[11px] text-rose-300/80">▸ {c}</p>)}</div>
                )}
                {r.pending.length > 0 && (
                  <div><p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Pending / unavailable</p>
                  {r.pending.map((c, i) => <p key={i} className="text-[11px] text-amber-200/70">▸ {c}</p>)}</div>
                )}
                <button onClick={() => onPick(r.instrumentKey)} className="rounded-lg bg-cyan-400 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-950">Open analysis →</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DominanceBoard({
  title, icon, rows, open, setOpen, onPick, side,
}: {
  title: string; icon: React.ReactNode;
  rows: TerminalPayload["momentum"] extends undefined ? never : NonNullable<TerminalPayload["momentum"]>["dominance"];
  open: string | null; setOpen: (s: string | null) => void; onPick: (k: string) => void;
  side: "BUYER" | "SELLER" | "warn";
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-800 p-3">
        {icon}
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">{title}</h3>
        <span className="mono ml-auto text-[10px] text-slate-600">{rows.length}</span>
      </div>
      {rows.length === 0 && <div className="p-4 text-[12px] text-slate-600">No qualifying instruments.</div>}
      {rows.map((r) => {
        const isOpen = open === r.instrumentKey;
        const winScore = side === "BUYER" ? r.buyerScore : r.sellerScore;
        return (
          <div key={r.instrumentKey}>
            <button onClick={() => setOpen(isOpen ? null : r.instrumentKey)} className="w-full border-b border-slate-800/60 px-3 py-2 text-left transition hover:bg-slate-800/20">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono w-20 truncate text-[12px] font-semibold text-slate-100">{r.symbol}</span>
                <span className={`tag ${r.classification.includes("STRONG") ? "exact" : r.classification.includes("WEAKENING") || r.classification.includes("REVERSAL") ? "unavailable" : "estimated"}`}>
                  {r.classification.replace(/_/g, " ").toLowerCase()}
                </span>
                {r.pressureTrend !== "UNKNOWN" && <span className={`tag ${r.pressureTrend === "BUILDING" ? "approximate" : r.pressureTrend === "FADING" ? "unavailable" : ""}`}>{r.pressureTrend.toLowerCase()}</span>}
                {r.absorption.detected && <span className="tag oi_candidate">absorption</span>}
                {r.divergence.detected && <span className="tag unavailable">divergence</span>}
                <span className="mono ml-auto text-[11px] text-slate-400">B {r.buyerScore.toFixed(0)} / S {r.sellerScore.toFixed(0)}</span>
                <ChevronRight size={12} className={`text-slate-600 transition ${isOpen ? "rotate-90" : ""}`} />
              </div>
            </button>
            {isOpen && (
              <div className="space-y-2 border-t border-slate-800 bg-slate-900/40 p-3">
                <div className="grid grid-cols-2 gap-2 text-[11px] mono sm:grid-cols-4">
                  <KV k="Buyer score" v={r.buyerScore.toFixed(1)} />
                  <KV k="Seller score" v={r.sellerScore.toFixed(1)} />
                  <KV k="Dominance" v={winScore.toFixed(1)} />
                  <KV k="Delta (est.)" v={r.deltaRatio !== null ? r.deltaRatio.toFixed(2) : "—"} hint={r.deltaStatus} />
                  <KV k="CVD slope" v={r.cvdSlope !== null ? fmtCnt(r.cvdSlope) : "—"} />
                  <KV k="5m OI" v={r.oi5mChange !== null ? fmtCnt(r.oi5mChange) : "—"} />
                  <KV k="15m OI" v={r.oi15mChange !== null ? fmtCnt(r.oi15mChange) : "—"} />
                  <KV k="Structure" v={r.structureTrend.toLowerCase()} />
                  <KV k="Support" v={r.nearestSupport !== null ? fmtNum(r.nearestSupport, 1) : "—"} />
                  <KV k="Resistance" v={r.nearestResistance !== null ? fmtNum(r.nearestResistance, 1) : "—"} />
                  <KV k="Zone" v={r.zoneAcceptance.replace(/_/g, " ").toLowerCase()} />
                  <KV k="Futures" v={r.futuresInterpretation ? r.futuresInterpretation.replace(/_/g, " ").toLowerCase().replace(" candidate", "") : "—"} />
                </div>
                {r.evidence.length > 0 && <div><p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Evidence</p>
                  {r.evidence.map((e, i) => <p key={i} className="text-[11px] text-emerald-300/80">▸ {e}</p>)}</div>}
                {r.conflicts.length > 0 && <div><p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Conflicts</p>
                  {r.conflicts.map((e, i) => <p key={i} className="text-[11px] text-rose-300/80">▸ {e}</p>)}</div>}
                {r.absorption.detected && <p className="rounded-lg border border-violet-400/25 bg-violet-400/5 px-2.5 py-1.5 text-[11px] text-violet-200/90">{r.absorption.note}</p>}
                {r.divergence.detected && <p className="rounded-lg border border-rose-400/25 bg-rose-400/5 px-2.5 py-1.5 text-[11px] text-rose-200/90">{r.divergence.note}</p>}
                {r.reversalEvidence.detected && <p className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-2.5 py-1.5 text-[11px] text-amber-200/90">{r.reversalEvidence.note}</p>}
                {r.pending.length > 0 && <div><p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Pending / unavailable</p>
                  {r.pending.map((e, i) => <p key={i} className="text-[11px] text-amber-200/70">▸ {e}</p>)}</div>}
                <button onClick={() => onPick(r.instrumentKey)} className="rounded-lg bg-cyan-400 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-950">Open analysis →</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function KV({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2" title={hint}>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="truncate text-slate-200">{v}</div>
    </div>
  );
}

void Color; void fmtIst;
