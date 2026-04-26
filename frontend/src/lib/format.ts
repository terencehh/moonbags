export const truncMint = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
export const fmtSol = (n: number) => n.toFixed(6);
export const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;
export const fmtAge = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
export const fmtRel = (ms: number) => {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3600_000)}h ago`;
};
export const fmtUptime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
export const fmtHold = (secs: number) => {
  if (secs > 1e10) return "∞";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
};
export const fmtUsd = (n: number) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
};

export const fmtCompactSol = (n: number) => {
  if (n >= 100) return `${n.toFixed(0)} SOL`;
  if (n >= 10) return `${n.toFixed(1)} SOL`;
  if (n >= 1) return `${n.toFixed(2)} SOL`;
  if (n >= 0.1) return `${n.toFixed(3)} SOL`;
  return `${n.toFixed(4)} SOL`;
};
