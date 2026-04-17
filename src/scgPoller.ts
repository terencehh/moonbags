import { CONFIG } from "./config.js";
import logger from "./logger.js";
import type { ScgAlert, ScgAlertsResponse } from "./types.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type AlertHandler = (alert: ScgAlert) => void | Promise<void>;

export type AlertEvent = {
  at: number;
  mint: string;
  name: string;
  score: number;
  age_mins: number;
  liquidity: number;
  action: "fired" | "filtered" | "dedup";
  reason?: string;
};

export const SCG_URL = "https://api.scgalpha.com/api/alerts";
const DEDUP_CAP = 5000;
const RECENT_CAP = 200;

export function alertKey(a: Pick<ScgAlert, "mint" | "alert_time">): string {
  return `${a.mint}:${a.alert_time}`;
}

// ---------------------------------------------------------------------------
// Poller health — updated from inside startScgPoller's tick() so /ping can
// report whether the upstream is reachable and whether the poller is actually
// processing what it receives. Readable via getPollerHealth() / hasSeenAlert().
// ---------------------------------------------------------------------------
let pollerStartedAt = 0;
let lastTickStartedAt = 0;
let lastTickOkAt = 0;
let lastTickError: string | null = null;
let lastHttpStatus: number | null = null;
let lastAlertCount = 0;
let seenRef: Set<string> | null = null;

export type PollerHealth = {
  startedAt: number;
  lastTickStartedAt: number;
  lastTickOkAt: number;
  lastTickError: string | null;
  lastHttpStatus: number | null;
  lastAlertCount: number;
  seenSize: number;
};

export function getPollerHealth(): PollerHealth {
  return {
    startedAt: pollerStartedAt,
    lastTickStartedAt,
    lastTickOkAt,
    lastTickError,
    lastHttpStatus,
    lastAlertCount,
    seenSize: seenRef?.size ?? 0,
  };
}

export function hasSeenAlert(key: string): boolean {
  return seenRef?.has(key) ?? false;
}

const recentEvents: AlertEvent[] = [];

function recordEvent(e: AlertEvent): void {
  recentEvents.push(e);
  while (recentEvents.length > RECENT_CAP) recentEvents.shift();
}

export function getRecentAlertEvents(): AlertEvent[] {
  return [...recentEvents];
}

// ---------------------------------------------------------------------------
// Runtime controls — pause/resume + blacklist (used by Telegram /pause /skip)
// ---------------------------------------------------------------------------
let paused = false;
const blacklist = new Set<string>();

const STATE_DIR = path.resolve("state");
const POLLER_STATE_FILE = path.join(STATE_DIR, "poller.json");

type PollerState = { paused: boolean; blacklist: string[] };

let persistTimer: NodeJS.Timeout | null = null;
function persistPollerState(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await mkdir(STATE_DIR, { recursive: true });
      const state: PollerState = { paused, blacklist: [...blacklist] };
      await writeFile(POLLER_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.error({ err: String(err) }, "[scgPoller] persist state failed");
    }
  }, 200);
  persistTimer.unref?.();
}

/**
 * Restore paused flag and blacklist from disk. Should be awaited at boot
 * (called from main.ts) before the poller starts firing alerts so that
 * a restart doesn't silently un-pause the bot.
 */
export async function loadPollerState(): Promise<void> {
  try {
    const raw = await readFile(POLLER_STATE_FILE, "utf8");
    const state = JSON.parse(raw) as PollerState;
    paused = Boolean(state.paused);
    blacklist.clear();
    for (const m of state.blacklist ?? []) blacklist.add(m);
    logger.info({ paused, blacklistCount: blacklist.size }, "[scgPoller] state restored");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      logger.info("[scgPoller] no prior state — starting fresh (not paused, empty blacklist)");
    } else {
      logger.warn({ err: String(err) }, "[scgPoller] state load failed");
    }
  }
}

export function isPaused(): boolean { return paused; }
export function setPaused(v: boolean): void { paused = v; persistPollerState(); }
export function getBlacklist(): string[] { return [...blacklist]; }
export function addToBlacklist(mint: string): void { blacklist.add(mint); persistPollerState(); }
export function removeFromBlacklist(mint: string): void { blacklist.delete(mint); persistPollerState(); }
export function isBlacklisted(mint: string): boolean { return blacklist.has(mint); }

