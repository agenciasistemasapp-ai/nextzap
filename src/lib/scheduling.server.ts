// Agendamento no servidor: disponibilidade real, reserva atômica, sincronização Google
// com idempotência e reconciliação. Usado pelo webhook do WhatsApp e pela tela Agenda.
// Sempre recebe o company_id já validado (webhook com token ou sessão autenticada).

import {
  checkSlot, firstName, formatSlotPt, formatSlotsForPrompt, hasAnyOpenDay,
  listAvailableSlots, MSG, nearestAlternatives, parseAiDateTime, parseAntecedenciaMin, parseDurationMin,
  parseServicos, findServico, zonedToUtc, lembreteDevido, respostaLembrete,
  type Interval, type LembreteTipo, type Servico, type SlotRules,
} from "@/lib/scheduling";
import type { DaySchedule } from "@/lib/business-hours";

const ACTIVE = ["agendado", "confirmado"];
const RECURSO_PADRAO = "principal";
const GCAL = "https://www.googleapis.com/calendar/v3";

export type SchedulingContext = {
  ativo: boolean;
  tz: string;
  dias: Record<string, DaySchedule> | null;
  servicos: Servico[];
  defaultMin: number | null;
  leadMin: number | null;
  observacoes: string;
  problemas: string[];
  google: { conectado: boolean; calendarId: string };
};

export async function loadSchedulingContext(admin: any, companyId: string, cfg?: any): Promise<SchedulingContext> {
  let c = cfg;
  if (!c) {
    const { data } = await admin.from("agent_config").select("*").eq("company_id", companyId).maybeSingle();
    c = data ?? {};
  }
  const { data: gi } = await admin
    .from("google_integration").select("conectado, calendar_id").eq("company_id", companyId).maybeSingle();
  const horarios = c?.horarios_atendimento ?? null;
  const tz = (horarios?.timezone as string) || "America/Sao_Paulo";
  const dias = (horarios?.dias ?? null) as Record<string, DaySchedule> | null;
  const defaultMin = parseDurationMin(c?.duracao_padrao);
  const leadMin = parseAntecedenciaMin(c?.antecedencia_min);
  const problemas: string[] = [];
  if (!hasAnyOpenDay(dias)) problemas.push("Nenhum dia/horário de funcionamento configurado (aba Horários).");
  if (defaultMin == null) problemas.push(`Duração padrão inválida: "${c?.duracao_padrao ?? ""}".`);
  if (leadMin == null) problemas.push(`Antecedência mínima inválida: "${c?.antecedencia_min ?? ""}".`);
  // Sem "Serviços agendáveis" preenchido, usa as durações escritas em "Produtos/Serviços"
  // (só itens com duração explícita) para não reservar tudo com a duração padrão.
  let servicos = parseServicos(c?.servicos_agendaveis, defaultMin ?? 30);
  if (!servicos.length) servicos = parseServicos(c?.produtos_servicos, defaultMin ?? 30, { onlyWithDuration: true });
  return {
    ativo: !!c?.agendamento_ativo,
    tz,
    dias,
    servicos,
    defaultMin,
    leadMin,
    observacoes: String(c?.horarios_disponiveis ?? "").trim(),
    problemas,
    google: { conectado: !!gi?.conectado, calendarId: gi?.calendar_id || "primary" },
  };
}

function rulesOf(ctx: SchedulingContext, now = new Date()): SlotRules {
  return { dias: ctx.dias, tz: ctx.tz, minLeadMin: ctx.leadMin ?? 0, now };
}

// ---------------- Google ----------------

async function recordGoogleError(admin: any, companyId: string, msg: string | null) {
  await admin.from("google_integration")
    .update({ ultimo_erro: msg, ultimo_erro_em: msg ? new Date().toISOString() : null })
    .eq("company_id", companyId);
}

export async function getGoogleAccess(admin: any, companyId: string):
  Promise<{ ok: true; token: string; calendarId: string } | { ok: false; error: string }> {
  const { data: gi, error } = await admin.from("google_integration").select("*").eq("company_id", companyId).maybeSingle();
  if (error) return { ok: false, error: "Falha ao ler integração Google" };
  if (!gi?.conectado || !gi.access_token) return { ok: false, error: "Google Agenda não conectado" };
  let token = gi.access_token as string;
  const expiring = !gi.expiry || new Date(gi.expiry).getTime() < Date.now() + 60_000;
  if (expiring) {
    if (!gi.refresh_token) {
      await recordGoogleError(admin, companyId, "Autorização expirada e sem renovação. Reconecte o Google Agenda.");
      return { ok: false, error: "Autorização Google expirada" };
    }
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID || "",
          client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
          refresh_token: gi.refresh_token as string,
          grant_type: "refresh_token",
        }),
      });
      const tok: any = await res.json().catch(() => ({}));
      if (!res.ok || !tok.access_token) {
        const reason = tok?.error === "invalid_grant"
          ? "Acesso ao Google revogado ou expirado. Reconecte o Google Agenda."
          : `Falha ao renovar acesso Google (${res.status}).`;
        await recordGoogleError(admin, companyId, reason);
        return { ok: false, error: reason };
      }
      token = tok.access_token;
      await admin.from("google_integration").update({
        access_token: token,
        expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      }).eq("company_id", companyId);
    } catch {
      await recordGoogleError(admin, companyId, "Google indisponível ao renovar acesso.");
      return { ok: false, error: "Google indisponível" };
    }
  }
  return { ok: true, token, calendarId: gi.calendar_id || "primary" };
}

