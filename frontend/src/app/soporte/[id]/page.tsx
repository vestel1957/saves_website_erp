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
import { esCambioDeMegas, esCambioTitular, esReconexion, esTecnico, esTraslado, puedeEditarOrdenes, ORIGEN_ORDEN, TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";
import { AsignarEquipoModal } from "@/components/soporte/AsignarEquipoModal";
import { UbicarEquipoModal, type EquipoUbicar } from "@/components/subscribers/UbicarEquipoModal";
import { AutenticarOnuOrden } from "@/components/soporte/AutenticarOnuOrden";
import { ConsumirMaterialModal } from "@/components/inventory/ConsumirMaterialModal";
import { EditarOrdenModal } from "@/components/soporte/EditarOrdenModal";
import type { OrdenEnCurso } from "@/components/soporte/VisitaAgendada";
import { SignaturePad } from "@/components/support/SignaturePad";
import { fmtDate } from "@/lib/format";
import { ACCEPT_IMAGEN } from "@/lib/adjuntos";
import { listaJson, mensajeDeError } from "@/lib/errores";
import { CapturarGps } from "@/components/map/CapturarGps";
import { DatosDelCliente } from "@/components/soporte/DatosDelCliente";
import { FotoVivienda, fotosDeVivienda } from "@/components/subscribers/FotoVivienda";
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

/** Firma dibujada del acta: el endpoint pide token, así que igual que la foto
    del hilo hay que traerla como blob (un <img src> plano recibe 401). */
function FirmaImg({ ticketId }: { ticketId: string }) {
  const { authFetch } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [fail, setFail] = useState(false);
  useEffect(() => {
    let obj: string | null = null;
    void authFetch(`/support/tickets/${ticketId}/signature.png`)
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => { obj = URL.createObjectURL(b); setUrl(obj); })
      .catch(() => setFail(true));
    return () => { if (obj) URL.revokeObjectURL(obj); };
  }, [authFetch, ticketId]);
  if (fail) return <p className="text-[11px] text-error-text">No se pudo cargar la firma.</p>;
  if (!url) return <div className="h-24 w-48 animate-pulse rounded border border-border-subtle bg-surface-2" />;
  return <img src={url} alt="Firma de quien recibe" className="h-24 w-auto rounded border border-border-subtle bg-white" />;
}

