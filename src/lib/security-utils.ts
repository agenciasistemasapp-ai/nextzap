// Utilitários de segurança puros (sem rede/banco) — cobertos por security-utils.test.ts.

/** Compara dois segredos sem vazar, pelo tempo de resposta, quantos caracteres batem. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] ?? 0) ^ (y[i % (y.length || 1)] ?? 0);
  return diff === 0 && x.length === y.length;
}

/** Senha temporária com gerador criptográfico (não Math.random). */
export function randomPassword(len = 14): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return `${s}!9`;
}

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^198\.1[89]\./, /^224\./, /^255\./,
];

/**
 * URL de webhook de saída aceitável: https, porta padrão, sem usuário/senha
 * e sem apontar para a rede interna (localhost, IPs privados, metadados de nuvem).
 */
export function checkOutboundUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL(String(raw || "").trim()); } catch { return { ok: false, error: "URL inválida." }; }
  if (u.protocol !== "https:") return { ok: false, error: "Use um endereço https://." };
  if (u.username || u.password) return { ok: false, error: "Não inclua usuário ou senha na URL." };
  if (u.port && u.port !== "443") return { ok: false, error: "Use a porta padrão (443)." };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")
      || host === "metadata.google.internal") {
    return { ok: false, error: "Endereço interno não é permitido." };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) {
    return { ok: false, error: "Endereço interno não é permitido." };
  }
  if (host.includes(":")) {
    // IPv6 literal: bloqueia loopback, link-local, ULA e IPv4 mapeado.
    if (host === "::1" || host === "::" || /^(fe8|fe9|fea|feb|fc|fd)/.test(host) || host.startsWith("::ffff:")) {
      return { ok: false, error: "Endereço interno não é permitido." };
    }
  }
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return { ok: false, error: "URL inválida." };
  if (u.href.length > 500) return { ok: false, error: "URL muito longa." };
  return { ok: true, url: u.href };
}

export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
