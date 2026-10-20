// Regras puras de agendamento (sem banco, sem rede) — testáveis isoladamente.
// Usadas pelo webhook do WhatsApp, pela agenda interna e pelo prompt da IA.

import type { DaySchedule } from "@/lib/business-hours";

export type Interval = { start: number; end: number }; // epoch ms, fim exclusivo
export type Servico = { nome: string; duracaoMin: number };

const DIA_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const DIA_LONGO = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export function normalize(s: string): string {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** "30 min", "1h", "1h30", "1 hora e meia", "90 minutos", "45" → minutos. null se não entender. */
export function parseDurationMin(input: string | null | undefined): number | null {
  const s = normalize(String(input ?? "")).replace(",", ".");
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 && n <= 24 * 60 ? n : null;
  }
  let total = 0;
  let matched = false;
  const h = s.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hora|horas)\b/);
  if (h) { total += Math.round(Number(h[1]) * 60); matched = true; }
  const hm = s.match(/(\d+)\s*h\s*(\d{1,2})\b/); // 1h30
  if (hm) { total = Number(hm[1]) * 60 + Number(hm[2]); matched = true; }
  else {
    const m = s.match(/(\d+)\s*(m|min|mins|minuto|minutos)\b/);
    if (m) { total += Number(m[1]); matched = true; }
  }
  if (/e meia/.test(s) && h && !hm) total += 30;
  if (!matched || total <= 0 || total > 24 * 60) return null;
  return total;
}

/** "2 horas", "30 min", "1 dia", "" → minutos. "" = 0. null se não entender. */
export function parseAntecedenciaMin(input: string | null | undefined): number | null {
  const s = normalize(String(input ?? ""));
  if (!s || s === "0" || /sem antecedencia|nenhuma/.test(s)) return 0;
  const d = s.match(/(\d+)\s*(d|dia|dias)\b/);
  if (d) return Number(d[1]) * 24 * 60;
  return parseDurationMin(s);
}

/**
 * Lê "Serviços agendáveis" (texto livre). Cada linha ou item separado por vírgula/; vira um serviço.
 * Se o item tiver duração ("Corte - 30 min", "Coloração (1h30)"), ela é usada; senão, a duração padrão.
 */
export function parseServicos(text: string | null | undefined, defaultMin: number): Servico[] {
  const raw = String(text ?? "")
    .split(/\n|;|,(?![^()]*\))/)
    .map((s) => s.replace(/^[\s•\-*\d.)]+/, "").trim())
    .filter(Boolean);
  const out: Servico[] = [];
  for (const item of raw) {
    const durMatch = item.match(/[(\-–:|]\s*([^()\-–:|]*\d[^()\-–:|]*)\)?\s*$/);
    let dur: number | null = null;
    let nome = item;
    if (durMatch) {
      const d = parseDurationMin(durMatch[1].replace(/r\$\s*[\d.,]+/i, ""));
      if (d) { dur = d; nome = item.slice(0, durMatch.index).trim(); }
    }
    nome = nome.replace(/[\s\-–:|(]+$/, "").trim();
    if (!nome) continue;
    out.push({ nome: nome.slice(0, 80), duracaoMin: dur ?? defaultMin });
  }
  return out;
}

export function findServico(servicos: Servico[], pedido: string | null | undefined): Servico | null {
  const q = normalize(String(pedido ?? ""));
  if (!q) return null;
  const exact = servicos.find((s) => normalize(s.nome) === q);
  if (exact) return exact;
  const contains = servicos.filter((s) => q.includes(normalize(s.nome)) || normalize(s.nome).includes(q));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1) return contains.sort((a, b) => b.nome.length - a.nome.length)[0];
  return null;
}

// ---------------- Fuso horário ----------------

function tzOffsetMs(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Data/hora "de parede" no fuso da empresa → instante UTC. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

export function zonedParts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { y: p.year, m: p.month, d: p.day, hh: p.hour === 24 ? 0 : p.hour, mm: p.minute, dow };
}