/** Períodos ocupados no calendário Google (ignora eventos "livres" e cancelados). */
export async function getGoogleBusy(
  admin: any, companyId: string, from: Date, to: Date, excludeEventIds: string[] = [], tz = "America/Sao_Paulo",
): Promise<{ ok: true; busy: Interval[] } | { ok: false; error: string }> {
  const acc = await getGoogleAccess(admin, companyId);
  if (!acc.ok) return acc;
  const busy: Interval[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < 5; page++) {
      const u = new URL(`${GCAL}/calendars/${encodeURIComponent(acc.calendarId)}/events`);
      u.searchParams.set("timeMin", from.toISOString());
      u.searchParams.set("timeMax", to.toISOString());
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("maxResults", "250");
      u.searchParams.set("fields", "items(id,status,transparency,start,end),nextPageToken");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const res = await fetch(u, { headers: { Authorization: `Bearer ${acc.token}` } });
      if (!res.ok) {
        const msg = res.status === 401 || res.status === 403
          ? "Sem permissão para ler o Google Agenda. Reconecte a conta."
          : `Google Agenda respondeu ${res.status}.`;
        await recordGoogleError(admin, companyId, msg);
        return { ok: false, error: msg };
      }
      const j: any = await res.json();
      for (const ev of j.items ?? []) {
        if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
        if (excludeEventIds.includes(ev.id)) continue;
        let s: number, e: number;
        if (ev.start?.dateTime) {
          s = new Date(ev.start.dateTime).getTime();
          e = new Date(ev.end?.dateTime ?? ev.start.dateTime).getTime();
        } else if (ev.start?.date) {
          // Dia inteiro: start.date inclusivo, end.date exclusivo, no fuso da empresa.
          const [ys, ms, ds] = String(ev.start.date).split("-").map(Number);
          const endDate = String(ev.end?.date ?? ev.start.date);
          const [ye, me, de] = endDate.split("-").map(Number);
          s = zonedToUtc(ys, ms, ds, 0, 0, tz).getTime();
          e = endDate === ev.start.date
            ? s + 24 * 3600_000
            : zonedToUtc(ye, me, de, 0, 0, tz).getTime();
        } else continue;
        if (e > s) busy.push({ start: s, end: e });
      }
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
  } catch {
    await recordGoogleError(admin, companyId, "Google Agenda indisponível no momento.");
    return { ok: false, error: "Google indisponível" };
  }
  await recordGoogleError(admin, companyId, null);
  return { ok: true, busy };
}

/** ID determinístico do evento Google (base32hex) → retentativas nunca duplicam o evento. */
export function googleEventIdFor(agendamentoId: string): string {
  return agendamentoId.replace(/-/g, "").toLowerCase().replace(/[^a-v0-9]/g, "0");
}

/**
 * Leva o evento Google ao estado do agendamento interno (criar, atualizar ou cancelar).
 * Idempotente: pode ser chamada quantas vezes for preciso.
 */
