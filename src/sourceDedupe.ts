const acceptedByMint = new Map<string, { at: number; source: string }>();

export function markSignalMintAccepted(mint: string, source: string, at = Date.now()): void {
  acceptedByMint.set(mint, { at, source });
}

export function checkSignalMintCooldown(
  mint: string,
  cooldownMins: number,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (cooldownMins <= 0) return { ok: true };
  const seen = acceptedByMint.get(mint);
  if (!seen) return { ok: true };
  const ageMs = now - seen.at;
  if (ageMs >= cooldownMins * 60_000) return { ok: true };
  return {
    ok: false,
    reason: `mint cooldown ${Math.ceil((cooldownMins * 60_000 - ageMs) / 60_000)}m remaining from ${seen.source}`,
  };
}
