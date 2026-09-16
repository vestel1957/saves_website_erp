"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import {
  type WaTemplate, type WaCampaign, type WaCampaignReport, type WaHealth,
  type WaFiltroCampana, type WaOpcionesCampana, type WaPreviewCampana,
  WA_SEND_STATUS, WA_QUALITY, WA_TIER, WA_CAMPAIGN_STATUS,
} from "@/lib/whatsapp";
import { mensajeDeError } from "@/lib/errores";

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString("es-CO") : "—");
const num = (n: number) => n.toLocaleString("es-CO");
const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n || 0);

/** "POR_RETIRAR" → "Por retirar". */
const estadoLegible = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

/**
 * Nombre de plantilla para personas: los de Meta arrastran el prefijo de la empresa,
 * el id del legacy y el sufijo `_hx…` de Twilio
 * (`vestel_facturacion_86_hx3fca…` → "Facturacion").
 */
function nombrePlantilla(n: string) {
  const limpio = n.replace(/_hx[0-9a-f]{32}$/i, "").replace(/^vestel_/, "").replace(/_\d+$/, "").replace(/_/g, " ").trim();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

const FILTRO_INICIAL: WaFiltroCampana = {
  statuses: ["ACTIVO"],
  branchIds: [],
  planIds: [],
  deuda: undefined,
  deudaMin: 1000,
  soloMoviles: true,
  omitirEnAtencion: true,
};

type Paso = 1 | 2 | 3;
type Vista = "nueva" | "campanas";

// ─────────────────────────────────────────────────────────────────────────────
// Salud del número
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Salud del número (calidad + tier de Meta) y cuánto del cupo de 24 h va gastado.
 * La calidad baja por bloqueos/reportes de los clientes y es lo que decide si Meta
 * sube o BAJA el cupo diario de envíos.
 */
function HealthPanel({ health }: { health: WaHealth | null }) {
  if (!health) return null;
  if (!health.ok) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-2xl border border-error-subtle bg-error-soft p-3 text-[13px] text-error-text">
        <Icon name="alert-triangle" size={15} /> WhatsApp no disponible: {health.error ?? "sin diagnóstico"}
      </div>
    );
  }
  const q = health.quality ? WA_QUALITY[health.quality.toUpperCase()] : null;
  const tier = health.tier ? (WA_TIER[health.tier.toUpperCase()] ?? health.tier) : null;
  const cupo = health.cupo;
  const pct = cupo && cupo.limite > 0 ? Math.min(100, Math.round((cupo.usadas / cupo.limite) * 100)) : 0;
  return (
    <section className="mt-4 rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <div className="flex items-center gap-2">
            <Icon name="phone" size={14} className="text-text-tertiary" />
            <span className="font-mono">{health.phone ?? "—"}</span>
            {health.name && <span className="text-text-secondary">· {health.name}</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-tertiary">Calidad:</span>
            {q ? <Badge label={q.label} tone={q.tone} /> : <span className="text-text-secondary">sin calificar todavía</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-tertiary">Límite de Meta:</span>
            {tier ? <span className="font-medium text-text-primary">{tier}</span> : <span className="text-text-secondary">sin dato</span>}
          </div>
        </div>
        {cupo && (
          <div className="min-w-0 lg:w-80">
            <div className="flex items-baseline justify-between text-[12px]">
              <span className="text-text-tertiary">Cupo de hoy para campañas</span>
              <span className="tabular-nums text-text-secondary">
                <span className="font-semibold text-text-primary">{num(cupo.usadas)}</span> / {num(cupo.limite)}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full ${pct >= 90 ? "bg-error-text" : pct >= 70 ? "bg-warning-text" : "bg-brand"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-text-tertiary">
              Quedan {num(cupo.disponibles)} clientes nuevos en las próximas 24 h. Se deja un 10 % del límite de Meta para el bot y la bandeja.
            </p>
          </div>
        )}
      </div>
      {(q?.tone === "error" || q?.tone === "warning") && (
        <p className="mt-2 text-[12px] text-warning-text">
          La calidad baja cuando los clientes bloquean o reportan el número. Con calidad baja Meta reduce el límite diario:
          pausa las campañas no esenciales y revisa el texto de las plantillas.
        </p>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporte de una campaña
// ─────────────────────────────────────────────────────────────────────────────

function ReportModal({ campaignId, onClose }: { campaignId: string | null; onClose: () => void }) {
  const { authFetch } = useAuth();
  const [data, setData] = useState<WaCampaignReport | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ pageSize: "200" });
      if (statusFilter) qs.set("status", statusFilter);
      const r = await authFetch(`/admin/whatsapp/campaigns/${campaignId}?${qs}`);
      setData(r.ok ? await r.json() : null);
    } finally { setLoading(false); }
  }, [authFetch, campaignId, statusFilter]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!campaignId) { setData(null); setStatusFilter(""); } }, [campaignId]);

  async function retry() {
    if (!campaignId) return;
    try {
      const r = await authFetch(`/admin/whatsapp/campaigns/${campaignId}/retry`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo reintentar");
      toast(`Reencolados ${d.requeued} envíos fallidos`, "check");
      setTimeout(load, 800);
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  }

  const c = data?.campaign;
  const st = c ? WA_CAMPAIGN_STATUS[c.status] : null;
  return (
    <Modal open={!!campaignId} onClose={onClose} title={c ? `Campaña · ${c.name}` : "Campaña"} maxWidth="max-w-3xl">
      {!data ? <PageSkeleton /> : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
            {st && <Badge label={st.label} tone={st.tone} />}
            <span className="font-mono">{nombrePlantilla(c!.templateName)}</span>
            {c!.createdByName && <span>· por {c!.createdByName}</span>}
          </div>
          {c!.status === "waiting" && (
            <p className="rounded-lg border border-warning-subtle bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
              Se acabó el cupo de 24 h. Lo que falta sale solo a medida que se libere cupo; no hay que hacer nada.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {([["Total", c!.total], ["Enviados", c!.sent], ["Entregados", c!.delivered], ["Leídos", c!.read], ["Fallidos", c!.failed]] as const).map(([lbl, val]) => (
              <div key={lbl} className="rounded-lg border border-border-subtle bg-surface-2 p-2 text-center">
                <div className="text-[18px] font-bold tabular-nums text-text-primary">{num(val)}</div>
                <div className="text-[11px] text-text-tertiary">{lbl}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="sm:max-w-[200px]">
              <option value="">Todos los estados</option>
              {Object.entries(WA_SEND_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
            {c!.failed > 0 && <Button size="sm" variant="secondary" onClick={retry}><Icon name="refresh-cw" size={13} /> Reintentar fallidos</Button>}
          </div>
          <PagedTable
            rows={data.sends}
            empty="Sin envíos."
            columns={[
              { key: "name", header: "Cliente", render: (s) => s.subscriberId
                ? <Link href={`/clientes/${s.subscriberId}`} className="text-brand hover:underline">{s.name || "—"}</Link>
                : (s.name || "—") },
              { key: "phone", header: "Teléfono", render: (s) => <span className="font-mono text-[12px]">{s.phone}</span> },
              { key: "status", header: "Estado", render: (s) => <Badge label={WA_SEND_STATUS[s.status]?.label ?? s.status} tone={WA_SEND_STATUS[s.status]?.tone ?? "default"} /> },
              { key: "sent", header: "Enviado", render: (s) => fmt(s.sentAt) },
              { key: "err", header: "Error", render: (s) => s.error ? <span className="text-[12px] text-error-text">{s.error}</span> : "—" },
            ]}
          />
          {loading && <p className="text-center text-[12px] text-text-tertiary">Actualizando…</p>}
        </div>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Asistente de campaña
// ─────────────────────────────────────────────────────────────────────────────

/** Encabezado de pasos: se puede volver a uno anterior, no saltar adelante. */
function Pasos({ paso, onIr }: { paso: Paso; onIr: (p: Paso) => void }) {
  const pasos: { n: Paso; label: string }[] = [
    { n: 1, label: "A quién" },
    { n: 2, label: "Qué mensaje" },
    { n: 3, label: "Revisar y enviar" },
  ];
  return (
    <ol className="flex items-center gap-2 overflow-x-auto pb-1 text-[13px]">
      {pasos.map((p, i) => {
        const hecho = p.n < paso;
        const actual = p.n === paso;
        return (
          <li key={p.n} className="flex shrink-0 items-center gap-2">
            {i > 0 && <span className="h-px w-6 bg-border-subtle" />}
            <button
              type="button"
              disabled={!hecho}
              onClick={() => onIr(p.n)}
              className={`inline-flex min-h-8 items-center gap-2 rounded-full px-3 py-1 font-medium ${
                actual ? "bg-brand text-on-brand" : hecho ? "bg-brand-soft text-brand hover:underline" : "bg-surface-2 text-text-tertiary"
              }`}
            >
              <span className="tabular-nums">{hecho ? <Icon name="check" size={13} /> : p.n}</span>
              {p.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Burbuja estilo WhatsApp con el mensaje tal como le llega al cliente. */
function Burbuja({ cabecera, cuerpo }: { cabecera?: string | null; cuerpo: string }) {
  return (
    <div className="rounded-xl bg-[#0b141a] p-3">
      <div className="max-w-[92%] rounded-lg rounded-tl-sm bg-[#202c33] px-3 py-2 text-[13px] leading-relaxed text-white shadow-sm">
        {cabecera && <div className="mb-1 font-semibold">{cabecera}</div>}
        <div className="whitespace-pre-wrap break-words">{cuerpo}</div>
      </div>
    </div>
  );
}

function Casilla({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[13px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand" />
      <span>
        <span className="font-medium text-text-primary">{label}</span>
        <span className="block text-[12px] text-text-tertiary">{hint}</span>
      </span>
    </label>
  );
}

function Resumen({ preview, cargando }: { preview: WaPreviewCampana | null; cargando: boolean }) {
  if (!preview) {
    return <div className="rounded-xl border border-border-subtle bg-surface-2 p-4 text-[13px] text-text-tertiary">{cargando ? "Contando clientes…" : "Elige al menos un estado."}</div>;
  }
  const d = preview.descartes;
  const caidas = ([
    ["no cumplen la condición de deuda", d.fueraPorDeuda],
    ["sin celular válido", d.sinTelefono],
    ["hablando con una persona en la bandeja", d.enAtencion],
    ["comparten celular con otra ficha (reciben uno solo)", d.telefonoRepetido],
  ] as const).filter(([, n]) => n > 0);
  return (
    <div className={`rounded-xl border border-border-subtle bg-surface-2 p-4 transition-opacity ${cargando ? "opacity-60" : ""}`}>
      <div className="text-[12px] uppercase tracking-wide text-text-tertiary">Recibirán el mensaje</div>
      <div className="text-[32px] font-bold leading-tight tabular-nums text-text-primary">{num(preview.destinatarios)}</div>
      <div className="text-[12px] text-text-secondary">
        de {num(preview.coinciden)} clientes que cumplen el filtro
        {preview.deudaTotal > 0 && <> · {cop(preview.deudaTotal)} en deuda</>}
      </div>
      {caidas.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 border-t border-border-subtle pt-3 text-[12px] text-text-secondary">
          {caidas.map(([txt, n]) => (
            <li key={txt} className="flex justify-between gap-3"><span>Fuera: {txt}</span><span className="tabular-nums">{num(n)}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NuevaCampana({ onLanzada }: { onLanzada: () => void }) {
  const { authFetch } = useAuth();
  const [paso, setPaso] = useState<Paso>(1);
  const [opciones, setOpciones] = useState<WaOpcionesCampana | null>(null);
  const [plantillas, setPlantillas] = useState<WaTemplate[]>([]);
  const [filtro, setFiltro] = useState<WaFiltroCampana>(FILTRO_INICIAL);
  const [templateName, setTemplateName] = useState("");
  const [buscarPlantilla, setBuscarPlantilla] = useState("");
  const [preview, setPreview] = useState<WaPreviewCampana | null>(null);
  const [cargando, setCargando] = useState(false);
  const [nombre, setNombre] = useState("");
  const [telPrueba, setTelPrueba] = useState("");
  const [probando, setProbando] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const [lanzando, setLanzando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  // Opciones de filtro y plantillas aprobadas. La sede puede venir de la pantalla de
  // la sede (`?sede=`); se lee de `window` para no arrastrar la frontera de Suspense.
  useEffect(() => {
    const sede = new URLSearchParams(window.location.search).get("sede");
    if (sede) setFiltro((f) => ({ ...f, branchIds: [sede] }));
    void authFetch("/admin/whatsapp/campaigns/options")
      .then(async (r) => { if (r.ok) setOpciones(await r.json()); })
      .catch(() => undefined);
    void authFetch("/admin/whatsapp/templates")
      .then(async (r) => {
        if (!r.ok) return;
        const t: WaTemplate[] = await r.json();
        // Solo activas y APROBADAS: una en revisión sale FAILED en cada envío.
        setPlantillas(t.filter((x) => x.active && x.metaStatus === "APPROVED"));
      })
      .catch(() => undefined);
  }, [authFetch]);

  // Conteo en vivo. Cada cambio de filtro o plantilla recalcula con una pausa corta;
  // `pedido` descarta respuestas viejas que lleguen después de una nueva.
  const pedido = useRef(0);
  const clave = JSON.stringify([filtro, templateName]);
  useEffect(() => {
    if (!filtro.statuses.length) { setPreview(null); return; }
    const id = ++pedido.current;
    setCargando(true);
    const t = setTimeout(async () => {
      try {
        const r = await authFetch("/admin/whatsapp/campaigns/preview", {
          method: "POST",
          body: JSON.stringify({ filter: filtro, templateName: templateName || undefined }),
        });
        const d = await r.json();
        if (id !== pedido.current) return;
        if (!r.ok) throw new Error(d?.message || "No se pudo calcular el público");
        setPreview(d);
      } catch (e) {
        if (id === pedido.current) toast(mensajeDeError(e), "alert-triangle");
      } finally {
        if (id === pedido.current) setCargando(false);
      }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, authFetch]);

  const set = <K extends keyof WaFiltroCampana>(k: K, v: WaFiltroCampana[K]) => setFiltro((f) => ({ ...f, [k]: v }));

  const plantilla = plantillas.find((t) => t.name === templateName) ?? null;
  const plantillasVisibles = useMemo(() => {
    const q = buscarPlantilla.trim().toLowerCase();
    if (!q) return plantillas;
    return plantillas.filter((t) => [t.name, t.bodyText].some((v) => v.toLowerCase().includes(q)));
  }, [plantillas, buscarPlantilla]);

  function siguiente() {
    setAviso(null);
    if (paso === 1) {
      if (!filtro.statuses.length) return setAviso("Elige al menos un estado de cliente.");
      if (!preview || preview.destinatarios === 0) return setAviso("Con estos filtros no le llega a nadie.");
      setPaso(2);
    } else if (paso === 2) {
      if (!plantilla) return setAviso("Elige la plantilla que se va a enviar.");
      if (!nombre.trim()) {
        const mes = new Date().toLocaleDateString("es-CO", { month: "long", year: "numeric" });
        setNombre(`${nombrePlantilla(plantilla.name)} · ${mes}`);
      }
      setPaso(3);
    }
  }

  async function enviarPrueba() {
    if (!plantilla) return;
    if (!/^3\d{9}$/.test(telPrueba.replace(/\D/g, "").slice(-10))) {
      toast("Escribe un celular de 10 dígitos que empiece por 3.", "alert-triangle");
      return;
    }
    setProbando(true);
    try {
      const r = await authFetch("/admin/whatsapp/campaigns/test", {
        method: "POST",
        body: JSON.stringify({ templateName: plantilla.name, phone: telPrueba, subscriberId: preview?.ejemplo?.subscriberId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo enviar la prueba");
      if (!d.ok) throw new Error(`Meta no lo aceptó: ${d.error}`);
      toast("Prueba enviada. Revisa ese WhatsApp.", "check");
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setProbando(false); }
  }

  async function lanzar() {
    if (!plantilla || !preview) return;
    setLanzando(true);
    try {
      const r = await authFetch("/admin/whatsapp/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: nombre.trim(), templateName: plantilla.name, templateId: plantilla.id, language: plantilla.language, filter: filtro,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo lanzar la campaña");
      toast(`Campaña lanzada a ${num(d.total)} clientes`, "check");
      setConfirmar(false);
      setPaso(1); setFiltro(FILTRO_INICIAL); setTemplateName(""); setNombre(""); setPreview(null);
      onLanzada();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setLanzando(false); }
  }

  if (!opciones) return <PageSkeleton />;

  const esMarketing = plantilla?.category?.toUpperCase() === "MARKETING";
  // Frenar a quien lanza cientos con un clic distraído: por encima de esto hay que escribirlo.
  const pedirTexto = (preview?.destinatarios ?? 0) >= 200;

  return (
    <section className="mt-4 rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
      <Pasos paso={paso} onIr={(p) => { setAviso(null); setPaso(p); }} />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          {paso === 1 && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Estado del cliente" required>
                  <MultiSelect
                    label="Estado" todos="Elige estados" value={filtro.statuses} onChange={(v) => set("statuses", v)}
                    options={opciones.estados.map((e) => ({ value: e.value, label: estadoLegible(e.value), count: e.count }))}
                  />
                </Field>
                <Field label="Sede">
                  <MultiSelect
                    label="Sede" todos="Todas las sedes" value={filtro.branchIds} onChange={(v) => set("branchIds", v)}
                    options={opciones.sedes.map((s) => ({ value: s.id, label: s.name }))}
                  />
                </Field>
                <Field label="Plan">
                  <MultiSelect
                    label="Plan" todos="Todos los planes" value={filtro.planIds} onChange={(v) => set("planIds", v)}
                    options={opciones.planes.map((p) => ({ value: p.id, label: p.name }))}
                  />
                </Field>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field label="Deuda">
                  <Segmented
                    ariaLabel="Condición de deuda"
                    value={filtro.deuda ?? "todos"}
                    onChange={(v) => set("deuda", v === "todos" ? undefined : v)}
                    options={[
                      { value: "todos", label: "No importa" },
                      { value: "con", label: "Con deuda" },
                      { value: "sin", label: "Al día" },
                    ]}
                  />
                </Field>
                {filtro.deuda === "con" && (
                  <Field label="Deuda mínima" hint="Por debajo suele ser un resto de redondeo.">
                    <Input
                      type="number" min={0} step={1000} value={filtro.deudaMin ?? 0}
                      onChange={(e) => set("deudaMin", Math.max(0, Number(e.target.value) || 0))}
                      className="sm:w-40"
                    />
                  </Field>
                )}
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-border-subtle p-3">
                <Casilla
                  checked={filtro.soloMoviles} onChange={(v) => set("soloMoviles", v)}
                  label="Solo celulares"
                  hint="A un teléfono fijo WhatsApp no llega: el envío sale fallido y gasta tiempo de la campaña."
                />
                <Casilla
                  checked={filtro.omitirEnAtencion} onChange={(v) => set("omitirEnAtencion", v)}
                  label="Saltar a quien está hablando con una persona"
                  hint="Si el cliente espera respuesta en la bandeja, un mensaje masivo en medio confunde."
                />
              </div>

              {preview && preview.muestra.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-text-tertiary">Algunos de los que lo recibirán</h3>
                  <PagedTable
                    rows={preview.muestra}
                    empty="—"
                    columns={[
                      { key: "n", header: "Cliente", render: (m) => <span className="text-text-primary">{m.nombre}</span> },
                      { key: "a", header: "Abonado", render: (m) => m.abonado ?? "—" },
                      { key: "t", header: "Celular", render: (m) => <span className="font-mono text-[12px]">{m.telefono}</span> },
                      { key: "d", header: "Deuda", align: "right" as const, render: (m) => (m.deuda ? cop(m.deuda) : "—") },
                    ]}
                  />
                </div>
              )}
            </div>
          )}

          {paso === 2 && (
            <div className="flex flex-col gap-3">
              <Input value={buscarPlantilla} onChange={(e) => setBuscarPlantilla(e.target.value)} placeholder="Buscar plantilla por nombre o texto…" />
              {plantillas.length === 0 ? (
                <p className="text-[13px] text-text-secondary">
                  No hay plantillas aprobadas por Meta. Revísalas en{" "}
                  <Link href="/configuracion/whatsapp/plantillas" className="text-brand hover:underline">Plantillas</Link>.
                </p>
              ) : (
                <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto pr-1">
                  {plantillasVisibles.map((t) => {
                    const elegida = t.name === templateName;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => setTemplateName(t.name)}
                          className={`w-full rounded-xl border p-3 text-left transition-colors ${
                            elegida ? "border-brand bg-brand-soft" : "border-border-subtle hover:bg-surface-2"
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-text-primary">{nombrePlantilla(t.name)}</span>
                            {t.category && (
                              <Badge label={t.category === "MARKETING" ? "Marketing" : "Utilidad"} tone={t.category === "MARKETING" ? "warning" : "info"} />
                            )}
                            {elegida && <Icon name="check" size={14} className="ml-auto text-brand" />}
                          </div>
                          <p className="mt-1 line-clamp-2 text-[12px] text-text-secondary">{t.bodyText}</p>
                        </button>
                      </li>
                    );
                  })}
                  {plantillasVisibles.length === 0 && <li className="text-[13px] text-text-tertiary">Ninguna plantilla coincide.</li>}
                </ul>
              )}
            </div>
          )}

          {paso === 3 && plantilla && preview && (
            <div className="flex flex-col gap-4">
              <Field label="Nombre de la campaña" required hint="Para encontrarla después en el reporte.">
                <Input value={nombre} onChange={(e) => setNombre(e.target.value)} />
              </Field>

              <dl className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
                <div className="rounded-lg border border-border-subtle p-3">
                  <dt className="text-[12px] text-text-tertiary">Destinatarios</dt>
                  <dd className="text-[18px] font-bold tabular-nums text-text-primary">{num(preview.destinatarios)}</dd>
                </div>
                <div className="rounded-lg border border-border-subtle p-3">
                  <dt className="text-[12px] text-text-tertiary">Plantilla</dt>
                  <dd className="font-medium text-text-primary">{nombrePlantilla(plantilla.name)}</dd>
                </div>
              </dl>

              {preview.reparto.dias > 1 || preview.reparto.hoy < preview.destinatarios ? (
                <div className="flex gap-2 rounded-lg border border-warning-subtle bg-warning-soft px-3 py-2 text-[13px] text-warning-text">
                  <Icon name="calendar-days" size={15} className="mt-0.5 shrink-0" />
                  <span>
                    El límite de hoy no alcanza para todos: ahora salen <b>{num(preview.reparto.hoy)}</b> y el resto sigue solo
                    a medida que se libera cupo, en unos <b>{preview.reparto.dias}</b> días. No hay que volver a lanzarla.
                  </span>
                </div>
              ) : (
                <div className="flex gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] text-text-secondary">
                  <Icon name="gauge" size={15} className="mt-0.5 shrink-0" />
                  <span>Cabe en el cupo de hoy: quedan {num(preview.cupo.disponibles)} de {num(preview.cupo.limite)}.</span>
                </div>
              )}

              {esMarketing && (
                <div className="flex gap-2 rounded-lg border border-warning-subtle bg-warning-soft px-3 py-2 text-[13px] text-warning-text">
                  <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0" />
                  <span>Es de <b>marketing</b>: Meta la cobra más cara y puede no entregarla a quien ya recibió muchas promociones. Para cobros y avisos usa plantillas de utilidad.</span>
                </div>
              )}

              <div className="rounded-xl border border-border-subtle p-3">
                <h3 className="text-[13px] font-semibold text-text-primary">Envíate una prueba primero</h3>
                <p className="mt-0.5 text-[12px] text-text-tertiary">
                  Te llega el mensaje con los datos de {preview.ejemplo?.nombre ?? "un cliente de la lista"}, tal como lo verá.
                </p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <Input value={telPrueba} onChange={(e) => setTelPrueba(e.target.value)} placeholder="Tu celular (3001234567)" inputMode="tel" className="sm:max-w-xs" />
                  <Button variant="secondary" onClick={enviarPrueba} disabled={probando}>
                    <Icon name="flask-conical" size={14} /> {probando ? "Enviando…" : "Enviar prueba"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {aviso && (
            <p className="mt-3 flex items-center gap-1.5 text-[13px] text-error-text"><Icon name="alert-triangle" size={14} /> {aviso}</p>
          )}

          <div className="mt-4 flex flex-col-reverse gap-2 border-t border-border-subtle pt-4 sm:flex-row sm:justify-between">
            <Button variant="ghost" onClick={() => { setAviso(null); setPaso((p) => (p > 1 ? ((p - 1) as Paso) : p)); }} disabled={paso === 1}>
              <Icon name="chevron-left" size={14} /> Atrás
            </Button>
            {paso < 3 ? (
              <Button onClick={siguiente}>Siguiente <Icon name="chevron-right" size={14} /></Button>
            ) : (
              <Button
                onClick={() => {
                  if (!nombre.trim()) return setAviso("Ponle un nombre a la campaña.");
                  setAviso(null); setConfirmar(true);
                }}
              >
                <Icon name="send" size={14} /> Enviar a {num(preview?.destinatarios ?? 0)} clientes
              </Button>
            )}
          </div>
        </div>

        {/* En celular el conteo va ARRIBA: es la respuesta a cada filtro que se toca,
            y abajo quedaba fuera de la pantalla. */}
        <aside className="-order-1 flex min-w-0 flex-col gap-3 lg:order-none">
          <Resumen preview={preview} cargando={cargando} />
          {paso >= 2 && (
            preview?.ejemplo ? (
              <div>
                <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                  Así le llega a {preview.ejemplo.nombre}
                </span>
                <Burbuja cabecera={preview.ejemplo.cabecera} cuerpo={preview.ejemplo.cuerpo} />
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-border-subtle p-4 text-center text-[12px] text-text-tertiary">
                Elige una plantilla para ver el mensaje.
              </p>
            )
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={confirmar}
        tone="primary"
        icon="send"
        title="Enviar campaña"
        busy={lanzando}
        confirmLabel={`Enviar a ${num(preview?.destinatarios ?? 0)}`}
        message={
          <>
            Se enviará <b>{plantilla ? nombrePlantilla(plantilla.name) : ""}</b> a <b>{num(preview?.destinatarios ?? 0)}</b> clientes.
            Los mensajes enviados no se pueden recoger.
          </>
        }
        requireText={pedirTexto ? "ENVIAR" : undefined}
        requireHint={pedirTexto ? "Escribe ENVIAR para confirmar." : undefined}
        onConfirm={lanzar}
        onClose={() => setConfirmar(false)}
      />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Página
// ─────────────────────────────────────────────────────────────────────────────

function ListaCampanas({ campaigns, onVer }: { campaigns: WaCampaign[]; onVer: (id: string) => void }) {
  const [buscar, setBuscar] = useState("");
  const visibles = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    if (!q) return campaigns;
    return campaigns.filter((c) => [c.name, c.templateName].some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [campaigns, buscar]);

  return (
    <section className="mt-4">
      <ListToolbar search={buscar} onSearch={setBuscar} searchPlaceholder="Buscar campaña o plantilla…" />
      <PagedTable
        rows={visibles}
        empty={buscar ? "Ninguna campaña coincide con la búsqueda." : "No hay campañas todavía."}
        columns={[
          { key: "name", header: "Campaña", render: (c: WaCampaign) => (
            <button type="button" onClick={() => onVer(c.id)} className="text-left font-medium text-text-primary hover:underline">{c.name}</button>
          ) },
          { key: "tpl", header: "Plantilla", render: (c: WaCampaign) => <span className="text-[12px] text-text-secondary">{nombrePlantilla(c.templateName)}</span> },
          { key: "avance", header: "Avance", render: (c: WaCampaign) => {
            const pct = c.total ? Math.round(((c.sent + c.failed) / c.total) * 100) : 0;
            return (
              <div className="min-w-[7rem]">
                <div className="text-[12px] tabular-nums text-text-secondary">{num(c.sent + c.failed)} / {num(c.total)}</div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-brand" style={{ width: `${pct}%` }} /></div>
              </div>
            );
          } },
          { key: "deliv", header: "Entregados", align: "right" as const, render: (c: WaCampaign) => num(c.delivered) },
          { key: "read", header: "Leídos", align: "right" as const, render: (c: WaCampaign) => num(c.read) },
          { key: "fail", header: "Fallidos", align: "right" as const, render: (c: WaCampaign) => c.failed ? <span className="text-error-text">{num(c.failed)}</span> : 0 },
          { key: "st", header: "Estado", render: (c: WaCampaign) => {
            const st = WA_CAMPAIGN_STATUS[c.status];
            return <Badge label={st?.label ?? c.status} tone={st?.tone ?? "default"} />;
          } },
          { key: "date", header: "Fecha", render: (c: WaCampaign) => fmt(c.createdAt) },
          { key: "acc", header: "", align: "right" as const, render: (c: WaCampaign) => (
            <button type="button" onClick={() => onVer(c.id)} className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-brand hover:underline"><Icon name="eye" size={13} /> Ver</button>
          ) },
        ]}
      />
    </section>
  );
}

export default function MensajesMasivosPage() {
  const { loading: authLoading, authFetch, can } = useAuth();
  const puede = can(PERM.WHATSAPP_MANAGE);
  const [vista, setVista] = useState<Vista>("nueva");
  const [health, setHealth] = useState<WaHealth | null>(null);
  const [campaigns, setCampaigns] = useState<WaCampaign[]>([]);
  const [report, setReport] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const [c, h] = await Promise.all([
      authFetch("/admin/whatsapp/campaigns?pageSize=50").then((r) => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] })),
      authFetch("/admin/whatsapp/health").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    setCampaigns(c.items ?? []);
    setHealth(h);
  }, [authFetch]);
  useEffect(() => { if (!authLoading && puede) void cargar(); }, [authLoading, puede, cargar]);

  // Mientras haya campañas enviando o esperando cupo, el avance se refresca solo.
  const activas = campaigns.some((c) => c.status === "running" || c.status === "waiting");
  useEffect(() => {
    if (!activas) return;
    const t = setInterval(() => void cargar(), 15_000);
    return () => clearInterval(t);
  }, [activas, cargar]);

  if (authLoading) return <PageSkeleton />;
  if (!puede) {
    return (
      <>
        <PageHeading icon="send" title="Mensajes masivos" />
        <p className="mt-4 text-[13px] text-text-secondary">Lanzar campañas de WhatsApp requiere el permiso de administrar el canal.</p>
      </>
    );
  }

  const enCurso = campaigns.filter((c) => c.status === "running" || c.status === "waiting").length;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <PageHeading icon="send" title="Mensajes masivos" subtitle="Campañas de WhatsApp con plantilla aprobada, tope diario y reporte de entregas" />
        <Segmented
          ariaLabel="Vista"
          value={vista}
          onChange={setVista}
          options={[
            { value: "nueva", label: "Nueva campaña" },
            { value: "campanas", label: enCurso ? `Campañas (${enCurso} en curso)` : "Campañas" },
          ]}
        />
      </div>

      <HealthPanel health={health} />

      {vista === "nueva"
        ? <NuevaCampana onLanzada={() => { setVista("campanas"); setTimeout(() => void cargar(), 800); }} />
        : <ListaCampanas campaigns={campaigns} onVer={setReport} />}

      <ReportModal campaignId={report} onClose={() => setReport(null)} />
    </>
  );
}