export async function syncAgendamentoGoogle(admin: any, companyId: string, agendamentoId: string):
  Promise<"sincronizado" | "falhou" | "nao_aplicavel"> {
  const { data: ag } = await admin.from("agendamento").select("*")
    .eq("id", agendamentoId).eq("company_id", companyId).maybeSingle();
  if (!ag || ag.google_sync_status === "nao_aplicavel") return "nao_aplicavel";

  const fail = async (msg: string) => {
    await admin.from("agendamento").update({
      google_sync_status: "falhou", google_sync_erro: msg.slice(0, 300),
      google_sync_tentativas: (ag.google_sync_tentativas ?? 0) + 1, google_sync_em: new Date().toISOString(),
    }).eq("id", ag.id);
    return "falhou" as const;
  };

  const acc = await getGoogleAccess(admin, companyId);
  if (!acc.ok) return fail(acc.error);

  const eventId = ag.google_event_id || googleEventIdFor(ag.id);
  const base = `${GCAL}/calendars/${encodeURIComponent(acc.calendarId)}/events`;
  const headers = { Authorization: `Bearer ${acc.token}`, "Content-Type": "application/json" };
  const cancelado = !ACTIVE.includes(ag.status);
  try {
    if (cancelado) {
      const res = await fetch(`${base}/${eventId}`, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404 && res.status !== 410) return fail(`Google ${res.status} ao cancelar evento`);
    } else {
      const body = {
        summary: ag.titulo,
        description: [
          ag.servico ? `Serviço: ${ag.servico}` : "",
          ag.contato_nome ? `Cliente: ${ag.contato_nome}` : "",
          ag.contato_numero ? `WhatsApp: ${ag.contato_numero}` : "",
          "Criado pelo NextZap",
        ].filter(Boolean).join("\n"),
        start: { dateTime: new Date(ag.inicio).toISOString() },
        end: { dateTime: new Date(ag.fim).toISOString() },
        status: "confirmed",
      };
      let res = await fetch(`${base}/${eventId}`, { method: "PATCH", headers, body: JSON.stringify(body) });
      if (res.status === 404) {
        res = await fetch(base, { method: "POST", headers, body: JSON.stringify({ ...body, id: eventId }) });
        if (res.status === 409) {
          res = await fetch(`${base}/${eventId}`, { method: "PATCH", headers, body: JSON.stringify(body) });
        }
      }
      if (!res.ok) return fail(`Google ${res.status} ao gravar evento`);
    }
  } catch {
    return fail("Google indisponível");
  }
  await admin.from("agendamento").update({
    google_event_id: eventId, google_sync_status: "sincronizado", google_sync_erro: null,
    google_sync_em: new Date().toISOString(),
  }).eq("id", ag.id);
  return "sincronizado";
}

/** Reconciliação: reprocessa sincronizações pendentes/falhas (mais antigas primeiro, limite pequeno). */
export async function retryPendingGoogleSyncs(admin: any, companyId: string, limit = 3) {
  const { data: gi } = await admin.from("google_integration").select("conectado").eq("company_id", companyId).maybeSingle();
  if (!gi?.conectado) return { processados: 0 };
  const { data: rows } = await admin.from("agendamento").select("id")
    .eq("company_id", companyId).in("google_sync_status", ["pendente", "falhou"])
    .lt("google_sync_tentativas", 20)
    .order("google_sync_em", { ascending: true, nullsFirst: true })
    .limit(limit);
  let ok = 0;
  for (const r of rows ?? []) {
    if ((await syncAgendamentoGoogle(admin, companyId, r.id)) === "sincronizado") ok++;
  }
  return { processados: (rows ?? []).length, sincronizados: ok };
}

// ---------------- Disponibilidade ----------------

async function getInternalBusy(admin: any, companyId: string, from: Date, to: Date, excludeId?: string): Promise<Interval[]> {
  let q = admin.from("agendamento").select("id, inicio, fim")
    .eq("company_id", companyId).eq("recurso", RECURSO_PADRAO).in("status", ACTIVE)
    .lt("inicio", to.toISOString()).gt("fim", from.toISOString());
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q;
  if (error) throw new Error("Falha ao consultar agenda interna");
  return (data ?? []).map((r: any) => ({ start: new Date(r.inicio).getTime(), end: new Date(r.fim).getTime() }));
}

async function getBusy(
  admin: any, companyId: string, ctx: SchedulingContext, from: Date, to: Date, exclude?: { id: string; eventId?: string | null },
): Promise<{ ok: true; busy: Interval[] } | { ok: false; error: string }> {
  const internal = await getInternalBusy(admin, companyId, from, to, exclude?.id);
  if (!ctx.google.conectado) return { ok: true, busy: internal };
  const ex = exclude ? [exclude.eventId || googleEventIdFor(exclude.id)] : [];
  const g = await getGoogleBusy(admin, companyId, from, to, ex, ctx.tz);
  if (!g.ok) return g;
  return { ok: true, busy: [...internal, ...g.busy] };
}

