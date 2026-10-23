import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Saldo + últimos 20 lançamentos para a empresa atual
export const getMyCredits = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: cu } = await context.supabase
      .from("company_user")
      .select("company_id")
      .eq("user_id", context.userId)
      .eq("ativo", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!cu) return { saldo: 0, origem: "trial", resetam_em: null, ledger: [] as any[] };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [comp, led] = await Promise.all([
      supabaseAdmin.from("company").select("creditos_saldo, creditos_origem, creditos_resetam_em").eq("id", cu.company_id).maybeSingle(),
      supabaseAdmin.from("credit_ledger").select("delta, saldo_apos, motivo, ref, created_at").eq("company_id", cu.company_id).order("created_at", { ascending: false }).limit(20),
    ]);
    return {
      saldo: comp.data?.creditos_saldo ?? 0,
      origem: comp.data?.creditos_origem ?? "trial",
      resetam_em: comp.data?.creditos_resetam_em ?? null,
      ledger: led.data ?? [],
    };
  });

// Admin: adiciona/remove créditos numa empresa
export const adminGrantCredits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { companyId: string; qtd: number; motivo?: string }) => {
    if (typeof d?.companyId !== "string" || !/^[0-9a-f-]{36}$/i.test(d.companyId)) throw new Error("Empresa inválida");
    const qtd = Math.trunc(Number(d?.qtd));
    if (!Number.isFinite(qtd) || qtd === 0 || Math.abs(qtd) > 1_000_000) throw new Error("Quantidade inválida");
    return { companyId: d.companyId, qtd, motivo: String(d?.motivo ?? "").trim().slice(0, 120) || undefined };
  })
  .handler(async ({ data, context }) => {
    const { data: isSuper } = await context.supabase.rpc("is_super_admin");
    if (!isSuper) throw new Error("Acesso negado");
    const { data: novo, error } = await context.supabase.rpc("grant_credits", {
      _company_id: data.companyId,
      _qtd: data.qtd,
      _motivo: data.motivo || "bonus_admin",
    });
    if (error) throw new Error(error.message);
    return { saldo: novo as number };
  });
