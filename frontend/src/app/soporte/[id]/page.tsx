"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Dropdown, MenuItem } from "@/components/ui/Dropdown";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { useAuth } from "@/context/AuthProvider";
import { cop, waLink } from "@/lib/subscribers";
import { TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";
import { AsignarEquipoModal } from "@/components/soporte/AsignarEquipoModal";
import { AutenticarOnuOrden } from "@/components/soporte/AutenticarOnuOrden";
import { ConsumirMaterialModal } from "@/components/soporte/ConsumirMaterialModal";
import { SignaturePad } from "@/components/support/SignaturePad";
import { fmtDate } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";
import { CapturarGps } from "@/components/map/CapturarGps";
import { MOTIVO_GEO, distMetros, pedirUbicacion } from "@/lib/geo";

const fmtT = (d: string | null) => (d ? new Date(d).toLocaleString("es-CO") : "—");
const STATES = ["PENDIENTE", "REALIZANDO", "RESUELTO", "ANULADA"];
const SERVICE_LABEL: Record<string, string> = { INTERNET: "Internet", TV: "TV", PUNTOS: "Puntos TV", STREAMING: "Streaming" };

/**
 * El paso natural desde el estado en el que está la orden. Es el botón grande de
 * la cabecera: el técnico abre la orden para hacer UNA cosa (empezarla o
 * cerrarla), y tenerla al mismo peso que "anular" la escondía entre iguales.
 */
const SIGUIENTE: Record<string, { estado: string; label: string; icon: string }> = {
  PENDIENTE: { estado: "REALIZANDO", label: "Empezar", icon: "play" },
  REALIZANDO: { estado: "RESUELTO", label: "Cerrar orden", icon: "check" },
};

/** Causas/soluciones predefinidas (migradas del select del legacy tickets/thread). */
const SOLUCIONES = [
  "Cablemoden desconfigurado", "Mantenimiento a la Red", "Cambio de Tecnologia", "Fusiono Fibra",
  "Cambio de Fibra", "Cambio de Cable RG 6", "Reestructuracion Red", "Instalo Caja NAP",
  "Instalaciones Internas en Mal estado", "Manipulacion del Usuario", "Daño General", "Sin energia el Sector",
  "Elementos Quemados", "Internet lento", "No aparece la Red", "No prende Cablemoden", "Fibra Rota",
  "Cable Caido", "ONU alarmada", "Desconfigurado Cablemoden", "No hay Internet",
  "Fallo Causado por Proveedor de Servicio", "Fallo en centro de datos principal", "Baja cobertura wifi interna",
  "Cambio de conectores mecánicos", "Cambio de equipo por daño", "Cambio de Patch Cord de fibra",
  "Cambio de tendido de fibra óptica", "Condiciones de equipo final fuera de parámetros de operación",
  "Configuración de red lan del cliente", "Entrega de servicio a satisfacción", "Equipo de cliente final por defecto",
  "Habilitación de servicio de internet", "Habilitación de servicio de televisión", "Mantenimiento Correctivo de red",
  "Mejoramiento de infraestructura de red", "Migración de Tecnología", "Retiro de equipos de comunicaciones",
  "Revisión de red interna del cliente", "Suministro de equipos o material", "Traslado de equipos por cambio de vivienda",
  "Traslado interno de equipos de red en cliente final", "Viabilidad y/o levantamiento técnico",
  "Punto de distribución de red intermitente o in-operativo",
];

/**
 * Separa la causa del texto del renglón del hilo.
 *
 * Al documentar se guarda `"<causa>/ <texto>"` (formato heredado del legacy), y
 * hasta ahora se pintaba crudo: los mensajes sin causa empezaban con una barra
 * suelta ("/ Daño cajas nap") y la causa, que es el dato clasificable, se leía
 * como parte de la frase.
 */
function partirMensaje(msg: string | null): { causa: string | null; texto: string | null } {
  const m = (msg ?? "").trim();
  if (!m) return { causa: null, texto: null };
  const i = m.indexOf("/");
  if (i < 0) return { causa: null, texto: m };
  const posible = m.slice(0, i).trim();
  const resto = m.slice(i + 1).trim();
  if (!posible) return { causa: null, texto: resto || null };
  const causa = SOLUCIONES.find((s) => s.toLowerCase() === posible.toLowerCase());
  return causa ? { causa, texto: resto || null } : { causa: null, texto: m };
}

/** Fila etiqueta: valor de la ficha lateral. */
function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-[13px] leading-relaxed">
      <span className="shrink-0 font-semibold text-text-secondary">{label}:</span>
      <span className="min-w-0 break-words text-text-primary">{children ?? "—"}</span>
    </div>
  );
}

