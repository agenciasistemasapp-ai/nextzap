import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/** Agendador: envia lembretes de agendamento (1 dia e 1 hora antes) pelo WhatsApp. */
export const Route = createFileRoute("/api/public/jobs/send-reminders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { enviarLembretesPendentes } = await import("@/lib/scheduling.server");
          const r = await enviarLembretesPendentes(supabaseAdmin);
          return Response.json({ ok: true, ...r });
        } catch (e: any) {
          console.error("[send-reminders]", e?.message);
          return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
        }
      },
    },
  },
});