/** Aceita "2026-10-21T10:00" (hora local da empresa) ou ISO com offset/Z. */
export function parseAiDateTime(input: string | null | undefined, tz: string): Date | null {
  const s = String(input ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  const [, y, mo, d, hh, mi, off] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(hh) > 23 || Number(mi) > 59) return null;
  if (off) {
    const dt = new Date(s.replace(" ", "T"));
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = zonedToUtc(Number(y), Number(mo), Number(d), Number(hh), Number(mi), tz);
  // Rejeita datas impossíveis (ex.: 31/02)
  const back = zonedParts(dt, tz);
  if (back.d !== Number(d) || back.m !== Number(mo)) return null;
  return dt;
}

function pad(n: number) { return String(n).padStart(2, "0"); }

/** "terça (21/10) às 10h00" */
export function formatSlotPt(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${DIA_LONGO[p.dow]} (${pad(p.d)}/${pad(p.m)}) às ${pad(p.hh)}h${pad(p.mm)}`;
}

export function formatLocalIso(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
}

// ---------------- Disponibilidade ----------------

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function hhmm(s: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** Janela de expediente (UTC) do dia local y-m-d, ou null se fechado. */
export function dayWindow(dias: Record<string, DaySchedule> | null | undefined, y: number, m: number, d: number, tz: string): Interval | null {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const day = dias?.[String(dow)] ?? null;
  if (!day) return null;
  const open = hhmm(day.abre); const close = hhmm(day.fecha);
  if (open == null || close == null || open === close) return null;
  const start = zonedToUtc(y, m, d, Math.floor(open / 60), open % 60, tz).getTime();
  let end = zonedToUtc(y, m, d, Math.floor(close / 60), close % 60, tz).getTime();
  if (close < open) end += 24 * 60 * 60_000; // cruza meia-noite
  return { start, end };
}

export function hasAnyOpenDay(dias: Record<string, DaySchedule> | null | undefined): boolean {
  if (!dias) return false;
  return Object.values(dias).some((d) => d && hhmm(d.abre) != null && hhmm(d.fecha) != null && d.abre !== d.fecha);
}

export type SlotRules = {
  dias: Record<string, DaySchedule> | null | undefined;
  tz: string;
  minLeadMin: number;
  now: Date;
};

export type SlotCheck =
  | { ok: true }
  | { ok: false; reason: "passado" | "antecedencia" | "fora_expediente" | "ocupado" };

export function checkSlot(start: Date, durationMin: number, rules: SlotRules, busy: Interval[]): SlotCheck {
  const s = start.getTime();
  const e = s + durationMin * 60_000;
  const now = rules.now.getTime();
  if (s <= now) return { ok: false, reason: "passado" };
  if (s < now + rules.minLeadMin * 60_000) return { ok: false, reason: "antecedencia" };
  const p = zonedParts(start, rules.tz);
  // Considera também a janela do dia anterior (expediente que cruza meia-noite)
  const prev = new Date(Date.UTC(p.y, p.m - 1, p.d - 1));
  const windows = [
    dayWindow(rules.dias, p.y, p.m, p.d, rules.tz),
    dayWindow(rules.dias, prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), rules.tz),
  ].filter(Boolean) as Interval[];
  if (!windows.some((w) => s >= w.start && e <= w.end)) return { ok: false, reason: "fora_expediente" };
  if (busy.some((b) => overlaps({ start: s, end: e }, b))) return { ok: false, reason: "ocupado" };
  return { ok: true };
}

export function listAvailableSlots(
  durationMin: number,
  rules: SlotRules,
  busy: Interval[],
  opts?: { days?: number; stepMin?: number; maxPerDay?: number; maxTotal?: number; from?: Date },
): Date[] {
  const days = opts?.days ?? 7;
  const step = opts?.stepMin ?? (durationMin <= 15 ? 15 : 30);
  const maxPerDay = opts?.maxPerDay ?? 8;
  const maxTotal = opts?.maxTotal ?? 40;
  const base = zonedParts(opts?.from ?? rules.now, rules.tz);
  const out: Date[] = [];
  for (let i = 0; i < days && out.length < maxTotal; i++) {
    const dd = new Date(Date.UTC(base.y, base.m - 1, base.d + i));
    const w = dayWindow(rules.dias, dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate(), rules.tz);
    if (!w) continue;
    let count = 0;
    for (let t = w.start; t + durationMin * 60_000 <= w.end && count < maxPerDay; t += step * 60_000) {
      const c = checkSlot(new Date(t), durationMin, rules, busy);
      if (c.ok) { out.push(new Date(t)); count++; if (out.length >= maxTotal) break; }
    }
  }
  return out;
}

/** Slots mais próximos de um horário pedido (para oferecer alternativas). */
export function nearestAlternatives(target: Date, durationMin: number, rules: SlotRules, busy: Interval[], n = 3): Date[] {
  const all = listAvailableSlots(durationMin, rules, busy, { days: 7, maxPerDay: 48, maxTotal: 200 });
  return all
    .sort((a, b) => Math.abs(a.getTime() - target.getTime()) - Math.abs(b.getTime() - target.getTime()))
    .slice(0, n)
    .sort((a, b) => a.getTime() - b.getTime());
}

/** Agrupa slots por dia para o prompt: "ter 21/10: 09:00, 09:30". */
export function formatSlotsForPrompt(slots: Date[], tz: string): string {
  const byDay = new Map<string, string[]>();
  for (const s of slots) {
    const p = zonedParts(s, tz);
    const key = `${DIA_CURTO[p.dow]} ${pad(p.d)}/${pad(p.m)} (${p.y}-${pad(p.m)}-${pad(p.d)})`;
    const arr = byDay.get(key) ?? [];
    arr.push(`${pad(p.hh)}:${pad(p.mm)}`);
    byDay.set(key, arr);
  }
  return [...byDay.entries()].map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n");
}

// ---------------- Proteção contra confirmação falsa ----------------

const STRONG_CONFIRM = [
  /\b(esta|ta|fica|ficou|foi|ja esta|deixei|deixamos|seu horario esta|sua reserva esta)\s+(confirmad|agendad|marcad|reservad)/,
  /\b(agendamento|horario|reserva|consulta|atendimento|sessao|visita)\s+(esta\s+|foi\s+)?(confirmad|agendad|marcad|reservad)/,
  /\b(agendei|marquei|reservei|confirmei|agendamos|marcamos|reservamos)\b/,
  /^(prontinho|pronto|perfeito|otimo|show|combinado)\b.*\b(confirmad|agendad|marcad|reservad)/,
  /^(confirmadissimo|confirmado|confirmada|agendado|agendada|marcado|marcada)\b/,
];

/**
 * true quando o texto afirma que um horário foi reservado/confirmado.
 * Perguntas ("fica confirmado?") não contam.
 */
export function looksLikeBookingConfirmation(text: string): boolean {
  const sentences = String(text || "").split(/(?<=[.!?\n])/);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || s.endsWith("?")) continue;
    const n = normalize(s);
    if (STRONG_CONFIRM.some((re) => re.test(n))) return true;
  }
  return false;
}

// ---------------- Mensagens ao cliente (geradas pelo backend) ----------------

export function firstName(nome: string | null | undefined): string {
  const n = String(nome ?? "").trim().split(/\s+/)[0] || "";
  return n.length > 1 && n.length < 30 ? n : "";
}

export function joinOptions(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ou ${items[items.length - 1]}`;
}

export const MSG = {
  confirmado: (nome: string, servico: string, quando: string) =>
    `Prontinho${nome ? `, ${nome}` : ""}! Seu horário está confirmado: ${servico}, ${quando}. Se precisar mudar, é só me chamar por aqui.`,
  jaExistia: (servico: string, quando: string) =>
    `Seu horário já está reservado: ${servico}, ${quando}. Se precisar mudar, é só me chamar por aqui.`,
  indisponivel: (alternativas: string[]) =>
    alternativas.length
      ? `Poxa, esse horário não está disponível. Tenho ${joinOptions(alternativas)}. Qual fica melhor pra você?`
      : `Poxa, esse horário não está disponível e não encontrei outro livre nos próximos dias. Vou pedir pra alguém da equipe falar com você.`,
  antecedencia: (alternativas: string[]) =>
    alternativas.length
      ? `Esse horário está muito em cima pra eu conseguir reservar. Tenho ${joinOptions(alternativas)}. Qual prefere?`
      : `Esse horário está muito em cima pra eu conseguir reservar. Vou pedir pra alguém da equipe falar com você.`,
  qualServico: (servicos: string[]) =>
    `Pra eu reservar certinho, qual serviço você quer agendar: ${joinOptions(servicos.slice(0, 6))}?`,
  falha: () =>
    `Não consegui confirmar seu horário agora, então ele ainda não está reservado. Vou pedir pra alguém da equipe confirmar com você em seguida.`,
  semAgenda: () =>
    `No momento não consigo consultar a agenda pra garantir esse horário. Vou pedir pra alguém da equipe confirmar com você.`,
  pedirConfirmacao: () =>
    `Só pra eu garantir a reserva: me confirma o serviço, o dia e o horário que você quer?`,
  cancelado: (servico: string, quando: string) =>
    `Pronto, cancelei seu horário de ${servico}, ${quando}. Se quiser remarcar, é só me dizer.`,
  nadaParaCancelar: () => `Não encontrei nenhum horário futuro agendado neste número.`,
  remarcado: (servico: string, quando: string) =>
    `Pronto! Remarquei seu horário de ${servico} para ${quando}. Te esperamos!`,
  remarcarIndisponivel: (original: string, alternativas: string[]) =>
    (alternativas.length
      ? `Esse novo horário não está disponível. Tenho ${joinOptions(alternativas)}.`
      : `Esse novo horário não está disponível.`) + ` Seu horário original (${original}) continua reservado.`,
};
