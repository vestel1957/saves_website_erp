"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";
import { AsignarEquipoModal } from "@/components/soporte/AsignarEquipoModal";
import { ConsumirMaterialModal } from "@/components/soporte/ConsumirMaterialModal";
import { SignaturePad } from "@/components/support/SignaturePad";

const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("es-CO") : "—");
const fmtT = (d: string | null) => (d ? new Date(d).toLocaleString("es-CO") : "—");
const STATES = ["PENDIENTE", "REALIZANDO", "RESUELTO", "ANULADA"];
const SERVICE_LABEL: Record<string, string> = { INTERNET: "Internet", TV: "TV", PUNTOS: "Puntos TV", STREAMING: "Streaming" };

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

/** Fila etiqueta: valor de la ficha (estilo legacy: "Etiqueta: valor"). */
function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-[13px] leading-relaxed">
      <span className="shrink-0 font-semibold text-text-secondary">{label}:</span>
      <span className="min-w-0 break-words text-text-primary">{children ?? "—"}</span>
    </div>
  );
}

/** Captura la ubicación del dispositivo. Devuelve null si el navegador la bloquea (p.ej. HTTP) o el usuario niega. */
function getGeo(): Promise<{ lat: string; lng: string } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  });
}

/** Distancia aproximada en metros entre dos coordenadas (haversine). */
function distMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
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

  /** Abre el PDF de la orden (endpoint autenticado → blob → pestaña nueva). */
  async function abrirPdf() {
    setPdfBusy(true);
    try {
      const res = await authFetch(`/support/tickets/${id}/pdf`);
      if (!res.ok) throw new Error("No se pudo generar el PDF");
      const url = URL.createObjectURL(new Blob([await res.blob()], { type: "application/pdf" }));
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setPdfBusy(false); }
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
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setBusy(false); }
  }

  async function documentar() {
    const msg = solucion ? `${solucion}/ ${reply.trim()}`.trim() : reply.trim();
    // Con foto → multipart al endpoint de evidencia (intenta geo-etiquetar).
    if (photo) {
      setBusy(true);
      try {
        const geo = await getGeo();
        const fd = new FormData();
        fd.append("file", photo);
        if (msg) fd.append("message", msg);
        if (geo) { fd.append("lat", geo.lat); fd.append("lng", geo.lng); }
        const res = await authFetch(`/support/tickets/${id}/attach`, { method: "POST", body: fd });
        const d = await res.json();
        if (!res.ok) throw new Error(d?.message || "No se pudo subir la foto");
        toast(geo ? "Foto subida con ubicación" : "Foto subida (sin ubicación; requiere HTTPS)");
        setReply(""); setSolucion(""); setPhoto(null); reload();
      } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setBusy(false); }
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

  return (
    <div className="w-full">
      <Link href="/soporte" className="mb-1 inline-flex items-center gap-1 text-[12px] text-text-tertiary hover:text-text-secondary"><Icon name="arrow-left" size={13} /> Soporte</Link>

      {/* Encabezado */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[20px] font-bold text-text-primary">{t.subject} <span className="text-text-tertiary">Nº {t.code ?? "—"}</span></h1>
            <Badge label={TICKET_STATUS_LABEL[t.status] ?? t.status} tone={TICKET_STATUS_TONE[t.status] ?? "default"} />
            {t.priority && <Badge label={`Prioridad: ${t.priority}`} tone={TICKET_PRIORITY_TONE[t.priority] ?? "default"} />}
          </div>
          <p className="text-[12px] text-text-tertiary">Creada {fmt(t.created)}{t.finalDate ? ` · Finalizada ${fmt(t.finalDate)}` : ""}{t.assigned ? ` · Técnico: ${t.assigned}` : ""}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Button variant="secondary" size="sm" disabled={pdfBusy} onClick={abrirPdf}>
            <Icon name="download" size={13} /> {pdfBusy ? "Generando…" : "Orden PDF"}
          </Button>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-text-tertiary">Prioridad</span>
            <Select value={t.priority ?? "Media"} disabled={busy} className="w-auto py-1 text-[12px]"
              onChange={(e) => post(`/support/tickets/${id}/priority`, { priority: e.target.value }, `Prioridad: ${e.target.value}`)}>
              {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {STATES.filter((x) => x !== t.status).map((x) => (
              <Button key={x} variant={x === "ANULADA" ? "danger" : "secondary"} size="sm" disabled={busy}
                onClick={() => post(`/support/tickets/${id}/status`, { status: x }, `Estado: ${TICKET_STATUS_LABEL[x] ?? x}`)}>
                {TICKET_STATUS_LABEL[x] ?? x}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Ficha del cliente / orden (bloque denso estilo legacy) */}
      <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="user" size={15} className="text-brand" />Información del cliente</div>
        {s ? (
          <>
            <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <KV label="Creado">{fmtT(t.created)}</KV>
              <KV label="Usuario"><Link href={`/clientes/${s.id}`} className="text-brand hover:underline">{s.name}</Link></KV>
              <KV label="Documento">{s.doc ?? "—"}</KV>
              <KV label="Abonado">{s.abonado ?? "—"}</KV>
              <KV label="Celular">{[s.phone, s.phone2].filter(Boolean).join(" · ") || "—"}</KV>
              <KV label="Barrio">{s.barrio ?? "—"}</KV>
              <KV label="Dirección">{s.address || "—"}</KV>
              <KV label="Referencia">{[s.residencia, s.referencia].filter(Boolean).join(" / ") || "—"}</KV>
              <KV label="Sede">{s.branch ?? "—"}</KV>
              <KV label="Estado servicio">{s.profile ? s.profile : "—"}</KV>
            </div>
            {/* Coordenadas */}
            <div className="flex gap-2 py-0.5 text-[13px]">
              <span className="shrink-0 font-semibold text-text-secondary">Coordenadas:</span>
              {s.gpsLat && s.gpsLng ? (
                <a href={`https://www.google.com/maps/search/?api=1&query=${s.gpsLat},${s.gpsLng}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
                  <Icon name="map-pin" size={12} /> {s.gpsLat}, {s.gpsLng} · Abrir en Maps
                </a>
              ) : <span className="text-text-primary">No registradas</span>}
            </div>
            {/* Servicios contratados */}
            <KV label="Servicios contratados">{serviciosStr || "Sin servicios registrados"}</KV>
            {/* Equipo asignado */}
            <KV label="Equipo asignado"><span className="font-mono">{equipoStr || "Sin equipo"}</span></KV>
            {/* Deuda */}
            <div className="mt-2 flex items-center gap-2 border-t border-border-subtle pt-2 text-[13px]">
              <span className="font-semibold text-text-secondary">Deuda actual:</span>
              <span className={`text-[16px] font-bold ${debt > 0 ? "text-error-text" : "text-success-text"}`}>{cop(debt)}</span>
            </div>
          </>
        ) : <p className="text-[12px] text-text-tertiary">Sin cliente asociado.</p>}
        {/* Asignar técnico */}
        <div className="mt-3 border-t border-border-subtle pt-3">
          <div className="mb-1 text-[11px] font-semibold text-text-tertiary">Asignar técnico</div>
          <div className="flex gap-2">
            <Select value={assign} onChange={(e) => setAssign(e.target.value)}>
              <option value="">— Sin asignar —</option>
              {techs.map((tt) => <option key={tt.id} value={tt.username || tt.name}>{tt.name}</option>)}
            </Select>
            <Button size="sm" disabled={busy} onClick={() => post(`/support/tickets/${id}/assign`, { assigned: assign }, "Técnico asignado")}>Guardar</Button>
          </div>
        </div>
      </div>

      {/* Detalles */}
      <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="clipboard-list" size={15} className="text-brand" />Detalles</div>
        <p className="text-[13px] font-semibold text-text-primary">{t.type}</p>
        {t.problem && <p className="mt-1 whitespace-pre-wrap text-[13px] text-text-secondary">{t.problem}</p>}
        {t.section && <p className="mt-1 whitespace-pre-wrap text-[12px] text-text-tertiary">{t.section}</p>}
      </div>

      {/* Equipo asignado + material consumido */}
      <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="boxes" size={15} className="text-brand" />Equipo y material</div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEqModal(true)}><Icon name="radio-tower" size={13} /> Asignar equipo</Button>
            <Button variant="secondary" size="sm" onClick={() => setMatModal(true)}><Icon name="package-check" size={13} /> Registrar material</Button>
          </div>
        </div>

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

      {/* Hilo de respuestas + formulario */}
      <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-2 text-[13px] font-bold text-text-primary">Seguimiento ({t.threads?.length ?? 0})</div>

        {/* Formulario de respuesta */}
        <div className="mb-3 flex flex-col gap-2 border-b border-border-subtle pb-3">
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

        {/* Lista del hilo */}
        {t.threads?.length ? (
          <ol className="flex flex-col gap-3">
            {t.threads.map((h: any) => (
              <li key={h.id} className="flex gap-3 border-b border-border-subtle pb-3 last:border-0 last:pb-0">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2"><Icon name="message-square" size={13} className="text-text-tertiary" /></span>
                <div className="min-w-0">
                  {h.message && <p className="whitespace-pre-wrap text-[13px] text-text-primary">{h.message}</p>}
                  {h.attach && <ThreadImage threadId={h.id} />}
                  {h.geoLat && h.geoLng && (
                    <a href={`https://www.google.com/maps/search/?api=1&query=${h.geoLat},${h.geoLng}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
                      <Icon name="map-pin" size={11} /> Ubicación de la foto
                      {s?.gpsLat && s?.gpsLng && (() => {
                        const d = distMeters(Number(h.geoLat), Number(h.geoLng), Number(s.gpsLat), Number(s.gpsLng));
                        return <span className={d <= 150 ? "text-success-text" : "text-warning-text"}>· a ~{d} m del cliente</span>;
                      })()}
                    </a>
                  )}
                  <p className="text-[10px] text-text-tertiary">{fmtT(h.date)}{h.employeeId ? ` · empleado #${h.employeeId}` : ""}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="text-[12px] text-text-tertiary">Sin mensajes de seguimiento.</p>}
      </div>

      {/* Acta de recibido / firma */}
      <div className="mb-6 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="user-check" size={15} className="text-brand" />Firma de quien recibe</div>
        {t.signature ? (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-text-secondary">Firmó: <b>{t.signature.name}</b> {t.signature.cc ? `(CC ${t.signature.cc})` : ""} {t.signature.rel ? `· ${t.signature.rel}` : ""}</p>
            {t.signature.hasImage && <img src={`${process.env.NEXT_PUBLIC_API_URL ?? ""}/support/tickets/${id}/signature.png`} alt="Firma" className="h-24 w-auto rounded border border-border-subtle bg-white" />}
          </div>
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

      <AsignarEquipoModal open={eqModal} onClose={() => setEqModal(false)} onDone={reload} ticketId={id} />
      <ConsumirMaterialModal open={matModal} onClose={() => setMatModal(false)} onDone={reload} ticketId={id} />
    </div>
  );
}
