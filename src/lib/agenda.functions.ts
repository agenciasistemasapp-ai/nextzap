import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function getMembership(supabase: any, userId: string) {
  const { data: cu } = await supabase
    .from("company_user").select("company_id, role").eq("user_id", userId).eq("ativo", true)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!cu) throw new Error("Sem empresa vinculada");
  return cu as { company_id: string; role: "owner" | "admin" | "atendente" };
}

function isIso(s: unknown): s is string {
  return typeof s === "string" && !isNaN(new Date(s).getTime());
}

export const getAgenda = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { from: string; to: string }) => {
    if (!isIso(d?.from) || !isIso(d?.to)) throw new Error("Período inválido");
    const from = new Date(d.from); const to = new Date(d.to);
    if (to <= from || to.getTime() - from.getTime() > 62 * 24 * 3600_000) throw new Error("Período inválido");
    return { from: from.toISOString(), to: to.toISOString() };
  })
  .handler(async ({ context, data }) => {
    const cu = await getMembership(context.supabase, context.userId);
    // Leitura com RLS do próprio usuário (isolamento por empresa).
    const { data: rows, error } = await context.supabase
      .from("agendamento")
      .select("id, titulo, servico, inicio, fim, status, origem, contato_nome, contato_numero, card_id, google_sync_status, google_sync_erro, google_event_id, created_at")
      .eq("company_id", cu.company_id)
      .lt("inicio", data.to).gt("fim", data.from)
      .order("inicio", { ascending: true }).limit(500);
    if (error) throw new Error("Falha ao carregar a agenda");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadSchedulingContext } = await import("@/lib/scheduling.server");
    const [{ data: gi }, ctx, { count: pendentes }] = await Promise.all([
      (supabaseAdmin as any).from("google_integration")
        .select("conectado, email, ultimo_erro, ultimo_erro_em").eq("company_id", cu.company_id).maybeSingle(),
      loadSchedulingContext(supabaseAdmin, cu.company_id),
      (supabaseAdmin as any).from("agendamento").select("id", { count: "exact", head: true })
        .eq("company_id", cu.company_id).in("google_sync_status", ["pendente", "falhou"]),
    ]);
    return {
      role: cu.role,
      rows: rows ?? [],
      tz: ctx.tz,
      agendamentoAtivo: ctx.ativo,
      problemas: ctx.problemas,
      servicos: ctx.servicos,
      duracaoPadrao: ctx.defaultMin,
      google: {
        conectado: !!gi?.conectado,
        email: gi?.email ?? null,
        ultimoErro: gi?.ultimo_erro ?? null,
        ultimoErroEm: gi?.ultimo_erro_em ?? null,
        pendentes: pendentes ?? 0,
      },
    };
  });

export const criarAgendamentoManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    inicioLocal: string; duracaoMin: number; servico?: string; contatoNome?: string; contatoNumero?: string; bloqueio?: boolean;
  }) => {
    if (typeof d?.inicioLocal !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.inicioLocal)) throw new Error("Data/hora inválida");
    const dur = Math.floor(Number(d.duracaoMin));
    if (!Number.isFinite(dur) || dur < 5 || dur > 12 * 60) throw new Error("Duração deve ficar entre 5 min e 12 h");
    const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const numero = clean(d.contatoNumero, 20).replace(/\D/g, "");
    return {
      inicioLocal: d.inicioLocal, duracaoMin: dur,
      servico: clean(d.servico, 80), contatoNome: clean(d.contatoNome, 80), contatoNumero: numero,
      bloqueio: !!d.bloqueio,
    };
  })
  .handler(async ({ context, data }) => {
    const cu = await getMembership(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadSchedulingContext, reservarAgendamento } = await import("@/lib/scheduling.server");
    const { parseAiDateTime, formatSlotPt } = await import("@/lib/scheduling");
    const ctx = await loadSchedulingContext(supabaseAdmin, cu.company_id);
    const inicio = parseAiDateTime(data.inicioLocal, ctx.tz);
    if (!inicio) throw new Error("Data/hora inválida");

    let cardId: string | null = null;
    if (data.contatoNumero) {
      const { data: card } = await context.supabase.from("crm_cards").select("id")
        .eq("company_id", cu.company_id).eq("numero", data.contatoNumero).maybeSingle();
      cardId = card?.id ?? null;
    }
    const r = await reservarAgendamento(supabaseAdmin, cu.company_id, ctx, {
      inicio,
      duracaoMin: data.duracaoMin,
      servico: data.bloqueio ? "Bloqueio" : (data.servico || "Atendimento"),
      titulo: data.bloqueio ? `Bloqueio${data.servico ? ` — ${data.servico}` : ""}` : null,
      contatoNome: data.bloqueio ? null : data.contatoNome || null,
      contatoNumero: data.bloqueio ? null : data.contatoNumero || null,
      cardId,
      origem: data.bloqueio ? "bloqueio" : "manual",
      ignorarExpediente: true,
    });
    if (r.status === "reservado" || r.status === "duplicado") {
      return { ok: true as const, google: r.google, quando: formatSlotPt(r.inicio, ctx.tz) };
    }
    if (r.status === "indisponivel") return { ok: false as const, error: "Já existe um compromisso nesse horário." };
    if (r.status === "sem_agenda") return { ok: false as const, error: `Não foi possível conferir o Google Agenda: ${r.error}` };
    return { ok: false as const, error: "Não foi possível salvar o agendamento." };
  });

export const cancelarAgendamentoFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => {
    if (typeof d?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(d.id)) throw new Error("ID inválido");
    return { id: d.id };
  })
  .handler(async ({ context, data }) => {
    const cu = await getMembership(context.supabase, context.userId);
    // Confere pela RLS do usuário que o agendamento é da empresa dele.
    const { data: own } = await context.supabase.from("agendamento").select("id")
      .eq("id", data.id).eq("company_id", cu.company_id).maybeSingle();
    if (!own) throw new Error("Agendamento não encontrado");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { cancelarAgendamento } = await import("@/lib/scheduling.server");
    const row = await cancelarAgendamento(supabaseAdmin, cu.company_id, data.id);
    return { ok: true, jaCancelado: !row };
  });

export const sincronizarGoogleAgenda = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { incluirAnteriores?: boolean }) => ({ incluirAnteriores: !!d?.incluirAnteriores }))
  .handler(async ({ context, data }) => {
    const cu = await getMembership(context.supabase, context.userId);
    if (!["owner", "admin"].includes(cu.role)) throw new Error("Apenas dono ou admin");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;
    const { data: gi } = await admin.from("google_integration").select("conectado").eq("company_id", cu.company_id).maybeSingle();
    if (!gi?.conectado) return { ok: false as const, error: "Google Agenda não conectado" };
    if (data.incluirAnteriores) {
      // Envio retroativo explícito: só compromissos futuros e ativos que nunca foram ao Google.
      await admin.from("agendamento").update({ google_sync_status: "pendente", google_sync_tentativas: 0 })
        .eq("company_id", cu.company_id).eq("google_sync_status", "nao_aplicavel")
        .in("status", ["agendado", "confirmado"]).gte("inicio", new Date().toISOString());
    }
    const { retryPendingGoogleSyncs } = await import("@/lib/scheduling.server");
    const r = await retryPendingGoogleSyncs(admin, cu.company_id, 15);
    return { ok: true as const, ...r };
  });
