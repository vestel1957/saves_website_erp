"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select, Textarea } from "@/components/ui/Field";
import { PagedTable } from "@/components/ui/PagedTable";
import { TabStrip } from "@/components/ui/TabStrip";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import dynamic from "next/dynamic";
import { Dropdown, MenuItem } from "@/components/ui/Dropdown";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import {
  SUB_STATUS_LABEL, SUB_STATUS_TONE, INVOICE_KIND_LABEL, INVOICE_RON_LABEL, INVOICE_RON_TONE,
  INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, SUB_FILE_KIND_OPTS, SUB_FILE_KIND_LABEL, SUB_FILE_KIND_TONE, cop,
  waLink, initials, antiguedad, STATUS_AVATAR_CLASS,
} from "@/lib/subscribers";
import { TICKET_STATUS_LABEL, TICKET_STATUS_TONE } from "@/lib/support";
import { SERVICE_KIND_LABEL } from "@/lib/plans";
import { PlayhubPanel } from "@/components/playhub/PlayhubPanel";
import { CobranzaPanel } from "@/components/cobranzas/CobranzaPanel";
import { fmtDate, fmtDiaLargo, fmtHora } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";
import { UbicacionModal } from "@/components/map/UbicacionModal";
import { FotoVivienda, fotosDeVivienda } from "@/components/subscribers/FotoVivienda";
import { EstadoConexion } from "@/components/network/EstadoConexion";

// Modales cargados bajo demanda: su JS NO entra en el chunk inicial de la
// página (la más pesada de la app); se descarga al abrirlos por primera vez.
const RegistrarPagoModal = dynamic(() => import("@/components/cobranzas/RegistrarPagoModal").then((m) => m.RegistrarPagoModal), { ssr: false });
const MikrotikModal = dynamic(() => import("@/components/network/MikrotikModal").then((m) => m.MikrotikModal), { ssr: false });
const WifiModal = dynamic(() => import("@/components/network/WifiModal").then((m) => m.WifiModal), { ssr: false });
const ClienteWizardModal = dynamic(() => import("@/components/subscribers/ClienteWizardModal").then((m) => m.ClienteWizardModal), { ssr: false });
const EditarFacturaModal = dynamic(() => import("@/components/subscribers/EditarFacturaModal").then((m) => m.EditarFacturaModal), { ssr: false });
const CambiarPlanModal = dynamic(() => import("@/components/subscribers/CambiarPlanModal").then((m) => m.CambiarPlanModal), { ssr: false });
const CambiarEstadoModal = dynamic(() => import("@/components/subscribers/CambiarEstadoModal").then((m) => m.CambiarEstadoModal), { ssr: false });
const EstadoServicioModal = dynamic(() => import("@/components/subscribers/EstadoServicioModal").then((m) => m.EstadoServicioModal), { ssr: false });
const ClavePortalModal = dynamic(() => import("@/components/subscribers/ClavePortalModal").then((m) => m.ClavePortalModal), { ssr: false });
const NuevaOrdenModal = dynamic(() => import("@/components/soporte/NuevaOrdenModal").then((m) => m.NuevaOrdenModal), { ssr: false });
const NuevaFacturaModal = dynamic(() => import("@/components/billing/NuevaFacturaModal").then((m) => m.NuevaFacturaModal), { ssr: false });
const DevolverEquipoModal = dynamic(() => import("@/components/subscribers/DevolverEquipoModal").then((m) => m.DevolverEquipoModal), { ssr: false });
// El bloque del contrato entra con la pestaña Resumen: arrastra el lienzo de la
// firma, que no tiene por qué viajar en el chunk inicial de la ficha.
const ContratoCard = dynamic(() => import("@/components/subscribers/ContratoCard").then((m) => m.ContratoCard), { ssr: false });

type Detail = any;

/** Icono por tipo de servicio (para los chips de la cabecera). */
const SERVICE_KIND_ICON: Record<string, string> = {
  INTERNET: "wifi", TV: "tv", PUNTOS: "tv", STREAMING: "play",
};

/**
 * De dónde salió el plan cuando no está registrado como servicio: `"factura"` es la
 * última que se le emitió (de ahí lo lee el legacy) y `"perfil"` es el perfil PPPoE
 * con el que navega. Los dos se enseñan igual —es lo que el cliente tiene— pero sin
 * estado, porque ni una factura ni un perfil lo tienen.
 */
type Servicio = { kind: string; planName: string | null; price: number | null; status: string | null; qty?: number; source?: "plan" | "factura" | "perfil" };

/**
 * Un servicio CAÍDO se pinta en rojo y con la palabra escrita.
 *
 * Rojo porque es lo que se viene a mirar cuando el cliente llama —"no me sirve
 * la tele"—, y escrito porque el color solo no basta: el mismo panel ya usa
 * rojo para la cartera, la ficha se lee a diario en el celular del técnico y
 * hay quien no distingue el rojo del gris. El plan sigue en su color normal:
 * teñir el renglón entero lo vuelve ilegible y no dice nada más.
 *
 * Al aire NO se decora: lo normal no lleva insignia, si no la excepción deja de
 * saltar a la vista.
 */
const SERVICE_STATUS_LABEL: Record<string, string> = {
  CORTADO: "Cortado",
  SUSPENDIDO: "Suspendido",
};
/**
 * Color del punto que va sobre la foto de la vivienda, en escritorio.
 *
 * Repite el estado que antes daba el círculo de iniciales, que la foto sustituye.
 * Es un refuerzo, no la señal: la palabra sigue en la pastilla junto al nombre —el
 * color solo no basta.
 */
const STATUS_DOT_CLASS: Record<string, string> = {
  success: "bg-success",
  error: "bg-error",
  warning: "bg-warning",
  info: "bg-info",
  default: "bg-border-strong",
};

const caido = (status?: string | null) => !!status && status !== "ACTIVO";
const etiquetaEstado = (status?: string | null) =>
  SERVICE_STATUS_LABEL[status ?? ""] ?? (status ? status.charAt(0) + status.slice(1).toLowerCase() : "");

/**
 * El plan que se enseña en grande y los demás que tiene contratados.
 *
 * Manda el de INTERNET: 3.281 de los 4.769 abonados tienen dos servicios
 * (internet + televisión) y el que define lo que la gente llama "su plan" es el
 * de internet. Entre varios del mismo tipo gana el ACTIVO, que es el vigente;
 * los cortados se enseñan igual (con su estado) porque un plan cortado sigue
 * siendo el que tiene contratado.
 */
function planContratado(services: Servicio[] | undefined) {
  const lista = services ?? [];
  if (!lista.length) return { principal: null, otros: [] as Servicio[] };
  const vivo = (s: Servicio) => s.status === "ACTIVO";
  // Los PUNTOS son un accesorio del servicio (y van con cantidad), no un plan:
  // se enseñan con los demás pero nunca pueden salir como "su plan".
  const planes = lista.filter((s) => s.kind !== "PUNTOS");
  const internet = planes.filter((s) => s.kind === "INTERNET");
  const principal = internet.find(vivo) ?? internet[0] ?? planes.find(vivo) ?? planes[0] ?? null;
  return { principal, otros: lista.filter((s) => s !== principal) };
}

const fmtBytes = (n: number) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

/** Cuántas observaciones se ven sin desplegar (las más recientes primero). */
const NOTAS_VISIBLES = 8;

/**
 * Color del tipo de observación que trae el legacy. Sólo se destacan las que piden
 * lectura —un compromiso de pago vencido, un cambio de titular—; el resto va neutro
 * para que la ficha no parezca un semáforo.
 */
const tonoDeNota = (kind: string): "default" | "info" | "warning" | "brand" => {
  if (/vencid/i.test(kind)) return "warning";
  if (/compromiso/i.test(kind)) return "info";
  if (/titular/i.test(kind)) return "brand";
  return "default";
};