/** Bloco do prompt com horários livres verificados agora + agendamentos futuros do contato. */
export async function buildSchedulingPrompt(admin: any, companyId: string, ctx: SchedulingContext, numero: string): Promise<string> {
  const now = new Date();
  const header = `AGENDAMENTO (agenda real da empresa — siga à risca):
Agora: ${formatSlotPt(now, ctx.tz)} (fuso ${ctx.tz}).`;
  const regrasSemAgenda = `REGRA: neste momento você NÃO consegue ver a agenda. Não ofereça nem confirme horários; diga que alguém da equipe vai confirmar o horário com o cliente. Nunca emita [AGENDAR].`;
  if (ctx.problemas.length) return `${header}\n${regrasSemAgenda}`;

  const to = new Date(now.getTime() + 8 * 24 * 3600_000);
  let busy: Interval[];
  try {
    const b = await getBusy(admin, companyId, ctx, now, to);
    if (!b.ok) return `${header}\n${regrasSemAgenda}`;
    busy = b.busy;
  } catch {
    return `${header}\n${regrasSemAgenda}`;
  }

  const rules = rulesOf(ctx, now);
  const todas = [...new Set(ctx.servicos.length ? ctx.servicos.map((s) => s.duracaoMin) : [ctx.defaultMin!])]
    .sort((a, b) => a - b);
  // No máximo 4 listas: menor, maior e intermediárias — o backend revalida a duração real na reserva.
  const duracoes = todas.length <= 4
    ? todas
    : [...new Set([todas[0], todas[Math.floor(todas.length / 3)], todas[Math.floor((2 * todas.length) / 3)], todas[todas.length - 1]])];
  const listas = duracoes.map((d) => {
    const slots = listAvailableSlots(d, rules, busy, { days: 7, maxPerDay: 8, maxTotal: 40 });
    return `Para serviços de até ${d} min:\n${slots.length ? formatSlotsForPrompt(slots, ctx.tz) : "(nenhum horário livre nos próximos 7 dias)"}`;
  });

  const { data: meus } = await admin.from("agendamento").select("inicio, servico, titulo")
    .eq("company_id", companyId).in("contato_numero", numerosDoContato(numero)).in("status", ACTIVE)
    .gte("inicio", now.toISOString()).order("inicio", { ascending: true }).limit(3);
  const meusTxt = (meus ?? []).length
    ? (meus as any[]).map((m) => `• ${m.servico || m.titulo} — ${formatSlotPt(new Date(m.inicio), ctx.tz)}`).join("\n")
    : "nenhum";

  const servicosTxt = ctx.servicos.length
    ? ctx.servicos.map((s) => `• ${s.nome} (${s.duracaoMin} min)`).join("\n")
    : `• Atendimento (${ctx.defaultMin} min)`;

  return `${header}
Serviços agendáveis e duração:
${servicosTxt}
Antecedência mínima: ${ctx.leadMin} min.
${ctx.observacoes ? `Observações da empresa sobre horários: ${ctx.observacoes}\n` : ""}HORÁRIOS LIVRES VERIFICADOS AGORA:
${listas.join("\n")}
Agendamentos futuros deste contato:
${meusTxt}

REGRAS DE AGENDAMENTO:
- Ofereça SOMENTE horários da lista acima. Nunca invente horário nem diga que um horário está livre se não estiver na lista.
- Use a lista "até X min" com o MENOR X que seja igual ou maior que a duração do serviço escolhido (ex.: serviço de 50 min → lista de até 60 min). Assim o atendimento nunca invade o horário de outro cliente.
- Se o cliente falar de um serviço de forma genérica e houver mais de uma opção (ex.: limpeza profunda ou express), pergunte qual antes de oferecer horários.
- Pergunte só o que faltar: serviço, nome e dia/horário. Uma pergunta por vez.
- Perguntar preço, serviço ou horários NÃO é pedido de reserva. Só reserve quando o cliente escolher um dia + horário específico e disser claramente que quer.
- Quando o cliente confirmar, responda APENAS com a linha:
[AGENDAR: AAAA-MM-DDTHH:MM | serviço | nome do cliente]
(horário local da empresa; mais o [ESTAGIO] de sempre). NÃO escreva confirmação: o sistema verifica, reserva e envia a confirmação ao cliente.
- Você NUNCA diz que algo está confirmado, agendado, marcado ou reservado. Quem confirma é o sistema.
- Se o cliente pedir para REMARCAR um agendamento futuro dele e confirmar o novo dia+horário: responda APENAS com [REMARCAR: AAAA-MM-DDTHH:MM].
- Se o cliente pedir claramente para CANCELAR o agendamento futuro dele: responda APENAS com [CANCELAR_AGENDAMENTO].`;
}

// ---------------- Reserva / cancelamento / remarcação ----------------

export type ReservaResult =
  | { status: "reservado" | "duplicado"; id: string; inicio: Date; servico: string; google: string }
  | { status: "indisponivel" | "antecedencia"; alternativas: Date[] }
  | { status: "servico_desconhecido"; servicos: string[] }
  | { status: "sem_agenda" | "erro"; error: string };

