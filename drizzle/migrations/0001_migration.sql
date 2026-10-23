ALTER TABLE public.agendamento
  ADD COLUMN IF NOT EXISTS lembrete_24h_enviado_em timestamptz,
  ADD COLUMN IF NOT EXISTS lembrete_1h_enviado_em timestamptz,
  ADD COLUMN IF NOT EXISTS aguardando_resposta_lembrete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cliente_confirmou_em timestamptz;

ALTER TABLE public.agent_config
  ADD COLUMN IF NOT EXISTS lembretes_ativos boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS agendamento_lembrete_idx
  ON public.agendamento (inicio)
  WHERE status IN ('agendado','confirmado') AND contato_numero IS NOT NULL
    AND (lembrete_24h_enviado_em IS NULL OR lembrete_1h_enviado_em IS NULL);

CREATE INDEX IF NOT EXISTS agendamento_aguardando_idx
  ON public.agendamento (company_id, contato_numero)
  WHERE aguardando_resposta_lembrete;