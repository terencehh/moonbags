/**
 * IPv4-only fetch wrapper.
 *
 * GMGN OpenAPI rejects IPv6 connections with 403. We pre-resolve the hostname
 * to an IPv4 address using dns.resolve4() and substitute it into the URL,
 * then pass the original Host header so TLS/SNI still works correctly.
 *
 * This approach works on all platforms without relying on undici internals.
 */

import dns from "dns";

const ipv4Cache = new Map<string, { ip: string; expiresAt: number }>();
const TTL_MS = 5 * 60_000;

async function resolveIPv4(hostname: string): Promise<string> {
  const cached = ipv4Cache.get(hostname);
  if (cached && Date.now() < cached.expiresAt) return cached.ip;
  try {
    const addrs = await dns.promises.resolve4(hostname);
    const ip = addrs[0];
    if (!ip) return hostname;
    ipv4Cache.set(hostname, { ip, expiresAt: Date.now() + TTL_MS });
    return ip;
  } catch {
    return hostname; // fallback — let OS resolve, better than crashing
  }
}

export async function ipv4Fetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const hostname = parsed.hostname;

  const ip = await resolveIPv4(hostname);

  // Replace hostname with resolved IPv4 address
  const ipUrl = new URL(parsed.toString());
  ipUrl.hostname = ip;

  const headers = new Headers(init?.headers);
  headers.set("Host", hostname); // preserve SNI / virtual host routing

  return fetch(ipUrl.toString(), {
    ...(init ?? {}),
    headers,
  });
}
