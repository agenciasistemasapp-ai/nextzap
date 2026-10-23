import { describe, expect, it } from "vitest";
import { checkOutboundUrl, escapeHtml, randomPassword, safeEqual } from "@/lib/security-utils";

describe("webhook de saída não acessa a rede interna", () => {
  it("aceita https público", () => {
    expect(checkOutboundUrl("https://hooks.example.com/x").ok).toBe(true);
  });
  it("recusa http, localhost, IP privado e metadados", () => {
    for (const u of [
      "http://hooks.example.com/x",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://192.168.1.10/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://metadata.google.internal/x",
      "https://user:pass@example.com/x",
      "https://example.com:8080/x",
    ]) expect(checkOutboundUrl(u).ok, u).toBe(false);
  });
});

describe("segredos", () => {
  it("compara iguais e diferentes", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
    expect(safeEqual("abc123", "abc124")).toBe(false);
    expect(safeEqual("abc", "abc123")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
  it("senha temporária tem 16 caracteres e não se repete", () => {
    const a = randomPassword(); const b = randomPassword();
    expect(a).toHaveLength(16);
    expect(a).not.toBe(b);
  });
  it("escapa HTML", () => {
    expect(escapeHtml('<img src=x onerror="a">')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;");
  });
});
