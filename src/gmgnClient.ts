import { randomUUID } from "node:crypto";
import logger from "./logger.js";
import { ipv4Fetch } from "./ipv4Fetch.js";

export type GmgnChain = "sol" | "bsc" | "base" | "eth";
export type GmgnTrendingInterval = "1m" | "5m" | "1h" | "6h" | "24h";
export type GmgnTrenchesType = "new_creation" | "near_completion" | "completed";
export type GmgnRow = Record<string, unknown>;

export type GmgnTrendingOptions = {
  limit?: number;
  orderBy?: string;
  direction?: "asc" | "desc";
  filters?: string[];
  platforms?: string[];
};

export type GmgnTrenchesOptions = {
  types?: GmgnTrenchesType[];
  launchpadPlatforms?: string[];
  limit?: number;
  filterPreset?: string;
  minSmartDegenCount?: number;
  sortBy?: string;
};

export type GmgnSignalGroup = {
  signal_type: number[];
  [k: string]: unknown;
};

export type GmgnSignalOptions = {
  groups?: GmgnSignalGroup[];
  signalType?: number[];
  limit?: number;
  side?: "buy" | "sell";
};

export type GmgnTokenInfo = GmgnRow;
export type GmgnTokenSecurity = GmgnRow;
export type GmgnTokenPool = GmgnRow;

const GMGN_BASE_URL = process.env.GMGN_HOST?.trim() || "https://openapi.gmgn.ai";
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_INTERVAL_MS = Math.max(
  0,
  Math.min(2_000, Math.round(Number(process.env.GMGN_MIN_INTERVAL_MS ?? 250))),
);
const MAX_RETRY_DELAY_MS = 60_000;
let nextAvailableAt = 0;
let pacerQueue: Promise<void> = Promise.resolve();

function acquireSlot(): Promise<void> {
  const task = pacerQueue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, nextAvailableAt - now);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextAvailableAt = Date.now() + MIN_INTERVAL_MS;
  });
  pacerQueue = task.catch(() => undefined);
  return task;
}

function delayAll(ms: number): void {
  const target = Date.now() + Math.min(MAX_RETRY_DELAY_MS, ms);
  if (target > nextAvailableAt) nextAvailableAt = target;
}
type GmgnHeaders = Record<string, string>;
type GmgnRequestInit = {
  method?: string;
  body?: string;
  headers?: GmgnHeaders;
};

type CacheEntry<T> = { at: number; value: T };
const cache = new Map<string, CacheEntry<unknown>>();

function isRecord(value: unknown): value is GmgnRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cacheGet<T>(key: string, ttlMs: number): T | undefined {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet<T>(key: string, value: T): void {
  cache.set(key, { at: Date.now(), value });
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function gmgnApiKey(): string {
  const key = process.env.GMGN_API_KEY?.trim();
  if (key) return key;
  logger.warn("[gmgn] GMGN_API_KEY is missing");
  throw new Error("missing GMGN_API_KEY");
}

export function isGmgnConfigured(): boolean {
  return Boolean(process.env.GMGN_API_KEY?.trim());
}

function buildHeaders(extra?: GmgnHeaders): GmgnHeaders {
  const key = gmgnApiKey();
  return {
    accept: "application/json",
    "content-type": "application/json",
    "X-APIKEY": key,
    ...(extra ?? {}),
  };
}

function appendAuthQuery(url: URL): void {
  if (!url.searchParams.has("timestamp")) {
    url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
  }
  if (!url.searchParams.has("client_id")) {
    url.searchParams.set("client_id", randomUUID());
  }
}

function normalizeResponse<T>(payload: unknown): T {
  if (!isRecord(payload)) return payload as T;

  const code = payload.code;
  const ok = payload.ok;
  const success = payload.success;
  if ((typeof code === "number" && code !== 0) || ok === false || success === false) {
    const message =
      text(payload.message) ||
      text(payload.msg) ||
      text(payload.error) ||
      `GMGN request failed (code=${String(code ?? "n/a")})`;
    throw new Error(message);
  }

  if ("data" in payload) return payload.data as T;
  if ("result" in payload) return payload.result as T;
  return payload as T;
}

function collectRows(value: unknown, out: GmgnRow[] = []): GmgnRow[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) out.push(item);
      else if (Array.isArray(item) || isRecord(item)) collectRows(item, out);
    }
    return out;
  }
  if (!isRecord(value)) return out;

  for (const key of [
    "list",
    "items",
    "rows",
    "signals",
    "records",
    "tokens",
    "trends",
    "rank",
    "data",
    "pump",
    "result",
    "results",
  ]) {
    const child = value[key];
    if (Array.isArray(child)) {
      collectRows(child, out);
    }
  }

  return out;
}

function firstObject(value: unknown): GmgnRow | null {
  if (isRecord(value)) return value;
  if (Array.isArray(value)) {
    const first = value.find(isRecord);
    return first ?? null;
  }
  return null;
}

