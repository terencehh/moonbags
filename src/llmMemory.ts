/**
 * LLM memory for the exit advisor.
 *
 * Tiered memory:
 *   - L2 (in-memory): ring buffer of recent PositionSnapshots + recent LLM
 *     decisions per mint. computeTrends() turns the snapshot ring into a
 *     compact trend-vector block that the user prompt embeds.
 *   - L3 (persisted):   state/llm_decisions.json — a closed-trade log used
 *     for track-record and similar-case injection.
 *   - Audit trail:      state/llm_audits/<mint>.json — exact prompt payloads
 *     and gate outcomes for post-mortem debugging.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { PositionSnapshot } from "./okxClient.js";

// ---------------------------------------------------------------------------
// L2 — in-memory ring buffers
// ---------------------------------------------------------------------------
const SNAPSHOT_DEPTH = 10;
const DECISION_DEPTH = 10;

type SnapshotRecord = { at: number; snap: PositionSnapshot };

export type DecisionRecord = {
  at: number;
  action: "hold" | "exit_now" | "set_trail" | "partial_exit" | "tighten_trail";   // legacy "tighten_trail" tolerated
  newTrailPct?: number;
  oldTrailPct: number;
  reason: string;
  pnlPct: number;        // decimal at time of decision (e.g. 0.574)
  peakPnlPct: number;    // decimal
  citedFacts?: string[];
  evidenceKeys?: string[];
  gate?: {
    partialExitAllowed: boolean;
    exitNowAllowed: boolean;
    tightenAllowed: boolean;
    blockedAction?: string;
  };
};

const snapshotLog = new Map<string, SnapshotRecord[]>();
const decisionLog = new Map<string, DecisionRecord[]>();

export function recordSnapshot(mint: string, snap: PositionSnapshot): void {
  const arr = snapshotLog.get(mint) ?? [];
  arr.push({ at: Date.now(), snap });
  if (arr.length > SNAPSHOT_DEPTH) arr.splice(0, arr.length - SNAPSHOT_DEPTH);
  snapshotLog.set(mint, arr);
}

export function recordDecision(mint: string, dec: DecisionRecord): void {
  const arr = decisionLog.get(mint) ?? [];
  arr.push(dec);
  if (arr.length > DECISION_DEPTH) arr.splice(0, arr.length - DECISION_DEPTH);
  decisionLog.set(mint, arr);
}

export function getSnapshots(mint: string): SnapshotRecord[] {
  return snapshotLog.get(mint) ?? [];
}

export function getDecisions(mint: string): DecisionRecord[] {
  return decisionLog.get(mint) ?? [];
}

export function clearMint(mint: string): void {
  snapshotLog.delete(mint);
  decisionLog.delete(mint);
}

// ---------------------------------------------------------------------------
// Trend vectors — last ~5 samples of each key signal, oldest → newest
// ---------------------------------------------------------------------------
export type TrendVectors = {
  samples: number;
  ageSecs: number[];
  price: number[];
  volume5m: number[];
  priceChange5m: number[];
  holders: number[];
  smartMoneyNetFlow: number[];
  bundlersNetFlow: number[];
  devNetFlow: number[];
  whalesNetFlow: number[];
  topHoldersAvgPnl: number[];
  liquidityTotal: number[];
};

const TREND_SAMPLES = 5;

function liquiditySum(snap: PositionSnapshot): number {
  return snap.liquidity.reduce((s, p) => s + p.liquidityUsd, 0);
}

export function computeTrends(mint: string): TrendVectors | null {
  const arr = snapshotLog.get(mint);
  if (!arr || arr.length < 2) return null;

  // oldest → newest, keep last TREND_SAMPLES
  const slice = arr.slice(-TREND_SAMPLES);
  const now = Date.now();

  const price: number[] = [];
  const volume5m: number[] = [];
  const priceChange5m: number[] = [];
  const holders: number[] = [];
  const smartMoneyNetFlow: number[] = [];
  const bundlersNetFlow: number[] = [];
  const devNetFlow: number[] = [];
  const whalesNetFlow: number[] = [];
  const topHoldersAvgPnl: number[] = [];
  const liquidityTotal: number[] = [];
  const ageSecs: number[] = [];

  for (const rec of slice) {
    const s = rec.snap;
    ageSecs.push(Math.floor((now - rec.at) / 1000));
    price.push(s.momentum?.priceUsd ?? 0);
    volume5m.push(s.momentum?.volume5m ?? 0);
    priceChange5m.push(s.momentum?.priceChange5m ?? 0);
    holders.push(s.momentum?.holders ?? 0);
    smartMoneyNetFlow.push(s.smartMoney.netFlowSol);
    bundlersNetFlow.push(s.bundlers.netFlowSol);
    devNetFlow.push(s.dev.netFlowSol);
    whalesNetFlow.push(s.whales.netFlowSol);
    topHoldersAvgPnl.push(s.topHolders?.averagePnlUsd ?? 0);
    liquidityTotal.push(liquiditySum(s));
  }

  return {
    samples: slice.length,
    ageSecs,
    price,
    volume5m,
    priceChange5m,
    holders,
    smartMoneyNetFlow,
    bundlersNetFlow,
    devNetFlow,
    whalesNetFlow,
    topHoldersAvgPnl,
    liquidityTotal,
  };
}

// ---------------------------------------------------------------------------
// L3 — persistent decision log (shadow-mode; not read back into prompts)
// ---------------------------------------------------------------------------
const STATE_DIR = path.resolve("state");
const DECISIONS_FILE = path.join(STATE_DIR, "llm_decisions.json");
const AUDIT_DIR = path.join(STATE_DIR, "llm_audits");
const MAX_RECORDS = 500;
const MAX_AUDIT_RECORDS_PER_MINT = 50;

export type LlmTradeRecord = {
  mint: string;
  name: string;
  openedAt: number;
  closedAt: number;
  holdSecs: number;
  entryPnlPct: number;
  exitPnlPct: number;
  peakPnlPct: number;
  exitReason: string;
  decisions: DecisionRecord[];
  verdict:
    | "correct_exit"        // LLM pulled the trigger, captured >70% of peak
    | "premature_exit"      // LLM pulled the trigger, captured <70% of peak (jeeted too early)
    | "correct_tighten"     // LLM tightened, captured >50% of peak
    | "premature_tighten"   // LLM tightened, captured <50% of peak
    | "held_well"           // all holds, exit POSITIVE and captured >60% of peak
    | "held_partial_gain"   // all holds, exit POSITIVE but <60% of peak (profitable round-trip)
    | "round_trip_loss"     // all holds, peaked >+50% then exited NEGATIVE (failed runner)
    | "stuck_loser"         // all holds, never peaked above +50%, exited negative (dying token)
    | "mixed";              // mixture of actions that don't cleanly fit above
};

/**
 * Map a closed trade's decision timeline + outcome to a verdict label.
 *
 * The labels drive two things:
 *   1. The /track histogram (how's the LLM doing overall)
 *   2. Future L3 track-record injection ("you over-tighten" etc.)
 *
 * Distinguishing held_well vs held_partial_gain vs round_trip_loss vs
 * stuck_loser matters because each needs a DIFFERENT corrective lesson:
 *   - held_partial_gain  → "tighten earlier on fading momentum, lock more profit"
 *   - round_trip_loss    → "protect peak gains, don't let winners become losers"
 *   - stuck_loser        → "exit sooner when the initial thesis fails"
 *   - held_well          → keep doing what you're doing
 */
