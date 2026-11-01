/**
 * Priority option-chain fetch queue.
 *
 * ROOT CAUSE THIS FIXES: the chain scheduler previously fetched 3 indices + 1
 * focused instrument + `CHAINS_PER_CYCLE = 2` stocks chosen by an alphabetical
 * rotation cursor. That cursor NEVER consulted the Trade Finder shortlist, so
 * with 213 option-enabled equities a shortlisted stock had only a ~0.94%
 * chance of receiving a chain in any given cycle (a full rotation took ~53
 * minutes) — while the Trade Finder was analysing 6 stocks per cycle.
 *
 * The queue registers every shortlisted instrument automatically and orders
 * fetches by explicit priority tiers:
 *   1. INDEX            — NIFTY, BANKNIFTY, SENSEX
 *   2. NEW_SHORTLIST    — newly shortlisted this cycle (highest stock priority)
 *   3. ACTIVE_CANDIDATE — still on the shortlist
 *   4. FOCUSED          — user-selected instrument
 *   5. ROTATION         — remaining F&O universe, fair background rotation
 *
 * Invariants (tested):
 *  - An instrument never appears twice in one cycle's fetch list.
 *  - Removing an instrument from the shortlist demotes it, never deletes data.
 *  - A successful fetch updates the per-underlying timestamp; failures do not.
 *  - The queue is deterministic for identical inputs.
 */

export type ChainPriority = "INDEX" | "NEW_SHORTLIST" | "ACTIVE_CANDIDATE" | "FOCUSED" | "ROTATION";

/** Explicit chain availability/fetch statuses surfaced to the UI. */
export type ChainAvailabilityStatus =
  | "OPTIONS_AVAILABLE"
  | "OPTIONS_UNAVAILABLE"
  | "FETCHING"
  | "FETCH_FAILED"
  | "STALE_CHAIN"
  | "INVALID_INSTRUMENT";

export interface QueueEntry {
  underlyingKey: string;
  symbol: string;
  priority: ChainPriority;
  /** First cycle in which this instrument was shortlisted. */
  shortlistedAtCycle: number | null;
  lastSuccessfulFetchAt: number | null;
  lastAttemptAt: number | null;
  consecutiveFailures: number;
  status: ChainAvailabilityStatus;
  note: string;
}

const PRIORITY_ORDER: Record<ChainPriority, number> = {
  INDEX: 0,
  NEW_SHORTLIST: 1,
  ACTIVE_CANDIDATE: 2,
  FOCUSED: 3,
  ROTATION: 4,
};

/** Freshness window beyond which a cached chain is reported STALE_CHAIN. */
export const CHAIN_STALE_MS = 150_000;

export class ChainPriorityQueue {
  private entries = new Map<string, QueueEntry>();
  private cycle = 0;

  /** Advance the cycle counter; returns the new cycle number. */
  nextCycle(): number {
    return ++this.cycle;
  }

  get currentCycle(): number {
    return this.cycle;
  }

  /**
   * Register the indices (always fetched, highest priority).
   */
  registerIndices(indices: { key: string; symbol: string }[]): void {
    for (const i of indices) {
      const e = this.ensure(i.key, i.symbol);
      e.priority = "INDEX";
    }
  }

  /**
   * Synchronise the queue with the latest Trade Finder shortlist.
   *
   * Newly shortlisted instruments are promoted to NEW_SHORTLIST so they are
   * fetched ahead of everything except the indices; instruments already on the
   * list stay ACTIVE_CANDIDATE; instruments no longer shortlisted are demoted
   * to ROTATION (their cached data and timestamps are preserved, never wiped).
   */
  syncShortlist(keys: string[], symbolOf: (key: string) => string): { added: string[]; retained: string[]; demoted: string[] } {
    const shortlistSet = new Set(keys);
    const added: string[] = [];
    const retained: string[] = [];
    const demoted: string[] = [];

    for (const key of keys) {
      const existing = this.entries.get(key);
      if (!existing || existing.priority === "ROTATION" || existing.priority === "FOCUSED") {
        this.ensure(key, symbolOf(key)).priority = "NEW_SHORTLIST";
        this.entries.get(key)!.shortlistedAtCycle = this.cycle;
        added.push(key);
      } else {
        retained.push(key);
      }
    }

    // Demote anything shortlisted previously but absent now (indices excluded).
    for (const [key, e] of this.entries) {
      if (e.priority === "INDEX") continue;
      if (!shortlistSet.has(key) && (e.priority === "NEW_SHORTLIST" || e.priority === "ACTIVE_CANDIDATE")) {
        e.priority = "ROTATION";
        demoted.push(key);
      }
    }

    // New entries stay NEW_SHORTLIST for exactly one cycle, then become
    // ACTIVE_CANDIDATE so the next newly-shortlisted stock outranks them.
    for (const key of added) {
      // no-op here; ageing happens in agePriorities()
    }
    return { added, retained, demoted };
  }