/** Encabezado común de las tarjetas de la ficha. */
function CardTitle({ icon, children, right }: { icon: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
        <Icon name={icon} size={15} className="text-brand" />
        {children}
      </div>
      {right}
    </div>
  );
}

/** Botón-enlace compacto de contacto/navegación (llamar, WhatsApp, cómo llegar). */
function Chip({ href, icon, children }: { href: string; icon: string; children: React.ReactNode }) {
  const externo = href.startsWith("http");
  return (
    <a
      href={href}
      target={externo ? "_blank" : undefined}
      rel={externo ? "noopener noreferrer" : undefined}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border-default px-2.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
    >
      <Icon name={icon} size={13} /> {children}
    </a>
  );
}

/** Preview autenticado de la foto del hilo (fetch como blob, ya que el endpoint pide token). */
function ThreadImage({ threadId }: { threadId: string }) {
  const { authFetch } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [fail, setFail] = useState(false);
  useEffect(() => {
    let obj: string | null = null;
    void authFetch(`/support/threads/${threadId}/attachment`)
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => { obj = URL.createObjectURL(b); setUrl(obj); })
      .catch(() => setFail(true));
    return () => { if (obj) URL.revokeObjectURL(obj); };
  }, [authFetch, threadId]);
  if (fail) return <p className="mt-1 text-[11px] text-error-text">No se pudo cargar la imagen.</p>;
  if (!url) return <div className="mt-1 h-40 w-56 animate-pulse rounded-lg bg-surface-2" />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block">
      <img src={url} alt="Evidencia de la orden" className="max-h-64 max-w-xs rounded-lg border border-border-subtle object-cover" />
    </a>
  );
}

