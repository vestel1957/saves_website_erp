"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { PagedTable } from "@/components/ui/PagedTable";
import { Modal } from "@/components/Modal";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import dynamic from "next/dynamic";
import { Dropdown, MenuItem } from "@/components/ui/Dropdown";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import {
  SUB_STATUS_LABEL, SUB_STATUS_TONE, INVOICE_KIND_LABEL, INVOICE_RON_LABEL, INVOICE_RON_TONE,
  INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, cop,
  waLink, initials, antiguedad, STATUS_AVATAR_CLASS,
} from "@/lib/subscribers";
import { TICKET_STATUS_LABEL, TICKET_STATUS_TONE } from "@/lib/support";
import { SERVICE_KIND_LABEL } from "@/lib/plans";

// Modales cargados bajo demanda: su JS NO entra en el chunk inicial de la
// página (la más pesada de la app); se descarga al abrirlos por primera vez.
const RegistrarPagoModal = dynamic(() => import("@/components/cobranzas/RegistrarPagoModal").then((m) => m.RegistrarPagoModal), { ssr: false });
const MikrotikModal = dynamic(() => import("@/components/network/MikrotikModal").then((m) => m.MikrotikModal), { ssr: false });
const ClienteWizardModal = dynamic(() => import("@/components/subscribers/ClienteWizardModal").then((m) => m.ClienteWizardModal), { ssr: false });
const EditarFacturaModal = dynamic(() => import("@/components/subscribers/EditarFacturaModal").then((m) => m.EditarFacturaModal), { ssr: false });
const CambiarPlanModal = dynamic(() => import("@/components/subscribers/CambiarPlanModal").then((m) => m.CambiarPlanModal), { ssr: false });
const NuevaOrdenModal = dynamic(() => import("@/components/soporte/NuevaOrdenModal").then((m) => m.NuevaOrdenModal), { ssr: false });

type Detail = any;

/** Icono por tipo de servicio (para los chips de la cabecera). */
const SERVICE_KIND_ICON: Record<string, string> = {
  INTERNET: "wifi", TV: "tv", PUNTOS: "tv", STREAMING: "play",
};

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("es-CO") : "—");

const fmtBytes = (n: number) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

const fileIcon = (mime: string) => {
  if (mime?.includes("sheet") || mime?.includes("excel") || mime?.includes("csv")) return "file-spreadsheet";
  return "file-text";
};

/* ── Piezas UI locales ─────────────────────────────────────────── */

function Card({ title, icon, action, children }: { title: string; icon: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Icon name={icon} size={15} className="text-brand" />
          {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border-subtle py-1.5 last:border-0">
      <span className="text-[12px] text-text-tertiary">{label}</span>
      <span className="text-right text-[12px] font-medium text-text-primary">{value ?? "—"}</span>
    </div>
  );
}

/** Botón de copiar al portapapeles con feedback breve. */
function CopyBtn({ text }: { text?: string | null }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      title="Copiar"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="shrink-0 text-text-tertiary transition-colors hover:text-text-secondary"
    >
      <Icon name={done ? "check" : "copy"} size={13} className={done ? "text-success-text" : ""} />
    </button>
  );
}

/** Fila de contacto accionable: se oculta si no hay valor. */
function ContactRow({ icon, value, href, copy }: { icon: string; value?: string | null; href?: string | null; copy?: boolean }) {
  if (!value) return null;
  const content = href ? (
    <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="truncate text-text-primary hover:text-brand hover:underline">
      {value}
    </a>
  ) : (
    <span className="truncate text-text-primary">{value}</span>
  );
  return (
    <div className="flex items-center gap-2.5 border-b border-border-subtle py-2 text-[13px] last:border-0">
      <Icon name={icon} size={14} className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1">{content}</span>
      {copy && <CopyBtn text={value} />}
    </div>
  );
}

/** Botón-ícono para acciones rápidas del encabezado. */
function QuickAction({ icon, label, href, tone }: { icon: string; label: string; href?: string | null; tone?: "wa" }) {
  const disabled = !href;
  const base = "inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors";
  const cls = disabled
    ? `${base} border-border-subtle text-text-tertiary opacity-40`
    : tone === "wa"
      ? `${base} border-success-soft bg-success-soft text-success-text hover:brightness-95`
      : `${base} border-border-default text-text-secondary hover:bg-surface-2`;
  if (disabled) return <span title={`${label} no disponible`} className={cls}><Icon name={icon} size={16} /></span>;
  return (
    <a href={href!} target="_blank" rel="noreferrer" title={label} className={cls}>
      <Icon name={icon} size={16} />
    </a>
  );
}