async function requestJson(pathname: string, init: GmgnRequestInit = {}, ttlMs?: number): Promise<unknown> {
  const cacheKey = ttlMs ? `${pathname}:${JSON.stringify({ method: init.method ?? "GET", body: init.body ?? null })}` : "";
  if (ttlMs) {
    const hit = cacheGet<unknown>(cacheKey, ttlMs);
    if (hit !== undefined) return hit;
  }

  const url = new URL(pathname, GMGN_BASE_URL);
  appendAuthQuery(url);
  const retryLimit = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retryLimit; attempt++) {
    await acquireSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await ipv4Fetch(url, {
        ...init,
        headers: buildHeaders(init.headers),
        signal: controller.signal,
      });
      const rawText = await res.text();
      let parsed: unknown = rawText;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch {
          parsed = rawText;
        }
      } else {
        parsed = null;
      }

      if (res.ok) {
        const normalized = normalizeResponse<unknown>(parsed);
        if (ttlMs) cacheSet(cacheKey, normalized);
        return normalized;
      }

      const retryAtHeader = res.headers.get("x-ratelimit-reset");
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAtBody = isRecord(parsed) ? num(parsed.reset_at, 0) : 0;
      const retryAt = retryAtBody > 0
        ? retryAtBody * 1000
        : retryAtHeader
          ? Number(retryAtHeader) * 1000
          : 0;
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0;
      const errorTag =
        isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "";
      const isBanned = errorTag === "RATE_LIMIT_BANNED";

      const err = new Error(
        `GMGN ${res.status} ${res.statusText}${typeof parsed === "string" ? `: ${parsed.slice(0, 160)}` : ""}`,
      );
      if (res.status === 429) {
        const baseDelay = retryAt > Date.now()
          ? retryAt - Date.now()
          : retryAfter > 0
            ? retryAfter
            : 1_000;
        const cap = isBanned ? MAX_RETRY_DELAY_MS : 5_000;
        const delay = Math.min(cap, Math.max(500, baseDelay));
        delayAll(delay);
        if (isBanned || attempt + 1 >= retryLimit) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    } catch (err) {
      const cause = err instanceof Error ? (err as NodeJS.ErrnoException).cause : undefined;
      const causeMsg = cause ? ` (cause: ${String(cause)})` : "";
      lastError = err instanceof Error
        ? (causeMsg ? Object.assign(new Error(err.message + causeMsg), { cause }) : err)
        : new Error(String(err));
      if (attempt + 1 < retryLimit && /AbortError|network|fetch/i.test(lastError.message)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("GMGN request failed");
}

function toRows(raw: unknown): GmgnRow[] {
  const normalized = normalizeResponse<unknown>(raw);
  if (Array.isArray(normalized)) {
    return normalized.filter(isRecord);
  }
  const rows = collectRows(normalized);
  if (rows.length > 0) return rows;
  const object = firstObject(normalized);
  return object ? [object] : [];
}

function toObject(raw: unknown): GmgnRow | null {
  const normalized = normalizeResponse<unknown>(raw);
  return firstObject(normalized);
}

export async function getTokenInfo(chain: GmgnChain, address: string): Promise<GmgnTokenInfo | null> {
  const key = `token-info:${chain}:${address}`;
  const hit = cacheGet<GmgnTokenInfo | null>(key, 60_000);
  if (hit !== undefined) return hit;
  const raw = await requestJson(`/v1/token/info?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`);
  const obj = toObject(raw);
  cacheSet(key, obj);
  return obj;
}

export async function getTokenSecurity(chain: GmgnChain, address: string): Promise<GmgnTokenSecurity | null> {
  const key = `token-security:${chain}:${address}`;
  const hit = cacheGet<GmgnTokenSecurity | null>(key, 60_000);
  if (hit !== undefined) return hit;
  const raw = await requestJson(`/v1/token/security?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`);
  const obj = toObject(raw);
  cacheSet(key, obj);
  return obj;
}

export async function getTokenPool(chain: GmgnChain, address: string): Promise<GmgnTokenPool | null> {
  const key = `token-pool:${chain}:${address}`;
  const hit = cacheGet<GmgnTokenPool | null>(key, 60_000);
  if (hit !== undefined) return hit;
  const raw = await requestJson(`/v1/token/pool_info?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`);
  const obj = toObject(raw);
  cacheSet(key, obj);
  return obj;
}

export async function getMarketTrending(
  chain: GmgnChain,
  interval: GmgnTrendingInterval,
  options: GmgnTrendingOptions = {},
): Promise<GmgnRow[]> {
  const query = new URLSearchParams();
  query.set("chain", chain);
  query.set("interval", interval);
  query.set("limit", String(options.limit ?? 20));
  query.set("order_by", options.orderBy ?? "volume");
  query.set("direction", options.direction ?? "desc");
  for (const filter of options.filters ?? []) query.append("filter", filter);
  for (const platform of options.platforms ?? []) query.append("platform", platform);

  const raw = await requestJson(`/v1/market/rank?${query.toString()}`, {}, 10_000);
  return toRows(raw);
}

export async function getMarketTrenches(chain: GmgnChain, options: GmgnTrenchesOptions = {}): Promise<GmgnRow[]> {
  const body = {
    chain,
    type: options.types ?? ["new_creation", "near_completion", "completed"],
    launchpad_platform: options.launchpadPlatforms ?? [],
    limit: options.limit ?? 20,
    filter_preset: options.filterPreset ?? "safe",
    min_smart_degen_count: options.minSmartDegenCount ?? 0,
    sort_by: options.sortBy ?? "smart_degen_count",
  };
  const raw = await requestJson(
    `/v1/trenches?chain=${encodeURIComponent(chain)}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    10_000,
  );
  return toRows(raw);
}

export async function getMarketSignal(chain: GmgnChain, options: GmgnSignalOptions = {}): Promise<GmgnRow[]> {
  const body = {
    chain,
    groups:
      options.groups ??
      (options.signalType ? [{ signal_type: options.signalType }] : [{ signal_type: [12] }]),
    limit: options.limit ?? 20,
    side: options.side,
  };
  const raw = await requestJson(
    "/v1/market/token_signal",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    10_000,
  );
  return toRows(raw);
}

export function getMaybeString(value: unknown): string | undefined {
  const out = text(value);
  return out.length > 0 ? out : undefined;
}

export function getMaybeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getMaybeBool(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0 || value === "1" || value === "0" || value === "true" || value === "false") {
    return bool(value);
  }
  return undefined;
}
