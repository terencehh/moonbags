/**
 * IPv4-only fetch wrapper.
 *
 * GMGN OpenAPI rejects IPv6 connections. IPv4 preference is enforced globally
 * by `dns.setDefaultResultOrder("ipv4first")` in main.ts before any network
 * calls, so no hostname substitution is needed here. Substituting a raw IP
 * breaks TLS SNI (the server sees SNI=<IP> instead of the hostname and rejects
 * the handshake with SSL alert 40), so we just delegate to the native fetch.
 */

export function ipv4Fetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}
