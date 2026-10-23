import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, RefreshCw, Ban, AlertTriangle, CheckCircle2, Clock, XCircle } from "lucide-react";
import { brand } from "@/config/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HelpTip } from "@/components/help-tip";
import { getAgenda, criarAgendamentoManual, cancelarAgendamentoFn, sincronizarGoogleAgenda } from "@/lib/agenda.functions";

export const Route = createFileRoute("/app/agenda")({
  head: () => ({ meta: [{ title: `${brand.name} — Agenda` }] }),
  component: AgendaPage,
});

type Modo = "dia" | "semana" | "mes";
type Row = {
  id: string; titulo: string; servico: string | null; inicio: string; fim: string; status: string; origem: string;
  contato_nome: string | null; contato_numero: string | null; card_id: string | null;
  google_sync_status: string; google_sync_erro: string | null;
};

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function rangeOf(modo: Modo, cursor: Date) {
  const base = startOfDay(cursor);
  if (modo === "dia") return { from: base, to: addDays(base, 1) };
  if (modo === "semana") {
    const dow = (base.getDay() + 6) % 7; // segunda
    const from = addDays(base, -dow);
    return { from, to: addDays(from, 7) };
  }
  const from = new Date(base.getFullYear(), base.getMonth(), 1);
  return { from, to: new Date(base.getFullYear(), base.getMonth() + 1, 1) };
}

const SYNC_LABEL: Record<string, { label: string; icon: any; cls: string }> = {
  sincronizado: { label: "No Google", icon: CheckCircle2, cls: "text-[var(--brand-text)]" },
  pendente: { label: "Google pendente", icon: Clock, cls: "text-muted-foreground" },
  falhou: { label: "Falha no Google", icon: AlertTriangle, cls: "text-destructive" },
  nao_aplicavel: { label: "Só agenda interna", icon: CalendarDays, cls: "text-muted-foreground" },
};

