-- Melhoria aditiva do agendamento (nenhuma coluna/tabela removida).
-- Reversão: drop constraint agendamento_sem_sobreposicao, agendamento_fim_maior, agendamento_google_sync_status_chk;
-- drop index agendamento_idem_uniq, agendamento_sync_pendente_idx, agendamento_contato_idx; drop trigger agendamento_updated_at;
-- drop das colunas novas listadas abaixo.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE public.agendamento
  ADD COLUMN IF NOT EXISTS recurso text NOT NULL DEFAULT 'principal',
  ADD COLUMN IF NOT EXISTS contato_numero text,
  ADD COLUMN IF NOT EXISTS contato_nome text,
  ADD COLUMN IF NOT EXISTS servico text,
  ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS google_sync_status text NOT NULL DEFAULT 'nao_aplicavel',
  ADD COLUMN IF NOT EXISTS google_sync_erro text,
  ADD COLUMN IF NOT EXISTS google_sync_tentativas integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS google_sync_em timestamptz,
  ADD COLUMN IF NOT EXISTS cancelado_em timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.agendamento
  ADD CONSTRAINT agendamento_fim_maior CHECK (fim > inicio);

ALTER TABLE public.agendamento
  ADD CONSTRAINT agendamento_google_sync_status_chk
  CHECK (google_sync_status IN ('nao_aplicavel','pendente','sincronizado','falhou'));

-- Idempotência: a mesma solicitação (mesma chave) nunca gera dois registros.
CREATE UNIQUE INDEX IF NOT EXISTS agendamento_idem_uniq
  ON public.agendamento (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Anti-conflito atômico: dois compromissos ativos da mesma empresa e do mesmo recurso
-- não podem se sobrepor (vale também para pedidos simultâneos).
ALTER TABLE public.agendamento
  ADD CONSTRAINT agendamento_sem_sobreposicao
  EXCLUDE USING gist (
    company_id WITH =,
    recurso WITH =,
    tstzrange(inicio, fim, '[)') WITH &&
  ) WHERE (status IN ('agendado','confirmado'));

CREATE INDEX IF NOT EXISTS agendamento_sync_pendente_idx
  ON public.agendamento (company_id, google_sync_em)
  WHERE google_sync_status IN ('pendente','falhou');

CREATE INDEX IF NOT EXISTS agendamento_contato_idx
  ON public.agendamento (company_id, contato_numero, inicio);

DROP TRIGGER IF EXISTS agendamento_updated_at ON public.agendamento;
CREATE TRIGGER agendamento_updated_at
  BEFORE UPDATE ON public.agendamento
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Estado real da integração Google (último erro), lido apenas no servidor.
ALTER TABLE public.google_integration
  ADD COLUMN IF NOT EXISTS ultimo_erro text,
  ADD COLUMN IF NOT EXISTS ultimo_erro_em timestamptz;