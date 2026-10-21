import { describe, expect, it } from "vitest";
import {
  checkSlot, listAvailableSlots, looksLikeBookingConfirmation, nearestAlternatives, parseAiDateTime,
  parseAntecedenciaMin, parseDurationMin, parseServicos, findServico, formatSlotPt, type SlotRules,
} from "@/lib/scheduling";
import { parseAiOutput, buildSystemPrompt } from "@/lib/ai-prompt";

const TZ = "America/Sao_Paulo";
const dias = {
  "0": null,
  "1": { abre: "09:00", fecha: "18:00" },
  "2": { abre: "09:00", fecha: "18:00" },
  "3": { abre: "09:00", fecha: "18:00" },
  "4": { abre: "09:00", fecha: "18:00" },
  "5": { abre: "09:00", fecha: "18:00" },
  "6": null,
};
// Terça, 20/10/2026 09:47 em São Paulo (12:47 UTC)
const NOW = new Date("2026-10-20T12:47:00Z");
const rules = (lead = 120): SlotRules => ({ dias, tz: TZ, minLeadMin: lead, now: NOW });
const at = (local: string) => parseAiDateTime(local, TZ)!;

describe("durações e antecedência", () => {
  it("lê durações comuns", () => {
    expect(parseDurationMin("30 min")).toBe(30);
    expect(parseDurationMin("1h")).toBe(60);
    expect(parseDurationMin("1h30")).toBe(90);
    expect(parseDurationMin("1 hora e meia")).toBe(90);
    expect(parseDurationMin("90 minutos")).toBe(90);
    expect(parseDurationMin("abc")).toBeNull();
  });
  it("lê antecedência", () => {
    expect(parseAntecedenciaMin("2 horas")).toBe(120);
    expect(parseAntecedenciaMin("1 dia")).toBe(1440);
    expect(parseAntecedenciaMin("")).toBe(0);
  });
  it("serviço com duração própria usa a dela; sem duração usa a padrão", () => {
    const s = parseServicos("Corte - 30 min\nColoração (1h30)\nBarba", 45);
    expect(s).toEqual([
      { nome: "Corte", duracaoMin: 30 },
      { nome: "Coloração", duracaoMin: 90 },
      { nome: "Barba", duracaoMin: 45 },
    ]);
    expect(findServico(s, "coloracao")?.duracaoMin).toBe(90);
  });
  it("faixa de duração usa o maior valor (60 a 75 min → 75)", () => {
    const s = parseServicos("Limpeza de pele profunda (60 a 75 min) R$ 149 | Limpeza de pele express (30-40 min) R$ 89", 30);
    expect(s).toEqual([
      { nome: "Limpeza de pele profunda", duracaoMin: 75 },
      { nome: "Limpeza de pele express", duracaoMin: 40 },
    ]);
  });
  it("lê durações da lista de produtos/serviços com categorias e ignora itens sem duração", () => {
    const texto =
      "FACIAL: Limpeza de pele profunda (60 a 75 min) R$ 149 | Limpeza de pele express (30 a 40 min) R$ 89 | Hidratação facial (45 min) R$ 119. " +
      "MASSAGENS E BEM-ESTAR: Massagem relaxante (50 min) R$ 139 | Protocolo corporal personalizado a partir de R$ 219 (duração sob avaliação). " +
      "ORIENTAÇÃO: Avaliação estética inicial (30 min) R$ 50 (abatida em procedimentos a partir de R$ 149 no mesmo dia).";
    const s = parseServicos(texto, 30, { onlyWithDuration: true });
    expect(s).toEqual([
      { nome: "Limpeza de pele profunda", duracaoMin: 75 },
      { nome: "Limpeza de pele express", duracaoMin: 40 },
      { nome: "Hidratação facial", duracaoMin: 45 },
      { nome: "Massagem relaxante", duracaoMin: 50 },
      { nome: "Avaliação estética inicial", duracaoMin: 30 },
    ]);
  });
  it("pedido genérico com mais de uma opção não chuta duração", () => {
    const s = [
      { nome: "Limpeza de pele profunda", duracaoMin: 75 },
      { nome: "Limpeza de pele express", duracaoMin: 40 },
    ];
    expect(findServico(s, "limpeza de pele")).toBeNull();
    expect(findServico(s, "Limpeza de pele profunda")?.duracaoMin).toBe(75);
    expect(findServico(s, "limpeza de pele profunda com hidratação")?.duracaoMin).toBe(75);
  });
  it("profunda de 75 min às 11:30 bloqueia o horário de 12:00", () => {
    const busy = [{ start: at("2026-10-21T11:30").getTime(), end: at("2026-10-21T11:30").getTime() + 75 * 60_000 }];
    expect(checkSlot(at("2026-10-21T12:00"), 40, rules(), busy).ok).toBe(false);
    expect(checkSlot(at("2026-10-21T12:45"), 40, rules(), busy).ok).toBe(true);
  });
});

describe("fuso horário", () => {
  it("interpreta horário local da empresa (-03:00)", () => {
    expect(at("2026-10-21T10:00").toISOString()).toBe("2026-10-21T13:00:00.000Z");
    expect(formatSlotPt(at("2026-10-21T10:00"), TZ)).toBe("quarta (21/10) às 10h00");
  });
  it("rejeita data impossível", () => {
    expect(parseAiDateTime("2026-02-31T10:00", TZ)).toBeNull();
  });
});

