/**
 * Quick smoke test — verifies okxClient.ts wires up correctly.
 *
 * Usage:  npx tsx src/_okxTest.ts [mint]
 */

import { getPositionSnapshot } from "./okxClient.js";

const MINT = process.argv[2] ?? "FNpK6anEbnx9PMrwA6aeiUXWF4hJqvbtXLdLM7ALpump";

async function main() {
  console.log(`\nFetching full snapshot for ${MINT}...\n`);
  const t0 = Date.now();
  const snap = await getPositionSnapshot(MINT, 30);
  const ms = Date.now() - t0;

  console.log(`Snapshot fetched in ${ms}ms\n`);

  if (snap.momentum) {
    const m = snap.momentum;
    console.log(`📈 PRICE  $${m.priceUsd.toExponential(3)}  mcap $${(m.marketCapUsd/1000).toFixed(1)}K  liq $${(m.liquidityUsd/1000).toFixed(1)}K  holders ${m.holders}`);
    console.log(`         5m ${m.priceChange5m.toFixed(1)}%  1h ${m.priceChange1h.toFixed(1)}%  4h ${m.priceChange4h.toFixed(1)}%  24h ${m.priceChange24h.toFixed(1)}%`);
    console.log(`   VOL   5m $${m.volume5m.toFixed(0)}  1h $${m.volume1h.toFixed(0)}  4h $${m.volume4h.toFixed(0)}  24h $${m.volume24h.toFixed(0)}`);
    console.log(`   TXS   5m ${m.txs5m}  1h ${m.txs1h}  4h ${m.txs4h}  24h ${m.txs24h}`);
    console.log(`   from ATH: ${m.pctFromAth.toFixed(1)}%`);
  } else {
    console.log("📈 momentum: null");
  }

  console.log("");
  const fmtTW = (label: string, w: typeof snap.smartMoney) =>
    `🤝 ${label.padEnd(13)} buys: ${w.buys}/${w.buyVolumeSol.toFixed(2)} SOL  sells: ${w.sells}/${w.sellVolumeSol.toFixed(2)} SOL  net: ${w.netFlowSol.toFixed(2)} SOL  wallets: ${w.uniqueWallets}`;
  console.log(fmtTW("dev        30m", snap.dev));
  console.log(fmtTW("smartMoney 30m", snap.smartMoney));
  console.log(fmtTW("bundlers   30m", snap.bundlers));
  console.log(fmtTW("insiders   30m", snap.insiders));
  console.log(fmtTW("whales     30m", snap.whales));

  console.log("");
  if (snap.topHolders) {
    const h = snap.topHolders;
    console.log(`👥 TOP 10  holding ${h.holdingPercent.toFixed(1)}%  trend [${h.trendType.join(",")}]  avg PnL $${h.averagePnlUsd.toFixed(2)}`);
    console.log(`   buy  $${h.averageBuyPriceUsd.toExponential(3)}  (${h.averageBuyPricePercent.toFixed(1)}% vs current)`);
    console.log(`   sell $${h.averageSellPriceUsd.toExponential(3)}  (${h.averageSellPricePercent.toFixed(1)}% vs current)`);
  } else {
    console.log("👥 topHolders: null");
  }

  console.log("");
  if (snap.risk) {
    const r = snap.risk;
    const devTag = r.tokenTags.find(t => t.startsWith("devHoldingStatus")) ?? "(unknown)";
    console.log(`🛡️  RISK   tags: [${r.tokenTags.join(",")}]`);
    console.log(`   bundle ${r.bundleHoldingPercent}%  top10 ${r.top10HoldPercent}%  sniper ${r.sniperHoldingPercent}%  LP burned ${r.lpBurnedPercent.toFixed(1)}%`);
    console.log(`   DEV holds ${r.devHoldingPercent}%  status: ${devTag}  snipers ${r.snipersClearAddressCount}/${r.snipersTotal} exited`);
  } else {
    console.log("🛡️  risk: null");
  }

  console.log("");
  console.log(`💧 LP pools: ${snap.liquidity.length}`);
  for (const p of snap.liquidity.slice(0, 3)) {
    console.log(`   ${p.protocolName.padEnd(10)} $${p.liquidityUsd.toFixed(0).padStart(8)}   ${p.pool}`);
  }

  console.log("");
  console.log(`📡 SIGNALS (60m, scoped to token): ${snap.signals.length}`);
  for (const s of snap.signals.slice(0, 5)) {
    const ago = Math.floor((Date.now() - s.timestamp) / 60_000);
    const wt = s.walletType === 1 ? "smart" : s.walletType === 2 ? "kol" : "whale";
    console.log(`   ${ago}m ago — ${wt} (${s.triggerWalletCount} wallets) $${s.amountUsd.toFixed(0)}  sold ${s.soldRatioPercent}%`);
  }

  console.log("");
  console.log(`🕯️  KLINE 1m: ${snap.kline1m.length} candles`);
  if (snap.kline1m.length > 0) {
    const last = snap.kline1m[snap.kline1m.length - 1];
    const first = snap.kline1m[0];
    if (first && last) {
      console.log(`   first $${first.close.toExponential(3)}  →  last $${last.close.toExponential(3)}  (${(((last.close/first.close)-1)*100).toFixed(1)}% over ${snap.kline1m.length}m)`);
    }
  }
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
