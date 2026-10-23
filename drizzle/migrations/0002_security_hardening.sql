-- 1) Visitantes sem login: nenhuma tabela, exceto a lista pública de planos ativos.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', r.tablename);
  END LOOP;
END $$;
GRANT SELECT ON public.plan TO anon;

-- 2) Funções privilegiadas: só o servidor pode chamar.
REVOKE EXECUTE ON FUNCTION public.consume_ai_credit(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.topup_plan_credits(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_fin_categorias(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_super_admin_if_empty() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_default_stages() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_company_trial_credits() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_fin_auto_receita_on_ganho() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_credit(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.topup_plan_credits(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_fin_categorias(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_super_admin_if_empty() TO service_role;
-- Funções usadas pelas regras de acesso: só usuários logados.
REVOKE EXECUTE ON FUNCTION public.has_company_access(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_company_role(uuid, text[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_company_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fin_enable_for_company(uuid, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_company_access(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_company_role(uuid, text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_company_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_enable_for_company(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid, integer, text) TO authenticated, service_role;

-- 3) Empresa: só dono/admin editam, e nunca cobrança, teste grátis ou créditos.
DROP POLICY IF EXISTS company_insert ON public.company;
DROP POLICY IF EXISTS company_update ON public.company;
CREATE POLICY company_update ON public.company FOR UPDATE TO authenticated
  USING (public.is_super_admin() OR public.has_company_role(id, ARRAY['owner','admin']))
  WITH CHECK (public.is_super_admin() OR public.has_company_role(id, ARRAY['owner','admin']));

CREATE OR REPLACE FUNCTION public.tg_company_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status_cobranca := 'trial';
    NEW.trial_ate := now() + interval '14 days';
    NEW.financeiro_ativo := false;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.status_cobranca IS DISTINCT FROM OLD.status_cobranca
     OR NEW.trial_ate IS DISTINCT FROM OLD.trial_ate
     OR NEW.creditos_saldo IS DISTINCT FROM OLD.creditos_saldo
     OR NEW.creditos_origem IS DISTINCT FROM OLD.creditos_origem
     OR NEW.creditos_resetam_em IS DISTINCT FROM OLD.creditos_resetam_em
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.financeiro_ativo IS DISTINCT FROM OLD.financeiro_ativo THEN
    RAISE EXCEPTION 'Alteração não permitida nestes dados da empresa' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.tg_company_guard() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS company_guard ON public.company;
CREATE TRIGGER company_guard BEFORE INSERT OR UPDATE ON public.company
  FOR EACH ROW EXECUTE FUNCTION public.tg_company_guard();

-- 4) Assinatura: só o sistema de pagamento (servidor) ou o Master alteram.
DROP POLICY IF EXISTS "subscription owner update" ON public.subscription;
DROP POLICY IF EXISTS subscription_owner_admin_read ON public.subscription;
CREATE POLICY subscription_owner_admin_read ON public.subscription FOR SELECT TO authenticated
  USING (public.is_super_admin() OR public.has_company_role(company_id, ARRAY['owner','admin']));

-- 5) Equipe: atendente não remove ninguém; só o dono mexe em outro dono; sempre fica 1 dono ativo.
DROP POLICY IF EXISTS company_user_delete ON public.company_user;
CREATE POLICY company_user_delete ON public.company_user FOR DELETE TO authenticated
  USING (public.is_super_admin() OR public.has_company_role(company_id, ARRAY['owner','admin']));
DROP POLICY IF EXISTS company_user_insert ON public.company_user;
CREATE POLICY company_user_insert ON public.company_user FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin() OR public.has_company_role(company_id, ARRAY['owner','admin']));
DROP POLICY IF EXISTS company_user_self_update ON public.company_user;
CREATE POLICY company_user_self_update ON public.company_user FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.tg_company_user_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE _cid uuid; _is_owner boolean; _outros int;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') OR public.is_super_admin() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  _cid := COALESCE(NEW.company_id, OLD.company_id);
  _is_owner := public.has_company_role(_cid, ARRAY['owner']);

  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Alteração não permitida' USING ERRCODE = '42501';
    END IF;
    -- Quem não é dono/admin só pode limpar o aviso de "trocar senha" do próprio cadastro.
    IF NOT public.has_company_role(_cid, ARRAY['owner','admin']) THEN
      IF NEW.user_id <> auth.uid() OR NEW.role IS DISTINCT FROM OLD.role OR NEW.ativo IS DISTINCT FROM OLD.ativo
         OR NEW.convite_token IS DISTINCT FROM OLD.convite_token OR NEW.forcar_troca_senha THEN
        RAISE EXCEPTION 'Acesso negado' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF (OLD.role = 'owner' OR NEW.role = 'owner') AND NOT _is_owner
       AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.ativo IS DISTINCT FROM OLD.ativo) THEN
      RAISE EXCEPTION 'Apenas o dono pode alterar um dono' USING ERRCODE = '42501';
    END IF;
    IF OLD.role = 'owner' AND OLD.ativo AND (NEW.role <> 'owner' OR NOT NEW.ativo) THEN
      SELECT count(*) INTO _outros FROM public.company_user
        WHERE company_id = _cid AND role = 'owner' AND ativo AND id <> OLD.id;
      IF _outros = 0 THEN RAISE EXCEPTION 'A empresa precisa de pelo menos um dono ativo'; END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.role = 'owner' AND NOT _is_owner THEN
      RAISE EXCEPTION 'Apenas o dono pode adicionar outro dono' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  ELSE
    IF OLD.role = 'owner' AND NOT _is_owner THEN
      RAISE EXCEPTION 'Apenas o dono pode remover um dono' USING ERRCODE = '42501';
    END IF;
    IF OLD.role = 'owner' AND OLD.ativo THEN
      SELECT count(*) INTO _outros FROM public.company_user
        WHERE company_id = _cid AND role = 'owner' AND ativo AND id <> OLD.id;
      IF _outros = 0 THEN RAISE EXCEPTION 'A empresa precisa de pelo menos um dono ativo'; END IF;
    END IF;
    RETURN OLD;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.tg_company_user_guard() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS company_user_guard ON public.company_user;
CREATE TRIGGER company_user_guard BEFORE INSERT OR UPDATE OR DELETE ON public.company_user
  FOR EACH ROW EXECUTE FUNCTION public.tg_company_user_guard();

-- 6) Chaves de API e webhooks da empresa: só dono/admin.
DROP POLICY IF EXISTS api_token_company_access ON public.api_token;
CREATE POLICY api_token_owner_admin ON public.api_token FOR ALL TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner','admin']))
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner','admin']));
DROP POLICY IF EXISTS webhook_endpoint_company_access ON public.webhook_endpoint;
CREATE POLICY webhook_endpoint_owner_admin ON public.webhook_endpoint FOR ALL TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner','admin']))
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner','admin']));
DROP POLICY IF EXISTS webhook_log_company_read ON public.webhook_delivery_log;
CREATE POLICY webhook_log_owner_admin_read ON public.webhook_delivery_log FOR SELECT TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner','admin']));

-- 7) Google Agenda: o navegador nunca lê nem grava as chaves de acesso.
REVOKE ALL ON public.google_integration FROM authenticated;
GRANT SELECT (company_id, email, conectado, calendar_id, expiry, updated_at, ultimo_erro, ultimo_erro_em)
  ON public.google_integration TO authenticated;
GRANT ALL ON public.google_integration TO service_role;
DROP POLICY IF EXISTS google_integration_owner_admin ON public.google_integration;
CREATE POLICY google_integration_owner_admin_read ON public.google_integration FOR SELECT TO authenticated
  USING (public.is_super_admin() OR public.has_company_role(company_id, ARRAY['owner','admin']));

-- 8) Regras antigas que valiam também para visitantes: restringe a usuários logados.
DROP POLICY IF EXISTS agent_config_owner_admin ON public.agent_config;
CREATE POLICY agent_config_owner_admin ON public.agent_config FOR ALL TO authenticated
  USING (public.is_super_admin() OR public.has_company_role(company_id, ARRAY['owner','admin']))
  WITH CHECK (public.is_super_admin() OR public.has_company_role(company_id, ARRAY['owner','admin']));
DROP POLICY IF EXISTS billing_owner_admin_read ON public.company_billing;
DROP POLICY IF EXISTS billing_owner_admin_write ON public.company_billing;
CREATE POLICY billing_owner_admin ON public.company_billing FOR ALL TO authenticated
  USING (public.is_super_admin() OR public.has_company_role(company_id, ARRAY['owner','admin']))
  WITH CHECK (public.is_super_admin() OR public.has_company_role(company_id, ARRAY['owner','admin']));
DROP POLICY IF EXISTS profiles_company_admin_select ON public.profiles;
CREATE POLICY profiles_company_admin_select ON public.profiles FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.company_user me
    JOIN public.company_user target ON target.company_id = me.company_id
    WHERE me.user_id = auth.uid() AND me.ativo AND me.role IN ('owner','admin')
      AND target.user_id = profiles.user_id AND target.ativo));

-- 9) Perfil criado automaticamente no cadastro (sem promover ninguém a Master).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email)
  VALUES (NEW.id, lower(NEW.email))
  ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
    WHERE public.profiles.email IS NULL;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
INSERT INTO public.profiles (user_id, email)
  SELECT u.id, lower(u.email) FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id);

-- 10) Desempenho: conversas são sempre buscadas por empresa + número + data.
CREATE INDEX IF NOT EXISTS idx_mensagens_company_numero_created
  ON public.mensagens (company_id, numero, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mensagens_company_created
  ON public.mensagens (company_id, created_at DESC);
DROP INDEX IF EXISTS public.idx_mensagens_company;
DROP INDEX IF EXISTS public.idx_agent_config_company;
DROP INDEX IF EXISTS public.idx_csat_token;