export function computeVerdict(
  rec: Omit<LlmTradeRecord, "verdict">,
): LlmTradeRecord["verdict"] {
  const hadTighten = rec.decisions.some(
    (d) =>
      (d.action === "set_trail" || d.action === "tighten_trail") &&
      d.newTrailPct != null &&
      d.newTrailPct < d.oldTrailPct,
  );
  const hadExit = rec.exitReason === "llm";
  const allHolds = rec.decisions.length > 0 && rec.decisions.every((d) => d.action === "hold");
  const exitPct = rec.exitPnlPct;   // decimal, e.g. 0.308 = +30.8%
  const peakPct = rec.peakPnlPct;    // decimal, e.g. 2.574 = +257.4%
  const capturedRatio = peakPct > 0 ? exitPct / peakPct : 1;

  if (hadExit) {
    return capturedRatio > 0.7 ? "correct_exit" : "premature_exit";
  }
  if (hadTighten) {
    return capturedRatio > 0.5 ? "correct_tighten" : "premature_tighten";
  }
  if (allHolds) {
    // Profitable exits split by how much of the peak they captured
    if (exitPct > 0) {
      return capturedRatio > 0.6 ? "held_well" : "held_partial_gain";
    }
    // Negative exits split by whether the position was ever a real winner
    // (peaked above +50%) or was always bleeding (stuck_loser).
    return peakPct > 0.5 ? "round_trip_loss" : "stuck_loser";
  }
  return "mixed";
}

