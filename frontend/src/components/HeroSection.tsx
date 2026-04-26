import { useMemo, useState } from "react";
import { Liveline } from "liveline";
import type { State, ClosedTrade } from "../types";
import { Rocket } from "lucide-react";
import heroMoon from "../assets/hero-moon.png";

type Props = { state: State | null };
const DAY_SECS = 86_400;

/**
 * Visual centerpiece — massive PnL number, faux Pepe-glow halo, sparkline of
 * cumulative realized PnL across closed trades, and a 4-tile KPI footer.
 */
export function HeroSection({ state }: Props) {
  const [windowMode, setWindowMode] = useState<"24h" | "all">("24h");
  const pnl = state?.stats.realizedPnlSol ?? 0;
  const pnlPositive = pnl >= 0;
  const closed = state?.closedTrades ?? [];
  const hasClosed = closed.length > 0;

  // KPIs derived from closedTrades
  const winRate = hasClosed
    ? (closed.filter((t) => t.pnlSol >= 0).length / closed.length) * 100
    : null;
  const avgTradeSol = hasClosed
    ? closed.reduce((s, t) => s + t.pnlSol, 0) / closed.length
    : null;
  const best = hasClosed ? Math.max(...closed.map((t) => t.pnlPct)) : null;
  const worst = hasClosed ? Math.min(...closed.map((t) => t.pnlPct)) : null;
  const grossWins = closed.filter((t) => t.pnlSol > 0).reduce((s, t) => s + t.pnlSol, 0);
  const grossLosses = Math.abs(closed.filter((t) => t.pnlSol < 0).reduce((s, t) => s + t.pnlSol, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : null;
  const allWindowSecs = useMemo(() => {
    if (!closed.length) return DAY_SECS * 365;
    const oldest = Math.min(...closed.map((trade) => trade.closedAt));
    return Math.max(DAY_SECS, Math.ceil((Date.now() - oldest) / 1000) + 60);
  }, [closed]);
  const effectiveWindow = windowMode === "all" ? allWindowSecs : DAY_SECS;
  const chartPoints = useMemo(
    () => buildPnlSeries(closed, effectiveWindow === allWindowSecs ? null : effectiveWindow),
    [allWindowSecs, closed, effectiveWindow],
  );
  const currentChartValue = chartPoints.at(-1)?.value ?? 0;
  const chartEmptyText = effectiveWindow === DAY_SECS
    ? "No closed trades in last 24h"
    : "No closed trades yet";

  return (
    <section className="relative mt-2 overflow-hidden rounded-2xl border border-outline-variant/30 bg-surface-container-low/60 px-6 py-7 backdrop-blur-xl md:px-8 md:py-8">
      <img
        src={heroMoon}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover object-right opacity-52"
      />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(11,12,15,0.96)_0%,rgba(11,12,15,0.82)_38%,rgba(11,12,15,0.58)_68%,rgba(11,12,15,0.32)_100%)] pointer-events-none" aria-hidden="true" />
      <div className="absolute inset-y-0 left-1/4 right-1/3 bg-[radial-gradient(circle_at_center,rgba(134,196,61,0.14),transparent_68%)] pointer-events-none" aria-hidden="true" />

      <div className="relative z-10 grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] lg:items-end">
        <div className="space-y-4">
          <div className="space-y-3">
            <h1
              className={`text-6xl sm:text-7xl md:text-[112px] font-display font-bold leading-none tracking-[-0.06em] relative ${
                pnlPositive ? "text-pepe" : "text-coral"
              }`}
            >
              {pnlPositive ? "+" : ""}
              {pnl.toFixed(2)}
              <span className="ml-3 text-3xl align-baseline sm:text-4xl md:ml-4 md:text-6xl">SOL</span>
            </h1>
            <p className="font-mono text-muted-foreground tracking-[0.22em] text-sm uppercase">
              Realized · Lifetime
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-5 gap-y-6 border-t border-outline-variant/20 pt-6 md:grid-cols-3">
            <Kpi label="WIN RATE" value={winRate === null ? null : `${winRate.toFixed(0)}%`} tone="neutral" />
            <Kpi
              label="AVG PNL / TRADE"
              value={avgTradeSol === null ? null : `${avgTradeSol >= 0 ? "+" : ""}${avgTradeSol.toFixed(2)} SOL`}
              tone={avgTradeSol === null ? "neutral" : avgTradeSol >= 0 ? "good" : "bad"}
            />
            <Kpi label="BEST TRADE" value={best === null ? null : `${best >= 0 ? "+" : ""}${best.toFixed(0)}%`} tone="good" />
            <Kpi label="WORST TRADE" value={worst === null ? null : `${worst >= 0 ? "+" : ""}${worst.toFixed(0)}%`} tone={worst === null ? "neutral" : worst < 0 ? "bad" : "good"} />
            <Kpi
              label="PROFIT FACTOR"
              value={profitFactor === null ? null : !Number.isFinite(profitFactor) ? "∞" : profitFactor.toFixed(2)}
              tone={profitFactor === null ? "neutral" : profitFactor >= 1 ? "good" : "bad"}
            />
            <Kpi label="TOTAL TRADES" value={hasClosed ? `${closed.length}` : null} tone="neutral" />
          </div>
        </div>

        <div className="relative min-h-[220px] overflow-hidden rounded-xl border border-outline-variant/20 bg-background/20 px-4 py-4">
          <div className="absolute inset-y-0 left-0 right-0 bg-[linear-gradient(to_bottom,transparent,rgba(12,14,18,0.16)_76%,rgba(12,14,18,0.48))]" aria-hidden="true" />
          <div className="relative z-20 flex flex-wrap items-center justify-between gap-3">
            <div className="rounded-md border border-outline-variant/15 bg-background/55 px-3 py-1.5 font-mono text-[10px] uppercase text-muted-foreground backdrop-blur">
              Window
              <span className="ml-2 text-foreground">{windowMode === "24h" ? "24H" : "ALL"}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-outline-variant/20 bg-background/70 p-1 backdrop-blur">
              <WindowButton
                label="24H"
                active={windowMode === "24h"}
                onClick={() => setWindowMode("24h")}
              />
              <WindowButton
                label="All"
                active={windowMode === "all"}
                onClick={() => setWindowMode("all")}
              />
            </div>
          </div>
          <div className="relative z-10 mt-4 h-[140px] md:h-[154px]">
            <Liveline
              data={chartPoints}
              value={currentChartValue}
              theme="dark"
              color="#86c43d"
              window={effectiveWindow}
              grid={false}
              badge={false}
              fill
              pulse
              momentum
              scrub={false}
              showValue={false}
              emptyText={chartEmptyText}
              formatValue={(value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)} SOL`}
              formatTime={(time) => new Date(time * 1000).toLocaleString()}
              padding={{ top: 12, right: 12, bottom: 24, left: 10 }}
              className="h-full w-full"
            />
          </div>
          <div className="absolute -bottom-10 -right-10 opacity-[0.10] pointer-events-none text-pepe" aria-hidden="true">
            <Rocket className="h-[220px] w-[220px]" strokeWidth={1} />
          </div>
        </div>
      </div>
    </section>
  );
}

function buildPnlSeries(closed: ClosedTrade[], windowSecs: number | null) {
  const now = Date.now();
  const filtered = [...closed]
    .sort((a, b) => a.closedAt - b.closedAt)
    .filter((trade) => windowSecs === null || now - trade.closedAt <= windowSecs * 1000);

  let acc = 0;
  return filtered.map((trade) => {
    acc += trade.pnlSol;
    return { time: Math.floor(trade.closedAt / 1000), value: acc };
  });
}

function WindowButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md px-3 py-1.5 font-mono text-[10px] uppercase transition-colors ${
        active
          ? "bg-pepe/18 text-pepe border border-pepe/30 shadow-[0_0_0_1px_rgba(134,196,61,0.12)_inset]"
          : "text-muted-foreground border border-transparent hover:text-foreground hover:bg-background/60"
      }`}
    >
      {label}
    </button>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone: "good" | "bad" | "neutral";
}) {
  const color = value === null
    ? "text-muted-foreground"
    : tone === "good"
      ? "text-pepe"
      : tone === "bad"
        ? "text-coral"
        : "text-foreground";
  return (
    <div>
      <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest block mb-1">
        {label}
      </span>
      <span className={`text-[28px] leading-none font-mono font-bold tabular-nums ${color}`}>
        {value ?? "—"}
      </span>
    </div>
  );
}