  /** Age NEW_SHORTLIST entries into ACTIVE_CANDIDATE after one cycle. */
  agePriorities(): void {
    for (const e of this.entries.values()) {
      if (e.priority === "NEW_SHORTLIST" && e.shortlistedAtCycle !== null && this.cycle > e.shortlistedAtCycle) {
        e.priority = "ACTIVE_CANDIDATE";
      }
    }
  }

  /** Register/refresh the user-focused instrument. */
  registerFocused(key: string | null, symbolOf: (key: string) => string): void {
    if (!key) return;
    const e = this.ensure(key, symbolOf(key));
    if (e.priority !== "INDEX" && e.priority !== "NEW_SHORTLIST" && e.priority !== "ACTIVE_CANDIDATE") {
      e.priority = "FOCUSED";
    }
  }

  /**
   * The ordered fetch list for this cycle, bounded by `budget`.
   * Deterministic: stable priority order, then symbol, then key.
   */
  fetchList(budget: number): QueueEntry[] {
    const list = [...this.entries.values()].sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        a.symbol.localeCompare(b.symbol) ||
        a.underlyingKey.localeCompare(b.underlyingKey)
    );
    return list.slice(0, Math.max(0, budget));
  }

  /**
   * Rotation backfill: instruments not otherwise prioritised are added so the
   * wider universe still receives periodic coverage.
   */
  addRotation(candidates: { key: string; symbol: string }[], cursor: number, count: number): string[] {
    if (candidates.length === 0) return [];
    const added: string[] = [];
    for (let i = 0; i < candidates.length && added.length < count; i++) {
      const c = candidates[(cursor + i) % candidates.length];
      const existing = this.entries.get(c.key);
      if (existing && existing.priority !== "ROTATION") continue; // already higher priority
      if (!existing) {
        this.ensure(c.key, c.symbol).priority = "ROTATION";
        added.push(c.key);
      }
    }
    return added;
  }

  /** Mark a fetch attempt (success or failure). Older data is never overwritten by failures. */
  recordAttempt(key: string, ok: boolean, note: string, now: number): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.lastAttemptAt = now;
    if (ok) {
      e.lastSuccessfulFetchAt = now;
      e.consecutiveFailures = 0;
      e.status = "OPTIONS_AVAILABLE";
      e.note = note;
    } else {
      e.consecutiveFailures++;
      e.status = "FETCH_FAILED";
      e.note = note;
      // a failure never clears a previously successful fetch timestamp
    }
  }

  markFetching(key: string, now: number): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.lastAttemptAt = now;
    e.status = "FETCHING";
  }

  markUnavailable(key: string, note: string, now: number): void {
    const e = this.ensure(key, key);
    e.status = "OPTIONS_UNAVAILABLE";
    e.note = note;
    e.lastAttemptAt = now;
  }

  markInvalid(key: string, note: string, now: number): void {
    const e = this.ensure(key, key);
    e.status = "INVALID_INSTRUMENT";
    e.note = note;
    e.lastAttemptAt = now;
  }

  /** Current status, applying the staleness rule to successfully fetched chains. */
  statusOf(key: string, now: number): ChainAvailabilityStatus | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.status === "OPTIONS_AVAILABLE" && e.lastSuccessfulFetchAt !== null && now - e.lastSuccessfulFetchAt > CHAIN_STALE_MS) {
      return "STALE_CHAIN";
    }
    return e.status;
  }

  entry(key: string): QueueEntry | null {
    return this.entries.get(key) ?? null;
  }

  all(): QueueEntry[] {
    return [...this.entries.values()];
  }

  /** How many instruments currently hold a fresh, successfully fetched chain. */
  stats(now: number): {
    registered: number;
    shortlisted: number;
    freshChains: number;
    staleChains: number;
    failed: number;
  } {
    let shortlisted = 0, fresh = 0, stale = 0, failed = 0;
    for (const e of this.entries.values()) {
      if (e.priority === "NEW_SHORTLIST" || e.priority === "ACTIVE_CANDIDATE") shortlisted++;
      const st = this.statusOf(e.underlyingKey, now);
      if (st === "OPTIONS_AVAILABLE") fresh++;
      else if (st === "STALE_CHAIN") stale++;
      else if (st === "FETCH_FAILED" || st === "INVALID_INSTRUMENT" || st === "OPTIONS_UNAVAILABLE") failed++;
    }
    return { registered: this.entries.size, shortlisted, freshChains: fresh, staleChains: stale, failed };
  }

  private ensure(key: string, symbol: string): QueueEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = {
        underlyingKey: key, symbol, priority: "ROTATION",
        shortlistedAtCycle: null, lastSuccessfulFetchAt: null, lastAttemptAt: null,
        consecutiveFailures: 0, status: "OPTIONS_UNAVAILABLE",
        note: "not yet fetched",
      };
      this.entries.set(key, e);
    }
    return e;
  }
}