// Serialize writes to llm_decisions.json — concurrent closes must not race
// the read-modify-write.
let chain: Promise<void> = Promise.resolve();

export async function appendLlmTradeRecord(rec: LlmTradeRecord): Promise<void> {
  chain = chain.then(async () => {
    try {
      await mkdir(STATE_DIR, { recursive: true });
      let all: LlmTradeRecord[] = [];
      try {
        const raw = await readFile(DECISIONS_FILE, "utf8");
        all = JSON.parse(raw) as LlmTradeRecord[];
      } catch {
        /* first write */
      }
      all.push(rec);
      if (all.length > MAX_RECORDS) all = all.slice(-MAX_RECORDS);
      await writeFile(DECISIONS_FILE, JSON.stringify(all, null, 2));
    } catch (err) {
      // Don't crash position close on logging error
      // eslint-disable-next-line no-console
      console.error("[llm-decisions] append failed:", String(err));
    }
  });
  return chain;
}

export async function readLlmTradeRecords(limit = 100): Promise<LlmTradeRecord[]> {
  try {
    const raw = await readFile(DECISIONS_FILE, "utf8");
    const all = JSON.parse(raw) as LlmTradeRecord[];
    return all.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export type LlmPromptAuditRecord = {
  at: number;
  mint: string;
  name: string;
  context: Record<string, unknown>;
  evidence: unknown;
  similarCases: unknown;
  payload: unknown;
  userPrompt: string;
  rawToolArguments?: string;
  decision?: unknown;
  gate?: unknown;
  error?: string;
  latencyMs?: number;
};

function auditFileForMint(mint: string): string {
  const safe = mint.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return path.join(AUDIT_DIR, `${safe}.json`);
}

export async function appendLlmPromptAudit(rec: LlmPromptAuditRecord): Promise<void> {
  chain = chain.then(async () => {
    try {
      await mkdir(AUDIT_DIR, { recursive: true });
      const file = auditFileForMint(rec.mint);
      let all: LlmPromptAuditRecord[] = [];
      try {
        const raw = await readFile(file, "utf8");
        all = JSON.parse(raw) as LlmPromptAuditRecord[];
      } catch {
        /* first write */
      }
      all.push(rec);
      if (all.length > MAX_AUDIT_RECORDS_PER_MINT) {
        all = all.slice(-MAX_AUDIT_RECORDS_PER_MINT);
      }
      await writeFile(file, JSON.stringify(all, null, 2));
    } catch (err) {
      // Audit writes must never block trading.
      // eslint-disable-next-line no-console
      console.error("[llm-audit] append failed:", String(err));
    }
  });
  return chain;
}