export default function OrdenDetallePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch, user, isSuperadmin } = useAuth();
  const [t, setT] = useState<any | null>(null);
  /**
   * Fotos de la VIVIENDA del cliente (`SubscriberFile.kind = VIVIENDA`), las mismas
   * que enseña su ficha. Se piden aparte porque son del abonado, no de la orden: la
   * que el técnico toma aquí va a ESE campo y a ningún otro, y verla aquí es lo que
   * lo demuestra sin salir de la orden (2026-09-18). La foto de la VISITA es otra
   * cosa y cuelga del seguimiento.
   */
  const [fotosCasa, setFotosCasa] = useState<any[]>([]);
  /** El motivo por el que no se pudo cargar, tal cual lo dice el backend. */
  const [err, setErr] = useState("");
  /**
   * La orden que ya tiene abierta, cuando el 403 viene del candado de "una orden a la
   * vez" (2026-09-09). Se guarda aparte del mensaje porque lo que hace falta es el
   * ENLACE: decirle "ciérrala primero" sin llevarlo a ella es dejarlo buscándola.
   */
  const [bloqueo, setBloqueo] = useState<OrdenEnCurso | null>(null);
  const [techs, setTechs] = useState<any[]>([]);
  const [reply, setReply] = useState("");
  const [solucion, setSolucion] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [assign, setAssign] = useState("");
  const [sig, setSig] = useState<{ name: string; cc: string; rel: string; image?: string | null }>({ name: "", cc: "", rel: "", image: null });
  const [busy, setBusy] = useState(false);
  const [eqModal, setEqModal] = useState(false);
  /** Equipo al que se le está corrigiendo la caja NAP y el puerto desde la orden. */
  const [ubicar, setUbicar] = useState<EquipoUbicar | null>(null);
  const [matModal, setMatModal] = useState(false);
  const [editModal, setEditModal] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  /** Firmar una orden ya cerrada es la excepción: el bloque arranca plegado. */
  const [verFirma, setVerFirma] = useState(false);
  /** Bloqueo de la geo-cerca pendiente de justificar. */
  const [cerca, setCerca] = useState<{
    estado: string; razon: string; message: string; distanciaM?: number; radioM?: number;
  } | null>(null);
  const [motivo, setMotivo] = useState("");
  /** Bloqueo por falta de registro fotográfico (2026-09-10). */
  const [faltaFoto, setFaltaFoto] = useState<string | null>(null);
  /** Bloqueo por IP remota: el cliente se queda sin acceso remoto (2026-09-10). */
  const [faltaIp, setFaltaIp] = useState<string | null>(null);
  const [faltanDatos, setFaltanDatos] = useState<{ message: string; falta: { ubicacion?: boolean; foto?: boolean } } | null>(null);

  /**
   * Deja dicho en el seguimiento que el punto guardado del cliente no corresponde.
   *
   * No cierra nada: desde el 2026-09-10 fuera de rango no se cierra ni con motivo
   * (lo pidió el usuario). Pero el técnico que SÍ está en la puerta necesita poder
   * dejar constancia sin llamar a nadie, y alguien tiene que poder corregir la
   * coordenada — esto es lo que se lo dice.
   */
  async function avisarUbicacionMal() {
    const dist = cerca?.distanciaM != null ? `${Math.round(cerca.distanciaM)} m` : "otro punto";
    const texto =
      `⚠ No pudo cerrar por la ubicación: el sistema lo ubica a ${dist} del punto guardado del `
      + `cliente. Dice: ${motivo.trim()}`;
    setBusy(true);
    try {
      const res = await authFetch(`/support/tickets/${id}/thread`, {
        method: "POST",
        body: JSON.stringify({ message: texto }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      setCerca(null); setMotivo("");
      toast("Aviso registrado en el seguimiento");
      reload();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
  }

  /**
   * El técnico corrigió el punto del cliente desde el modal del bloqueo. Mover el
   * domicilio es lo que le abre la puerta a cerrar, así que no puede pasar en
   * silencio: queda el renglón en el seguimiento con la distancia que lo frenó, y
   * el modal se cierra para que reintente con la coordenada buena. La captura ya
   * quedó auditada aparte como `GeoPing` (`subscriber.capture`).
   */
  async function avisarGpsCorregido(p: { lat: number; lng: number }) {
    const dist = cerca?.distanciaM != null ? `estaba a ${Math.round(cerca.distanciaM)} m` : "estaba fuera del rango";
    const texto =
      `📍 Corrigió la ubicación del cliente desde la orden: ${dist} del punto anterior al `
      + `intentar cerrar. Nuevo punto ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}.`;
    try {
      await authFetch(`/support/tickets/${id}/thread`, {
        method: "POST",
        body: JSON.stringify({ message: texto }),
      });
    } catch { /* el punto ya quedó guardado: el aviso no puede tumbar la corrección */ }
    setCerca(null); setMotivo("");
    toast("Ubicación corregida: vuelve a cerrar la orden", "map-pin");
    reload();
  }

  /**
   * Le activa la IP remota al cliente: el sistema le reparte una dirección fija de
   * las que su router ya usa y se la escribe en el secret. El técnico no elige nada
   * —no tiene por qué saber qué /24 le toca— y la respuesta dice cuál quedó.
   */
  async function activarIpRemota() {
    setBusy(true);
    try {
      const res = await authFetch(`/support/tickets/${id}/ip-remota`, { method: "POST" });
      const d = await res.json();
      if (!res.ok || d?.ok === false) throw new Error(d?.message || "No se pudo activar la IP remota");
      setFaltaIp(null);
      toast(d.dryRun ? `Simulación: ${d.message}` : `IP remota activada: ${d.ip}`);
      reload();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setBusy(false); }
  }

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
    void authFetch(`/support/tickets/${id}`)
      .then(async (r) => {
        if (r.ok) return r.json();
        // El motivo importa: un 403 de alcance ("esta orden no está asignada a ti") y
        // un 404 mandan a sitios distintos, y decir "no encontrada" a lo primero lo
        // manda a buscar una avería que no existe. Se enseña lo que responde el
        // backend, que ya explica qué hacer.
        //
        // Aquí ya NO llega el candado de "una orden a la vez": desde el 2026-09-10
        // abrir una orden nunca se bloquea (regla del legacy). El 403 de `enCurso`
        // sale sólo al pulsar "Empezar" — se maneja en `cambiarEstado`.
        const cuerpo = await r.json().catch(() => null);
        throw new Error(cuerpo?.message ?? "");
      })
      .then((d) => { setT(d); setAssign(d.assigned || ""); })
      .catch((e) => setErr(e?.message || "Orden no encontrada."));
  }, [authFetch, id]);

  /** Las fotos de la vivienda del cliente de esta orden. */
  const recargarFotosCasa = useCallback(
    (subId?: string | null) => {
      if (!subId) { setFotosCasa([]); return; }
      void authFetch(`/subscribers/${subId}/files`)
        .then((r) => (r.ok ? r.json() : []))
        .then((d) => setFotosCasa(fotosDeVivienda(Array.isArray(d) ? d : (d?.items ?? []))))
        // Sin adjuntos legibles no se rompe la orden: simplemente no hay foto que enseñar.
        .catch(() => setFotosCasa([]));
    },
    [authFetch],
  );

  useEffect(() => { recargarFotosCasa(t?.subscriber?.id); }, [t?.subscriber?.id, recargarFotosCasa]);

  useEffect(() => {
    if (authLoading) return;
    reload();
    void authFetch("/support/technicians").then(listaJson).then(setTechs).catch(() => {});
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

  /** Borrar un renglón del seguimiento. Sólo superusuario (el backend lo exige igual). */
  async function borrarSeguimiento(threadId: string) {
    if (!confirm("¿Eliminar este reporte del seguimiento? Esta acción no se puede deshacer.")) return;
    setBusy(true);
    try {
      const res = await authFetch(`/support/threads/${threadId}`, { method: "DELETE" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Reporte eliminado"); reload();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
  }

  /**
   * Cambia el estado de la orden. Al cerrarla (RESUELTO) adjunta la ubicación:
   * el servidor comprueba que el técnico esté en el domicilio (geo-cerca).
   *
   * Se manda SIEMPRE que se pueda, aunque el cliente no tenga coordenada
   * guardada: en ese caso el propio cierre lo georreferencia.
   */
  async function cambiarEstado(nuevo: string) {
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
        body: JSON.stringify({ status: nuevo, ...geo }),
      });
      const d = await res.json();
      if (!res.ok) {
        // 422 con code GEOFENCE = la orden no se cerró porque el técnico no está
        // donde debería. No es un error a secas: se le ofrece justificar.
        if (res.status === 422 && d?.code === "GEOFENCE") {
          setCerca({ estado: nuevo, ...d });
          return;
        }
        // 422 con code FOTO_REQUERIDA = falta la evidencia de la visita. Como el de
        // la cerca, no es un error a secas: hay algo concreto que hacer y está en
        // esta misma pantalla, unos centímetros más abajo.
        if (res.status === 422 && d?.code === "FOTO_REQUERIDA") {
          setFaltaFoto(d.message as string);
          return;
        }
        // 422 con code IP_REMOTA_REQUERIDA = el cliente no tiene IP fija, así que
        // sistemas no podría entrar a su equipo ni cartera cortarlo. Tampoco es un
        // error a secas: se arregla desde aquí mismo, con un botón.
        if (res.status === 422 && d?.code === "IP_REMOTA_REQUERIDA") {
          setFaltaIp(d.message as string);
          return;
        }
        // 422 con code DATOS_CLIENTE_REQUERIDOS = la visita NO arrancó porque al
        // cliente le falta la ubicación o la foto de la vivienda (2026-09-18). Es el
        // único candado del ARRANQUE, y como los de cierre no es un error a secas:
        // las dos cosas se resuelven aquí mismo, estando en la puerta.
        if (res.status === 422 && d?.code === "DATOS_CLIENTE_REQUERIDOS") {
          setFaltanDatos({ message: d.message as string, falta: d.falta ?? {} });
          return;
        }
        // 403 con code ORDEN_EN_CURSO = "una orden a la vez" (`support/turno.ts`, la
        // regla del legacy): ya tiene otra EMPEZADA. Como los dos de arriba, no es un
        // error a secas —hay algo concreto que hacer y está en otra orden—, así que se
        // guarda entera para pintar el enlace en vez de dejar sólo un toast que se va.
        if (res.status === 403 && d?.code === "ORDEN_EN_CURSO") {
          setBloqueo((d.enCurso as OrdenEnCurso) ?? null);
          toast(d.message as string, "alert-triangle");
          return;
        }
        throw new Error(d?.message || "Error");
      }
      setCerca(null);
      setBloqueo(null);
      setFaltanDatos(null);
      setMotivo("");
      // Lo que hicieron (o no pudieron hacer) los equipos al cerrar: si la TV no
      // volvió, quien cierra tiene que enterarse aquí y no por la llamada del
      // cliente tres días después. Ver `mensajeDeCascada` en el backend.
      const aviso: string | undefined = d?.cascade?.mensaje;
      const falla = !!aviso && aviso.includes("⚠");
      toast(aviso ? `${etiqueta} · ${aviso}` : `Estado: ${etiqueta}`, falla ? "alert-triangle" : undefined);
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
  if (err)
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">
        {err}{" "}
        {/* Aquí ya no hay caso de candado: desde el 2026-09-10 abrir una orden nunca
            da 403 (ver `reload`). Lo que queda son el alcance y el 404, y de los dos
            se sale volviendo a la lista. */}
        <Link href="/soporte" className="text-brand">
          Volver
        </Link>
      </div>
    );

  const s = t.subscriber;
  const serviciosStr: string = s?.services?.length ? s.services.map((x: any) => `${SERVICE_LABEL[x.kind] ?? x.kind}: ${x.plan ?? "—"}`).join(" · ") : "";
  const eq = t.equipment?.[0];
  const equipoStr: string = eq ? `${eq.mac ?? "sin MAC"}  ${eq.installType ?? ""}${eq.vlan != null ? ` V:${eq.vlan}` : ""}${eq.nat != null ? ` N:${eq.nat}` : ""}${eq.port != null ? ` PN:${eq.port}` : ""}`.trim() : (s?.macEquipo || "");
  const debt = Number(s?.debt ?? 0);
  const abierta = t.status !== "RESUELTO" && t.status !== "ANULADA";
  /**
   * ¿Se puede tocar esta orden? Dos condiciones distintas, no una:
   *  · `support.write` — quien no lo tiene entra a MIRAR (jefaturas, auditoría).
   *  · no ser técnico   — corregir la orden es de quien la abre, no de quien la
   *    atiende: si está mal, el técnico lo dice en el seguimiento.
   * Lo segundo restringe solo la corrección; lo primero apaga TODO control, que
   * es lo que el servidor va a exigir de todas formas.
   */
  const puedeEscribir = puedeEditarOrdenes(user);
  const puedeEditar = puedeEscribir && !esTecnico(user);
  const paso = SIGUIENTE[t.status];
  const wa = waLink(s?.phone);
  // El barrio NO tapa la falta de dirección: llegar a "Mirador" no es llegar a
  // una casa, y con la dirección vacía el técnico tiene que llamar antes de salir.
  const direccion: string | null = s?.address?.trim() ? [s.address.trim(), s.barrio].filter(Boolean).join(" · ") : null;
  const referencia = [s?.residencia, s?.referencia].filter(Boolean).join(" / ");

  return (
    <div className="w-full">
      {/* "Ya tienes una orden abierta": sale al intentar EMPEZAR ésta teniendo otra a
          medias. Va arriba del todo y con el enlace, porque el camino de salida no es
          esta pantalla sino la otra orden — igual que el `<a>` del error del legacy. */}
      {bloqueo && (
        <div className="mb-3 flex flex-col gap-2 rounded-xl border border-warning-border bg-warning-soft px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <Icon name="lock" size={16} className="mt-0.5 shrink-0 text-warning-text" />
            <p className="text-[12.5px] text-text-primary">
              No puedes empezar ésta: ya tienes abierta la{" "}
              <b>
                {bloqueo.code ? `#${bloqueo.code} · ` : ""}
                {bloqueo.type}
              </b>
              {bloqueo.cliente ? ` · ${bloqueo.cliente}` : ""}. Ciérrala y vuelve.
            </p>
          </div>
          <Link
            href={`/soporte/${bloqueo.id}`}
            className="tap inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-[12px] font-semibold text-on-brand transition-opacity hover:opacity-90"
          >
            <Icon name="arrow-right" size={14} /> Ver la orden abierta
          </Link>
        </div>
      )}
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
            {/* El plazo es la razón de ser de esta orden: al cerrarla el cliente
                queda protegido del corte justo estos días, ni uno más. */}
            {t.graceDays != null && <Badge label={`Reconexión por ${t.graceDays} día(s)`} tone="warning" />}
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
        subtitle={<>Creada {fmtDate(t.created)}{t.generadaPor ? ` por ${t.generadaPor.nombre}` : ""}{t.finalDate ? ` · Finalizada ${fmtDate(t.finalDate)}` : ""}{t.assigned ? ` · Técnico: ${t.assigned}` : " · Sin técnico asignado"}</>}
        actions={
          <>
            <Button variant="secondary" size="sm" disabled={pdfBusy} onClick={abrirPdf} className="w-full sm:w-auto">
              <Icon name="download" size={13} /> {pdfBusy ? "Generando…" : "Orden PDF"}
            </Button>
            {puedeEscribir && paso && (
              <Button size="sm" disabled={busy} onClick={() => void cambiarEstado(paso.estado)} className="w-full sm:w-auto">
                <Icon name={paso.icon} size={13} /> {paso.label}
              </Button>
            )}
            {/* Los demás estados no compiten con el paso natural: viven en el menú
                (antes eran tres botones iguales, y "Anulada" quedaba al lado de
                "Cerrar" con el mismo peso visual). */}
            {puedeEscribir && (
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
            )}
          </>
        }
      />

      {/* QUÉ HACE FALTA PARA EMPEZARLA (2026-09-18). Va ANTES del bloque de cierre y
          sólo mientras la orden está PENDIENTE: son los datos del cliente —su
          ubicación y la foto de la casa— que hay que dejar al llegar, porque después
          ya no se pueden tomar. Cada renglón trae su botón: ver `DatosDelCliente`. */}
      {t.status === "PENDIENTE" && puedeEscribir && t.requisitosInicio?.aplica
        && (t.requisitosInicio.ubicacion || t.requisitosInicio.foto) && s?.id && (
        <div className="mb-3 rounded-xl border border-warning bg-warning-soft p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-bold text-text-primary">
            <Icon name="alert-triangle" size={14} className="text-warning-text" /> Para empezar esta visita
          </div>
          <p className="mb-2 text-[12px] text-text-tertiary">
            Esta orden no arranca hasta que el cliente tenga estos datos. Hazlo estando en la
            puerta: el punto que captures es el que va a comprobar el cierre.
          </p>
          <DatosDelCliente
            subscriberId={s.id}
            falta={{ ubicacion: t.requisitosInicio.ubicacion, foto: t.requisitosInicio.foto }}
            gps={s.gpsLat && s.gpsLng ? { lat: Number(s.gpsLat), lng: Number(s.gpsLng) } : null}
            onHecho={() => { recargarFotosCasa(s.id); reload(); }}
          />
        </div>
      )}

      {/* QUÉ HACE FALTA PARA CERRARLA (2026-09-10). Sólo en las visitas a domicilio
          y mientras siga abierta: en un corte o una reconexión no aplica ninguno de
          los dos requisitos y anunciarlos sería ruido en el 85% de las órdenes.
          Se pinta con lo que manda el servidor (`requisitosCierre`) y no con una
          lista de tipos repetida aquí. */}
      {abierta && puedeEscribir && t.requisitosCierre?.deCampo
        && (t.requisitosCierre.foto || t.requisitosCierre.ubicacion || t.requisitosCierre.firma
          || t.requisitosCierre.ipRemota || t.requisitosCierre.ipRemotaValor) && (
        <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-bold text-text-primary">
            <Icon name="clipboard-check" size={14} className="text-brand" /> Para cerrar esta visita
          </div>
          <ul className="flex flex-col gap-1">
            {t.requisitosCierre.foto && (
              <li className="flex items-start gap-1.5 text-[12.5px] text-text-secondary">
                <Icon
                  name={t.requisitosCierre.fotos > 0 ? "check" : "camera"}
                  size={14}
                  className={`mt-0.5 shrink-0 ${t.requisitosCierre.fotos > 0 ? "text-success-text" : "text-warning-text"}`}
                />
                <span>
                  {t.requisitosCierre.fotos > 0
                    ? `Foto de la visita: ${t.requisitosCierre.fotos} adjunta${t.requisitosCierre.fotos === 1 ? "" : "s"}.`
                    : "Falta la foto de la visita. Adjúntala abajo, en el seguimiento."}
                </span>
              </li>
            )}
            {t.requisitosCierre.ubicacion && (
              <li className="flex items-start gap-1.5 text-[12.5px] text-text-secondary">
                <Icon name="map-pin" size={14} className="mt-0.5 shrink-0 text-warning-text" />
                <span>
                  Cerrarla desde la casa del cliente, con el GPS encendido y el permiso de
                  ubicación aceptado. Desde otro sitio no se cierra: no hay excepción por motivo.
                </span>
              </li>
            )}
            {t.requisitosCierre.firma && (
              <li className="flex items-start gap-1.5 text-[12.5px] text-text-secondary">
                <Icon name="pencil" size={14} className="mt-0.5 shrink-0 text-warning-text" />
                <span>Falta la firma de quien recibe, al pie de la orden.</span>
              </li>
            )}
            {/* IP remota (2026-09-10). Cuando falta, el arreglo está en el propio
                renglón: el técnico no tiene que ir a Red ni llamar a sistemas. Y
                cuando ya está, se enseña cuál es — es la dirección por la que se
                entra al equipo del cliente. */}
            {(t.requisitosCierre.ipRemota || t.requisitosCierre.ipRemotaValor) && (
              <li className="flex flex-wrap items-start gap-1.5 text-[12.5px] text-text-secondary">
                <Icon
                  name={t.requisitosCierre.ipRemota ? "wifi" : "check"}
                  size={14}
                  className={`mt-0.5 shrink-0 ${t.requisitosCierre.ipRemota ? "text-warning-text" : "text-success-text"}`}
                />
                {t.requisitosCierre.ipRemota ? (
                  <>
                    <span>
                      El cliente no tiene IP remota activa: sin ella sistemas no puede entrar a
                      su equipo y tampoco se le puede cortar.
                    </span>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void activarIpRemota()}>
                      Asignar IP remota
                    </Button>
                  </>
                ) : (
                  <span>IP remota activa: {t.requisitosCierre.ipRemotaValor}.</span>
                )}
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Dos columnas desde xl: el trabajo a la izquierda y el cliente —a quién
          se va a ver y dónde— fijo a la derecha. En pantallas menores se apila,
          y el cliente va PRIMERO: es lo que se mira antes de arrancar. */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <div className="order-2 flex min-w-0 flex-col gap-3 xl:order-1">
          {/* Trabajo a realizar */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            {/* Corregir va AQUÍ, junto a lo que corrige, y no en la cabecera: lo que
                se arregla es lo que se está leyendo. Al técnico de campo no se le
                ofrece —el servidor se lo negaría igual— porque él atiende el trabajo,
                no lo redefine: si la orden está mal, lo dice en el seguimiento. */}
            <CardTitle
              icon="clipboard-list"
              right={
                !puedeEditar ? undefined : (
                  <Button variant="secondary" size="sm" onClick={() => setEditModal(true)}>
                    <Icon name="pencil" size={13} /> Corregir orden
                  </Button>
                )
              }
            >
              Trabajo a realizar
            </CardTitle>
            {t.problem && (
              <div>
                {/* En un retiro esta casilla no lleva una avería sino POR QUÉ se va
                    el cliente (lista cerrada, ver `MOTIVOS_RETIRO`): llamarla "falla
                    reportada" le hace leer al técnico que hay algo que arreglar. */}
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                  {(t.type ?? "").trim().toLowerCase() === "retiro voluntario" ? "Razón del retiro" : "Falla reportada"}
                </div>
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
            {/* El técnico ya fue y no pudo hacerla. Va aquí, junto a la falla, porque
                es parte del trabajo a realizar: dice qué le faltó al viaje anterior
                (material, otro tipo de orden, el cliente ausente). La orden sigue
                PENDIENTE, así que sin esto parecía que nadie había ido nunca. */}
            {t.noAtendida && (
              <div className="mt-3 rounded-lg border border-warning-border bg-warning-soft p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning-text">
                  <Icon name="alert-triangle" size={12} /> No se pudo atender
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] text-text-primary">{t.noAtendida.motivo || "Sin motivo escrito."}</p>
                <p className="mt-1 text-[11.5px] text-text-tertiary">
                  {t.noAtendida.por ?? "—"} · {fmtT(t.noAtendida.fecha)} · la visita quedó sin agendar
                </p>
              </div>
            )}
            {/* Traslado: de dónde a dónde. La ficha del cliente ya quedó con la
                dirección nueva al abrirse la orden, así que lo que aquí hace falta
                es la vieja — es donde está el equipo que hay que recoger. */}
            {t.traslado && (
              <div className="mt-3 rounded-lg border border-border-default bg-surface-2 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Traslado</div>
                <p className="mt-1 text-[13px] text-text-secondary">
                  De <b className="text-text-primary">{t.traslado.desde || "dirección sin registrar"}</b>{" "}
                  a <b className="text-text-primary">{t.traslado.hasta}</b>
                </p>
                <p className="mt-1 text-[12px] text-text-tertiary">
                  {t.traslado.factura
                    ? <>Cobrado en la factura Nº {t.traslado.factura}.</>
                    : <>Sin factura del traslado: cóbralo aparte si corresponde.</>}
                </p>
              </div>
            )}
            {/* Cambio de titular: quién era y quién quedó. La ficha ya tiene al nuevo. */}
            {t.cambioTitular && (
              <div className="mt-3 rounded-lg border border-border-default bg-surface-2 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Cambio de titular</div>
                <p className="mt-1 text-[13px] text-text-secondary">
                  De <b className="text-text-primary">{t.cambioTitular.desde || "titular sin registrar"}</b>{" "}
                  a <b className="text-text-primary">{t.cambioTitular.hasta}</b>
                </p>
                <p className="mt-1 text-[12px] text-text-tertiary">La ficha del cliente ya quedó a nombre del nuevo titular.</p>
              </div>
            )}
            {!t.cambioTitular && esCambioTitular(t.type) && (
              <div className="mt-3 rounded-lg border border-warning-border bg-warning-soft p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning-text">
                  <Icon name="alert-triangle" size={12} /> Cambio de titular sin datos
                </div>
                <p className="mt-1 text-[13px] text-text-secondary">
                  Esta orden no dice a nombre de quién queda el servicio.
                </p>
                {puedeEditar && (
                  <Button variant="secondary" className="mt-2" onClick={() => setEditModal(true)}>
                    Registrar el nuevo titular
                  </Button>
                )}
              </div>
            )}
            {/* Las MEGAS: de cuánto viene y a cuánto va. El cliente sigue en su plan
                de hoy —y pagando su precio— hasta que la orden se cierre: es ahí
                donde se le cambia el plan y se le reprecia la factura del mes. Lo
                que hace falta aquí es a qué velocidad hay que dejarlo, que es lo
                que el técnico aplica a la ONU desde el bloque de abajo. */}
            {t.megas && (
              <div className="mt-3 rounded-lg border border-border-default bg-surface-2 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Megas</div>
                <p className="mt-1 text-[13px] text-text-secondary">
                  De{" "}
                  <b className="text-text-primary">
                    {t.megas.de != null ? `${t.megas.de} Megas` : t.megas.planAnterior || "plan sin registrar"}
                  </b>{" "}
                  a <b className="text-text-primary">{t.megas.a != null ? `${t.megas.a} Megas` : t.megas.plan}</b>
                  {t.megas.plan ? <> · plan «{t.megas.plan}»</> : null}
                </p>
                <p className="mt-1 text-[12px] text-text-tertiary">
                  {t.megas.aplicado
                    ? <>El plan ya está cambiado en la ficha ({fmtT(t.megas.aplicado)}).</>
                    : t.status === "RESUELTO" || t.status === "ANULADA"
                      // Una orden del sistema viejo nunca lleva la marca de aplicado: el
                      // cambio de plan lo hizo ÉL al cerrarla, y esa marca dice "lo aplicó
                      // este sistema". Decirle a la cajera que no se cambió sería mandarla
                      // a repetir a mano un cambio que ya está hecho.
                      ? t.generadaPor?.origen === "LEGACY"
                        ? <>Se cerró en el sistema viejo, que es donde se le cambió el plan: compruébalo en su ficha.</>
                        : <>La orden se cerró y el plan NO llegó a cambiarse: hazlo desde su ficha (Cambiar plan).</>
                      : <>El cliente sigue en su plan de hoy: pasa a éste —y se le reprecia la factura del mes— al cerrar la orden.</>}
                  {puedeEditar && <> Si no es el plan que se acordó, corrígelo en «Corregir orden».</>}
                </p>
              </div>
            )}
            {/* Una orden de megas que no dice cuántas. Desde 2026-09-04 el sync trae el
                plan de las del sistema viejo (allá vive en `temporales.internet`), así
                que aquí quedan las que de verdad nacieron sin decirlo: las del chatbot
                —el cliente pide "más megas" y el plan lo confirma quien atienda— y las
                130 del legacy que dejaron esa casilla en blanco. Sin este aviso el
                técnico salía a preguntar por teléfono a qué velocidad dejar al cliente. */}
            {!t.megas && esCambioDeMegas(t.type) && (
              <div className="mt-3 rounded-lg border border-warning-border bg-warning-soft p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning-text">
                  <Icon name="alert-triangle" size={12} /> Orden de megas sin plan
                </div>
                <p className="mt-1 text-[13px] text-text-secondary">
                  Esta orden no dice a cuántas megas se pasa el cliente: sin eso, el técnico no sabe a qué velocidad
                  tiene que dejarlo en la red.
                </p>
                {puedeEditar && (
                  <Button variant="secondary" className="mt-2" onClick={() => setEditModal(true)}>
                    Registrar el plan
                  </Button>
                )}
              </div>
            )}
            {/* El cargo de la orden, cuando su tipo se cobra al abrirlo y no es el
                traslado (que ya lo dice en su bloque, con la dirección). Responde
                la pregunta de ventanilla: ¿esto ya está facturado o hay que
                cobrarlo? Ver `billing/cargos-orden.ts`. */}
            {t.cargo && !t.traslado && (
              <div className="mt-3 rounded-lg border border-border-default bg-surface-2 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Cargo de la orden</div>
                <p className="mt-1 text-[13px] text-text-secondary">
                  <b className="text-text-primary">{t.cargo.concepto || "Cargo"}</b>
                  {t.cargo.factura
                    ? <> · cobrado en la factura Nº {t.cargo.factura}</>
                    : <> · sin factura: cóbralo aparte si corresponde</>}
                </p>
              </div>
            )}
            {/* Un traslado que no dice a dónde. Es lo que pasa con los que se abren
                en el sistema viejo —allá no hay columna para el destino— y con los
                que entran por el chatbot. Sin este aviso la orden se veía como
                cualquier otra y el técnico salía a preguntar la dirección por
                teléfono; con él, quien atiende al cliente la registra en el sitio. */}
            {!t.traslado && esTraslado(t.type) && (
              <div className="mt-3 rounded-lg border border-warning-border bg-warning-soft p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning-text">
                  <Icon name="alert-triangle" size={12} /> Traslado sin dirección nueva
                </div>
                <p className="mt-1 text-[13px] text-text-secondary">
                  Esta orden no dice a dónde se muda el cliente
                  {t.subscriber?.address ? <> · hoy figura en <b className="text-text-primary">{t.subscriber.address}</b></> : null}.
                </p>
                {puedeEditar && (
                  <Button variant="secondary" className="mt-2" onClick={() => setEditModal(true)}>
                    Registrar la dirección
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Autenticar la ONU contra la OLT (solo en órdenes que lo requieren).
              Se monta aquí, junto a la instalación, y no en una pantalla aparte:
              la velocidad la pone el plan, así que no hay nada más que preguntar. */}
          {puedeEscribir && <AutenticarOnuOrden ticketId={id} tipo={t.type} estadoOrden={t.status} onDone={reload} />}

          {/* Equipo asignado + material consumido */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle
              icon="boxes"
              right={
                !puedeEscribir ? undefined : (
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setEqModal(true)}><Icon name="radio-tower" size={13} /> Asignar equipo</Button>
                    <Button variant="secondary" size="sm" onClick={() => setMatModal(true)}><Icon name="package-check" size={13} /> Registrar material</Button>
                  </div>
                )
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
                    {/* La caja y el puerto como están ROTULADOS. Los ids crudos del
                        legacy (`N:241 · PN:2393`) sólo se enseñan cuando no casan con
                        ninguna caja de aquí: es la pista de que hay que corregirlos. */}
                    {e.napName
                      ? <span className="text-text-secondary">NAP {e.napName}{e.portNumber != null ? ` · pto ${e.portNumber}` : ""}</span>
                      : <>
                          {e.nat != null && <span className="text-text-tertiary">N:{e.nat}</span>}
                          {e.port != null && <span className="text-text-tertiary">PN:{e.port}</span>}
                        </>}
                    {e.vlan != null && <span className="text-text-tertiary">V:{e.vlan}</span>}
                    {e.status && <Badge label={e.status} tone={e.reservado ? "info" : "default"} />}
                    {/* Apartado en bodega para ESTA orden al abrirla: es el que el
                        técnico tiene que llevarse; si instala ese, la ONU se
                        autentica sola. */}
                    {e.reservado && (
                      <span className="text-text-secondary">
                        <Icon name="bookmark" size={12} className="mr-0.5 inline text-brand" />
                        reservado para esta orden{e.bodega ? ` · llévelo de la bodega ${e.bodega}` : ""}
                      </span>
                    )}
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
                    {/* Ponerle (o corregirle) la caja NAP y el puerto sin salir de la
                        orden: es el técnico que acaba de colgar el equipo quien sabe en
                        qué caja y en qué puerto quedó. Mismo editor que la ficha. */}
                    {puedeEscribir && t.subscriber?.id && (
                      <button
                        type="button"
                        onClick={() => setUbicar({
                          id: e.id, code: e.code, mac: e.mac, serial: e.serial, vlan: e.vlan,
                          napId: e.napId, napName: e.napName, portId: e.portId, portNumber: e.portNumber,
                          nat: e.nat, port: e.port,
                        })}
                        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-brand hover:bg-surface-3"
                      >
                        <Icon name="pencil" size={12} /> {e.napName ? "Editar caja y puerto" : "Asignar caja y puerto"}
                      </button>
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
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-[11px] text-text-tertiary">
                            <span className="font-semibold text-text-secondary">{h.author ?? (h.employeeId ? `Empleado #${h.employeeId}` : "Sistema")}</span>
                            {" · "}{fmtT(h.date)}
                          </p>
                          {isSuperadmin && (
                            <button type="button" disabled={busy} onClick={() => borrarSeguimiento(h.id)} title="Eliminar reporte" aria-label="Eliminar reporte" className="shrink-0 rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-error-text disabled:opacity-50">
                              <Icon name="trash" size={13} />
                            </button>
                          )}
                        </div>
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

            {/* Formulario de respuesta. Quien solo consulta lee el seguimiento
                completo; documentar la visita es de quien la hace. */}
            {puedeEscribir && (
            <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
              <Select value={solucion} onChange={(e) => setSolucion(e.target.value)}>
                <option value="">— Solución / causa (opcional) —</option>
                {SOLUCIONES.map((x) => <option key={x} value={x}>{x}</option>)}
              </Select>
              <Textarea rows={3} placeholder="Escribe la documentación / avance…" value={reply} onChange={(e) => setReply(e.target.value)} />
              {/* Foto de evidencia (con cámara en móvil; intenta geo-etiquetar al subir) */}
              <div id="seguimiento-foto" className="flex flex-wrap items-center justify-between gap-2">
                {/* Dos botones a propósito: `capture="environment"` abre la cámara y se
                    salta el selector, así que con un único botón la galería quedaba
                    inalcanzable y tocaba "convertir la foto en archivo" para subirla. */}
                <div className="inline-flex items-center gap-1.5">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
                    <Icon name="camera" size={14} /> Cámara
                    <input type="file" accept={ACCEPT_IMAGEN} capture="environment" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
                    <Icon name="image" size={14} /> Galería
                    <input type="file" accept={ACCEPT_IMAGEN} className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
                  </label>
                </div>
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
            )}
          </div>

          {/* Acta de recibido / firma. Con la orden cerrada y sin firma el bloque
              va plegado: eran 300 px de lienzo en blanco al pie de cada orden
              vieja, y firmar a destiempo es la excepción, no lo normal.

              La reconexión no lleva acta: se resuelve desde el sistema y no hay
              a quién pedirle la firma, así que el bloque ni se pinta (solo si esa
              orden ya trae una firma vieja, para no esconder lo que se guardó).

              Y con la orden REABIERTA se puede volver a firmar (2026-09-12): una
              orden que se cerró y se volvió a abrir se atiende otra vez, y el acta
              de la primera visita ya no es la del trabajo que se entrega. Con la
              firma guardada el lienzo no se pinta solo —firmar de nuevo es la
              excepción— pero el botón está ahí. El servidor siempre lo permitió
              (`saveSignature` reescribe); era la pantalla la que no ofrecía por
              dónde, y el técnico se quedaba en la puerta sin poder recogerla. */}
          {(t.signature || !esReconexion(t.type)) && (
          <div className="mb-6 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle
              icon="user-check"
              right={
                puedeEscribir && (t.signature ? abierta : !abierta) ? (
                  <Button variant="ghost" size="sm" onClick={() => setVerFirma((v) => !v)}>
                    {verFirma ? "Ocultar" : t.signature ? "Firmar de nuevo" : "Firmar de todos modos"}
                  </Button>
                ) : undefined
              }
            >
              Firma de quien recibe
            </CardTitle>
            {t.signature && !(abierta && verFirma && puedeEscribir) ? (
              <div className="flex flex-col gap-2">
                <p className="text-[12px] text-text-secondary">Firmó: <b>{t.signature.name}</b> {t.signature.cc ? `(CC ${t.signature.cc})` : ""} {t.signature.rel ? `· ${t.signature.rel}` : ""}</p>
                {t.signature.hasImage && <FirmaImg ticketId={id} />}
              </div>
            ) : !puedeEscribir ? (
              <p className="text-[12px] text-text-tertiary">Esta orden todavía no tiene acta firmada.</p>
            ) : !abierta && !verFirma ? (
              <p className="text-[12px] text-text-tertiary">Esta orden se cerró sin acta firmada.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {t.signature && (
                  <p className="rounded-lg border border-warning-border bg-warning-soft p-2 text-[12px] text-warning-text">
                    Esta orden ya tiene el acta de <b>{t.signature.name}</b>{t.signature.cc ? ` (CC ${t.signature.cc})` : ""}, de la visita anterior. La firma que guardes ahora la reemplaza; la anterior queda anotada en el seguimiento.
                  </p>
                )}
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
          )}
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
                  {/* LA FOTO DE LA VIVIENDA, la del campo de la ficha (2026-09-18).
                      Es el mismo componente que pinta `/clientes/[id]`, a propósito:
                      lo que el técnico toma desde la orden va a ESE campo y no a un
                      adjunto suelto ni al seguimiento, y verlo aquí es lo que lo
                      demuestra. Tomarla otra vez la reemplaza (la anterior queda de
                      historial). No confundir con la foto de la VISITA, que cuelga
                      de la orden y va abajo, en el seguimiento. */}
                  {s.id && (
                    <div className="mt-2">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                        Foto de la vivienda
                      </p>
                      <FotoVivienda
                        subscriberId={s.id}
                        fotos={fotosCasa}
                        variant="miniatura"
                        puedeEditar={puedeEscribir}
                        onCambio={() => { recargarFotosCasa(s.id); reload(); }}
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
                  <Link href={`/clientes/${s.id}?tab=facturas`} className="text-[12px] font-semibold text-brand hover:underline">Ver facturas</Link>
                )}
              </div>
            </div>
          )}

          {/* Gestión: lo que cambia la cajera/coordinación, no el técnico en la
              puerta. Por eso baja de la cabecera a su propia tarjeta. */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <CardTitle icon="settings">Gestión de la orden</CardTitle>
            <div className="mb-1 text-[11px] font-semibold text-text-tertiary">Técnico asignado</div>
            {puedeEscribir ? (
              <div className="flex gap-2">
                <Select value={assign} onChange={(e) => setAssign(e.target.value)}>
                  <option value="">— Sin asignar —</option>
                  {techs.map((tt) => <option key={tt.id} value={tt.name}>{tt.name}</option>)}
                </Select>
                <Button size="sm" disabled={busy || assign === (t.assigned || "")} onClick={() => post(`/support/tickets/${id}/assign`, { assigned: assign }, "Técnico asignado")}>Guardar</Button>
              </div>
            ) : (
              <p className="text-[13px] font-semibold text-text-primary">{t.assigned || "Sin asignar"}</p>
            )}
            <div className="mb-1 mt-3 text-[11px] font-semibold text-text-tertiary">Prioridad</div>
            {puedeEscribir ? (
              <Select value={t.priority ?? "Media"} disabled={busy}
                onChange={(e) => post(`/support/tickets/${id}/priority`, { priority: e.target.value }, `Prioridad: ${e.target.value}`)}>
                {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            ) : (
              <p className="text-[13px] font-semibold text-text-primary">{t.priority ?? "Media"}</p>
            )}
            {/* Las dos puntas de la orden: quién la mandó y quién la hace. Lo
                primero no se guardaba en ninguna parte y se preguntaba por
                teléfono; ahora la orden lo dice. Las heredadas del legacy que
                nacieron sin autor siguen sin poder decirlo (`generadaPor` null). */}
            <div className="mb-1 mt-3 text-[11px] font-semibold text-text-tertiary">Generada por</div>
            <p className="text-[13px] font-semibold text-text-primary">
              {t.generadaPor?.nombre ?? "Sin registro"}
              {t.generadaPor && ORIGEN_ORDEN[t.generadaPor.origen] && (
                <span className="ml-1.5 font-normal text-text-tertiary">({ORIGEN_ORDEN[t.generadaPor.origen]})</span>
              )}
            </p>
            <p className="mt-2 text-[11px] text-text-tertiary">
              Creada el {fmtT(t.created)}
              {!t.generadaPor && " · las órdenes del sistema viejo no guardaban quién las abría"}.
            </p>
          </div>
        </aside>
      </div>

      {/* El cliente viaja junto a la orden (2026-09-04): con él, el selector pone
          primero el equipo que ya está apartado a su nombre y el stock de SU sede. La
          entrega se sigue anotando en esta orden — eso lo decide `ticketId`. */}
      {puedeEscribir && <AsignarEquipoModal open={eqModal} onClose={() => setEqModal(false)} onDone={reload} ticketId={id} subscriberId={t.subscriber?.id ?? undefined} />}
      {ubicar && t.subscriber?.id && (
        <UbicarEquipoModal
          open
          subscriberId={t.subscriber.id}
          equipo={ubicar}
          onClose={() => setUbicar(null)}
          onDone={reload}
        />
      )}
      {puedeEscribir && <ConsumirMaterialModal open={matModal} onClose={() => setMatModal(false)} onDone={reload} ticketId={id} />}
      {puedeEditar && editModal && (
        <EditarOrdenModal
          open={editModal}
          onClose={() => setEditModal(false)}
          onDone={reload}
          orden={{
            id, code: t.code ?? null, subject: t.subject ?? null, type: t.type,
            problem: t.problem ?? null, section: t.section ?? null, created: t.created,
            status: t.status, graceDays: t.graceDays ?? null, score: t.score ?? null,
            subscriberId: t.subscriber?.id ?? null, moveToText: t.traslado?.hasta ?? null,
            megas: t.megas ?? null,
            cambioTitular: t.cambioTitular ?? null,
          }}
        />
      )}

      {/* Falta la foto: la orden NO se cerró. Aquí no hay salida por justificación —
          la evidencia se sube o no se cierra—, así que el diálogo sólo tiene un
          camino: ir a adjuntarla, que está en esta misma pantalla. */}
      <Modal
        open={!!faltaFoto}
        onClose={() => setFaltaFoto(null)}
        title="Falta la foto de la visita"
        maxWidth="max-w-md"
      >
        <div className="space-y-3">
          <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
            {faltaFoto}
          </p>
          <p className="text-[12.5px] text-text-tertiary">
            Con la foto queda constancia de lo que se hizo y de que la visita ocurrió: es lo
            que se mira cuando el cliente vuelve a llamar por lo mismo.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFaltaFoto(null)}>Cancelar</Button>
            <Button
              onClick={() => {
                setFaltaFoto(null);
                document.getElementById("seguimiento-foto")?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              Adjuntar la foto
            </Button>
          </div>
        </div>
      </Modal>

      {/* Falta la IP remota: la orden NO se cerró. Aquí sí hay salida inmediata —el
          sistema reparte la dirección y la escribe en el router—, así que el camino
          del diálogo es hacerlo y volver a cerrar. */}
      <Modal
        open={!!faltaIp}
        onClose={() => setFaltaIp(null)}
        title="Falta la IP remota del cliente"
        maxWidth="max-w-md"
      >
        <div className="space-y-3">
          <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
            {faltaIp}
          </p>
          <p className="text-[12.5px] text-text-tertiary">
            La IP fija es por donde sistemas entra al equipo del abonado, y es la dirección
            que el corte bloquea: sin ella, el cliente no se puede cortar aunque deba.
            Al asignarla se le reinicia la conexión un momento.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFaltaIp(null)}>Cancelar</Button>
            <Button disabled={busy} onClick={() => void activarIpRemota()}>Asignar IP remota</Button>
          </div>
        </div>
      </Modal>

      {/* Faltan los datos del cliente: la visita NO arrancó (2026-09-18). El modal
          repite el MISMO bloque del aviso de arriba —no otro texto— y se cierra solo
          cuando ya no falta nada, para que el técnico vuelva a pulsar «Empezar». */}
      <Modal
        open={!!faltanDatos}
        onClose={() => setFaltanDatos(null)}
        title="Faltan datos del cliente"
        maxWidth="max-w-md"
      >
        {faltanDatos && (
          <div className="space-y-3">
            <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
              {faltanDatos.message}
            </p>
            {s?.id && (
              <DatosDelCliente
                subscriberId={s.id}
                falta={faltanDatos.falta}
                gps={s.gpsLat && s.gpsLng ? { lat: Number(s.gpsLat), lng: Number(s.gpsLng) } : null}
                onHecho={() => { setFaltanDatos(null); recargarFotosCasa(s.id); reload(); }}
              />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setFaltanDatos(null)}>Cerrar</Button>
              <Button disabled={busy} onClick={() => void cambiarEstado("REALIZANDO")}>
                Empezar la orden
              </Button>
            </div>
          </div>
        )}
      </Modal>

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
                {/* Fuera de rango YA NO se cierra escribiendo un motivo (2026-09-10).
                    Lo que queda aquí son las dos salidas de verdad: reintentar desde
                    el domicilio, o dejar dicho que la dirección guardada está mal —lo
                    que se escribe va al seguimiento, NO cierra la orden— para que se
                    corrija la coordenada y la cierre quien responde por el trabajo. */}
                <p className="text-[12.5px] text-text-secondary">
                  Si estás en el domicilio y el GPS no agarra bien, acércate a una ventana o sal un
                  momento y reintenta. Esta orden no se puede cerrar desde otro sitio.
                </p>
                {cerca.distanciaM != null && (
                  <p className="text-[12px] text-text-tertiary">
                    El sistema te ubica a {Math.round(cerca.distanciaM).toLocaleString("es-CO")} m del
                    punto guardado del cliente{cerca.radioM ? ` (el máximo es ${cerca.radioM} m)` : ""}.
                  </p>
                )}
                {/* La salida del técnico que SÍ está en la puerta. La causa más frecuente
                    del bloqueo no es que esté lejos: es el punto guardado del cliente
                    —sembrado por un cierre remoto, o vacío en el legacy—. El botón ya
                    existía en la tarjeta del cliente, pero el que está frenado por el 422
                    está mirando ESTE modal y no lo veía: se quedaba esperando al
                    coordinador con el arreglo a dos dedos. Corregir deja renglón en el
                    seguimiento (`avisarGpsCorregido`), que es lo que mantiene visible la
                    válvula: se puede mover el punto, pero no en silencio. */}
                {s?.id && (
                  <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5">
                    <p className="text-[12.5px] font-semibold text-text-secondary">
                      ¿Estás en la casa del cliente y el punto guardado está mal?
                    </p>
                    <p className="mt-0.5 text-[12px] text-text-tertiary">
                      Corrígelo aquí mismo: guarda tu posición como domicilio del cliente y vuelve a
                      cerrar. No hace falta esperar a nadie.
                    </p>
                    <div className="mt-2">
                      <CapturarGps
                        subscriberId={s.id}
                        actual={s.gpsLat && s.gpsLng ? { lat: Number(s.gpsLat), lng: Number(s.gpsLng) } : null}
                        onGuardado={(p) => void avisarGpsCorregido(p)}
                      />
                    </div>
                  </div>
                )}
                <Textarea
                  rows={3}
                  placeholder="Ej.: estoy en la casa del cliente y la dirección guardada apunta a otro barrio…"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                />
                <p className="text-[11px] text-text-tertiary">
                  Esto NO cierra la orden: queda en el seguimiento para que se corrija la ubicación
                  del cliente y la cierre tu coordinador.
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="secondary" onClick={() => { setCerca(null); setMotivo(""); }}>
                    Cancelar
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void avisarUbicacionMal()}
                    disabled={busy || motivo.trim().length < 10}
                  >
                    Avisar en el seguimiento
                  </Button>
                  <Button onClick={() => void cambiarEstado(cerca.estado)} disabled={busy}>
                    {busy ? "Ubicando…" : "Reintentar ubicación"}
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
