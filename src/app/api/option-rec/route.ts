/**
 * Stage-2 option recommendations for every shortlisted underlying signal.
 *
 * Reads the existing stage-1 Trade Finder board and attaches an option
 * contract recommendation to each entry. Consumes cached provider data only —
 * no additional Upstox requests are issued here.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("instrumentKey");

  const e = await ensureBoot();
  const status = e.getStatus();

  if (status.tokenStatus !== "VALID") {
    return NextResponse.json({
      ok: false,
      state: "REQUIRES_TOKEN",
      reason: "Option recommendations need live option-chain data: connect an Upstox access token.",
      recommendations: [],
      asOf: Date.now(),
    });
  }

  // Single instrument, or the whole shortlist.
  if (key) {
    const rec = e.getOptionRecommendation(key);
    return NextResponse.json({
      ok: true,
      state: "LOADED",
      recommendations: rec ? [rec] : [],
      asOf: Date.now(),
    });
  }

  const seen = new Set<string>();
  const recommendations = [];
  for (const sig of e.signalsBoard) {
    if (sig.status !== "WATCH" && sig.status !== "ACTIVE") continue;
    if (seen.has(sig.instrumentKey)) continue;
    seen.add(sig.instrumentKey);
    const rec = e.getOptionRecommendation(sig.instrumentKey);
    if (rec) recommendations.push(rec);
  }

  return NextResponse.json({
    ok: true,
    state: "LOADED",
    recommendations,
    asOf: Date.now(),
  });
}