export function startScgPoller(onNew: AlertHandler): () => void {
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  let isRunning = false;
  let seeded = false;

  pollerStartedAt = Date.now();
  seenRef = seen;

  function remember(key: string): void {
    if (seen.has(key)) return;
    seen.add(key);
    seenOrder.push(key);
    while (seenOrder.length > DEDUP_CAP) {
      const evict = seenOrder.shift();
      if (evict !== undefined) seen.delete(evict);
    }
  }

  function passesFilters(a: ScgAlert): { ok: boolean; reason?: string } {
    if (CONFIG.MAX_ALERT_AGE_MINS > 0 && a.age_mins > CONFIG.MAX_ALERT_AGE_MINS) {
      return { ok: false, reason: `age_mins ${a.age_mins} > ${CONFIG.MAX_ALERT_AGE_MINS}` };
    }
    if (a.score < CONFIG.MIN_SCORE) {
      return { ok: false, reason: `score ${a.score} < ${CONFIG.MIN_SCORE}` };
    }
    if (a.liquidity < CONFIG.MIN_LIQUIDITY_USD) {
      return { ok: false, reason: `liquidity ${a.liquidity} < ${CONFIG.MIN_LIQUIDITY_USD}` };
    }
    if (CONFIG.MAX_RUG_RATIO > 0 && a.rug_ratio >= CONFIG.MAX_RUG_RATIO) {
      return { ok: false, reason: `rug_ratio ${a.rug_ratio} >= ${CONFIG.MAX_RUG_RATIO}` };
    }
    if (CONFIG.MAX_BUNDLER_PCT > 0 && a.bundler_pct >= CONFIG.MAX_BUNDLER_PCT) {
      return { ok: false, reason: `bundler_pct ${a.bundler_pct} >= ${CONFIG.MAX_BUNDLER_PCT}` };
    }
    if (CONFIG.MAX_TOP10_PCT > 0 && a.top10_pct >= CONFIG.MAX_TOP10_PCT) {
      return { ok: false, reason: `top10_pct ${a.top10_pct} >= ${CONFIG.MAX_TOP10_PCT}` };
    }
    if (CONFIG.REQUIRE_RISING_LIQ && a.liq_trend !== "rising") {
      return { ok: false, reason: `liq_trend ${a.liq_trend} !== rising` };
    }
    return { ok: true };
  }

  async function tick(): Promise<void> {
    if (isRunning) {
      logger.debug("[scgPoller] previous tick still running, skipping");
      return;
    }
    isRunning = true;
    lastTickStartedAt = Date.now();
    try {
      logger.debug("[scgPoller] polling");
      const res = await fetch(SCG_URL);
      lastHttpStatus = res.status;
      if (!res.ok) {
        lastTickError = `HTTP ${res.status} ${res.statusText}`;
        logger.error({ status: res.status, statusText: res.statusText }, "[scgPoller] non-OK response");
        return;
      }
      const body = (await res.json()) as ScgAlertsResponse;
      const alerts = Array.isArray(body?.alerts) ? body.alerts : [];
      lastAlertCount = alerts.length;
      lastTickError = null;
      lastTickOkAt = Date.now();

      if (!seeded) {
        for (const a of alerts) remember(alertKey(a));
        seeded = true;
        logger.debug({ count: alerts.length }, "[scgPoller] seeded dedup set on first poll");
        return;
      }

      const fresh: ScgAlert[] = [];
      for (const a of alerts) {
        const k = alertKey(a);
        if (seen.has(k)) continue;
        remember(k);
        if (paused) {
          recordEvent({
            at: Date.now(),
            mint: a.mint, name: a.name, score: a.score,
            age_mins: a.age_mins, liquidity: a.liquidity,
            action: "filtered", reason: "bot paused",
          });
          continue;
        }
        if (blacklist.has(a.mint)) {
          recordEvent({
            at: Date.now(),
            mint: a.mint, name: a.name, score: a.score,
            age_mins: a.age_mins, liquidity: a.liquidity,
            action: "filtered", reason: "blacklisted",
          });
          continue;
        }
        const check = passesFilters(a);
        if (!check.ok) {
          logger.debug({ mint: a.mint, name: a.name, reason: check.reason }, "[scgPoller] filtered out");
          recordEvent({
            at: Date.now(),
            mint: a.mint,
            name: a.name,
            score: a.score,
            age_mins: a.age_mins,
            liquidity: a.liquidity,
            action: "filtered",
            reason: check.reason,
          });
          continue;
        }
        recordEvent({
          at: Date.now(),
          mint: a.mint,
          name: a.name,
          score: a.score,
          age_mins: a.age_mins,
          liquidity: a.liquidity,
          action: "fired",
        });
        fresh.push(a);
      }

      if (fresh.length === 0) return;

      await Promise.all(
        fresh.map((a) => {
          logger.info(
            { mint: a.mint, name: a.name, score: a.score, age_mins: a.age_mins, liquidity: a.liquidity },
            "[scgPoller] firing alert",
          );
          return Promise.resolve()
            .then(() => onNew(a))
            .catch((err) => {
              logger.error({ err, mint: a.mint }, "[scgPoller] handler error");
            });
        }),
      );
    } catch (err) {
      lastTickError = (err as Error)?.message ?? String(err);
      logger.error({ err }, "[scgPoller] poll failed");
    } finally {
      isRunning = false;
    }
  }

  const interval = setInterval(() => {
    void tick();
  }, CONFIG.SCG_POLL_MS);

  void tick();

  return () => {
    clearInterval(interval);
    logger.info("poller stopped");
  };
}
