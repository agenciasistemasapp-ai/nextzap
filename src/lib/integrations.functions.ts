import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Integrações (webhooks e chaves de API) são só para dono/admin; o banco também exige isso.
async function resolveCompanyId(supabase: any, userId: string): Promise<string> {
  const { data } = await supabase.from("company_user").select("company_id, role").eq("user_id", userId).eq("ativo", true).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!data) throw new Error("Sem empresa.");
  if (!["owner", "admin"].includes(data.role)) throw new Error("Apenas o dono ou um admin pode gerenciar integrações.");
  return data.company_id as string;
}

const EVENTOS = ["message.received", "message.sent", "lead.created", "lead.won", "lead.lost", "csat.responded"];
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

// ---------- Webhooks ----------
export const listWebhooks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { data } = await context.supabase.from("webhook_endpoint").select("*").eq("company_id", cid).order("created_at", { ascending: false });
    return data ?? [];
  });

export const saveWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id?: string; nome: string; url: string; eventos: string[]; ativo: boolean }) => {
    if (d?.id !== undefined && !isUuid(d.id)) throw new Error("ID inválido");
    const nome = String(d?.nome ?? "").trim().slice(0, 80);
    if (!nome) throw new Error("Informe um nome.");
    const eventos = Array.isArray(d?.eventos) ? d.eventos.filter((e) => EVENTOS.includes(e)) : [];
    return { id: d.id, nome, url: String(d?.url ?? ""), eventos, ativo: !!d?.ativo };
  })
  .handler(async ({ context, data }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { checkOutboundUrl } = await import("@/lib/security-utils");
    const u = checkOutboundUrl(data.url);
    if (!u.ok) throw new Error(u.error);
    const payload = { company_id: cid, nome: data.nome, url: u.url, eventos: data.eventos, ativo: data.ativo };
    if (data.id) {
      const { error } = await context.supabase.from("webhook_endpoint").update(payload).eq("id", data.id).eq("company_id", cid);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await context.supabase.from("webhook_endpoint").insert(payload);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const deleteWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => { if (!isUuid(d?.id)) throw new Error("ID inválido"); return { id: d.id }; })
  .handler(async ({ context, data }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { error } = await context.supabase.from("webhook_endpoint").delete().eq("id", data.id).eq("company_id", cid);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listWebhookLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { data } = await context.supabase.from("webhook_delivery_log").select("*").eq("company_id", cid).order("created_at", { ascending: false }).limit(50);
    return data ?? [];
  });

// ---------- API tokens ----------
export const listApiTokens = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { data } = await context.supabase.from("api_token").select("*").eq("company_id", cid).order("created_at", { ascending: false });
    return data ?? [];
  });

export const createApiToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { label: string }) => {
    const label = String(d?.label ?? "").trim().slice(0, 80);
    if (!label) throw new Error("Informe um nome para o token.");
    return { label };
  })
  .handler(async ({ context, data }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    // Gating: apenas Business
    const { data: sub } = await context.supabase
      .from("subscription").select("plan:plan(slug)")
      .eq("company_id", cid).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const slug = (sub as any)?.plan?.slug ?? "starter";
    if (slug !== "business") throw new Error("API pública disponível apenas no plano Business.");
    const { data: row, error } = await context.supabase
      .from("api_token").insert({ company_id: cid, label: data.label, criado_por: context.userId })
      .select("*").maybeSingle();
    if (error || !row) throw new Error(error?.message ?? "Falha.");
    return row;
  });

export const revokeApiToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => { if (!isUuid(d?.id)) throw new Error("ID inválido"); return { id: d.id }; })
  .handler(async ({ context, data }) => {
    const cid = await resolveCompanyId(context.supabase, context.userId);
    const { error } = await context.supabase.from("api_token").update({ revogado: true }).eq("id", data.id).eq("company_id", cid);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