export default function OrdenDetallePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();
  const [t, setT] = useState<any | null>(null);
  const [err, setErr] = useState(false);
  const [techs, setTechs] = useState<any[]>([]);
  const [reply, setReply] = useState("");
  const [solucion, setSolucion] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [assign, setAssign] = useState("");
  const [sig, setSig] = useState<{ name: string; cc: string; rel: string; image?: string | null }>({ name: "", cc: "", rel: "", image: null });
  const [busy, setBusy] = useState(false);
  const [eqModal, setEqModal] = useState(false);
  const [matModal, setMatModal] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  /** Firmar una orden ya cerrada es la excepción: el bloque arranca plegado. */
  const [verFirma, setVerFirma] = useState(false);
  /** Bloqueo de la geo-cerca pendiente de justificar. */
  const [cerca, setCerca] = useState<{
    estado: string; razon: string; message: string; distanciaM?: number; radioM?: number;
  } | null>(null);
  const [motivo, setMotivo] = useState("");

  /** Abre el PDF de la orden (endpoint autenticado → blob → pestaña nueva). */
  async function abrirPdf() {
    setPdfBusy(true);
    try {
      const res = await authFetch(`/support/tickets/${id}/pdf`);
      if (!res.ok) throw new Error("No se pudo generar el PDF");
      const url = URL.createObjectURL(new Blob([await res.blob()], { type: "application/pdf" }));
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setPdfBusy(false); }
  }

  const reload = useCallback(() => {
    void authFetch(`/support/tickets/${id}`).then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => { setT(d); setAssign(d.assigned || ""); }).catch(() => setErr(true));
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading) return;
    reload();
    void authFetch("/support/technicians").then((r) => r.json()).then(setTechs).catch(() => {});
  }, [authLoading, reload, authFetch]);

  async function post(url: string, body: any, okMsg: string) {
    setBusy(true);
    try {
      const res = await authFetch(url, { method: "POST", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(okMsg); reload();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
  }

  /**
   * Cambia el estado de la orden. Al cerrarla (RESUELTO) adjunta la ubicación:
   * el servidor comprueba que el técnico esté en el domicilio (geo-cerca).
   *
   * Se manda SIEMPRE que se pueda, aunque el cliente no tenga coordenada
   * guardada: en ese caso el propio cierre lo georreferencia.
   */
  async function cambiarEstado(nuevo: string, justificacion?: string) {
    const etiqueta = TICKET_STATUS_LABEL[nuevo] ?? nuevo;
    let geo: Record<string, number> = {};
    if (nuevo === "RESUELTO") {
      setBusy(true);
      const yo = await pedirUbicacion().finally(() => setBusy(false));
      if (yo.ok) geo = { lat: yo.lat, lng: yo.lng, accuracyM: yo.accuracy };
    }

    setBusy(true);
    try {
      const res = await authFetch(`/support/tickets/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: nuevo, ...geo, ...(justificacion ? { justificacion } : {}) }),
      });
      const d = await res.json();
      if (!res.ok) {
        // 422 con code GEOFENCE = la orden no se cerró porque el técnico no está
        // donde debería. No es un error a secas: se le ofrece justificar.
        if (res.status === 422 && d?.code === "GEOFENCE") {
          setCerca({ estado: nuevo, ...d });
          return;
        }
        throw new Error(d?.message || "Error");
      }
      setCerca(null);
      setMotivo("");
      toast(`Estado: ${etiqueta}`);
      reload();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setBusy(false);
    }
  }

  async function documentar() {
    const msg = solucion ? `${solucion}/ ${reply.trim()}`.trim() : reply.trim();
    // Con foto → multipart al endpoint de evidencia (intenta geo-etiquetar).
    if (photo) {
      setBusy(true);
      try {
        const geo = await pedirUbicacion();
        const fd = new FormData();
        fd.append("file", photo);
        if (msg) fd.append("message", msg);
        if (geo.ok) { fd.append("lat", String(geo.lat)); fd.append("lng", String(geo.lng)); }
        const res = await authFetch(`/support/tickets/${id}/attach`, { method: "POST", body: fd });
        const d = await res.json();
        if (!res.ok) throw new Error(d?.message || "No se pudo subir la foto");
        // El motivo importa: "requiere HTTPS" era la excusa fija, pero lo normal
        // es que el técnico haya denegado el permiso o esté bajo techo sin GPS.
        toast(geo.ok ? "Foto subida con ubicación" : `Foto subida sin ubicación. ${MOTIVO_GEO[geo.motivo]}`);
        setReply(""); setSolucion(""); setPhoto(null); reload();
      } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
      return;
    }
    // Solo texto → hilo normal.
    post(`/support/tickets/${id}/thread`, { message: msg }, "Respuesta agregada");
    setReply(""); setSolucion("");
  }

  if (authLoading || (!t && !err)) return <PageSkeleton />;
  if (err) return <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">Orden no encontrada. <Link href="/soporte" className="text-brand">Volver</Link></div>;

  const s = t.subscriber;
  const serviciosStr: string = s?.services?.length ? s.services.map((x: any) => `${SERVICE_LABEL[x.kind] ?? x.kind}: ${x.plan ?? "—"}`).join(" · ") : "";
  const eq = t.equipment?.[0];
  const equipoStr: string = eq ? `${eq.mac ?? "sin MAC"}  ${eq.installType ?? ""}${eq.vlan != null ? ` V:${eq.vlan}` : ""}${eq.nat != null ? ` N:${eq.nat}` : ""}${eq.port != null ? ` PN:${eq.port}` : ""}`.trim() : (s?.macEquipo || "");
  const debt = Number(s?.debt ?? 0);
  const abierta = t.status !== "RESUELTO" && t.status !== "ANULADA";
  const paso = SIGUIENTE[t.status];
  const wa = waLink(s?.phone);
  // El barrio NO tapa la falta de dirección: llegar a "Mirador" no es llegar a
  // una casa, y con la dirección vacía el técnico tiene que llamar antes de salir.
  const direccion: string | null = s?.address?.trim() ? [s.address.trim(), s.barrio].filter(Boolean).join(" · ") : null;
  const referencia = [s?.residencia, s?.referencia].filter(Boolean).join(" / ");

  return (
    <div className="w-full">
      {/* Esta pantalla se trabaja desde el celular, en la calle: el encabezado
          común ya baja los controles a ancho completo en móvil, y el botón del
          paso siguiente ocupa la fila entero, donde el pulgar lo alcanza.

          El título es el TIPO de trabajo ("Revisión de internet"), no la clase
          ("reclamo"): es lo que el técnico va a hacer. La clase queda de etiqueta. */}
      <DetailHeader
        backHref="/soporte"
        backLabel="Soporte"
        icon="wrench"
        title={<>{t.type || t.subject} <span className="text-text-tertiary">Nº {t.code ?? "—"}</span></>}
        badges={
          <>
            <Badge label={TICKET_STATUS_LABEL[t.status] ?? t.status} tone={TICKET_STATUS_TONE[t.status] ?? "default"} />
            {t.subject && t.subject !== t.type && <Badge label={t.subject} tone="info" />}
            {t.priority && <Badge label={`Prioridad: ${t.priority}`} tone={TICKET_PRIORITY_TONE[t.priority] ?? "default"} />}
            {/* Puntaje del trabajo. Si ya está cerrada muestra lo que se selló;
                si sigue abierta, lo que va a valer — que es lo que el técnico
                necesita saber antes de salir, no cuando ya volvió. */}
            {t.score != null ? (
              <Badge label={`${t.score} ${t.score === 1 ? "punto" : "puntos"}`} tone="success" />
            ) : t.puntajeVigente != null && t.status !== "ANULADA" ? (
              <Badge label={`Vale ${t.puntajeVigente} ${t.puntajeVigente === 1 ? "punto" : "puntos"}`} tone="default" />
            ) : null}
          </>
        }
        subtitle={<>Creada {fmtDate(t.created)}{t.finalDate ? ` · Finalizada ${fmtDate(t.finalDate)}` : ""}{t.assigned ? ` · Técnico: ${t.assigned}` : " · Sin técnico asignado"}</>}
        actions={
          <>
            <Button variant="secondary" size="sm" disabled={pdfBusy} onClick={abrirPdf} className="w-full sm:w-auto">
              <Icon name="download" size={13} /> {pdfBusy ? "Generando…" : "Orden PDF"}
            </Button>
            {paso && (
              <Button size="sm" disabled={busy} onClick={() => void cambiarEstado(paso.estado)} className="w-full sm:w-auto">
                <Icon name={paso.icon} size={13} /> {paso.label}
              </Button>
            )}
            {/* Los demás estados no compiten con el paso natural: viven en el menú
                (antes eran tres botones iguales, y "Anulada" quedaba al lado de
                "Cerrar" con el mismo peso visual). */}
            <Dropdown
              width={230}
              triggerClassName="w-full sm:w-auto"
              trigger={
                <span className="inline-flex min-h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2 sm:w-auto">
                  <Icon name="ellipsis" size={14} /> Cambiar estado
                </span>
              }
            >
              {({ close }) => (
                <>
                  {STATES.filter((x) => x !== t.status && x !== paso?.estado).map((x) => (
                    <MenuItem key={x} danger={x === "ANULADA"} onClick={() => { close(); void cambiarEstado(x); }}>
                      <Icon name={x === "ANULADA" ? "ban" : x === "RESUELTO" ? "check" : "rotate-cw"} size={14} />
                      {TICKET_STATUS_LABEL[x] ?? x}
                    </MenuItem>
                  ))}
                </>
              )}
            </Dropdown>
          </>
        }
      />

      {/* Dos columnas desde xl: el trabajo a la izquierda y el cliente —a quién
          se va a ver y dónde— fijo a la derecha. En pantallas menores se apila,
          y el cliente va PRIMERO: es lo que se mira antes de arrancar. */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <div className="order-2 flex min-w-0 flex-col gap-3 xl:order-1">
          {/* Trabajo a realizar */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle icon="clipboard-list">Trabajo a realizar</CardTitle>
            {t.problem && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Falla reportada</div>
                <p className="whitespace-pre-wrap text-[14px] font-semibold text-text-primary">{t.problem}</p>
              </div>
            )}
            {t.section && (
              <div className="mt-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Observaciones</div>
                <p className="whitespace-pre-wrap text-[13px] text-text-secondary">{t.section}</p>
              </div>
            )}
            {!t.problem && !t.section && <p className="mt-1 text-[12px] text-text-tertiary">Sin descripción del problema.</p>}
          </div>

          {/* Autenticar la ONU contra la OLT (solo en órdenes que lo requieren).
              Se monta aquí, junto a la instalación, y no en una pantalla aparte:
              la velocidad la pone el plan, así que no hay nada más que preguntar. */}
          <AutenticarOnuOrden ticketId={id} tipo={t.type} estadoOrden={t.status} onDone={reload} />

          {/* Equipo asignado + material consumido */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle
              icon="boxes"
              right={
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setEqModal(true)}><Icon name="radio-tower" size={13} /> Asignar equipo</Button>
                  <Button variant="secondary" size="sm" onClick={() => setMatModal(true)}><Icon name="package-check" size={13} /> Registrar material</Button>
                </div>
              }
            >
              Equipo y material
            </CardTitle>

            {/* Equipos del cliente */}
            {t.equipment?.length ? (
              <ul className="mb-2 flex flex-col gap-1">
                {t.equipment.map((e: any, i: number) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg bg-surface-2 px-3 py-1.5 text-[12px]">
                    <span className="font-mono font-semibold text-text-primary">{e.mac ?? "sin MAC"}</span>
                    {e.installType && <span className="text-text-secondary">{e.installType}</span>}
                    {e.serial && <span className="text-text-tertiary">S/N {e.serial}</span>}
                    {e.port != null && <span className="text-text-tertiary">PN:{e.port}</span>}
                    {e.nat != null && <span className="text-text-tertiary">N:{e.nat}</span>}
                    {e.vlan != null && <span className="text-text-tertiary">V:{e.vlan}</span>}
                    {e.status && <Badge label={e.status} tone="default" />}
                    {/* El equipo que está autenticado en la OLT, con el plan que le
                        rige: sin esto había que abrir Red › OLT para saberlo. */}
                    {e.esOnu && (
                      <>
                        <Badge label={`ONU${e.onuEstado ? ` · ${e.onuEstado}` : ""}`} tone={/online/i.test(e.onuEstado ?? "") ? "success" : "default"} />
                        {e.plan && (
                          <span className="text-text-secondary">
                            <Icon name="gauge" size={12} className="mr-0.5 inline text-brand" />
                            {e.plan}{e.megas != null ? ` · ${e.megas} Mbps` : ""}
                          </span>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="mb-2 text-[12px] text-text-tertiary">Sin equipo asignado.</p>}

            {/* Material consumido */}
            {t.materials?.length ? (
              <div className="overflow-x-auto rounded-lg border border-border-subtle">
                <table className="w-full text-[12px]">
                  <thead><tr className="border-b border-border-subtle bg-surface-2 text-left text-text-tertiary">
                    <th className="px-3 py-1.5 font-semibold">Material</th><th className="px-3 py-1.5 text-right font-semibold">Cant.</th>
                    <th className="px-3 py-1.5 text-right font-semibold">V. unit.</th><th className="px-3 py-1.5 text-right font-semibold">Total</th>
                  </tr></thead>
                  <tbody>
                    {t.materials.map((m: any) => (
                      <tr key={m.id} className="border-b border-border-subtle last:border-0">
                        <td className="px-3 py-1.5 text-text-primary">{m.name}{m.warehouse ? <span className="ml-1 text-[10px] text-text-tertiary">· {m.warehouse}</span> : null}</td>
                        <td className="px-3 py-1.5 text-right text-text-secondary">{m.qty}</td>
                        <td className="px-3 py-1.5 text-right text-text-secondary">{cop(m.price)}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-text-primary">{cop(m.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="bg-surface-2 font-bold text-text-primary">
                    <td className="px-3 py-1.5" colSpan={3}>Total material</td>
                    <td className="px-3 py-1.5 text-right">{cop(t.materials.reduce((sm: number, m: any) => sm + m.total, 0))}</td>
                  </tr></tfoot>
                </table>
              </div>
            ) : <p className="text-[12px] text-text-tertiary">Sin material registrado.</p>}
          </div>

          {/* Hilo de respuestas. Va primero lo que YA pasó y al pie el formulario:
              se lee como una conversación, y quien llega a documentar baja hasta
              el final habiendo visto lo que hicieron antes. */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle icon="message-square">Seguimiento ({t.threads?.length ?? 0})</CardTitle>

            {t.threads?.length ? (
              <ol className="mb-3 flex flex-col gap-3">
                {t.threads.map((h: any) => {
                  const { causa, texto } = partirMensaje(h.message);
                  return (
                    <li key={h.id} className="flex gap-3 border-b border-border-subtle pb-3 last:border-0 last:pb-0">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2"><Icon name="message-square" size={13} className="text-text-tertiary" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] text-text-tertiary">
                          <span className="font-semibold text-text-secondary">{h.author ?? (h.employeeId ? `Empleado #${h.employeeId}` : "Sistema")}</span>
                          {" · "}{fmtT(h.date)}
                        </p>
                        {causa && <span className="mt-1 inline-block"><Badge label={causa} tone="info" /></span>}
                        {texto && <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-text-primary">{texto}</p>}
                        {!texto && !causa && <p className="mt-0.5 text-[12px] italic text-text-tertiary">Sin texto</p>}
                        {h.attach && <ThreadImage threadId={h.id} />}
                        {h.geoLat && h.geoLng && (
                          <a href={`https://www.google.com/maps/search/?api=1&query=${h.geoLat},${h.geoLng}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
                            <Icon name="map-pin" size={11} /> Ubicación de la foto
                            {s?.gpsLat && s?.gpsLng && (() => {
                              const d = distMetros({ lat: Number(h.geoLat), lng: Number(h.geoLng) }, { lat: Number(s.gpsLat), lng: Number(s.gpsLng) });
                              return <span className={d <= 150 ? "text-success-text" : "text-warning-text"}>· a ~{d} m del cliente</span>;
                            })()}
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : <p className="mb-3 text-[12px] text-text-tertiary">Sin mensajes de seguimiento.</p>}

            {/* Formulario de respuesta */}
            <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
              <Select value={solucion} onChange={(e) => setSolucion(e.target.value)}>
                <option value="">— Solución / causa (opcional) —</option>
                {SOLUCIONES.map((x) => <option key={x} value={x}>{x}</option>)}
              </Select>
              <Textarea rows={3} placeholder="Escribe la documentación / avance…" value={reply} onChange={(e) => setReply(e.target.value)} />
              {/* Foto de evidencia (con cámara en móvil; intenta geo-etiquetar al subir) */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
                  <Icon name="camera" size={14} /> {photo ? "Cambiar foto" : "Adjuntar foto"}
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
                </label>
                {photo && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
                    <Icon name="file-text" size={12} /> {photo.name}
                    <button type="button" onClick={() => setPhoto(null)} className="text-error-text hover:underline"><Icon name="x" size={12} /></button>
                  </span>
                )}
                <span className="grow" />
                <Button disabled={busy || (!reply.trim() && !solucion && !photo)} onClick={documentar}>{photo ? "Subir evidencia" : "Documentar"}</Button>
              </div>
              {photo && <p className="text-[10px] text-text-tertiary">Se intentará adjuntar la ubicación del dispositivo (requiere HTTPS; sobre HTTP la foto sube sin coordenadas).</p>}
            </div>
          </div>

          {/* Acta de recibido / firma. Con la orden cerrada y sin firma el bloque
              va plegado: eran 300 px de lienzo en blanco al pie de cada orden
              vieja, y firmar a destiempo es la excepción, no lo normal. */}
          <div className="mb-6 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle
              icon="user-check"
              right={
                !t.signature && !abierta ? (
                  <Button variant="ghost" size="sm" onClick={() => setVerFirma((v) => !v)}>
                    {verFirma ? "Ocultar" : "Firmar de todos modos"}
                  </Button>
                ) : undefined
              }
            >
              Firma de quien recibe
            </CardTitle>
            {t.signature ? (
              <div className="flex flex-col gap-2">
                <p className="text-[12px] text-text-secondary">Firmó: <b>{t.signature.name}</b> {t.signature.cc ? `(CC ${t.signature.cc})` : ""} {t.signature.rel ? `· ${t.signature.rel}` : ""}</p>
                {t.signature.hasImage && <img src={`${process.env.NEXT_PUBLIC_API_URL ?? ""}/support/tickets/${id}/signature.png`} alt="Firma" className="h-24 w-auto rounded border border-border-subtle bg-white" />}
              </div>
            ) : !abierta && !verFirma ? (
              <p className="text-[12px] text-text-tertiary">Esta orden se cerró sin acta firmada.</p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <Input className="min-w-[140px] flex-1" placeholder="Nombre completo quien recibe" value={sig.name} onChange={(e) => setSig({ ...sig, name: e.target.value })} />
                  <Input className="w-28" placeholder="Cédula" value={sig.cc} onChange={(e) => setSig({ ...sig, cc: e.target.value })} />
                  <Input className="w-32" placeholder="Parentesco" value={sig.rel} onChange={(e) => setSig({ ...sig, rel: e.target.value })} />
                </div>
                <SignaturePad onChange={(img) => setSig((s) => ({ ...s, image: img }))} />
                <div className="flex justify-end">
                  <Button size="sm" disabled={busy || !sig.name.trim()} onClick={() => post(`/support/tickets/${id}/signature`, sig, "Acta guardada")}>Guardar firma</Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Columna del cliente: a quién se va a ver, dónde y con qué servicio. */}
        <aside className="order-1 flex min-w-0 flex-col gap-3 xl:order-2">
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle icon="user">Cliente</CardTitle>
            {s ? (
              <>
                <Link href={`/clientes/${s.id}`} className="text-[15px] font-bold text-brand hover:underline">{s.name}</Link>
                <p className="mt-0.5 text-[12px] text-text-tertiary">
                  Abonado {s.abonado ?? "—"}{s.doc ? ` · CC ${s.doc}` : ""}{s.branch ? ` · ${s.branch}` : ""}
                </p>

                {/* Contacto: en la calle esto es un toque, no un dato para copiar. */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.phone && <Chip href={`tel:${s.phone}`} icon="phone">{s.phone}</Chip>}
                  {wa && <Chip href={wa} icon="message-circle">WhatsApp</Chip>}
                  {s.phone2 && <Chip href={`tel:${s.phone2}`} icon="phone">{s.phone2}</Chip>}
                </div>

                {/* Dirección. Un guion suelto era todo lo que veía el técnico de
                    una orden sin dirección; ahora se dice y se ofrece el GPS. */}
                <div className="mt-3 border-t border-border-subtle pt-2">
                  {direccion ? (
                    <p className="flex items-start gap-1.5 text-[13px] text-text-primary">
                      <Icon name="map-pin" size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
                      <span>{direccion}</span>
                    </p>
                  ) : (
                    <p className="flex items-start gap-1.5 rounded-lg bg-warning-soft px-2 py-1.5 text-[12px] text-warning-text">
                      <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
                      <span>
                        Sin dirección registrada{s.barrio ? ` (barrio ${s.barrio})` : ""}. Confírmala por
                        teléfono antes de salir.
                      </span>
                    </p>
                  )}
                  {referencia && <p className="mt-1 pl-5 text-[12px] text-text-tertiary">Ref.: {referencia}</p>}
                  <p className="mt-1 pl-5 text-[11px] text-text-tertiary">
                    {s.gpsLat && s.gpsLng ? `GPS ${s.gpsLat}, ${s.gpsLng}` : "Sin coordenadas registradas"}
                  </p>
                  {/* Las dos cosas que hace el técnico con la ubicación de una orden:
                      llegar hasta ella, y —ya que está en la puerta— dejarla marcada.
                      La ruta se dibuja dentro del sistema, no en una pestaña aparte. */}
                  {s.id && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {s.gpsLat && s.gpsLng && (
                        <Link
                          href={`/mapa/ruta?abonado=${s.id}&nombre=${encodeURIComponent(s.name ?? "")}&volver=${encodeURIComponent(`/soporte/${id}`)}`}
                          className="inline-flex min-h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border-default px-2.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
                        >
                          <Icon name="navigation" size={13} /> Cómo llegar
                        </Link>
                      )}
                      <CapturarGps
                        subscriberId={s.id}
                        actual={s.gpsLat && s.gpsLng ? { lat: Number(s.gpsLat), lng: Number(s.gpsLng) } : null}
                        onGuardado={reload}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : <p className="text-[12px] text-text-tertiary">Sin cliente asociado.</p>}
          </div>

          {s && (
            <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
              <CardTitle icon="tv">Servicio y saldo</CardTitle>
              <KV label="Servicios">{serviciosStr || "Sin servicios registrados"}</KV>
              <KV label="Equipo"><span className="font-mono">{equipoStr || "Sin equipo"}</span></KV>
              <KV label="Perfil de red">{s.profile || "—"}</KV>
              {/* La deuda no es solo un número: si el técnico llega y el cliente
                  debe, tiene que poder abrir su cuenta ahí mismo. */}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-semibold text-text-secondary">Deuda actual:</span>
                  <span className={`text-[16px] font-bold ${debt > 0 ? "text-error-text" : "text-success-text"}`}>{cop(debt)}</span>
                </div>
                {debt > 0 && (
                  <Link href={`/clientes/${s.id}`} className="text-[12px] font-semibold text-brand hover:underline">Ver facturas</Link>
                )}
              </div>
            </div>
          )}

          {/* Gestión: lo que cambia la cajera/coordinación, no el técnico en la
              puerta. Por eso baja de la cabecera a su propia tarjeta. */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle icon="settings">Gestión de la orden</CardTitle>
            <div className="mb-1 text-[11px] font-semibold text-text-tertiary">Técnico asignado</div>
            <div className="flex gap-2">
              <Select value={assign} onChange={(e) => setAssign(e.target.value)}>
                <option value="">— Sin asignar —</option>
                {techs.map((tt) => <option key={tt.id} value={tt.name}>{tt.name}</option>)}
              </Select>
              <Button size="sm" disabled={busy || assign === (t.assigned || "")} onClick={() => post(`/support/tickets/${id}/assign`, { assigned: assign }, "Técnico asignado")}>Guardar</Button>
            </div>
            <div className="mb-1 mt-3 text-[11px] font-semibold text-text-tertiary">Prioridad</div>
            <Select value={t.priority ?? "Media"} disabled={busy}
              onChange={(e) => post(`/support/tickets/${id}/priority`, { priority: e.target.value }, `Prioridad: ${e.target.value}`)}>
              {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
            <p className="mt-2 text-[11px] text-text-tertiary">Creada el {fmtT(t.created)}.</p>
          </div>
        </aside>
      </div>

      <AsignarEquipoModal open={eqModal} onClose={() => setEqModal(false)} onDone={reload} ticketId={id} />
      <ConsumirMaterialModal open={matModal} onClose={() => setMatModal(false)} onDone={reload} ticketId={id} />

      {/* Geo-cerca: la orden NO se cerró. O se acerca al domicilio, o explica por qué no. */}
      <Modal
        open={!!cerca}
        onClose={() => { setCerca(null); setMotivo(""); }}
        title="No se pudo cerrar la orden"
        maxWidth="max-w-md"
      >
        {cerca && (
          <div className="space-y-3">
            <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
              {cerca.message}
            </p>

            {cerca.razon === "sin-ubicacion" ? (
              <>
                <p className="text-[12.5px] text-text-tertiary">
                  Esta orden es de las que se atienden en el domicilio del cliente, así que hace
                  falta tu ubicación para cerrarla. Revisa que el GPS esté encendido y que el
                  navegador tenga permiso.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setCerca(null)}>Cancelar</Button>
                  <Button onClick={() => void cambiarEstado(cerca.estado)} disabled={busy}>
                    {busy ? "Ubicando…" : "Reintentar"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-[12.5px] text-text-secondary">
                  Si estás en el domicilio y el GPS no agarra bien, acércate a una ventana o sal un
                  momento y reintenta. Si de verdad tienes que cerrarla desde donde estás, escribe
                  el motivo: queda registrado en la orden y lo revisa administración.
                </p>
                <Textarea
                  rows={3}
                  placeholder="Ej.: el cliente confirmó por teléfono que ya tiene servicio; la casa no aparece en el GPS…"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="secondary" onClick={() => { setCerca(null); setMotivo(""); }}>
                    Cancelar
                  </Button>
                  <Button variant="secondary" onClick={() => void cambiarEstado(cerca.estado)} disabled={busy}>
                    Reintentar ubicación
                  </Button>
                  <Button
                    onClick={() => void cambiarEstado(cerca.estado, motivo.trim())}
                    disabled={busy || motivo.trim().length < 10}
                  >
                    Cerrar con este motivo
                  </Button>
                </div>
                {motivo.trim().length > 0 && motivo.trim().length < 10 && (
                  <p className="text-right text-[11px] text-text-tertiary">
                    Explica un poco más (mínimo 10 caracteres).
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