const fileIcon = (mime: string) => {
  if (mime?.includes("sheet") || mime?.includes("excel") || mime?.includes("csv")) return "file-spreadsheet";
  // La mitad de lo que trae el legacy son fotos (cartas de retiro, cédulas): con el
  // icono de documento la lista parecía toda PDF.
  if (mime?.startsWith("image/")) return "image";
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
      className="tap shrink-0 text-text-tertiary transition-colors hover:text-text-secondary"
    >
      <Icon name={done ? "check" : "copy"} size={13} className={done ? "text-success-text" : ""} />
    </button>
  );
}

/** Fila de contacto accionable: se oculta si no hay valor. */
function ContactRow({ icon, value, href, onClick, copy }: { icon: string; value?: string | null; href?: string | null; onClick?: () => void; copy?: boolean }) {
  if (!value) return null;
  const content = onClick ? (
    <button type="button" onClick={onClick} className="truncate text-left text-text-primary hover:text-brand hover:underline">
      {value}
    </button>
  ) : href ? (
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

/**
 * Ficha compacta para las confirmaciones de borrado: sirve para que el operador
 * verifique que va a borrar el registro que cree, no el de al lado.
 */
function FichaConfirm({ filas }: { filas: [string, React.ReactNode][] }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        {filas.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-tertiary">{k}</dt>
            <dd className="min-w-0 break-words text-right text-text-primary">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/**
 * Celda de la franja de indicadores del encabezado.
 *
 * `destacada` la tiñe con el color de marca. El texto se deja en `text-primary`
 * (no en `text-brand`) porque el color primario lo elige cada usuario en su
 * perfil: sobre el fondo tintado, el único que tiene contraste garantizado en
 * claro y en oscuro es el de siempre.
 */
function StatCell({ label, tone, destacada, className = "", title, children }: { label: string; tone?: "error" | "success" | "default"; destacada?: boolean; className?: string; title?: string; children: React.ReactNode }) {
  const valueCls = tone === "error" ? "text-error-text" : tone === "success" ? "text-success-text" : "text-text-primary";
  return (
    <div title={title} className={`px-4 py-2.5 ${destacada ? "bg-brand-soft" : "bg-surface"} ${className}`}>
      <div className={`mb-0.5 text-[11px] uppercase tracking-wide ${destacada ? "font-semibold text-text-secondary" : "text-text-tertiary"}`}>{label}</div>
      <div className={valueCls}>{children}</div>
    </div>
  );
}

/* ── Página ────────────────────────────────────────────────────── */

export default function ClienteDetallePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  // Tocar una factura desde la ficha —cambiarle fechas o borrarla— es de contabilidad.
  // La cajera llega hasta aquí por su trabajo (ver la deuda, registrar el pago), pero
  // no corrige documentos de cobro; el backend niega las dos rutas igual.
  const puedeTocarFacturas = isSuperadmin || can(PERM.AREA_CONTABILIDAD);
  // Devolver un equipo y mandarlo a bodega es administrativo: lo hacen caja y
  // administración (y el superusuario). El técnico entrega el aparato, pero no es
  // quien lo da de baja del cliente ni decide con qué estado entra a bodega.
  const puedeDevolverEquipo = isSuperadmin || can(PERM.AREA_ADMINISTRACION) || can(PERM.AREA_CAJA);
  // Emitir una factura nueva SÍ es de ventanilla (2026-08-27): el cobro de una
  // instalación, un traslado o una venta de equipo nace en el mostrador. Es distinto
  // de `puedeTocarFacturas`, que es volver sobre una factura ya emitida.
  const puedeFacturar = isSuperadmin || can(PERM.AREA_CONTABILIDAD) || can(PERM.AREA_CAJA);
  // La clave para pagar en línea la fija quien atiende al cliente: ventanilla,
  // contabilidad y administración. Al técnico no le toca (y el backend se lo niega).
  const puedeClavePortal = isSuperadmin || can(PERM.AREA_ADMINISTRACION) || can(PERM.AREA_CONTABILIDAD) || can(PERM.AREA_CAJA);
  // El TÉCNICO entra a la ficha desde su orden (2026-08-31, a pedido del usuario) y
  // aquí es de CONSULTA: mira quién es el cliente, dónde vive, qué plan tiene y qué se
  // le ha hecho, pero no vuelve sobre sus datos. Se le esconden cobrar, editar, plan y
  // estado; le quedan WhatsApp, la conexión y "cómo llegar", que es a lo que viene.
  // Misma regla que `SubscribersController.soloMira` en el backend, que es quien de
  // verdad lo niega — se escribe aquí y no con el `esTecnicoDeCampo` de `lib/auth`
  // porque aquél sirve al GPS y deja pasar a contabilidad, que sí edita clientes.
  const soloMira =
    !isSuperadmin && can(PERM.AREA_TECNICOS) &&
    !can(PERM.AREA_ADMINISTRACION) && !can(PERM.AREA_CONTABILIDAD) && !can(PERM.AREA_GERENCIA);
  const [c, setC] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [mkOpen, setMkOpen] = useState(false);
  const [wifiOpen, setWifiOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [estadoOpen, setEstadoOpen] = useState(false);
  const [estadoSvcOpen, setEstadoSvcOpen] = useState(false);
  const [clavePortalOpen, setClavePortalOpen] = useState(false);
  const [ordenOpen, setOrdenOpen] = useState(false);
  const [facturaOpen, setFacturaOpen] = useState(false);
  const [gpsOpen, setGpsOpen] = useState(false);
  const [devolver, setDevolver] = useState<string | null>(null);
  const [tab, setTab] = useState<"resumen" | "facturas" | "cuenta" | "cobranza" | "ordenes" | "equipos" | "playhub" | "historial" | "archivos">("resumen");
  const [files, setFiles] = useState<any[]>([]);
  // Tipo de documento con el que se va a subir el próximo archivo, y el filtro
  // de la lista. Vacío = sin elegir / todos.
  const [fileKind, setFileKind] = useState("");
  const [filtroKind, setFiltroKind] = useState("");
  const [verTodasLasNotas, setVerTodasLasNotas] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [statement, setStatement] = useState<any | null>(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [editInvoice, setEditInvoice] = useState<any | null>(null);
  const [infoModal, setInfoModal] = useState<{ type: "promo" | "siigo"; inv: any } | null>(null);
  const [invoices, setInvoices] = useState<any[] | null>(null);
  // Una sola confirmación con discriminante: la página borra notas, facturas y archivos.
  const [confirmar, setConfirmar] = useState<
    | { kind: "nota"; nota: any }
    | { kind: "factura"; inv: any }
    | { kind: "archivo"; file: any }
    | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const reload = useCallback(() => {
    void authFetch(`/subscribers/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("No encontrado"))))
      .then(setC)
      .catch((e) => setErr(mensajeDeError(e)));
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
    setConfirmBusy(true);
    try {
      const res = await authFetch(`/subscribers/${id}/notes/${nid}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      reload();
    } catch {
      toast("No se pudo eliminar", "alert-circle");
    } finally {
      setConfirmBusy(false);
      setConfirmar(null);
    }
  }

  async function openPdf(path: string) {
    try {
      const res = await authFetch(path);
      if (!res.ok) {
        // El servidor puede negarse con un motivo (el paz y salvo exige saldo en cero
        // y equipo devuelto). Ese texto es la respuesta útil; "no se pudo generar" no.
        const motivo = await res.json().then((b) => b?.message as string | undefined).catch(() => undefined);
        throw new Error(motivo);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast((e as Error)?.message || "No se pudo generar el PDF", "alert-circle");
    }
  }

  function openEditInvoice(inv: any) {
    setEditInvoice(inv);
  }

  async function deleteInvoice(inv: any) {
    setConfirmBusy(true);
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
    } catch (e) {
      toast(mensajeDeError(e) ?? "No se pudo eliminar", "alert-circle");
    } finally {
      setConfirmBusy(false);
      setConfirmar(null);
    }
  }

  /**
   * Sube un adjunto CON SU TIPO DE DOCUMENTO (carta de retiro, suspensión,
   * solicitud…). El tipo viaja como un campo más del formulario y el backend lo
   * valida contra su catálogo; sin tipo no se sube, para que la carpeta del cliente
   * no vuelva a llenarse de PDFs anónimos como los que bajaron del sistema anterior.
   *
   * Dos tipos tienen ruta propia porque no son sólo una etiqueta y admiten menos
   * formatos: la CARTA DE RETIRO (uno de los cuatro requisitos del paz y salvo, por
   * eso al subirla se recarga el estado de cuenta, que es quien enciende el botón
   * del certificado) y la FOTO DE LA VIVIENDA (la portada de la ficha).
   */
  async function uploadFile(file: File, kind: string) {
    if (file.size > 20 * 1024 * 1024) {
      toast("El archivo supera el máximo de 20 MB", "alert-circle");
      return;
    }
    const ruta =
      kind === "CARTA_RETIRO" ? `/subscribers/${id}/carta-retiro`
      : kind === "VIVIENDA" ? `/subscribers/${id}/house-photo`
      : `/subscribers/${id}/files`;
    setUploading(true);
    try {
      const fd = new FormData();
      // El tipo va ANTES del binario: así multer ya lo tiene leído cuando entra el
      // archivo, y la ruta genérica puede rechazarlo sin haberlo escrito en disco.
      if (ruta.endsWith("/files")) fd.append("kind", kind);
      fd.append("file", file);
      const res = await authFetch(ruta, { method: "POST", body: fd });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(m?.message ?? "No se pudo subir");
      }
      toast(`Archivo subido · ${SUB_FILE_KIND_LABEL[kind] ?? "Sin clasificar"}`);
      loadFiles();
      if (kind === "CARTA_RETIRO") loadStatement();
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al subir", "alert-circle");
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
    setConfirmBusy(true);
    try {
      const res = await authFetch(`/subscribers/${id}/files/${f.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast("Archivo eliminado");
      loadFiles();
    } catch {
      toast("No se pudo eliminar", "alert-circle");
    } finally {
      setConfirmBusy(false);
      setConfirmar(null);
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
  const mail = c.email ? `mailto:${c.email}` : null;

  const anti = antiguedad(c.entryDate);
  const plan = planContratado(c.services);
  // Las fotos de la casa salen de los MISMOS adjuntos que ya carga la ficha
  // (marcados con `kind = VIVIENDA`): ni una petición más para pintar el encabezado.
  const fotosVivienda = fotosDeVivienda(files);
  // La carta de retiro/suspensión que ya está en la ficha (mismo truco: sale de los
  // adjuntos ya cargados). Sirve para que la zona de subida diga "reemplazar".
  const cartaEnFicha = files.some((f) => f.kind === "CARTA_RETIRO");
  // Tipos que de verdad aparecen en esta ficha: el filtro sólo ofrece lo que hay
  // (incluidos los heredados sin clasificar), no las trece opciones del catálogo.
  const tiposEnFicha = SUB_FILE_KIND_OPTS.filter((o) => files.some((f) => f.kind === o.value));
  const haySinClasificar = files.some((f) => !f.kind);
  const filesFiltrados = filtroKind
    ? files.filter((f) => (filtroKind === "_SIN" ? !f.kind : f.kind === filtroKind))
    : files;

  const TABS: { key: typeof tab; label: string; icon: string; count?: number }[] = [
    { key: "resumen", label: "Resumen", icon: "user" },
    { key: "facturas", label: "Facturas", icon: "receipt", count: invoices?.length ?? c.invoices?.length ?? 0 },
    { key: "cuenta", label: "Estado de cuenta", icon: "scroll-text" },
    { key: "cobranza", label: "Cobranza", icon: "hand-coins" },
    // El contador dice cuántas TIENE, no cuántas cupieron en la respuesta.
    { key: "ordenes", label: "Órdenes", icon: "wrench", count: c.workOrdersTotal ?? c.workOrders?.length ?? 0 },
    { key: "equipos", label: "Equipos", icon: "package-check", count: c.equipment?.length ?? 0 },
    { key: "playhub", label: "PlayHub", icon: "tv" },
    { key: "historial", label: "Historial", icon: "history", count: c.statusHistory?.length ?? 0 },
    { key: "archivos", label: "Archivos", icon: "folder", count: files.length },
  ];

  return (
    <>
      {/*
        Encabezado SIEMPRE visible, no solo en Resumen: antes, al pasar a
        "Facturas" u "Órdenes" desaparecía el nombre del cliente y no quedaba en
        pantalla ni una pista de a quién pertenecían esos datos.
      */}
      <DetailHeader
        backHref="/clientes"
        backLabel="Clientes"
        /* La foto de la vivienda ocupa el sitio del círculo de iniciales, pero SÓLO
           en escritorio: en móvil manda la banda de `cover` y aquí siguen las
           iniciales, que son las que llevan el color del estado. */
        avatar={
          <>
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[17px] font-bold sm:hidden ${STATUS_AVATAR_CLASS[tone]}`}>
              {initials(c.name)}
            </div>
            <div className="relative hidden shrink-0 sm:block">
              <FotoVivienda
                subscriberId={id}
                fotos={fotosVivienda}
                variant="miniatura"
                onCambio={loadFiles}
              />
              {/* El estado no se pierde al cambiar las iniciales por la foto: el
                  punto lo repite y la palabra sigue en la pastilla del nombre. */}
              <span
                aria-hidden
                className={`absolute left-1.5 top-1.5 h-3 w-3 rounded-full border-2 border-surface ${STATUS_DOT_CLASS[tone] ?? STATUS_DOT_CLASS.default}`}
              />
            </div>
          </>
        }
        cover={
          <FotoVivienda
            subscriberId={id}
            fotos={fotosVivienda}
            variant="banda"
            onCambio={loadFiles}
            className="mb-3 sm:hidden"
          />
        }
        title={c.name}
        subtitle={
          <>
            {c.companyName && <span className="text-text-secondary">{c.companyName} · </span>}
            Abonado <span className="font-mono font-semibold text-text-secondary">{c.abonado}</span>
            {/* El ID del legacy: es el número por el que se pregunta al otro sistema
                (los clientes creados aquí no lo tienen y entonces no se pinta). */}
            {c.legacyId != null && <> · ID <span className="font-mono text-text-secondary">{c.legacyId}</span></>}
            {c.docNumber && <> · {c.docType} {c.docNumber}</>}
            {c.branch && <> · {c.branch}</>}
            {c.neighborhood && <> · {c.neighborhood}</>}
          </>
        }
        /* Servicios contratados: Internet, TV, etc. (cada uno con su plan).
           Con `undefined` cuando no hay ninguno: un array vacío es "truthy" y
           dejaría un renglón en blanco bajo el subtítulo. */
        meta={!c.services?.length ? undefined : c.services.map((s: any) => (
          <span
            key={s.kind}
            title={s.price ? `${SERVICE_KIND_LABEL[s.kind as keyof typeof SERVICE_KIND_LABEL] ?? s.kind}: ${s.planName ?? "—"} · ${cop(s.price)}/mes` : undefined}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${caido(s.status) ? "border-error/40 bg-error-soft" : "border-border-subtle bg-surface-2"}`}
          >
            <Icon name={SERVICE_KIND_ICON[s.kind] ?? "package"} size={12} className={caido(s.status) ? "text-error-text" : "text-text-tertiary"} />
            <span className="font-semibold text-text-secondary">{SERVICE_KIND_LABEL[s.kind as keyof typeof SERVICE_KIND_LABEL] ?? s.kind}</span>
            <span className="text-text-tertiary">·</span>
            <span className="text-text-secondary">{s.planName || "sin plan"}</span>
            {s.qty > 1 && <span className="font-semibold text-text-secondary">×{s.qty}</span>}
            {/* El corte va DESPUÉS del plan y no en vez de él: el cliente sigue
                teniendo ese plan contratado, lo que pasa es que no lo recibe. */}
            {caido(s.status) && (
              <>
                <span className="text-error-text/50">·</span>
                <span className="font-bold uppercase tracking-wide text-error-text">{etiquetaEstado(s.status)}</span>
              </>
            )}
          </span>
        ))}
        /* Solo las dos acciones que se pulsan todo el día quedan a la vista —cobrar
           y abrir una orden—; el resto vive en "Acciones". En móvil se reparten una
           línea entera. */
        actions={
          <>
            <div className="order-last flex w-full gap-2 sm:order-none sm:w-auto">
              {!soloMira && (
                <Button onClick={() => setPayOpen(true)} className="flex-1 sm:flex-none">
                  <Icon name="dollar-sign" size={15} /> Registrar pago
                </Button>
              )}
              <Button variant="secondary" onClick={() => setOrdenOpen(true)} className="flex-1 sm:flex-none">
                <Icon name="wrench" size={15} /> Nueva orden
              </Button>
            </div>
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
                  <MenuItem
                    href={wa}
                    disabled={!wa}
                    title={wa ? undefined : "El cliente no tiene celular registrado"}
                    onClick={close}
                  >
                    <Icon name="message-circle" size={15} /> WhatsApp
                  </MenuItem>
                  <MenuItem onClick={() => { close(); setMkOpen(true); }}>
                    <Icon name="wifi" size={15} /> Conexión
                  </MenuItem>
                  {!soloMira && (
                    <>
                      <MenuItem onClick={() => { close(); setPlanOpen(true); }}>
                        <Icon name="gauge" size={15} /> Cambiar plan
                      </MenuItem>
                      <MenuItem onClick={() => { close(); setEstadoOpen(true); }}>
                        <Icon name="toggle-left" size={15} /> Cambiar estado
                      </MenuItem>
                      {/* El estado del CLIENTE y el de cada SERVICIO son cosas
                          distintas: se puede tener la TV suspendida y el internet
                          navegando. Van seguidos porque se confunden. */}
                      <MenuItem onClick={() => { close(); setEstadoSvcOpen(true); }}>
                        <Icon name="tv" size={15} /> Estado de los servicios
                      </MenuItem>
                    </>
                  )}
                  <MenuItem onClick={() => { close(); setGpsOpen(true); }}>
                    <Icon name="map-pin" size={15} /> Ubicación y cómo llegar
                  </MenuItem>
                  {puedeClavePortal && (
                    <MenuItem onClick={() => { close(); setClavePortalOpen(true); }}>
                      <Icon name="key-round" size={15} /> Clave de pagos en línea
                    </MenuItem>
                  )}
                  {!soloMira && (
                    <MenuItem onClick={() => { close(); setEditOpen(true); }}>
                      <Icon name="pencil" size={15} /> Editar
                    </MenuItem>
                  )}
                </>
              )}
            </Dropdown>
          </>
        }
      />

      {/* Pestañas — tira deslizable: nueve pestañas envueltas se comían cuatro
          renglones de una pantalla de móvil antes del primer dato. */}
      <TabStrip tabs={TABS} active={tab} onChange={setTab} />

      {/* Franja de indicadores — solo en Resumen */}
      {tab === "resumen" && (
        <div className="mb-4 grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle shadow-sm sm:grid-cols-9">
          {/* Lo primero de la franja: al abrir un cliente, lo que se pregunta antes
              que nada es qué tiene contratado. Cada servicio va en su renglón —el de
              internet manda y la televisión debajo— para que un combo se lea de un
              vistazo sin apiñar los dos nombres en la misma línea. En móvil la celda
              se lleva la fila entera: los nombres del catálogo son largos. */}
          <StatCell
            label="Plan contratado"
            destacada
            className="col-span-2 sm:col-span-3"
            title={
              plan.principal?.source === "factura"
                ? "Según su última factura: este cliente no tiene el plan asignado como servicio en el sistema."
                : plan.principal?.source === "perfil"
                  ? "Según el perfil con el que navega: este cliente no tiene plan asignado ni facturas con plan."
                  : undefined
            }
          >
            {plan.principal ? (
              <div className="flex flex-col gap-0.5">
                {[plan.principal, ...plan.otros].map((s: Servicio, i: number) => {
                  const etiqueta = SERVICE_KIND_LABEL[s.kind as keyof typeof SERVICE_KIND_LABEL] ?? s.kind;
                  const cortado = caido(s.status);
                  return (
                    <div
                      key={`${s.kind}-${s.planName ?? i}`}
                      title={`${etiqueta}${s.price ? ` · ${cop(s.price)}/mes` : ""}${cortado ? ` · ${etiquetaEstado(s.status).toUpperCase()} (según su última factura)` : ""}`}
                      className="flex items-center gap-1.5"
                    >
                      {/* Antes el servicio caído se atenuaba (opacity-60), que es
                          justo la señal contraria: lo apagaba en vez de sacarlo a
                          la luz. Va en rojo y con la palabra al lado. */}
                      <Icon
                        name={SERVICE_KIND_ICON[s.kind] ?? "package"}
                        size={i === 0 ? 18 : 13}
                        className={`shrink-0 ${cortado ? "text-error-text" : i === 0 ? "text-brand" : "text-text-tertiary"}`}
                      />
                      <span
                        className={
                          i === 0
                            ? "truncate text-[19px] font-extrabold leading-tight sm:text-[17px] lg:text-[19px]"
                            : "truncate text-[12px] font-semibold text-text-secondary"
                        }
                      >
                        {s.planName || etiqueta}
                        {(s.qty ?? 1) > 1 && <span className="text-text-tertiary"> ×{s.qty}</span>}
                      </span>
                      {/* El precio pegado a su propio plan: en un combo, saber cuál de
                          los dos cuesta qué es justo lo que se viene a mirar. Con
                          cantidad se enseña el total de la línea, que es lo que se
                          le cobra (25 puntos no son 5.000, son 125.000). */}
                      {cortado && (
                        <span className="shrink-0 rounded-full bg-error-soft px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-error-text">
                          {etiquetaEstado(s.status)}
                        </span>
                      )}
                      {s.price ? (
                        <span className="shrink-0 text-[11px] text-text-tertiary">{cop(s.price * (s.qty ?? 1))}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                <span className="text-[15px] font-semibold text-text-tertiary">Sin plan registrado</span>
                {/* Es un vacío de DATOS, no una afirmación sobre el cliente: no lo
                    tiene asignado, no aparece en sus facturas y no navega con un
                    perfil que lo diga. Se explica para que nadie lo lea como
                    "este cliente no tiene servicio". */}
                <span className="block text-[11px] text-text-tertiary">Ni en sus facturas ni en la red · asígnalo en Acciones ▸ Cambiar plan</span>
              </>
            )}
          </StatCell>
          <StatCell label="Cartera" tone={c.receivable > 0 ? "error" : "success"} className="sm:col-span-2">
            <span className="text-[17px] font-bold">{cop(c.receivable)}</span>
            <span className="ml-1.5 text-[11px] font-normal text-text-tertiary">{c.dueInvoices} pend.</span>
            {/* Lo que PAGARÍA hoy con la promoción vigente. Va debajo y no en lugar
                de la cartera: la deuda sigue siendo la de arriba —el descuento se
                concede al cobrar y sólo si salda la factura entera—, pero quien
                atiende necesita poder decirle al cliente la cifra que va a pagar. */}
            {c.promoDiscount > 0 && (
              <span className="mt-0.5 block text-[11.5px] font-semibold leading-snug text-success-text">
                Paga {cop(c.receivableWithDiscount)} hoy
                <span className="font-normal text-text-tertiary">
                  {" · "}−{cop(c.promoDiscount)}{c.promoName ? ` · ${c.promoName}` : ""}
                </span>
              </span>
            )}
          </StatCell>
          <StatCell
            label="Saldo a favor"
            tone={c.balance + (c.advance ?? 0) > 0 ? "success" : "default"}
            className="sm:col-span-2"
          >
            <span className="text-[17px] font-bold">{cop(c.balance + (c.advance ?? 0))}</span>
            {/* Lo pagado por adelantado se dice aparte: no es un saldo suelto, tiene
                destino (se imputa solo a la próxima factura del cliente). */}
            {(c.advance ?? 0) > 0 && (
              <span className="ml-1.5 text-[11px] font-normal text-text-tertiary">
                {cop(c.advance)} adelantado
              </span>
            )}
          </StatCell>
          <StatCell label="Estado" className="col-span-2 sm:col-span-2">
            {soloMira ? (
              <Badge label={SUB_STATUS_LABEL[c.status ?? ""] ?? c.status ?? "—"} tone={tone} size="md" />
            ) : (
              <button
                type="button"
                title="Cambiar estado"
                onClick={() => setEstadoOpen(true)}
                className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-75"
              >
                <Badge label={SUB_STATUS_LABEL[c.status ?? ""] ?? c.status ?? "—"} tone={tone} size="md" />
                <Icon name="pencil" size={13} className="text-text-tertiary" />
              </button>
            )}
            {/* POR QUÉ está así. Un EXONERADO o un CARTERA sin explicación obliga a
                preguntar por interno; el motivo se escribe al cambiar el estado y
                hasta ahora sólo se veía abriendo la pestaña de historial. */}
            {c.statusReason?.reason && (
              <p
                className="mt-1 text-[11.5px] leading-snug text-text-secondary"
                title={`${c.statusReason.author ? `${c.statusReason.author} · ` : ""}${fmtDate(c.statusReason.date)}`}
              >
                {c.statusReason.reason}
                <span className="text-text-tertiary">
                  {c.statusReason.author ? ` — ${c.statusReason.author}` : ""}
                  {c.statusReason.date ? `, ${fmtDate(c.statusReason.date)}` : ""}
                </span>
              </p>
            )}
          </StatCell>
        </div>
      )}

      {/* Instalación que espera pago: el cliente está dado de alta pero NADIE va a ir
          hasta que pague su factura de afiliación, y la orden nace sola cuando lo haga.
          Sin este aviso, un INSTALAR sin orden se lee como un olvido y alguien abre la
          orden a mano —que es exactamente lo que la regla quiere evitar—. */}
      {c.instalacionPendiente && (
        <div className="mb-2 flex flex-col gap-1 rounded-lg border border-warning-border bg-warning-soft p-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <Icon name="clipboard-list" size={15} className="mt-px shrink-0 text-warning-text" />
            <div>
              <div className="text-[13px] font-semibold text-text-primary">
                {c.instalacionPendiente.estado === "CANCELED" ? "Instalación en espera de una factura anulada" : "Instalación a la espera del pago"}
              </div>
              <div className="text-[11.5px] text-text-secondary">
                {c.instalacionPendiente.estado === "CANCELED" ? (
                  <>La factura de afiliación #{c.instalacionPendiente.tid} se anuló, así que la orden no va a abrirse sola: emítele otra factura y cóbrala, o abre la orden a mano desde Acciones ▸ Nueva orden.</>
                ) : (
                  <>
                    La orden de instalación se abre sola en cuanto se pague la factura de afiliación
                    #{c.instalacionPendiente.tid}
                    {c.instalacionPendiente.saldo > 0 ? ` (faltan ${cop(c.instalacionPendiente.saldo)})` : " (ya pagada: la orden se abre en la próxima pasada)"}.
                  </>
                )}
              </div>
            </div>
          </div>
          {c.instalacionPendiente.estado !== "CANCELED" && !soloMira && (
            <Button variant="secondary" onClick={() => setPayOpen(true)}>Registrar pago</Button>
          )}
        </div>
      )}

      {payOpen && <RegistrarPagoModal subscriberId={id} open={payOpen} onClose={() => setPayOpen(false)} onDone={reload} />}
      {gpsOpen && (
        <UbicacionModal
          open={gpsOpen}
          onClose={() => setGpsOpen(false)}
          subscriberId={c.id}
          subscriberName={c.name}
          actual={c.gps ? { lat: Number(c.gps.lat), lng: Number(c.gps.lng) } : null}
          onGuardado={reload}
        />
      )}
      {mkOpen && <MikrotikModal subscriberId={id} subscriberName={c.name} open={mkOpen} onClose={() => setMkOpen(false)} onDone={reload} />}
      {wifiOpen && <WifiModal subscriberId={id} subscriberName={c.name} open={wifiOpen} onClose={() => setWifiOpen(false)} />}
      {estadoOpen && <CambiarEstadoModal subscriberId={id} current={c.status} motivoActual={c.statusReason} open={estadoOpen} onClose={() => setEstadoOpen(false)} onDone={reload} />}
      {estadoSvcOpen && <EstadoServicioModal subscriberId={id} services={c.services ?? []} open={estadoSvcOpen} onClose={() => setEstadoSvcOpen(false)} onDone={reload} />}
      {clavePortalOpen && <ClavePortalModal subscriberId={id} nombreCliente={c.name} open={clavePortalOpen} onClose={() => setClavePortalOpen(false)} />}
      {devolver !== null && (
        <DevolverEquipoModal
          subscriberId={id}
          equipos={c.equipment ?? []}
          preseleccion={devolver || null}
          open={devolver !== null}
          onClose={() => setDevolver(null)}
          onDone={reload}
        />
      )}
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
      {facturaOpen && (
        <NuevaFacturaModal
          open={facturaOpen}
          onClose={() => setFacturaOpen(false)}
          onDone={() => { setInvoices(null); setStatement(null); reload(); }}
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
              {/* La dirección viene ARMADA del servidor (`address`), no del campo
                  `addressLine`: ese estaba vacío en 21.656 de 21.867 abonados, así
                  que este renglón salía en blanco para casi todo el mundo. Barrio y
                  ciudad llegan ya resueltos a nombre: en la BD son el id del
                  catálogo legacy y antes se pintaba el número crudo. */}
              <ContactRow icon="map-pin" value={[c.address, c.neighborhood, c.city].filter(Boolean).join(" · ") || null} onClick={() => setGpsOpen(true)} />
              {/* Cómo llegar: 'Frente a la Hogareña', 'PISO 1'. El legacy lo guarda
                  aparte de la dirección y es lo que de verdad usa el técnico. */}
              {c.addressRef && (
                <ContactRow icon="signpost" value={c.addressRef} />
              )}
              <ContactRow icon="cake" value={c.birthDate ? fmtDate(c.birthDate) : null} />
              {c.estrato != null && <Row label="Estrato" value={c.estrato} />}
              {!c.phone1 && !c.phone2 && !c.email && !c.address && (
                <p className="py-1 text-[12px] text-text-tertiary">Sin datos de contacto.</p>
              )}
            </Card>

            <Card title="Red / Conexión" icon="activity">
              {/* Semáforo en vivo: lo de abajo es lo guardado, esto es lo que el
                  router dice AHORA (verde navegando / rojo sin navegar). */}
              <EstadoConexion subscriberId={id} pppUsername={c.network?.pppUsername} />
              <Row label="Usuario PPPoE" value={c.network?.pppUsername} />
              {/* La clave va visible y con botón de copiar: quien atiende la dicta
                  por teléfono o la pega en el equipo, y tenerla que buscar abriendo
                  el wizard de edición era el paso de más. */}
              <Row
                label="Contraseña PPPoE"
                value={c.network?.pppPassword ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono">{c.network.pppPassword}</span>
                    <CopyBtn text={c.network.pppPassword} />
                  </span>
                ) : null}
              />
              <Row label="Perfil / Plan" value={c.network?.pppProfile} />
              <Row label="IP remota" value={c.network?.ipRemote} />
              <Row label="MAC equipo" value={c.network?.macEquipo} />
              <Row label="MAC ONT" value={c.network?.macOnt} />
              <Row label="Tecnología" value={c.network?.installTech} />
              {/* La VLAN por la que navega el cliente no está en ninguna columna:
                  vive dentro del comentario del secret que escribe el legacy
                  ("EL OASIS 57506 VLAN 340 FTTH"). Se saca aparte porque es lo
                  que se viene a buscar, y debajo queda el comentario entero, que
                  lo escribió una persona y a veces dice más. */}
              {c.network?.vlan != null && <Row label="VLAN" value={<span className="font-mono">{c.network.vlan}</span>} />}
              {c.network?.comment && (
                <div className="flex flex-col gap-1 border-b border-border-subtle py-1.5 last:border-0">
                  <span className="text-[12px] text-text-tertiary">Comentario de red</span>
                  <span className="break-words text-[12px] font-medium text-text-primary">{c.network.comment}</span>
                </div>
              )}
              {/* El cambio de WiFi del cliente sin mandar técnico: es el mismo
                  camino que usa el bot de WhatsApp (TR-069 por el ACS), aquí para
                  quien atiende por teléfono. Si el equipo no está o no contesta, el
                  modal lo dice y se sigue por orden de servicio. */}
              {(isSuperadmin || can(PERM.AREA_TECNICOS)) && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() => setWifiOpen(true)}
                >
                  <Icon name="wifi" size={14} /> Cambiar clave del WiFi
                </Button>
              )}
            </Card>

            <Card title="Facturación" icon="file-text">
              <Row label="Suscripción" value={c.suscripcion} />
              <Row label="Fecha contrato" value={fmtDate(c.contractDate)} />
              {/* La antigüedad venía en la franja de arriba, donde ahora va el plan. */}
              <Row label="Fecha ingreso" value={anti ? `${fmtDate(c.entryDate)} · ${anti}` : fmtDate(c.entryDate)} />
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

          {/* Contrato: permanencia, firma, huella y los dos PDF. */}
          <div className="mb-4">
            <ContratoCard subscriberId={id} nombre={c.name} openPdf={openPdf} />
          </div>

          {/* Notas */}
          <Card title={`Notas${c.notes?.length ? ` · ${c.notes.length}` : ""}`} icon="message-square">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row">
              <Textarea
                rows={2}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Escribe una observación sobre el cliente…"
                className="flex-1"
              />
              <Button
                onClick={() => void addNote()}
                disabled={savingNote || !noteText.trim()}
                className="w-full sm:w-auto sm:self-end"
              >
                <Icon name={savingNote ? "loader" : "plus"} size={15} className={savingNote ? "animate-spin" : ""} /> Agregar
              </Button>
            </div>
            {c.notes?.length ? (
              <ul className="flex flex-col divide-y divide-border-subtle">
                {(verTodasLasNotas ? c.notes : c.notes.slice(0, NOTAS_VISIBLES)).map((n: any) => (
                  <li key={n.id} className="group flex items-start gap-2 py-2">
                    <Icon name="corner-down-left" size={13} className="mt-0.5 shrink-0 rotate-180 text-text-tertiary" />
                    <div className="min-w-0 flex-1">
                      {/* El tipo viene del legacy (`historiales.tipos`): sin él, "Codigo:
                          311022 Motivo 311022" no dice que fue una devolución de equipo. */}
                      {n.kind && (
                        <Badge label={n.kind} tone={tonoDeNota(n.kind)} />
                      )}
                      <p className={`whitespace-pre-wrap text-[12px] text-text-primary${n.kind ? " mt-1" : ""}`}>{n.body}</p>
                      <p className="text-[10px] text-text-tertiary">
                        {n.author ?? "—"} · {n.legacy
                          ? new Date(n.createdAt).toLocaleDateString("es-CO")
                          : new Date(n.createdAt).toLocaleString("es-CO")}
                      </p>
                    </div>
                    {/* En móvil no hay hover: si se deja oculto tras `group-hover`
                        el botón de borrar la nota simplemente no existe para quien
                        entra desde el celular. Visible siempre hasta `sm`. */}
                    <button type="button" title="Eliminar" onClick={() => setConfirmar({ kind: "nota", nota: n })} className="shrink-0 p-1 text-text-tertiary transition-opacity hover:text-error-text sm:p-0 sm:opacity-0 sm:group-hover:opacity-100">
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-text-tertiary">Aún no hay notas.</p>
            )}
            {/* Un cliente viejo llega a tener 36 observaciones traídas del legacy: se
                muestran las últimas y el resto queda a un clic, sin empujar el pie de
                la ficha fuera de la pantalla. */}
            {c.notes?.length > NOTAS_VISIBLES && (
              <button
                type="button"
                onClick={() => setVerTodasLasNotas((v) => !v)}
                className="mt-2 text-[12px] font-semibold text-brand hover:underline"
              >
                {verTodasLasNotas ? "Ver menos" : `Ver las ${c.notes.length} observaciones`}
              </button>
            )}
          </Card>
        </>
      )}

      {/* ── Equipos ── */}
      {tab === "equipos" && (
        <div className="flex flex-col gap-3">
        {puedeDevolverEquipo && !!c.equipment?.length && (
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setDevolver("")}>
              <Icon name="package-x" size={15} /> Devolver equipo
            </Button>
          </div>
        )}
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
            ...(puedeDevolverEquipo ? [{
              key: "acciones", header: "", align: "right" as const, sortable: false,
              render: (e: any) => (
                <Button size="sm" variant="secondary" onClick={() => setDevolver(e.id)}>
                  <Icon name="package-x" size={14} /> Devolver
                </Button>
              ),
            }] : []),
          ]}
        />
        </div>
      )}

      {/* ── Historial de estados ── */}
      {tab === "playhub" && <PlayhubPanel subscriberId={id} email={c.email} />}

      {tab === "cobranza" && <CobranzaPanel subscriberId={id} />}

      {tab === "historial" && (
        <Card title="Historial de estados" icon="history">
          {c.statusHistory?.length ? (
            <ol className="relative flex flex-col gap-3 border-l border-border-default pl-4">
              {c.statusHistory.map((h: any, i: number) => (
                <li key={i} className="relative">
                  <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ${i === 0 ? "bg-brand ring-4 ring-brand-soft" : "bg-border-default"}`} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge label={SUB_STATUS_LABEL[h.status] ?? h.status} tone={SUB_STATUS_TONE[h.status] ?? "default"} />
                    <span className="text-[11px] text-text-tertiary">{fmtDate(h.date)}</span>
                    {/* Quién lo movió, cuando lo movió una persona: el historial no
                        tiene columna de autor y va dentro de la nota (ver
                        `partirNotaDeEstado` en el backend). */}
                    {h.author && <span className="text-[11px] text-text-tertiary">· {h.author}</span>}
                  </div>
                  {h.ticket && <span className="text-[10px] text-text-tertiary">Orden #{h.ticket}</span>}
                  {h.reason && <p className="mt-0.5 text-[12px] text-text-secondary">{h.reason}</p>}
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
                <div className="grid w-full flex-1 grid-cols-1 gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle sm:w-auto sm:grid-cols-3">
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
                {/* Los tres PDF no caben en línea en móvil: se envuelven y cada
                    uno crece hasta media fila, así siguen siendo pulsables. */}
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <Badge label={statement.pazysalvo ? "A paz y salvo" : "Con saldo pendiente"} tone={statement.pazysalvo ? "success" : "error"} />
                  {/* El `title` del botón no existe en el móvil: si lo que falta es el
                      equipo, hay que verlo sin pasar el ratón por encima. */}
                  {!!statement.equiposPendientes?.length && (
                    <Badge
                      label={statement.equiposPendientes.length === 1 ? "Equipo sin devolver" : `${statement.equiposPendientes.length} equipos sin devolver`}
                      tone="error"
                    />
                  )}
                  {/* Los otros dos requisitos, cada uno con su pastilla: el `title` del
                      botón no existe en el móvil y hay que ver QUÉ falta sin pulsar. */}
                  {!statement.cartaRetiro && <Badge label="Sin carta de retiro" tone="error" />}
                  {!statement.ordenRetiro && (
                    <Badge
                      label={statement.ordenRetiroAbierta
                        ? `Orden #${statement.ordenRetiroAbierta.code ?? "—"} sin cerrar`
                        : "Sin orden de retiro"}
                      tone="error"
                    />
                  )}
                  {/* El certificado exige LAS CUATRO cosas: cuenta en cero, equipo
                      devuelto, carta de retiro/suspensión entregada y la orden de baja
                      cerrada. El botón se apaga y dice cuál falta — enterarse al pulsar,
                      con el cliente en la ventanilla, llega tarde. El backend lo exige
                      igual: la ruta del PDF se cierra, no expide nada en negativo. */}
                  <Button
                    variant="secondary"
                    className="flex-1 sm:flex-none"
                    disabled={!statement.puedeEmitirPazYSalvo}
                    title={
                      statement.puedeEmitirPazYSalvo
                        ? "Expedir certificado de paz y salvo"
                        : `No se puede expedir: el cliente ${statement.motivosPazYSalvoTexto ?? (statement.motivosPazYSalvo ?? []).join(" y ")}.`
                    }
                    onClick={() => void openPdf(`/subscribers/${id}/paz-y-salvo.pdf`)}
                  >
                    <Icon name="shield-check" size={15} /> Paz y salvo
                  </Button>
                  <Button variant="secondary" className="flex-1 sm:flex-none" onClick={() => void openPdf(`/subscribers/${id}/statement.pdf`)}>
                    <Icon name="file-text" size={15} /> Descargar PDF
                  </Button>
                  <Button variant="secondary" className="flex-1 sm:flex-none" onClick={() => void openPdf(`/subscribers/${id}/contract.pdf`)}>
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
          {puedeFacturar && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setFacturaOpen(true)}
                title="Cobrar algo que aún no está facturado: instalación, traslado, reconexión, venta de equipo"
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
              >
                <Icon name="file-plus" size={15} /> Nueva factura
              </button>
            </div>
          )}
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
                  {/* "Ver detalle" salta a /facturacion, que no es ruta del técnico:
                      se lo llevaría el middleware a su inicio. */}
                  {!soloMira && <ActionBtn icon="eye" title="Ver detalle" onClick={() => router.push(`/facturacion/${r.id}`)} />}
                  {r.balance > 0 && r.status !== "CANCELED" && !soloMira && (
                    <ActionBtn icon="dollar-sign" title="Registrar pago" tone="success" onClick={() => setPayOpen(true)} />
                  )}
                  <ActionBtn icon="gift" title="Promociones" tone="warning" onClick={() => setInfoModal({ type: "promo", inv: r })} />
                  <ActionBtn icon="cloud" title="Factura electrónica (Siigo)" tone="info" onClick={() => setInfoModal({ type: "siigo", inv: r })} />
                  {puedeTocarFacturas && (
                    <>
                      <ActionBtn icon="pencil" title="Editar factura" tone="brand" onClick={() => openEditInvoice(r)} />
                      <ActionBtn icon="trash" title="Eliminar factura" tone="error" onClick={() => setConfirmar({ kind: "factura", inv: r })} />
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
        </div>
        );
      })()}

      {/* ── Órdenes de trabajo ──────────────────────────────────────────────
          Es la HISTORIA del cliente, así que se lee como un diario: un bloque por
          día, y dentro del día las órdenes en el orden en que ocurrieron.

          El desorden que se veía aquí no era de la pantalla: `created` es una fecha
          sin hora (así viene del legacy) y el backend las pedía sólo por ella, así
          que las cuatro órdenes de un mismo día —corte de TV, corte de internet y
          sus dos reconexiones— salían barajadas. El orden real lo pone ahora el
          consecutivo (ver `orden-cronologico.ts` en el backend); aquí sólo hay que
          NO volver a mezclarlas y dejar claro de qué día habla cada bloque.

          La hora se muestra cuando existe, que es en las órdenes abiertas en nexus:
          las heredadas no la tienen guardada en ninguna parte y ponerles una sería
          inventarla. */}
      {tab === "ordenes" && (() => {
        const ordenes: any[] = c.workOrders ?? [];
        const total: number = c.workOrdersTotal ?? ordenes.length;
        // Agrupar por día conservando el orden en que llegan (ya vienen ordenadas).
        // `created` es un valor de sólo fecha: el día es su parte UTC, o en Bogotá
        // (UTC-5) el bloque del 01/08 se titularía "31 de julio".
        const dias: { dia: string; items: any[] }[] = [];
        for (const o of ordenes) {
          const dia = String(o.created ?? "").slice(0, 10);
          if (dias[dias.length - 1]?.dia !== dia) dias.push({ dia, items: [] });
          dias[dias.length - 1].items.push(o);
        }
        const hayHeredadas = ordenes.some((o) => !o.createdAt);

        return (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          {ordenes.length ? (
            <>
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border-subtle pb-3">
                <p className="text-[13px] font-semibold text-text-primary">
                  {total} {total === 1 ? "orden" : "órdenes"} en {dias.length} {dias.length === 1 ? "día" : "días"}
                </p>
                {/* El tope existe (200) y hay clientes que lo rozan: si alguna vez
                    recorta, la pantalla lo dice. Antes se comía las que sobraban en
                    silencio y el contador de la pestaña mentía. */}
                {total > ordenes.length && (
                  <p className="text-[11px] text-text-tertiary">
                    Se muestran las {ordenes.length} más recientes · el resto, en{" "}
                    <button type="button" className="underline hover:text-brand" onClick={() => router.push(`/soporte?q=${c.abonado ?? ""}&todo=1`)}>
                      Soporte
                    </button>
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-5">
                {dias.map((g, gi) => (
                  <section key={g.dia}>
                    <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[12px] font-semibold capitalize text-text-primary">
                      {fmtDiaLargo(g.items[0].created)}
                      <span className="text-[11px] font-normal normal-case text-text-tertiary">
                        {g.items.length} {g.items.length === 1 ? "orden" : "órdenes"}
                      </span>
                    </h3>
                    <ol className="relative flex flex-col gap-3 border-l border-border-default pl-5">
                      {g.items.map((o: any, i: number) => {
                        const primera = gi === 0 && i === 0;
                        return (
                        <li key={o.id ?? `${g.dia}-${i}`} className="relative">
                          <span className={`absolute -left-[26px] top-1 flex h-4 w-4 items-center justify-center rounded-full ${primera ? "bg-brand-soft ring-4 ring-brand-soft" : "bg-surface-2"}`}>
                            <Icon name="wrench" size={10} className={primera ? "text-brand" : "text-text-tertiary"} />
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
                            {/* A cuántas megas pasa. 'Subir megas' a secas no dice a
                                cuánto, y había que abrir la orden para saberlo. */}
                            {o.megas && (
                              <p className="mt-1 text-[12px] text-text-secondary">
                                {o.megas.de != null ? `De ${o.megas.de} Megas a ` : "A "}
                                <b className="text-text-primary">
                                  {o.megas.a != null ? `${o.megas.a} Megas` : o.megas.plan}
                                </b>
                                {o.megas.plan && o.megas.a != null ? ` · plan «${o.megas.plan}»` : ""}
                              </p>
                            )}
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
                              {/* La fecha ya la puso el encabezado del día: aquí sólo
                                  la hora, y sólo si es una hora de verdad. */}
                              {o.createdAt && <span className="inline-flex items-center gap-1"><Icon name="clock" size={12} /> {fmtHora(o.createdAt)}</span>}
                              {o.finalDate && (
                                <span className="inline-flex items-center gap-1">
                                  <Icon name="check" size={12} /> Cerrada {fmtDate(o.finalDate)}
                                  {o.resolvedAt && ` · ${fmtHora(o.resolvedAt)}`}
                                </span>
                              )}
                              {o.assigned && <span className="inline-flex items-center gap-1"><Icon name="user-check" size={12} /> {o.assigned}</span>}
                              {o.generadaPor && <span className="inline-flex items-center gap-1"><Icon name="user" size={12} /> Generada por {o.generadaPor}</span>}
                            </div>
                          </button>
                        </li>
                        );
                      })}
                    </ol>
                  </section>
                ))}
              </div>

              {/* Se explica UNA vez, al pie, en lugar de escribir "sin hora" en cada
                  tarjeta heredada —que es la inmensa mayoría— o de dejar que el
                  usuario se pregunte por qué unas tienen hora y otras no. */}
              {hayHeredadas && (
                <p className="mt-4 border-t border-border-subtle pt-3 text-[11px] text-text-tertiary">
                  Las órdenes traídas del sistema anterior no guardan hora. Dentro de un mismo día se
                  ordenan por su número de orden, que es el orden en que se abrieron.
                </p>
              )}
            </>
          ) : (
            <p className="py-4 text-center text-[12px] text-text-tertiary">Este cliente no tiene órdenes de trabajo registradas.</p>
          )}
        </div>
        );
      })()}

      {/* ── Archivos ── */}
      {tab === "archivos" && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          {/* Zona de subida: PRIMERO el tipo de documento, después el archivo. Se
              elige antes a propósito — así el que sube dice para qué es el papel en
              vez de dejarlo suelto, y la carta de retiro o la foto de la vivienda se
              van por su ruta, que es la que las hace valer. */}
          <div className="mb-3 rounded-xl border-2 border-dashed border-border-default p-3">
            <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wide text-text-tertiary" htmlFor="tipo-archivo">
              Tipo de documento
            </label>
            <Select
              id="tipo-archivo"
              value={fileKind}
              disabled={uploading}
              onChange={(e) => setFileKind(e.target.value)}
            >
              <option value="">Elige el tipo…</option>
              {SUB_FILE_KIND_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === "CARTA_RETIRO" && cartaEnFicha ? `${o.label} (reemplazar)` : o.label}
                </option>
              ))}
            </Select>

            <label className={`mt-2 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-default px-4 py-5 text-center transition-colors ${fileKind && !uploading ? "cursor-pointer hover:bg-surface-2" : "pointer-events-none opacity-60"}`}>
              <Icon name={uploading ? "loader" : "file-plus"} size={22} className={uploading ? "animate-spin text-brand" : "text-text-tertiary"} />
              <span className="text-[13px] font-semibold text-text-primary">
                {uploading ? "Subiendo…" : fileKind ? "Elegir archivo" : "Elige primero el tipo de documento"}
              </span>
              <span className="text-[11px] text-text-tertiary">
                {SUB_FILE_KIND_OPTS.find((o) => o.value === fileKind)?.hint ?? "PDF, imágenes, Office, TXT o ZIP"} · máx. 20 MB
              </span>
              <input
                type="file"
                className="hidden"
                disabled={uploading || !fileKind}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && fileKind) void uploadFile(file, fileKind);
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          {/* Filtro por tipo: sólo cuando hay lista que filtrar (las fichas viejas
              traen decenas de adjuntos del sistema anterior). */}
          {files.length > 5 && (tiposEnFicha.length > 1 || (tiposEnFicha.length === 1 && haySinClasificar)) && (
            <div className="mb-3">
              <Select value={filtroKind} onChange={(e) => setFiltroKind(e.target.value)}>
                <option value="">Todos los tipos ({files.length})</option>
                {tiposEnFicha.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label} ({files.filter((f) => f.kind === o.value).length})
                  </option>
                ))}
                {haySinClasificar && <option value="_SIN">Sin clasificar ({files.filter((f) => !f.kind).length})</option>}
              </Select>
            </div>
          )}

          {/* Lista */}
          {filesFiltrados.length ? (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {filesFiltrados.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2.5">
                  <Icon name={fileIcon(f.mimeType)} size={18} className="shrink-0 text-brand" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-text-primary">{f.name}</span>
                      {/* Para qué es el adjunto: sin esto, la carta que habilita el paz
                          y salvo es indistinguible de cualquier otro PDF de la lista. */}
                      {f.kind && <Badge label={SUB_FILE_KIND_LABEL[f.kind] ?? f.kind} tone={SUB_FILE_KIND_TONE[f.kind] ?? "default"} />}
                    </div>
                    <div className="text-[11px] text-text-tertiary">
                      {/* El archivo del sistema anterior no trae fecha de subida (allá
                          la tabla no la guarda): mostrar la de importación haría creer
                          que todos se subieron el mismo día. */}
                      {fmtBytes(f.size)} · {f.legacy ? "Del sistema anterior" : fmtDate(f.createdAt)}
                      {f.uploadedBy && <> · {f.uploadedBy}</>}
                    </div>
                  </div>
                  {(f.mimeType?.startsWith("image/") || f.mimeType === "application/pdf") && (
                    <button type="button" title="Vista previa" onClick={() => void previewFile(f)} className="tap shrink-0 rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2">
                      <Icon name="eye" size={15} />
                    </button>
                  )}
                  <button type="button" title="Descargar" onClick={() => void downloadFile(f)} className="tap shrink-0 rounded-lg border border-border-default p-1.5 text-text-secondary transition-colors hover:bg-surface-2">
                    <Icon name="download" size={15} />
                  </button>
                  <button type="button" title="Eliminar" onClick={() => setConfirmar({ kind: "archivo", file: f })} className="tap shrink-0 rounded-lg border border-border-default p-1.5 text-error-text transition-colors hover:bg-error-soft">
                    <Icon name="x" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-[12px] text-text-tertiary">
              {filtroKind ? "Ningún archivo de ese tipo en esta ficha." : "Aún no hay archivos para este cliente."}
            </p>
          )}
        </div>
      )}

      {confirmar?.kind === "nota" && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void deleteNote(confirmar.nota.id)}
          tone="danger"
          icon="trash"
          title="Eliminar nota del cliente"
          confirmLabel="Eliminar nota"
          message={<>La observación desaparece de la ficha del cliente y no se puede recuperar.</>}
          detail={
            <FichaConfirm
              filas={[
                ["Nota", <span key="a" className="whitespace-pre-wrap">{confirmar.nota.body}</span>],
                ["Autor", confirmar.nota.author ?? "—"],
                ["Fecha", confirmar.nota.createdAt ? new Date(confirmar.nota.createdAt).toLocaleString("es-CO") : "—"],
              ]}
            />
          }
        />
      )}

      {confirmar?.kind === "factura" && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void deleteInvoice(confirmar.inv)}
          tone="danger"
          icon="trash"
          title="Eliminar factura del cliente"
          confirmLabel="Eliminar factura"
          // Toca dinero y no hay vuelta atrás: se teclea el número de factura.
          requireText={String(confirmar.inv.tid ?? "")}
          requireHint={<>Para confirmar, escribe el número de factura <span className="font-mono font-semibold text-text-primary">{confirmar.inv.tid}</span></>}
          message={
            <>
              La factura se borra de la cartera del cliente y el saldo pendiente se recalcula.{" "}
              <b className="text-error-text">No se puede deshacer.</b>
            </>
          }
          detail={
            <FichaConfirm
              filas={[
                ["N° Factura", <span key="a" className="font-mono">{confirmar.inv.tid ?? "—"}</span>],
                ...(confirmar.inv.date ? ([["Fecha", fmtDate(confirmar.inv.date)]] as [string, React.ReactNode][]) : []),
                ...(confirmar.inv.total != null ? ([["Importe", <span key="c" className="font-mono">{cop(confirmar.inv.total)}</span>]] as [string, React.ReactNode][]) : []),
                ...(confirmar.inv.status
                  ? ([["Estado", <Badge key="d" label={INVOICE_STATUS_LABEL[confirmar.inv.status] ?? confirmar.inv.status} tone={INVOICE_STATUS_TONE[confirmar.inv.status] ?? "default"} />]] as [string, React.ReactNode][])
                  : []),
              ]}
            />
          }
        />
      )}

      {confirmar?.kind === "archivo" && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void deleteFile(confirmar.file)}
          tone="danger"
          icon="trash"
          title="Eliminar archivo adjunto"
          confirmLabel="Eliminar archivo"
          message={<>El adjunto se borra del expediente del cliente y no se podrá volver a descargar.</>}
          detail={
            <FichaConfirm
              filas={[
                ["Archivo", confirmar.file.name],
                ["Tamaño", fmtBytes(confirmar.file.size)],
                ["Subido", `${fmtDate(confirmar.file.createdAt)}${confirmar.file.uploadedBy ? ` · ${confirmar.file.uploadedBy}` : ""}`],
              ]}
            />
          }
        />
      )}
    </>
  );
}
