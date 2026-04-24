import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "./logger.js";
import { quoteTokenToSol } from "./jupClient.js";
import { CONFIG } from "./config.js";

const execFileAsync = promisify(execFile);

export type PriceV3Entry = { usdPrice: number; decimals: number; blockId: number };

// ---------------------------------------------------------------------------
// OKX price feed — via onchainos CLI.
// ---------------------------------------------------------------------------
export async function getOkxPrices(
  mints: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;

  const unique = Array.from(new Set(mints));
  const tokens = unique.join(",");

  try {
    const localBin = `${process.env.HOME ?? "/root"}/.local/bin`;
    const priceFeedEnv = {
      ...process.env,
      PATH: process.env.PATH?.includes(localBin) ? process.env.PATH : `${localBin}:${process.env.PATH ?? ""}`,
    };
    const { stdout } = await execFileAsync("onchainos", [
      "market", "prices",
      "--tokens", tokens,
      "--chain", "solana",
    ], { timeout: 3_000, env: priceFeedEnv });

    const json = JSON.parse(stdout) as {
      ok: boolean;
      data?: Array<{ tokenContractAddress: string; price: string }>;
    };

    if (!json.ok || !json.data) {
      logger.warn({ tokens }, "[priceFeed] okx prices returned not-ok");
      return out;
    }

    for (const entry of json.data) {
      const price = parseFloat(entry.price);
      if (Number.isFinite(price) && price > 0) {
        out.set(entry.tokenContractAddress, price);
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[priceFeed] okx prices failed");
  }

  return out;
}

// ---------------------------------------------------------------------------
// Jupiter Price V3 batch — second-source price feed (up to 50 tokens/req).
// Uses premium endpoint with API key for higher rate limits.
// ---------------------------------------------------------------------------
const PRICE_V3_URL = "https://api.jup.ag/price/v3";
const BATCH_SIZE = 50;

export async function getPricesV3(
  mints: string[],
): Promise<Map<string, PriceV3Entry | null>> {
  const out = new Map<string, PriceV3Entry | null>();
  if (mints.length === 0) return out;

  const unique = Array.from(new Set(mints));
  try {
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const chunk = unique.slice(i, i + BATCH_SIZE);
      const url = `${PRICE_V3_URL}?ids=${chunk.join(",")}`;
      const res = await fetch(url, {
        headers: { "x-api-key": CONFIG.JUP_API_KEY, accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) {
        for (const m of chunk) out.set(m, null);
        continue;
      }
      const json = (await res.json()) as Record<
        string,
        { usdPrice?: number; decimals?: number; blockId?: number } | null
      >;
      for (const m of chunk) {
        const entry = json[m];
        if (!entry || entry.usdPrice == null) {
          out.set(m, null);
        } else {
          out.set(m, {
            usdPrice: Number(entry.usdPrice),
            decimals: Number(entry.decimals ?? 0),
            blockId: Number(entry.blockId ?? 0),
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[priceFeed] getPricesV3 failed");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified batch price fetch — runs OKX + V3 in parallel, merges results.
// OKX is preferred when present; V3 fills gaps; returns map of mint → USD price.
// Also returns solUsdPrice for SOL-denominated conversions.
// ---------------------------------------------------------------------------
export async function getBatchPricesParallel(mints: string[]): Promise<Map<string, number>> {
  if (mints.length === 0) return new Map();

  const [okxResult, v3Result] = await Promise.allSettled([
    getOkxPrices(mints),
    getPricesV3(mints),
  ]);

  const merged = new Map<string, number>();

  // Prefer OKX when available
  if (okxResult.status === "fulfilled") {
    for (const [m, p] of okxResult.value.entries()) {
      if (Number.isFinite(p) && p > 0) merged.set(m, p);
    }
  }

  // Fill gaps with V3
  if (v3Result.status === "fulfilled") {
    for (const [m, entry] of v3Result.value.entries()) {
      if (!merged.has(m) && entry && Number.isFinite(entry.usdPrice) && entry.usdPrice > 0) {
        merged.set(m, entry.usdPrice);
      }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Sell-quote price — most accurate, used as fallback and for entry pricing.
// ---------------------------------------------------------------------------
export async function getPriceViaSellQuote(
  mint: string,
  tokenAmountRaw: bigint,
): Promise<{ solPerTokenRaw: number; solReceivedLamports: bigint } | null> {
  if (tokenAmountRaw <= 0n) return null;
  const q = await quoteTokenToSol(mint, tokenAmountRaw);
  if (!q) return null;
  const solPerTokenRaw = Number(q.outSolLamports) / Number(tokenAmountRaw);
  return { solPerTokenRaw, solReceivedLamports: q.outSolLamports };
}
