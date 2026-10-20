// Agendamento no servidor: disponibilidade real, reserva atômica, sincronização Google
// com idempotência e reconciliação. Usado pelo webhook do WhatsApp e pela tela Agenda.
// Sempre recebe o company_id já validado (webhook com token ou sessão autenticada).

import {
  checkSlot, firstName, formatLocalIso, formatSlotPt, formatSlotsForPrompt, hasAnyOpenDay,
  listAvailableSlots, MSG, nearestAlternatives, normalize, parseAntecedenciaMin, parseDurationMin,
  parseServicos, findServico, type Interval, type Servico, type SlotRules,
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
  return {
    ativo: !!c?.agendamento_ativo,
    tz,
    dias,
    servicos: parseServicos(c?.servicos_agendaveis, defaultMin ?? 30),
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
  admin: any, companyId: string, from: Date, to: Date, excludeEventIds: string[] = [],
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
          // Dia inteiro: início inclusivo, fim exclusivo. Bloqueia o dia todo (margem de fuso).
          s = new Date(`${ev.start.date}T00:00:00-03:00`).getTime() - 3 * 3600_000;
          e = new Date(`${ev.end?.date ?? ev.start.date}T00:00:00-03:00`).getTime() + 3 * 3600_000;
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
  return `nz${agendamentoId.replace(/-/g, "").toLowerCase()}`.replace(/[^a-v0-9]/g, "0");
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
  const g = await getGoogleBusy(admin, companyId, from, to, ex);
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
  const duracoes = [...new Set([ctx.defaultMin!, ...ctx.servicos.map((s) => s.duracaoMin)])].slice(0, 3);
  const listas = duracoes.map((d) => {
    const slots = listAvailableSlots(d, rules, busy, { days: 7, maxPerDay: 8, maxTotal: 40 });
    return `Para serviços de ${d} min:\n${slots.length ? formatSlotsForPrompt(slots, ctx.tz) : "(nenhum horário livre nos próximos 7 dias)"}`;
  });

  const { data: meus } = await admin.from("agendamento").select("inicio, servico, titulo")
    .eq("company_id", companyId).eq("contato_numero", numero).in("status", ACTIVE)
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

async function proximoDoContato(admin: any, companyId: string, numero: string) {
  const { data } = await admin.from("agendamento").select("*")
    .eq("company_id", companyId).eq("contato_numero", numero).in("status", ACTIVE)
    .gte("inicio", new Date().toISOString()).order("inicio", { ascending: true }).limit(1).maybeSingle();
  return data;
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
  // import tardio evita ciclo; parseAiDateTime é puro
  return parseAiDateTimeLocal(s, tz);
}

import { parseAiDateTime as parseAiDateTimeLocal } from "@/lib/scheduling";

async function logLead(admin: any, companyId: string, cardId: string | null | undefined, tipo: string, descricao: string) {
  if (!cardId) return;
  try {
    await admin.from("lead_evento").insert({ company_id: companyId, card_id: cardId, tipo, descricao: descricao.slice(0, 300) });
  } catch {}
}

export { normalize, formatLocalIso };