function AgendaPage() {
  const fetchAgenda = useServerFn(getAgenda);
  const criarFn = useServerFn(criarAgendamentoManual);
  const cancelarFn = useServerFn(cancelarAgendamentoFn);
  const syncFn = useServerFn(sincronizarGoogleAgenda);

  const [modo, setModo] = useState<Modo>("semana");
  const [cursor, setCursor] = useState(() => new Date());
  const [data, setData] = useState<Awaited<ReturnType<typeof getAgenda>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [novoOpen, setNovoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ data: "", hora: "", duracao: "30", servico: "", nome: "", numero: "", bloqueio: false });

  const range = useMemo(() => rangeOf(modo, cursor), [modo, cursor]);

  async function load() {
    setLoading(true);
    try {
      const r = await fetchAgenda({ data: { from: range.from.toISOString(), to: range.to.toISOString() } });
      setData(r);
    } catch (e: any) {
      toast.error(e?.message || "Falha ao carregar a agenda");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [range.from.getTime(), range.to.getTime()]);

  const tz = data?.tz || "America/Sao_Paulo";
  const fmtDia = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit" }).format(new Date(iso));
  const fmtHora = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const diaKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

  const grupos = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of (data?.rows ?? []) as Row[]) {
      const k = diaKey(r.inicio);
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return [...m.entries()];
  }, [data, tz]);

  function shift(n: number) {
    if (modo === "dia") setCursor((c) => addDays(c, n));
    else if (modo === "semana") setCursor((c) => addDays(c, 7 * n));
    else setCursor((c) => new Date(c.getFullYear(), c.getMonth() + n, 1));
  }

  const tituloPeriodo = modo === "mes"
    ? new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(range.from)
    : modo === "dia"
      ? new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long" }).format(range.from)
      : `${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(range.from)} – ${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(addDays(range.to, -1))}`;

  async function salvarNovo() {
    if (!form.data || !form.hora) { toast.error("Informe data e horário"); return; }
    setBusy(true);
    try {
      const r = await criarFn({ data: {
        inicioLocal: `${form.data}T${form.hora}`, duracaoMin: Number(form.duracao),
        servico: form.servico, contatoNome: form.nome, contatoNumero: form.numero, bloqueio: form.bloqueio,
      } });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(form.bloqueio ? "Horário bloqueado" : `Agendado: ${r.quando}`);
      if (r.google === "falhou") toast.warning("Salvo na agenda, mas o Google Agenda não confirmou. Tentaremos de novo.");
      setNovoOpen(false);
      setForm({ data: "", hora: "", duracao: String(data?.duracaoPadrao ?? 30), servico: "", nome: "", numero: "", bloqueio: false });
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Falha ao salvar");
    } finally { setBusy(false); }
  }

  async function cancelar(id: string) {
    if (!confirm("Cancelar este compromisso?")) return;
    try {
      await cancelarFn({ data: { id } });
      toast.success("Compromisso cancelado");
      await load();
    } catch (e: any) { toast.error(e?.message || "Falha ao cancelar"); }
  }

  async function sincronizar(incluirAnteriores: boolean) {
    setBusy(true);
    try {
      const r = await syncFn({ data: { incluirAnteriores } });
      if (!r.ok) toast.error(r.error);
      else toast.success(`${r.sincronizados ?? 0} de ${r.processados} sincronizados com o Google`);
      await load();
    } catch (e: any) { toast.error(e?.message || "Falha ao sincronizar"); }
    finally { setBusy(false); }
  }

  const isAdmin = data?.role === "owner" || data?.role === "admin";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl sm:text-2xl font-bold flex items-center gap-2">
            Agenda <HelpTip text="Compromissos marcados pela IA no WhatsApp e pela equipe. O sistema impede dois horários sobrepostos." />
          </h1>
          <p className="text-sm text-muted-foreground">Agenda interna da empresa{data?.google.conectado ? ", sincronizada com o Google Agenda" : ""}.</p>
        </div>
        <Button onClick={() => { setForm((f) => ({ ...f, duracao: String(data?.duracaoPadrao ?? 30) })); setNovoOpen(true); }}>
          <Plus className="size-4 mr-2" /> Novo compromisso
        </Button>
      </header>

      {data && !data.agendamentoAtivo && (
        <div className="rounded-xl border border-[color:var(--hairline)] bg-[color:var(--panel-2)] p-4 text-sm">
          O agendamento pela IA está desligado. A agenda funciona para lançamentos da equipe.{" "}
          {isAdmin && <Link to="/app/agente/avancado" search={{ aba: "agendamento" }} className="underline">Ativar no Agente IA</Link>}
        </div>
      )}
      {data && data.agendamentoAtivo && data.problemas.length > 0 && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm space-y-1">
          <div className="font-semibold flex items-center gap-2"><AlertTriangle className="size-4" /> A IA não está oferecendo horários</div>
          {data.problemas.map((p) => <div key={p}>{p}</div>)}
        </div>
      )}
      {data?.google.conectado && data.google.ultimoErro && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5" />
          <div>
            <div className="font-semibold">Google Agenda com problema</div>
            <div>{data.google.ultimoErro} Enquanto isso, a IA não confirma novos horários pelo WhatsApp.</div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-[color:var(--hairline)] overflow-hidden">
          {(["dia", "semana", "mes"] as Modo[]).map((m) => (
            <button key={m} onClick={() => setModo(m)}
              className={`px-3 py-1.5 text-sm ${modo === m ? "bg-[color:var(--panel-2)] font-semibold" : "text-muted-foreground"}`}>
              {m === "dia" ? "Dia" : m === "semana" ? "Semana" : "Mês"}
            </button>
          ))}
        </div>
        <Button variant="outline" size="icon" onClick={() => shift(-1)} aria-label="Anterior"><ChevronLeft className="size-4" /></Button>
        <Button variant="outline" size="sm" onClick={() => setCursor(new Date())}>Hoje</Button>
        <Button variant="outline" size="icon" onClick={() => shift(1)} aria-label="Próximo"><ChevronRight className="size-4" /></Button>
        <div className="font-semibold capitalize ml-1">{tituloPeriodo}</div>
        {isAdmin && data?.google.conectado && (
          <div className="ml-auto flex gap-2">
            {data.google.pendentes > 0 && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => sincronizar(false)}>
                <RefreshCw className="size-3.5 mr-1.5" /> Reenviar {data.google.pendentes} ao Google
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => sincronizar(true)}>
              Enviar compromissos antigos ao Google
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-[color:var(--hairline)] bg-[color:var(--panel)] overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-sm text-muted-foreground">Carregando…</div>
        ) : grupos.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">Nenhum compromisso neste período.</div>
        ) : (
          <div className="divide-y divide-[color:var(--hairline)]">
            {grupos.map(([k, items]) => (
              <section key={k}>
                <div className="px-5 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground bg-[color:var(--panel-2)] capitalize">
                  {fmtDia(items[0].inicio)}
                </div>
                <ul className="divide-y divide-[color:var(--hairline)]">
                  {items.map((r) => {
                    const cancelado = !["agendado", "confirmado"].includes(r.status);
                    const sync = SYNC_LABEL[r.google_sync_status] ?? SYNC_LABEL.nao_aplicavel;
                    const SyncIcon = sync.icon;
                    return (
                      <li key={r.id} className={`px-5 py-3 flex flex-wrap items-center gap-3 ${cancelado ? "opacity-60" : ""}`}>
                        <div className="font-mono text-[13px] w-28 shrink-0">{fmtHora(r.inicio)} – {fmtHora(r.fim)}</div>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold truncate flex items-center gap-2">
                            {r.origem === "bloqueio" && <Ban className="size-3.5 text-muted-foreground" />}
                            {r.servico || r.titulo}
                            {cancelado && <span className="text-[11px] font-normal px-2 py-0.5 rounded-full bg-[color:var(--panel-2)] flex items-center gap-1"><XCircle className="size-3" />Cancelado</span>}
                            {r.status === "confirmado" && <span className="text-[11px] font-normal px-2 py-0.5 rounded-full bg-primary/15 text-primary">Confirmado pelo cliente</span>}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {[r.contato_nome, r.contato_numero].filter(Boolean).join(" · ") || (r.origem === "bloqueio" ? "Horário bloqueado" : "—")}
                            {" · "}{r.origem === "whatsapp" ? "Marcado pela IA" : r.origem === "bloqueio" ? "Bloqueio" : "Lançado pela equipe"}
                            {r.card_id ? " · Lead no CRM" : ""}
                          </div>
                        </div>
                        {data?.google.conectado || r.google_sync_status !== "nao_aplicavel" ? (
                          <span className={`text-[12px] flex items-center gap-1 ${sync.cls}`} title={r.google_sync_erro ?? undefined}>
                            <SyncIcon className="size-3.5" /> {sync.label}
                          </span>
                        ) : null}
                        {!cancelado && (
                          <Button variant="ghost" size="sm" onClick={() => cancelar(r.id)}>Cancelar</Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <Dialog open={novoOpen} onOpenChange={setNovoOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Novo compromisso</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.bloqueio} onChange={(e) => setForm({ ...form, bloqueio: e.target.checked })} />
              Apenas bloquear o horário (folga, pausa, compromisso pessoal)
            </label>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Data</Label><Input type="date" value={form.data} onChange={(e) => setForm({ ...form, data: e.target.value })} /></div>
              <div><Label>Início</Label><Input type="time" value={form.hora} onChange={(e) => setForm({ ...form, hora: e.target.value })} /></div>
              <div><Label>Duração (min)</Label><Input type="number" min={5} max={720} value={form.duracao} onChange={(e) => setForm({ ...form, duracao: e.target.value })} /></div>
            </div>
            <div>
              <Label>{form.bloqueio ? "Motivo (opcional)" : "Serviço"}</Label>
              <Input list="servicos-agenda" value={form.servico} onChange={(e) => {
                const v = e.target.value;
                const s = data?.servicos.find((x) => x.nome === v);
                setForm({ ...form, servico: v, duracao: s ? String(s.duracaoMin) : form.duracao });
              }} />
              <datalist id="servicos-agenda">
                {(data?.servicos ?? []).map((s) => <option key={s.nome} value={s.nome} />)}
              </datalist>
            </div>
            {!form.bloqueio && (
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Nome do cliente</Label><Input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} /></div>
                <div><Label>WhatsApp (opcional)</Label><Input value={form.numero} placeholder="5511999999999" onChange={(e) => setForm({ ...form, numero: e.target.value })} /></div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Horário da empresa ({tz}). O sistema recusa se já houver compromisso no mesmo horário.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNovoOpen(false)}>Voltar</Button>
            <Button onClick={salvarNovo} disabled={busy}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