describe("regras do horário", () => {
  it("aceita horário livre no expediente", () => {
    expect(checkSlot(at("2026-10-21T10:00"), 30, rules(), [])).toEqual({ ok: true });
  });
  it("recusa horário ocupado na agenda (sobreposição parcial)", () => {
    const busy = [{ start: at("2026-10-21T10:15").getTime(), end: at("2026-10-21T10:45").getTime() }];
    expect(checkSlot(at("2026-10-21T10:00"), 30, rules(), busy)).toEqual({ ok: false, reason: "ocupado" });
  });
  it("encostar no fim de outro compromisso não é conflito", () => {
    const busy = [{ start: at("2026-10-21T09:30").getTime(), end: at("2026-10-21T10:00").getTime() }];
    expect(checkSlot(at("2026-10-21T10:00"), 30, rules(), busy).ok).toBe(true);
  });
  it("respeita antecedência mínima de 2 horas", () => {
    expect(checkSlot(at("2026-10-20T11:00"), 30, rules(), [])).toEqual({ ok: false, reason: "antecedencia" });
    expect(checkSlot(at("2026-10-20T12:00"), 30, rules(), []).ok).toBe(true);
  });
  it("serviço de 90 min não cabe às 17h (fecha 18h)", () => {
    expect(checkSlot(at("2026-10-21T17:00"), 90, rules(), [])).toEqual({ ok: false, reason: "fora_expediente" });
    expect(checkSlot(at("2026-10-21T17:00"), 60, rules(), []).ok).toBe(true);
  });
  it("domingo fechado", () => {
    expect(checkSlot(at("2026-10-25T10:00"), 30, rules(), [])).toEqual({ ok: false, reason: "fora_expediente" });
  });
  it("lista só horários livres e alternativas próximas", () => {
    const busy = [{ start: at("2026-10-21T10:00").getTime(), end: at("2026-10-21T11:00").getTime() }];
    const slots = listAvailableSlots(30, rules(), busy, { days: 2, maxPerDay: 48 });
    const iso = slots.map((d) => d.toISOString());
    expect(iso).not.toContain(at("2026-10-21T10:00").toISOString());
    expect(iso).not.toContain(at("2026-10-21T10:30").toISOString());
    expect(iso).toContain(at("2026-10-21T11:00").toISOString());
    const alt = nearestAlternatives(at("2026-10-21T10:00"), 30, rules(), busy, 3).map((d) => d.toISOString());
    expect(alt).toEqual(["09:00", "09:30", "11:00"].map((h) => at(`2026-10-21T${h}`).toISOString()));
  });
});

describe("IA não confirma sozinha", () => {
  it("detecta confirmação afirmativa", () => {
    expect(looksLikeBookingConfirmation("Prontinho, confirmado! Corte terça às 10h.")).toBe(true);
    expect(looksLikeBookingConfirmation("Seu horário está agendado para amanhã.")).toBe(true);
    expect(looksLikeBookingConfirmation("Marquei você às 15h.")).toBe(true);
  });
  it("não confunde pergunta ou oferta com confirmação", () => {
    expect(looksLikeBookingConfirmation("Posso deixar agendado para quarta às 10h?")).toBe(false);
    expect(looksLikeBookingConfirmation("Tenho 10h ou 11h. Qual prefere?")).toBe(false);
    expect(looksLikeBookingConfirmation("Quer agendar um horário?")).toBe(false);
  });
  it("lê o marcador novo e remove do texto", () => {
    const r = parseAiOutput("[AGENDAR: 2026-10-21T10:00 | Corte | Samuel]\n[ESTAGIO: Negociando]", [{ nome: "Negociando" }]);
    expect(r.agendar).toMatchObject({ inicio: "2026-10-21T10:00", servico: "Corte", nome: "Samuel" });
    expect(r.parts).toEqual([]);
    expect(r.stage).toBe("Negociando");
  });
  it("lê remarcar e cancelar sem vazar marcador", () => {
    const r = parseAiOutput("ok [REMARCAR: 2026-10-22T09:00] [CANCELAR_AGENDAMENTO]");
    expect(r.remarcar).toEqual({ inicio: "2026-10-22T09:00" });
    expect(r.cancelar).toBe(true);
    expect(r.parts.join(" ")).toBe("ok");
  });
  it("com agenda real, o prompt proíbe a IA de confirmar", () => {
    const p = buildSystemPrompt({ agendamento_ativo: true } as any, { agendamento: "AGENDAMENTO (agenda real)" });
    expect(p).toContain("AGENDAMENTO (agenda real)");
    expect(p).toContain("NUNCA confirme você mesmo");
    expect(p).not.toContain("ENVIE A CONFIRMAÇÃO COMPLETA NA MESMA RESPOSTA");
  });
  it("sem agenda ativa, mantém o comportamento anterior", () => {
    const p = buildSystemPrompt({ agendamento_ativo: false } as any, {});
    expect(p).toContain("ENVIE A CONFIRMAÇÃO COMPLETA NA MESMA RESPOSTA");
  });
});