export async function reservarAgendamento(
  admin: any,
  companyId: string,
  ctx: SchedulingContext,
  req: {
    inicio: Date; servico?: string | null; titulo?: string | null; duracaoMin?: number | null;
    contatoNumero?: string | null; contatoNome?: string | null; cardId?: string | null;
    origem: "whatsapp" | "manual" | "bloqueio"; idempotencyKey?: string | null;
    ignorarExpediente?: boolean;
  },
): Promise<ReservaResult> {
  if (!req.ignorarExpediente && ctx.problemas.length) return { status: "sem_agenda", error: ctx.problemas.join(" ") };

  // 1) Serviço + duração
  let servicoNome = (req.servico || "").trim();
  let dur = req.duracaoMin ?? null;
  if (!dur) {
    if (ctx.servicos.length) {
      const s = findServico(ctx.servicos, servicoNome);
      if (!s) return { status: "servico_desconhecido", servicos: ctx.servicos.map((x) => x.nome) };
      servicoNome = s.nome; dur = s.duracaoMin;
    } else {
      dur = ctx.defaultMin ?? 30;
      servicoNome = servicoNome || "Atendimento";
    }
  }
  if (!dur || dur <= 0 || dur > 24 * 60) return { status: "erro", error: "Duração inválida" };
  const inicio = req.inicio;
  const fim = new Date(inicio.getTime() + dur * 60_000);

  // 2) Idempotência: mesma solicitação → mesmo resultado
  if (req.idempotencyKey) {
    const { data: prev } = await admin.from("agendamento").select("id, inicio, servico, status, google_sync_status")
      .eq("company_id", companyId).eq("idempotency_key", req.idempotencyKey).maybeSingle();
    if (prev && ACTIVE.includes(prev.status)) {
      return { status: "duplicado", id: prev.id, inicio: new Date(prev.inicio), servico: prev.servico || servicoNome, google: prev.google_sync_status };
    }
  }

  // 3) Regras (expediente, antecedência) + disponibilidade real (interna + Google)
  const now = new Date();
  const rules = rulesOf(ctx, now);
  const from = new Date(Math.min(inicio.getTime(), now.getTime()));
  const to = new Date(Math.max(fim.getTime(), now.getTime() + 8 * 24 * 3600_000));
  let busy: Interval[];
  try {
    const b = await getBusy(admin, companyId, ctx, from, to);
    if (!b.ok) return { status: "sem_agenda", error: b.error };
    busy = b.busy;
  } catch (e: any) {
    return { status: "erro", error: e?.message || "Falha ao consultar agenda" };
  }
  const check = req.ignorarExpediente
    ? (busy.some((b) => inicio.getTime() < b.end && b.start < fim.getTime()) ? { ok: false as const, reason: "ocupado" as const } : { ok: true as const })
    : checkSlot(inicio, dur, rules, busy);
  if (!check.ok) {
    const alternativas = req.ignorarExpediente || ctx.problemas.length ? [] : nearestAlternatives(inicio, dur, rules, busy, 3);
    return { status: check.reason === "antecedencia" ? "antecedencia" : "indisponivel", alternativas };
  }

  // 4) Reserva atômica — a restrição do banco impede sobreposição mesmo com pedidos simultâneos
  const titulo = (req.titulo || [servicoNome, req.contatoNome].filter(Boolean).join(" — ") || "Agendamento").slice(0, 120);
  const { data: row, error } = await admin.from("agendamento").insert({
    company_id: companyId,
    card_id: req.cardId ?? null,
    titulo,
    servico: servicoNome,
    inicio: inicio.toISOString(),
    fim: fim.toISOString(),
    status: "agendado",
    recurso: RECURSO_PADRAO,
    contato_numero: req.contatoNumero ?? null,
    contato_nome: req.contatoNome ?? null,
    origem: req.origem,
    idempotency_key: req.idempotencyKey ?? null,
    google_sync_status: ctx.google.conectado ? "pendente" : "nao_aplicavel",
  }).select("id").single();

  if (error) {
    if (error.code === "23505" && req.idempotencyKey) {
      const { data: prev } = await admin.from("agendamento").select("id, inicio, servico, status, google_sync_status")
        .eq("company_id", companyId).eq("idempotency_key", req.idempotencyKey).maybeSingle();
      if (prev && ACTIVE.includes(prev.status)) {
        return { status: "duplicado", id: prev.id, inicio: new Date(prev.inicio), servico: prev.servico || servicoNome, google: prev.google_sync_status };
      }
    }
    if (error.code === "23P01") {
      const fresh = await getInternalBusy(admin, companyId, from, to).catch(() => busy);
      return { status: "indisponivel", alternativas: req.ignorarExpediente ? [] : nearestAlternatives(inicio, dur, rules, [...busy, ...fresh], 3) };
    }
    console.error("[agendamento.insert]", error.code, error.message);
    return { status: "erro", error: "Falha ao gravar o agendamento" };
  }

  // 5) Google (o agendamento interno já está garantido; falha fica registrada para reconciliação)
  const google = ctx.google.conectado ? await syncAgendamentoGoogle(admin, companyId, row.id) : "nao_aplicavel";
  return { status: "reservado", id: row.id, inicio, servico: servicoNome, google };
}