/** Botón de acción con relleno de color suave (para la columna Acciones). */
const ACTION_TONES: Record<string, string> = {
  neutral: "bg-surface-2 text-text-secondary hover:brightness-95",
  success: "bg-success-soft text-success-text hover:brightness-95",
  info: "bg-info-soft text-info-text hover:brightness-95",
  warning: "bg-warning-soft text-warning-text hover:brightness-95",
  brand: "bg-brand-soft text-brand hover:brightness-95",
  error: "bg-error-soft text-error-text hover:brightness-95",
};
function ActionBtn({ icon, title, tone = "neutral", onClick }: { icon: string; title: string; tone?: keyof typeof ACTION_TONES; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition ${ACTION_TONES[tone]}`}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

/** Celda de la franja de indicadores del encabezado. */
function StatCell({ label, tone, children }: { label: string; tone?: "error" | "success" | "default"; children: React.ReactNode }) {
  const valueCls = tone === "error" ? "text-error-text" : tone === "success" ? "text-success-text" : "text-text-primary";
  return (
    <div className="bg-surface px-4 py-2.5">
      <div className="mb-0.5 text-[11px] uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className={valueCls}>{children}</div>
    </div>
  );
}

/* ── Página ────────────────────────────────────────────────────── */

export default function ClienteDetallePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();
  const [c, setC] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [mkOpen, setMkOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [ordenOpen, setOrdenOpen] = useState(false);
  const [tab, setTab] = useState<"resumen" | "facturas" | "cuenta" | "ordenes" | "equipos" | "historial" | "archivos">("resumen");
  const [files, setFiles] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [statement, setStatement] = useState<any | null>(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [editInvoice, setEditInvoice] = useState<any | null>(null);
  const [infoModal, setInfoModal] = useState<{ type: "promo" | "siigo"; inv: any } | null>(null);
  const [invoices, setInvoices] = useState<any[] | null>(null);

  const reload = useCallback(() => {
    void authFetch(`/subscribers/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("No encontrado"))))
      .then(setC)
      .catch((e) => setErr(e.message));
  }, [authFetch, id]);

  const loadFiles = useCallback(() => {
    void authFetch(`/subscribers/${id}/files`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setFiles)
      .catch(() => {});
  }, [authFetch, id]);

  const loadStatement = useCallback(() => {
    void authFetch(`/subscribers/${id}/statement`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setStatement)
      .catch(() => {});
  }, [authFetch, id]);

  const loadInvoices = useCallback(() => {
    void authFetch(`/subscribers/${id}/invoices`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setInvoices)
      .catch(() => {});
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading) return;
    reload();
    loadFiles();
  }, [authLoading, reload, loadFiles]);

  // Carga perezosa por pestaña (estado de cuenta / todas las facturas).
  useEffect(() => {
    if (tab === "cuenta" && !statement) loadStatement();
    if (tab === "facturas" && !invoices) loadInvoices();
  }, [tab, statement, invoices, loadStatement, loadInvoices]);

  async function addNote() {
    const body = noteText.trim();
    if (!body) return;
    setSavingNote(true);
    try {
      const res = await authFetch(`/subscribers/${id}/notes`, { method: "POST", body: JSON.stringify({ body }) });
      if (!res.ok) throw new Error();
      setNoteText("");
      reload();
    } catch {
      toast("No se pudo guardar la nota", "alert-circle");
    } finally {
      setSavingNote(false);
    }
  }

  async function deleteNote(nid: string) {
    if (!confirm("¿Eliminar esta nota?")) return;
    try {
      const res = await authFetch(`/subscribers/${id}/notes/${nid}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      reload();
    } catch {
      toast("No se pudo eliminar", "alert-circle");
    }
  }

  async function openPdf(path: string) {
    try {
      const res = await authFetch(path);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast("No se pudo generar el PDF", "alert-circle");
    }
  }

  function openEditInvoice(inv: any) {
    setEditInvoice(inv);
  }

  async function deleteInvoice(inv: any) {
    if (!confirm(`¿Eliminar la factura #${inv.tid}? Esta acción no se puede deshacer.`)) return;
    try {
      const res = await authFetch(`/subscribers/${id}/invoices/${inv.id}`, { method: "DELETE" });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(m?.message ?? "No se pudo eliminar");
      }
      toast(`Factura #${inv.tid} eliminada`);
      setStatement(null);
      setInvoices(null);
      reload();
    } catch (e: any) {
      toast(e.message ?? "No se pudo eliminar", "alert-circle");
    }
  }

  async function uploadFile(file: File) {
    if (file.size > 20 * 1024 * 1024) {
      toast("El archivo supera el máximo de 20 MB", "alert-circle");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetch(`/subscribers/${id}/files`, { method: "POST", body: fd });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(m?.message ?? "No se pudo subir");
      }
      toast("Archivo subido");
      loadFiles();
    } catch (e: any) {
      toast(e.message ?? "Error al subir", "alert-circle");
    } finally {
      setUploading(false);
    }
  }

  async function downloadFile(f: any) {
    try {
      const res = await authFetch(`/subscribers/${id}/files/${f.id}/download`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast("No se pudo descargar", "alert-circle");
    }
  }

  async function previewFile(f: any) {
    try {
      const res = await authFetch(`/subscribers/${id}/files/${f.id}/download`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      // Forzamos el tipo real para que el navegador lo renderice inline.
      const url = URL.createObjectURL(new Blob([blob], { type: f.mimeType }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast("No se pudo abrir la vista previa", "alert-circle");
    }
  }

  async function deleteFile(f: any) {
    if (!confirm(`¿Eliminar "${f.name}"?`)) return;
    try {
      const res = await authFetch(`/subscribers/${id}/files/${f.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast("Archivo eliminado");
      loadFiles();
    } catch {
      toast("No se pudo eliminar", "alert-circle");
    }
  }

  if (authLoading || (!c && !err)) return <PageSkeleton />;
  if (err)
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">
        Cliente no encontrado. <Link href="/clientes" className="text-brand">Volver</Link>
      </div>
    );

  const tone = SUB_STATUS_TONE[c.status ?? ""] ?? "default";
  const wa = waLink(c.phone1) ?? waLink(c.phone2);
  const tel = c.phone1 ? `tel:${c.phone1}` : c.phone2 ? `tel:${c.phone2}` : null;
  const mail = c.email ? `mailto:${c.email}` : null;
  const map = c.gps ? `https://www.google.com/maps/search/?api=1&query=${c.gps.lat},${c.gps.lng}` : null;

  const anti = antiguedad(c.entryDate);

  const TABS: { key: typeof tab; label: string; icon: string; count?: number }[] = [
    { key: "resumen", label: "Resumen", icon: "user" },
    { key: "facturas", label: "Facturas", icon: "receipt", count: invoices?.length ?? c.invoices?.length ?? 0 },
    { key: "cuenta", label: "Estado de cuenta", icon: "scroll-text" },
    { key: "ordenes", label: "Órdenes", icon: "wrench", count: c.workOrders?.length ?? 0 },
    { key: "equipos", label: "Equipos", icon: "package-check", count: c.equipment?.length ?? 0 },
    { key: "historial", label: "Historial", icon: "history", count: c.statusHistory?.length ?? 0 },
    { key: "archivos", label: "Archivos", icon: "folder", count: files.length },
  ];

  return (
    <>
      <Link href="/clientes" className="mb-2 inline-flex items-center gap-1 text-[12px] text-text-tertiary hover:text-text-secondary">
        <Icon name="arrow-left" size={13} /> Clientes
      </Link>

      {/* Pestañas */}
      <div className="mb-4 flex shrink-0 flex-wrap gap-1 border-b border-border-subtle">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-[13px] font-semibold transition-colors ${
              tab === t.key ? "border-brand text-text-primary" : "border-transparent text-text-tertiary hover:text-text-secondary"
            }`}
          >
            <Icon name={t.icon} size={14} className={tab === t.key ? "text-brand" : ""} />
            {t.label}
            {t.count != null && (
              <span className={`rounded-full px-1.5 text-[10px] ${tab === t.key ? "bg-brand-soft text-brand" : "bg-surface-2 text-text-tertiary"}`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Encabezado — solo visible en Resumen */}
      {tab === "resumen" && (
      <div className="mb-4 shrink-0 overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-sm">
        {/* Fila 1: identidad + acciones */}
        <div className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[17px] font-bold ${STATUS_AVATAR_CLASS[tone]}`}>
              {initials(c.name)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-[19px] font-bold text-text-primary">{c.name}</h1>
                <Badge label={SUB_STATUS_LABEL[c.status ?? ""] ?? c.status ?? "—"} tone={tone} />
              </div>
              <p className="truncate text-[12px] text-text-tertiary">
                {c.companyName && <span className="text-text-secondary">{c.companyName} · </span>}
                Abonado <span className="font-mono font-semibold text-text-secondary">{c.abonado}</span>
                {c.docNumber && <> · {c.docType} {c.docNumber}</>}
                {c.branch && <> · {c.branch}</>}
              </p>
              {/* Servicios contratados: Internet, TV, etc. (cada uno con su plan) */}
              {c.services?.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {c.services.map((s: any) => (
                    <span
                      key={s.kind}
                      title={s.price ? `${SERVICE_KIND_LABEL[s.kind as keyof typeof SERVICE_KIND_LABEL] ?? s.kind}: ${s.planName ?? "—"} · ${cop(s.price)}/mes` : undefined}
                      className={`inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface-2 px-2 py-0.5 text-[11px] ${s.status && s.status !== "ACTIVO" ? "opacity-60" : ""}`}
                    >
                      <Icon name={SERVICE_KIND_ICON[s.kind] ?? "package"} size={12} className="text-text-tertiary" />
                      <span className="font-semibold text-text-secondary">{SERVICE_KIND_LABEL[s.kind as keyof typeof SERVICE_KIND_LABEL] ?? s.kind}</span>
                      <span className="text-text-tertiary">·</span>
                      <span className="text-text-secondary">{s.planName || "sin plan"}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <QuickAction icon="message-circle" label="WhatsApp" href={wa} tone="wa" />
            <QuickAction icon="phone" label="Llamar" href={tel} />
            <QuickAction icon="mail" label="Correo" href={mail} />
            <QuickAction icon="map-pin" label="Ver en mapa" href={map} />
            <Button onClick={() => setPayOpen(true)}>
              <Icon name="dollar-sign" size={15} /> Registrar pago
            </Button>
            <Dropdown
              align="right"
              width={220}
              trigger={
                <span className="flex h-9 items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-3 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
                  <Icon name="ellipsis" size={16} /> Acciones
                </span>
              }
            >
              {({ close }) => (
                <>
                  <MenuItem onClick={() => { close(); setMkOpen(true); }}>
                    <Icon name="wifi" size={15} /> Conexión
                  </MenuItem>
                  <MenuItem onClick={() => { close(); setPlanOpen(true); }}>
                    <Icon name="gauge" size={15} /> Cambiar plan
                  </MenuItem>
                  <MenuItem onClick={() => { close(); setOrdenOpen(true); }}>
                    <Icon name="wrench" size={15} /> Nueva orden
                  </MenuItem>
                  <MenuItem onClick={() => { close(); setEditOpen(true); }}>
                    <Icon name="pencil" size={15} /> Editar
                  </MenuItem>
                </>
              )}
            </Dropdown>
          </div>
        </div>

        {/* Fila 2: franja de indicadores */}
        <div className="grid grid-cols-2 gap-px border-t border-border-subtle bg-border-subtle sm:grid-cols-4">
          <StatCell label="Cartera" tone={c.receivable > 0 ? "error" : "success"}>
            <span className="text-[17px] font-bold">{cop(c.receivable)}</span>
            <span className="ml-1.5 text-[11px] font-normal text-text-tertiary">{c.dueInvoices} pend.</span>
          </StatCell>
          <StatCell label="Saldo a favor" tone={c.balance > 0 ? "success" : "default"}>
            <span className="text-[17px] font-bold">{cop(c.balance)}</span>
          </StatCell>
          <StatCell label="Estado">
            <Badge label={SUB_STATUS_LABEL[c.status ?? ""] ?? c.status ?? "—"} tone={tone} />
            {c.statusChangedAt && (
              <span className="block text-[11px] text-text-tertiary">
                desde {fmtDate(c.statusChangedAt)}
                {c.previousStatus && <> · antes {SUB_STATUS_LABEL[c.previousStatus] ?? c.previousStatus}</>}
              </span>
            )}
          </StatCell>
          <StatCell label="Cliente desde">
            <span className="text-[14px] font-semibold text-text-primary">{fmtDate(c.entryDate)}</span>
            {anti && <span className="block text-[11px] text-text-tertiary">{anti}</span>}
          </StatCell>
        </div>
      </div>
      )}

      {payOpen && <RegistrarPagoModal subscriberId={id} open={payOpen} onClose={() => setPayOpen(false)} onDone={reload} />}
      {mkOpen && <MikrotikModal subscriberId={id} subscriberName={c.name} open={mkOpen} onClose={() => setMkOpen(false)} onDone={reload} />}
      {planOpen && (
        <CambiarPlanModal
          subscriberId={id}
          services={c.services ?? []}
          open={planOpen}
          onClose={() => setPlanOpen(false)}
          onDone={reload}
        />
      )}
      {editOpen && (
        <ClienteWizardModal
          mode="edit"
          subscriberId={id}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onDone={() => { setInvoices(null); setStatement(null); reload(); }}
        />
      )}
      {ordenOpen && (
        <NuevaOrdenModal
          open={ordenOpen}
          onClose={() => setOrdenOpen(false)}
          onDone={reload}
          fixedSub={{ id, name: c.name, abonado: c.abonado }}
        />
      )}
      {!!editInvoice && (
        <EditarFacturaModal
          subscriberId={id}
          invoice={editInvoice}
          open={!!editInvoice}
          onClose={() => setEditInvoice(null)}
          onDone={() => { setStatement(null); setInvoices(null); reload(); }}
        />
      )}

      {/* Modal de info: Promociones / Factura electrónica (Siigo) */}
      {infoModal && (
        <Modal
          open
          onClose={() => setInfoModal(null)}
          title={infoModal.type === "promo" ? `Promociones · Factura #${infoModal.inv.tid}` : `Factura electrónica · #${infoModal.inv.tid}`}
        >
          {infoModal.type === "promo" ? (
            infoModal.inv.promo?.has ? (
              <div>
                {infoModal.inv.promo.p1 ? (
                  <Row label="Promoción 1" value={`${infoModal.inv.promo.p1} mes(es)${infoModal.inv.promo.date1 ? ` · desde ${fmtDate(infoModal.inv.promo.date1)}` : ""}`} />
                ) : null}
                {infoModal.inv.promo.p2 ? (
                  <Row label="Promoción 2" value={`${infoModal.inv.promo.p2} mes(es)${infoModal.inv.promo.date2 ? ` · desde ${fmtDate(infoModal.inv.promo.date2)}` : ""}`} />
                ) : null}
              </div>
            ) : (
              <p className="py-2 text-[13px] text-text-tertiary">Esta factura no tiene promociones aplicadas.</p>
            )
          ) : (
            <div className="flex flex-col gap-1">
              <Row
                label="Estado e-factura"
                value={
                  <Badge
                    label={infoModal.inv.eInvoice?.created ? "Creada" : infoModal.inv.eInvoice?.flag ? "Por crear" : "Sin e-factura"}
                    tone={infoModal.inv.eInvoice?.created ? "success" : infoModal.inv.eInvoice?.flag ? "warning" : "default"}
                  />
                }
              />
              {infoModal.inv.eInvoice?.dian && <Row label="N° DIAN" value={infoModal.inv.eInvoice.dian} />}
              {infoModal.inv.eInvoice?.cufe && <Row label="CUFE" value={<span className="break-all font-mono text-[10px]">{infoModal.inv.eInvoice.cufe}</span>} />}
              {infoModal.inv.eInvoice?.date && <Row label="Fecha" value={fmtDate(infoModal.inv.eInvoice.date)} />}
              {infoModal.inv.eInvoice?.services && <Row label="Servicios" value={infoModal.inv.eInvoice.services} />}
              {infoModal.inv.eInvoice?.pdfUrl ? (
                <a href={infoModal.inv.eInvoice.pdfUrl} target="_blank" rel="noreferrer" className="mt-2 self-start">
                  <Button variant="secondary"><Icon name="cloud" size={15} /> Ver PDF DIAN</Button>
                </a>
              ) : !infoModal.inv.eInvoice?.flag ? (
                <p className="mt-1 text-[12px] text-text-tertiary">Esta factura no está marcada para facturación electrónica.</p>
              ) : null}
            </div>
          )}
        </Modal>
      )}

      {/* ── Resumen ── */}
      {tab === "resumen" && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <Card title="Contacto" icon="user">
              <ContactRow icon="phone" value={c.phone1} href={c.phone1 ? `tel:${c.phone1}` : null} copy />
              <ContactRow icon="phone" value={c.phone2} href={c.phone2 ? `tel:${c.phone2}` : null} copy />
              <ContactRow icon="mail" value={c.email} href={mail} copy />
              <ContactRow icon="map-pin" value={[c.addressLine, c.neighborhood].filter(Boolean).join(" · ") || null} href={map} />
              <ContactRow icon="cake" value={c.birthDate ? fmtDate(c.birthDate) : null} />
              {c.estrato != null && <Row label="Estrato" value={c.estrato} />}
              {!c.phone1 && !c.phone2 && !c.email && !c.addressLine && (
                <p className="py-1 text-[12px] text-text-tertiary">Sin datos de contacto.</p>
              )}
            </Card>

            <Card title="Red / Conexión" icon="activity">
              <Row label="Usuario PPPoE" value={c.network?.pppUsername} />
              <Row label="Perfil / Plan" value={c.network?.pppProfile} />
              <Row label="IP remota" value={c.network?.ipRemote} />
              <Row label="MAC equipo" value={c.network?.macEquipo} />
              <Row label="MAC ONT" value={c.network?.macOnt} />
              <Row label="Tecnología" value={c.network?.installTech} />
            </Card>

            <Card title="Contrato / Facturación" icon="file-text">
              <Row label="Suscripción" value={c.suscripcion} />
              <Row label="Fecha contrato" value={fmtDate(c.contractDate)} />
              <Row label="Fecha ingreso" value={fmtDate(c.entryDate)} />
              <Row label="Débito acumulado" value={cop(c.debit)} />
              <Row label="Crédito acumulado" value={cop(c.credit)} />
              <Row
                label="Factura electrónica"
                value={
                  c.eInvoice?.enabled ? (
                    <span className="flex flex-wrap justify-end gap-1">
                      {c.eInvoice.tv && <Badge label="TV" tone="info" />}
                      {c.eInvoice.internet && <Badge label="Internet" tone="info" />}
                      {c.eInvoice.puntos && <Badge label="Puntos" tone="info" />}
                      {!c.eInvoice.tv && !c.eInvoice.internet && !c.eInvoice.puntos && <Badge label="Activa" tone="success" />}
                    </span>
                  ) : (
                    <Badge label="No" tone="default" />
                  )
                }
              />
            </Card>
          </div>

          {/* Notas */}
          <Card title={`Notas${c.notes?.length ? ` · ${c.notes.length}` : ""}`} icon="message-square">
            <div className="mb-3 flex gap-2">
              <Textarea
                rows={2}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Escribe una observación sobre el cliente…"
                className="flex-1"
              />
              <Button onClick={() => void addNote()} disabled={savingNote || !noteText.trim()} className="self-end">
                <Icon name={savingNote ? "loader" : "plus"} size={15} className={savingNote ? "animate-spin" : ""} /> Agregar
              </Button>
            </div>
            {c.notes?.length ? (
              <ul className="flex flex-col divide-y divide-border-subtle">
                {c.notes.map((n: any) => (
                  <li key={n.id} className="group flex items-start gap-2 py-2">
                    <Icon name="corner-down-left" size={13} className="mt-0.5 shrink-0 rotate-180 text-text-tertiary" />
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap text-[12px] text-text-primary">{n.body}</p>
                      <p className="text-[10px] text-text-tertiary">{n.author ?? "—"} · {new Date(n.createdAt).toLocaleString("es-CO")}</p>
                    </div>
                    <button type="button" title="Eliminar" onClick={() => void deleteNote(n.id)} className="shrink-0 text-text-tertiary opacity-0 transition-opacity hover:text-error-text group-hover:opacity-100">
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-text-tertiary">Aún no hay notas.</p>
            )}
          </Card>
        </>
      )}

      {/* ── Equipos ── */}
      {tab === "equipos" && (
        <PagedTable
          rows={c.equipment ?? []}
          empty="Sin equipos asignados."
          columns={[
            { key: "code", header: "Código", render: (e: any) => <span className="font-mono font-semibold text-text-secondary">{e.code ?? "—"}</span> },
            { key: "mac", header: "MAC", render: (e: any) => <span className="font-mono text-[12px]">{e.mac || "—"}</span> },
            { key: "serial", header: "Serial", render: (e: any) => <span className="font-mono text-[12px]">{e.serial || "—"}</span> },
            { key: "status", header: "Estado", render: (e: any) => (e.status?.trim() ? <Badge label={e.status.trim()} tone={/bueno|activo/i.test(e.status) ? "success" : "default"} /> : <span className="text-text-tertiary">—</span>) },
            { key: "brand", header: "Marca", render: (e: any) => e.brand || "—" },
            { key: "installType", header: "Tipo instalación", render: (e: any) => e.installType || "—" },
            { key: "vlan", header: "Vlan", align: "right", render: (e: any) => e.vlan ?? "—" },
            { key: "port", header: "Puerto Nat", align: "right", render: (e: any) => e.port ?? "—" },
            { key: "nat", header: "Caja Nat", align: "right", render: (e: any) => e.nat ?? "—" },
            { key: "observation", header: "Observación", render: (e: any) => (e.observation?.trim() ? <span className="text-text-secondary">{e.observation.trim()}</span> : <span className="text-text-tertiary">—</span>) },
          ]}
        />
      )}

      {/* ── Historial de estados ── */}
      {tab === "historial" && (
        <Card title="Historial de estados" icon="history">
          {c.statusHistory?.length ? (
            <ol className="relative flex flex-col gap-3 border-l border-border-default pl-4">
              {c.statusHistory.map((h: any, i: number) => (
                <li key={i} className="relative">
                  <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ${i === 0 ? "bg-brand ring-4 ring-brand-soft" : "bg-border-default"}`} />
                  <div className="flex items-center gap-2">
                    <Badge label={SUB_STATUS_LABEL[h.status] ?? h.status} tone={SUB_STATUS_TONE[h.status] ?? "default"} />
                    <span className="text-[11px] text-text-tertiary">{fmtDate(h.date)}</span>
                  </div>
                  {h.ticket && <span className="text-[10px] text-text-tertiary">Orden #{h.ticket}</span>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[12px] text-text-tertiary">Sin historial de estados.</p>
          )}
        </Card>
      )}

      {/* ── Estado de cuenta ── */}
      {tab === "cuenta" && (
        <div className="flex flex-col gap-4">
          {!statement ? (
            <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center text-[13px] text-text-tertiary">Cargando estado de cuenta…</div>
          ) : (
            <>
              {/* Resumen + acciones */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="grid flex-1 grid-cols-3 gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle">
                  <div className="bg-surface px-4 py-2.5">
                    <div className="text-[11px] uppercase tracking-wide text-text-tertiary">Total facturado</div>
                    <div className="text-[16px] font-bold text-text-primary">{cop(statement.totalCharges)}</div>
                  </div>
                  <div className="bg-surface px-4 py-2.5">
                    <div className="text-[11px] uppercase tracking-wide text-text-tertiary">Total pagado</div>
                    <div className="text-[16px] font-bold text-success-text">{cop(statement.totalPayments)}</div>
                  </div>
                  <div className="bg-surface px-4 py-2.5">
                    <div className="text-[11px] uppercase tracking-wide text-text-tertiary">Saldo actual</div>
                    <div className={`text-[16px] font-bold ${statement.balance > 0 ? "text-error-text" : "text-success-text"}`}>{cop(statement.balance)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge label={statement.pazysalvo ? "A paz y salvo" : "Con saldo pendiente"} tone={statement.pazysalvo ? "success" : "error"} />
                  <Button variant="secondary" onClick={() => void openPdf(`/subscribers/${id}/paz-y-salvo.pdf`)}>
                    <Icon name="shield-check" size={15} /> Paz y salvo
                  </Button>
                  <Button variant="secondary" onClick={() => void openPdf(`/subscribers/${id}/statement.pdf`)}>
                    <Icon name="file-text" size={15} /> Descargar PDF
                  </Button>
                  <Button variant="secondary" onClick={() => void openPdf(`/subscribers/${id}/contract.pdf`)}>
                    <Icon name="file-signature" size={15} /> Contrato
                  </Button>
                </div>
              </div>

              {/* Ledger */}
              <PagedTable
                rows={statement.movements ?? []}
                empty="Sin movimientos."
                columns={[
                  { key: "date", header: "Fecha", render: (m: any) => fmtDate(m.date) },
                  { key: "concept", header: "Concepto", render: (m: any) => (
                    <span className="flex items-center gap-1.5">
                      <Icon name={m.kind === "CARGO" ? "file-text" : "hand-coins"} size={13} className={m.kind === "CARGO" ? "text-text-tertiary" : "text-success-text"} />
                      {m.concept}
                    </span>
                  ) },
                  { key: "debit", header: "Cargo", align: "right", render: (m: any) => (m.debit ? cop(m.debit) : "—") },
                  { key: "credit", header: "Abono", align: "right", render: (m: any) => <span className="text-success-text">{m.credit ? cop(m.credit) : "—"}</span> },
                  { key: "balance", header: "Saldo", align: "right", render: (m: any) => <span className={m.balance > 0 ? "font-semibold text-error-text" : "text-text-tertiary"}>{cop(m.balance)}</span> },
                ]}
              />
            </>
          )}
        </div>
      )}

      {/* ── Facturas ── */}
      {tab === "facturas" && (() => {
        const rows: any[] = invoices ?? c.invoices ?? [];
        const paidN = rows.filter((r) => r.status === "PAID").length;
        const partialN = rows.filter((r) => r.status === "PARTIAL").length;
        const dueN = rows.filter((r) => r.status === "DUE").length;
        const owed = rows.reduce((s, r) => s + (r.status === "CANCELED" ? 0 : Math.max(0, r.balance ?? 0)), 0);
        return (
        <div className="flex flex-col gap-3">
          {/* Resumen de pagos: pagadas (canceladas) · con abono · pendientes */}
          {rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-surface-2/40 px-3 py-2.5">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-success-text">
                <span className="h-2 w-2 rounded-full bg-success-text" /> {paidN} pagadas
              </span>
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-warning-text">
                <span className="h-2 w-2 rounded-full bg-warning-text" /> {partialN} con abono
              </span>
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-error-text">
                <span className="h-2 w-2 rounded-full bg-error-text" /> {dueN} pendientes
              </span>
              {owed > 0 && (
                <span className="ml-auto text-[12px] text-text-secondary">
                  Saldo por cobrar: <span className="font-bold text-error-text">{cop(owed)}</span>
                </span>
              )}
            </div>
          )}
        <PagedTable
          rows={rows}
          empty={invoices ? "Sin facturas." : "Cargando facturas…"}
          columns={[
            { key: "tid", header: "N° Factura", render: (r: any) => <span className="font-mono font-semibold text-text-secondary">{r.tid}</span> },
            { key: "kind", header: "Tipo", render: (r: any) => <span className="text-text-secondary">{INVOICE_KIND_LABEL[r.kind] ?? r.kind ?? "—"}</span> },
            { key: "date", header: "Fecha", render: (r: any) => fmtDate(r.date) },
            { key: "status", header: "Pago", render: (r: any) => (r.status ? <Badge label={INVOICE_STATUS_LABEL[r.status] ?? r.status} tone={INVOICE_STATUS_TONE[r.status] ?? "default"} /> : <span className="text-text-tertiary">—</span>) },
            { key: "ron", header: "Estado cliente", render: (r: any) => (r.ron ? <Badge label={INVOICE_RON_LABEL[r.ron] ?? r.ron} tone={INVOICE_RON_TONE[r.ron] ?? "default"} /> : <span className="text-text-tertiary">—</span>) },
            { key: "total", header: "Total", align: "right", render: (r: any) => (
              <div className="flex flex-col items-end leading-tight">
                <span className="font-medium">{cop(r.total)}</span>
                {r.status === "PARTIAL" && <span className="text-[11px] font-medium text-warning-text">Abonó {cop(r.paid)} · debe {cop(r.balance)}</span>}
                {r.status === "DUE" && <span className="text-[11px] font-medium text-error-text">Debe {cop(r.balance)}</span>}
                {r.status === "PAID" && <span className="text-[11px] text-success-text">Cancelada</span>}
              </div>
            ) },
            {
              key: "acciones", header: "Acciones", align: "right", render: (r: any) => (
                <div className="flex items-center justify-end gap-1">
                  <ActionBtn icon="eye" title="Ver detalle" onClick={() => router.push(`/facturacion/${r.id}`)} />
                  {r.balance > 0 && r.status !== "CANCELED" && (
                    <ActionBtn icon="dollar-sign" title="Registrar pago" tone="success" onClick={() => setPayOpen(true)} />
                  )}
                  <ActionBtn icon="gift" title="Promociones" tone="warning" onClick={() => setInfoModal({ type: "promo", inv: r })} />
                  <ActionBtn icon="cloud" title="Factura electrónica (Siigo)" tone="info" onClick={() => setInfoModal({ type: "siigo", inv: r })} />
                  <ActionBtn icon="pencil" title="Editar factura" tone="brand" onClick={() => openEditInvoice(r)} />
                  <ActionBtn icon="trash" title="Eliminar factura" tone="error" onClick={() => deleteInvoice(r)} />
                </div>
              ),
            },
          ]}
        />
        </div>
        );
      })()}

      {/* ── Órdenes de trabajo ── */}
      {tab === "ordenes" && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          {c.workOrders?.length ? (
            <ol className="relative flex flex-col gap-4 border-l border-border-default pl-5">
              {c.workOrders.map((o: any, i: number) => (
                <li key={o.id ?? i} className="relative">
                  <span className={`absolute -left-[26px] top-1 flex h-4 w-4 items-center justify-center rounded-full ${i === 0 ? "bg-brand-soft ring-4 ring-brand-soft" : "bg-surface-2"}`}>
                    <Icon name="wrench" size={10} className={i === 0 ? "text-brand" : "text-text-tertiary"} />
                  </span>
                  <button
                    type="button"
                    onClick={() => o.id && router.push(`/soporte/${o.id}`)}
                    disabled={!o.id}
                    className="group w-full rounded-lg border border-border-subtle bg-surface-2/50 p-3 text-left transition-colors hover:border-brand hover:bg-surface-2 disabled:cursor-default disabled:hover:border-border-subtle disabled:hover:bg-surface-2/50"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {o.code != null && <span className="font-mono text-[12px] font-semibold text-text-secondary">Orden #{o.code}</span>}
                      <span className="text-[13px] font-semibold text-text-primary">{o.type || o.subject || "Orden"}</span>
                      <Badge label={TICKET_STATUS_LABEL[o.status] ?? o.status} tone={TICKET_STATUS_TONE[o.status] ?? "default"} />
                      {o.id && <Icon name="chevron-right" size={14} className="ml-auto text-text-tertiary transition-colors group-hover:text-brand" />}
                    </div>
                    {o.subject && o.subject !== o.type && (
                      <p className="mt-0.5 text-[12px] text-text-secondary">{o.subject}</p>
                    )}
                    {o.problem && <p className="mt-1 text-[12px] text-text-tertiary">{o.problem}</p>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
                      <span className="inline-flex items-center gap-1"><Icon name="calendar" size={12} /> {fmtDate(o.created)}</span>
                      {o.finalDate && <span className="inline-flex items-center gap-1"><Icon name="check" size={12} /> Cerrada {fmtDate(o.finalDate)}</span>}
                      {o.assigned && <span className="inline-flex items-center gap-1"><Icon name="user-check" size={12} /> {o.assigned}</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-4 text-center text-[12px] text-text-tertiary">Este cliente no tiene órdenes de trabajo registradas.</p>
          )}
        </div>
      )}

      {/* ── Archivos ── */}
      {tab === "archivos" && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          {/* Zona de subida */}
          <label className={`mb-3 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border-default px-4 py-6 text-center transition-colors hover:bg-surface-2 ${uploading ? "pointer-events-none opacity-60" : ""}`}>
            <Icon name={uploading ? "loader" : "file-plus"} size={22} className={uploading ? "animate-spin text-brand" : "text-text-tertiary"} />
            <span className="text-[13px] font-semibold text-text-primary">{uploading ? "Subiendo…" : "Subir archivo"}</span>
            <span className="text-[11px] text-text-tertiary">PDF, imágenes, Office, TXT o ZIP · máx. 20 MB</span>
            <input
              type="file"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadFile(file);
                e.target.value = "";
              }}
            />
          </label>

          {/* Lista */}
          {files.length ? (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2.5">
                  <Icon name={fileIcon(f.mimeType)} size={18} className="shrink-0 text-brand" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text-primary">{f.name}</div>
                    <div className="text-[11px] text-text-tertiary">
                      {fmtBytes(f.size)} · {fmtDate(f.createdAt)}
                      {f.uploadedBy && <> · {f.uploadedBy}</>}
                    </div>
                  </div>
                  {(f.mimeType?.startsWith("image/") || f.mimeType === "application/pdf") && (
                    <button type="button" title="Vista previa" onClick={() => void previewFile(f)} className="shrink-0 rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2">
                      <Icon name="eye" size={15} />
                    </button>
                  )}
                  <button type="button" title="Descargar" onClick={() => void downloadFile(f)} className="shrink-0 rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2">
                    <Icon name="download" size={15} />
                  </button>
                  <button type="button" title="Eliminar" onClick={() => void deleteFile(f)} className="shrink-0 rounded-lg border border-border-default p-1.5 text-error-text transition-colors hover:bg-error-soft">
                    <Icon name="x" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-[12px] text-text-tertiary">Aún no hay archivos para este cliente.</p>
          )}
        </div>
      )}
    </>
  );
}