export async function cancelarAgendamento(admin: any, companyId: string, id: string) {
  const { data: rows, error } = await admin.from("agendamento")
    .update({ status: "cancelado", cancelado_em: new Date().toISOString() })
    .eq("id", id).eq("company_id", companyId).in("status", ACTIVE)
    .select("id, idempotency_key, google_event_id, google_sync_status, inicio, servico, titulo");
  if (error) throw new Error("Falha ao cancelar");
  const row = rows?.[0];
  if (!row) return null; // já cancelado (repetição) ou inexistente
  // Libera a chave para que o mesmo horário possa ser pedido de novo no futuro.
  const patch: any = {};
  if (row.idempotency_key) patch.idempotency_key = `${row.idempotency_key}:cancelado:${row.id}`;
  if (row.google_sync_status !== "nao_aplicavel") patch.google_sync_status = "pendente";
  if (Object.keys(patch).length) await admin.from("agendamento").update(patch).eq("id", row.id);
  if (patch.google_sync_status) await syncAgendamentoGoogle(admin, companyId, row.id);
  return row;
}

/** Número como o WhatsApp entrega (55 + DDD + número) e a forma digitada sem o 55. */
function numerosDoContato(numero: string): string[] {
  const d = String(numero || "").replace(/\D/g, "");
  const out = new Set<string>([d]);
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) out.add(d.slice(2));
  if (d.length === 10 || d.length === 11) out.add(`55${d}`);
  return [...out].filter(Boolean);
}

/** Número para envio: lançamentos manuais podem vir sem o código do país. */
function numeroParaEnvio(numero: string): string {
  const d = String(numero || "").replace(/\D/g, "");
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

async function proximoDoContato(admin: any, companyId: string, numero: string) {
  const { data } = await admin.from("agendamento").select("*")
    .eq("company_id", companyId).in("contato_numero", numerosDoContato(numero)).in("status", ACTIVE)
    .gte("inicio", new Date().toISOString()).order("inicio", { ascending: true }).limit(1).maybeSingle();
  return data;
}

// ---------------- Lembretes (1 dia e 1 hora antes) ----------------

/**
 * Envia os lembretes que venceram. Chamado pelo agendador a cada poucos minutos.
 * Cada lembrete é "reservado" no banco antes do envio, então duas execuções simultâneas
 * não mandam o mesmo lembrete duas vezes; se o envio falhar, a reserva é desfeita.
 */
export async function enviarLembretesPendentes(admin: any, now = new Date()) {
  const { data: rows, error } = await admin.from("agendamento")
    .select("id, company_id, servico, titulo, inicio, created_at, contato_numero, contato_nome, card_id, lembrete_24h_enviado_em, lembrete_1h_enviado_em, cliente_confirmou_em")
    .in("status", ACTIVE).not("contato_numero", "is", null).neq("origem", "bloqueio")
    .gt("inicio", now.toISOString()).lte("inicio", new Date(now.getTime() + 24 * 3600_000).toISOString())
    .or("lembrete_24h_enviado_em.is.null,lembrete_1h_enviado_em.is.null")
    .order("inicio", { ascending: true }).limit(200);
  if (error) throw new Error(`Falha ao buscar lembretes: ${error.message}`);

  const devidos = (rows ?? []).map((r: any) => ({
    r,
    tipo: lembreteDevido({
      inicio: new Date(r.inicio), criadoEm: new Date(r.created_at), now,
      enviado24h: !!r.lembrete_24h_enviado_em, enviado1h: !!r.lembrete_1h_enviado_em,
    }),
  })).filter((x: any) => x.tipo) as Array<{ r: any; tipo: LembreteTipo }>;

  const porEmpresa = new Map<string, typeof devidos>();
  for (const d of devidos) {
    const l = porEmpresa.get(d.r.company_id) ?? [];
    l.push(d); porEmpresa.set(d.r.company_id, l);
  }

  const { evoSendText } = await import("@/lib/evolution.server");
  const res = { enviados: 0, falhas: 0, ignorados: 0 };

  for (const [companyId, itens] of porEmpresa) {
    const [{ data: cfg }, { data: inst }] = await Promise.all([
      admin.from("agent_config").select("lembretes_ativos, horarios_atendimento").eq("company_id", companyId).maybeSingle(),
      admin.from("whatsapp_instances").select("instance_name, status, user_id").eq("company_id", companyId).maybeSingle(),
    ]);
    if (cfg?.lembretes_ativos === false || !inst || inst.status !== "open") { res.ignorados += itens.length; continue; }
    const tz = (cfg?.horarios_atendimento?.timezone as string) || "America/Sao_Paulo";

    for (const { r, tipo } of itens) {
      const col = tipo === "24h" ? "lembrete_24h_enviado_em" : "lembrete_1h_enviado_em";
      const { data: claimed } = await admin.from("agendamento").update({ [col]: now.toISOString() })
        .eq("id", r.id).is(col, null).in("status", ACTIVE).select("id");
      if (!claimed?.length) continue;

      const servico = r.servico || r.titulo || "atendimento";
      const quando = formatSlotPt(new Date(r.inicio), tz);
      const nome = firstName(r.contato_nome);
      const jaConfirmou = !!r.cliente_confirmou_em;
      const texto = tipo === "24h" ? MSG.lembrete24h(nome, servico, quando) : MSG.lembrete1h(nome, servico, quando, jaConfirmou);
      const destino = numeroParaEnvio(r.contato_numero);
      try {
        await evoSendText(inst.instance_name, destino, texto);
      } catch (e: any) {
        console.error("[lembrete.envio]", r.id, e?.message);
        await admin.from("agendamento").update({ [col]: null }).eq("id", r.id);
        res.falhas++;
        continue;
      }
      if (!jaConfirmou) await admin.from("agendamento").update({ aguardando_resposta_lembrete: true }).eq("id", r.id);
      await admin.from("mensagens").insert({
        company_id: companyId, user_id: inst.user_id, numero: destino, contato_nome: r.contato_nome ?? null,
        direcao: "saida", autor: "sistema", texto,
      });
      await logLead(admin, companyId, r.card_id, "lembrete_enviado", `Lembrete ${tipo === "24h" ? "de 1 dia" : "de 1 hora"} — ${servico}, ${quando}`);
      res.enviados++;
    }
  }
  return res;
}

/**
 * Resposta do cliente a um lembrete ("1", "2", "sim", "cancelar"...).
 * Devolve a mensagem a enviar, ou null quando não há lembrete aguardando resposta.
 */
export async function tratarRespostaLembrete(admin: any, companyId: string, numero: string, text: string): Promise<string | null> {
  const tipo = respostaLembrete(text);
  if (!tipo) return null;
  const { data: ag } = await admin.from("agendamento").select("*")
    .eq("company_id", companyId).in("contato_numero", numerosDoContato(numero))
    .eq("aguardando_resposta_lembrete", true).in("status", ACTIVE)
    .gt("inicio", new Date().toISOString()).order("inicio", { ascending: true }).limit(1).maybeSingle();
  if (!ag) return null;

  const { data: cfg } = await admin.from("agent_config").select("horarios_atendimento").eq("company_id", companyId).maybeSingle();
  const tz = (cfg?.horarios_atendimento?.timezone as string) || "America/Sao_Paulo";
  const servico = ag.servico || ag.titulo || "atendimento";
  const quando = formatSlotPt(new Date(ag.inicio), tz);

  if (tipo === "confirmar") {
    const { data: upd } = await admin.from("agendamento")
      .update({ status: "confirmado", cliente_confirmou_em: new Date().toISOString(), aguardando_resposta_lembrete: false })
      .eq("id", ag.id).eq("aguardando_resposta_lembrete", true).in("status", ACTIVE).select("id");
    if (!upd?.length) return null;
    await logLead(admin, companyId, ag.card_id, "agendamento_confirmado_cliente", `${servico} — ${quando}`);
    return MSG.presencaConfirmada(firstName(ag.contato_nome), servico, quando);
  }

  if (tipo === "cancelar") {
    const done = await cancelarAgendamento(admin, companyId, ag.id);
    await admin.from("agendamento").update({ aguardando_resposta_lembrete: false }).eq("id", ag.id);
    if (!done) return null;
    await logLead(admin, companyId, ag.card_id, "agendamento_cancelado", `${servico} — ${quando} (resposta ao lembrete)`);
    return MSG.cancelado(servico, quando);
  }

  // "2"/"não": pergunta se quer remarcar ou cancelar; a IA continua a conversa com os marcadores de sempre.
  const { data: upd } = await admin.from("agendamento").update({ aguardando_resposta_lembrete: false })
    .eq("id", ag.id).eq("aguardando_resposta_lembrete", true).select("id");
  if (!upd?.length) return null;
  return MSG.perguntarAlteracao(servico, quando);
}

// ---------------- Orquestração para o webhook ----------------

export type AcoesAgenda = {
  agendar?: { inicio: string; servico?: string | null; nome?: string | null } | null;
  remarcar?: { inicio: string } | null;
  cancelar?: boolean;
};

/**
 * Executa a ação pedida pela IA e devolve a mensagem que o cliente deve receber.
 * A mensagem só afirma sucesso quando a operação foi concluída no backend.
 */
export async function executarAcaoAgenda(
  admin: any, companyId: string, ctx: SchedulingContext,
  acao: AcoesAgenda,
  contato: { numero: string; nome?: string | null; cardId?: string | null },
): Promise<string | null> {
  const fmt = (d: Date) => formatSlotPt(d, ctx.tz);
  const nome1 = firstName(contato.nome);

  try {
    if (acao.cancelar) {
      const ag = await proximoDoContato(admin, companyId, contato.numero);
      if (!ag) return MSG.nadaParaCancelar();
      const done = await cancelarAgendamento(admin, companyId, ag.id);
      if (!done) return MSG.nadaParaCancelar();
      await logLead(admin, companyId, contato.cardId, "agendamento_cancelado", `${ag.servico || ag.titulo} — ${fmt(new Date(ag.inicio))}`);
      return MSG.cancelado(ag.servico || ag.titulo, fmt(new Date(ag.inicio)));
    }

    if (acao.remarcar) {
      const ag = await proximoDoContato(admin, companyId, contato.numero);
      if (!ag) return MSG.nadaParaCancelar();
      const novo = parseAi(acao.remarcar.inicio, ctx.tz);
      if (!novo) return MSG.pedirConfirmacao();
      if (ctx.problemas.length) return MSG.semAgenda();
      const dur = Math.round((new Date(ag.fim).getTime() - new Date(ag.inicio).getTime()) / 60_000);
      const original = fmt(new Date(ag.inicio));
      if (new Date(ag.inicio).getTime() === novo.getTime()) return MSG.jaExistia(ag.servico || ag.titulo, original);
      const now = new Date();
      const rules = rulesOf(ctx, now);
      const fim = new Date(novo.getTime() + dur * 60_000);
      const b = await getBusy(admin, companyId, ctx, now, new Date(Math.max(fim.getTime(), now.getTime() + 8 * 24 * 3600_000)), { id: ag.id, eventId: ag.google_event_id });
      if (!b.ok) return MSG.semAgenda();
      const c = checkSlot(novo, dur, rules, b.busy);
      if (!c.ok) return MSG.remarcarIndisponivel(original, nearestAlternatives(novo, dur, rules, b.busy, 3).map(fmt));
      // UPDATE atômico: se houver conflito, o banco rejeita e o horário original continua reservado.
      const newKey = `wa:${contato.numero}:${novo.toISOString()}`;
      const { data: upd, error } = await admin.from("agendamento").update({
        inicio: novo.toISOString(), fim: fim.toISOString(), idempotency_key: newKey,
        // Novo horário: os lembretes recomeçam e a confirmação anterior não vale mais.
        lembrete_24h_enviado_em: null, lembrete_1h_enviado_em: null,
        aguardando_resposta_lembrete: false, cliente_confirmou_em: null, status: "agendado",
        google_sync_status: ag.google_sync_status === "nao_aplicavel" ? "nao_aplicavel" : "pendente",
      }).eq("id", ag.id).eq("company_id", companyId).in("status", ACTIVE).eq("inicio", ag.inicio).select("id");
      if (error) {
        if (error.code === "23P01" || error.code === "23505") return MSG.remarcarIndisponivel(original, nearestAlternatives(novo, dur, rules, b.busy, 3).map(fmt));
        console.error("[agendamento.remarcar]", error.code, error.message);
        return MSG.falha();
      }
      if (!upd?.length) return MSG.falha();
      if (ag.google_sync_status !== "nao_aplicavel") await syncAgendamentoGoogle(admin, companyId, ag.id);
      await logLead(admin, companyId, contato.cardId, "agendamento_remarcado", `${original} → ${fmt(novo)}`);
      return MSG.remarcado(ag.servico || ag.titulo, fmt(novo));
    }

    if (acao.agendar) {
      const inicio = parseAi(acao.agendar.inicio, ctx.tz);
      if (!inicio) return MSG.pedirConfirmacao();
      const nomeCliente = (acao.agendar.nome || contato.nome || "").trim().slice(0, 80) || null;
      const r = await reservarAgendamento(admin, companyId, ctx, {
        inicio,
        servico: acao.agendar.servico,
        contatoNumero: contato.numero,
        contatoNome: nomeCliente,
        cardId: contato.cardId ?? null,
        origem: "whatsapp",
        idempotencyKey: `wa:${contato.numero}:${inicio.toISOString()}`,
      });
      switch (r.status) {
        case "reservado":
          await logLead(admin, companyId, contato.cardId, "agendamento_criado", `${r.servico} — ${fmt(r.inicio)}`);
          return MSG.confirmado(firstName(nomeCliente) || nome1, r.servico, fmt(r.inicio));
        case "duplicado":
          return MSG.jaExistia(r.servico, fmt(r.inicio));
        case "indisponivel":
          return MSG.indisponivel(r.alternativas.map(fmt));
        case "antecedencia":
          return MSG.antecedencia(r.alternativas.map(fmt));
        case "servico_desconhecido":
          return MSG.qualServico(r.servicos);
        case "sem_agenda":
          return MSG.semAgenda();
        default:
          return MSG.falha();
      }
    }
  } catch (e: any) {
    console.error("[agenda.acao]", e?.message);
    return MSG.falha();
  }
  return null;
}

function parseAi(s: string, tz: string): Date | null {
  return parseAiDateTime(s, tz);
}

async function logLead(admin: any, companyId: string, cardId: string | null | undefined, tipo: string, descricao: string) {
  if (!cardId) return;
  try {
    await admin.from("lead_evento").insert({ company_id: companyId, card_id: cardId, tipo, descricao: descricao.slice(0, 300) });
  } catch {}
}
