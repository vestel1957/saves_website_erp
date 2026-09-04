"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { listaJson, mensajeDeError, objetoJson } from "@/lib/errores";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { TICKET_ESTADOS_ABIERTOS, TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_PRIORITIES, type TicketRow } from "@/lib/support";
import { DireccionFields, DIRECCION_VACIA, NOM_KEYS, ZONA_KEYS, direccionArmada, type DireccionValor } from "@/components/subscribers/DireccionFields";
import { fmtDate, fullCurrency } from "@/lib/format";
import { type Plan } from "@/lib/plans";

/**
 * Lo que el cliente tiene contratado hoy, tal como lo sirve
 * `/subscribers/:id/plan`. En una orden de megas es la mitad de la frase: sin
 * saber de cuánto viene, "400 Megas" no dice si se sube o se baja.
 */
type ServicioActual = { kind: string; planId: string | null; planName: string | null; megas: number | null };

/** Una clase de orden con sus detalles, tal como la sirve `/support/order-catalog`. */
type ClaseOrden = { clase: string; etiqueta: string; descripcion: string; detalles: string[] };

/**
 * Un tipo de orden que se COBRA al abrirlo, tal como lo sirve
 * `/support/cargo-orden`: el traslado y agregar internet, 30.000 cada uno. `activo`
 * es su interruptor (se puede apagar desde el backend sin tocar esta pantalla).
 */
type CargoOrden = { clave: string; tipo: string; etiqueta: string; activo: boolean; precio: number };

/** Hoy en Colombia, en el formato que espera <input type="date">. */
const hoy = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());

/** `hoy() - n` días, también en formato de <input type="date">. */
const hoyMenos = (dias: number) => {
  const [y, m, d] = hoy().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - dias)).toISOString().slice(0, 10);
};

/** Lo mismo que el tope del backend (`MAX_DIAS_ATRAS_ORDEN`): candado contra el dedo. */
const MAX_DIAS_ATRAS = 90;

/**
 * Nueva orden de trabajo.
 *
 * La estructura la manda el legacy: una orden es de una CLASE (servicio, reclamo o
 * incidente) y dentro de ella tiene un DETALLE concreto ('Corte Internet',
 * 'Revision de Internet'…). Antes este formulario pedía un "Asunto" libre que caía
 * justo en la columna de la clase, así que las órdenes nuevas guardaban prosa donde
 * las 320.000 del legacy tienen una de tres palabras. El catálogo llega del backend
 * (`/support/order-catalog`), que es el mismo con el que se enderezan las órdenes
 * que entran por el chatbot.
 */
export function NuevaOrdenModal({ open, onClose, onDone, fixedSub }: { open: boolean; onClose: () => void; onDone: () => void; fixedSub?: PickedSub | null }) {
  const { authFetch } = useAuth();
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [catalogo, setCatalogo] = useState<ClaseOrden[]>([]);
  const [clase, setClase] = useState("servicio");
  const [type, setType] = useState("");
  const [assigned, setAssigned] = useState("");
  const [priority, setPriority] = useState("Media");
  const [agendar, setAgendar] = useState(false);
  const [fecha, setFecha] = useState(hoy());
  /**
   * Fecha con la que queda registrada la orden. Es hoy salvo que se diga otra cosa:
   * el trabajo se pide un día y a veces se alcanza a registrar al siguiente, y de
   * esta fecha —no de la de agendamiento— cuelgan los reportes y el corte del mes.
   */
  const [fechaOrden, setFechaOrden] = useState(hoy());
  const [section, setSection] = useState("");
  /** Días de gracia: solo lo pide la "Reconexion Combo por dias". */
  const [dias, setDias] = useState("3");
  /**
   * Por qué se va el cliente: solo lo pide el 'Retiro voluntario'. Arranca en blanco
   * a propósito —el legacy dejaba marcada "mal servicio", que es justo por qué ese
   * motivo tiene 720 retiros— y viaja en `problem`, la misma casilla que en el resto
   * de las órdenes lleva la falla reportada.
   */
  const [motivo, setMotivo] = useState("");
  /** La lista cerrada de motivos, que sirve el backend (`/support/motivos-retiro`). */
  const [motivos, setMotivos] = useState<string[]>([]);
  /**
   * A dónde se muda el cliente: solo lo pide el 'Traslado'. La ZONA se precarga
   * con la que tiene hoy (mudarse de barrio es lo raro) y la vía se deja en blanco
   * a propósito: es una dirección nueva, y arrancar con la vieja escrita es la
   * forma de que alguien la deje igual sin darse cuenta.
   */
  const [dir, setDir] = useState<DireccionValor>(DIRECCION_VACIA);
  /** La que tiene hoy, para enseñarla al lado y para no repetirla. */
  const [dirActual, setDirActual] = useState<string | null>(null);
  /**
   * A CUÁNTAS MEGAS se pasa: el plan destino de un 'Subir megas' / 'Bajar megas'.
   * Se elige un plan del catálogo y no se escribe un número a mano porque la
   * velocidad no viaja sola — el plan es también el precio de la próxima factura,
   * el perfil del Mikrotik y el traffic-table de la OLT.
   */
  const [planNuevo, setPlanNuevo] = useState("");
  /** Los planes de internet que se pueden vender hoy (los ocultos no se ofrecen). */
  const [planes, setPlanes] = useState<Plan[]>([]);
  /** Lo que tiene contratado, para decir de cuánto viene. */
  const [servicios, setServicios] = useState<ServicioActual[]>([]);
  /**
   * Los tipos de orden que se COBRAN al abrirlos, con su precio de hoy (el traslado
   * y agregar internet, 30.000 cada uno). Vienen del backend —salen del catálogo de
   * productos— y no escritos aquí: el día que suban de precio, esta pantalla no
   * puede seguir diciendo 30.000 mientras la factura dice otra cosa.
   */
  const [cargos, setCargos] = useState<CargoOrden[]>([]);
  const [techs, setTechs] = useState<any[]>([]);
  /**
   * Lo que este cliente ya tiene sin cerrar. Una orden nueva sobre un trabajo que
   * todavía está en la calle es la forma de que salgan dos técnicos a lo mismo (o
   * de que se corte lo que otra orden acaba de reconectar), así que se avisa —
   * pero no se prohíbe: duplicar a veces es lo correcto (una avería nueva mientras
   * arrastra un reclamo viejo, o la orden vieja que quedó zombi).
   */
  const [abiertas, setAbiertas] = useState<TicketRow[]>([]);
  const [abiertasTotal, setAbiertasTotal] = useState(0);
  /** El aviso está en pantalla, esperando que decidan. */
  const [avisando, setAvisando] = useState(false);
  /** Ya dijo "créala igual": no se vuelve a preguntar por este cliente. */
  const [avisado, setAvisado] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSub(fixedSub ?? null); setAssigned(""); setSection(""); setErr(null);
    setClase("servicio"); setType(""); setPriority("Media"); setAgendar(false); setFecha(hoy()); setFechaOrden(hoy());
    setMotivo("");
    setDir(DIRECCION_VACIA); setDirActual(null);
    setPlanNuevo(""); setServicios([]);
    setAbiertas([]); setAbiertasTotal(0); setAvisando(false); setAvisado(false);
    void authFetch("/support/technicians").then(listaJson).then(setTechs).catch(() => {});
    void authFetch("/support/order-catalog").then(listaJson).then(setCatalogo).catch(() => {});
    // Cuánto valen HOY los trabajos que se cobran al abrirlos. Se piden todos de
    // una vez, al abrir el formulario: preguntar por cada detalle que se prueba en
    // el desplegable serían diez consultas para enseñar un renglón.
    void authFetch("/support/cargo-orden")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCargos(Array.isArray(d) ? (d as CargoOrden[]) : []))
      .catch(() => {});
  }, [open, authFetch, fixedSub]);

  const claseActual = useMemo(() => catalogo.find((c) => c.clase === clase) ?? null, [catalogo, clase]);
  /**
   * Esta orden concede el servicio por un plazo, así que necesita un dato que
   * ninguna otra pide. Se compara con el mismo texto que sirve el backend para
   * que el día que se renombre el tipo no queden dos verdades.
   */
  const porDias = type.trim().toLowerCase() === "reconexion combo por dias";
  /**
   * El traslado necesita la dirección destino, y de paso lleva cargo propio. Es
   * 'Traslado' a secas: el 'Traslado interno De Equipos Red en cliente final' mueve
   * el equipo dentro de la misma casa, no cambia de dirección ni se cobra.
   */
  const porTraslado = type.trim().toLowerCase() === "traslado";
  /**
   * La baja del cliente. Es la única orden que pregunta POR QUÉ: de esa respuesta
   * sale el informe de por qué se pierden clientes, y solo se sabe hoy —cuando el
   * cliente está al teléfono diciéndolo—.
   */
  const porRetiro = type.trim().toLowerCase() === "retiro voluntario";
  /**
   * 'Subir megas' / 'Bajar megas': las dos únicas órdenes que tienen que decir a
   * CUÁNTAS. Se mira con `includes` —igual que el backend (`esCambioDeMegas`)— para
   * que las variantes que escribió el sistema viejo entren por el mismo sitio.
   */
  const porMegas = type.trim().toLowerCase().includes("megas");
  const subeMegas = porMegas && type.trim().toLowerCase().includes("subir");
  const bajaMegas = porMegas && type.trim().toLowerCase().includes("bajar");
  /** El plan de internet que tiene hoy: de ahí sale el "de cuánto viene". */
  const internetActual = useMemo(() => servicios.find((s) => s.kind === "INTERNET") ?? null, [servicios]);
  /** Los de internet, del más lento al más rápido: así se lee el desplegable. */
  const planesInternet = useMemo(
    () => planes
      .filter((p) => p.kind === "INTERNET")
      .sort((a, b) => (a.megas ?? 0) - (b.megas ?? 0) || a.name.localeCompare(b.name)),
    [planes],
  );
  const planElegido = useMemo(() => planesInternet.find((p) => p.id === planNuevo) ?? null, [planesInternet, planNuevo]);
  /**
   * El error de dedo de siempre: el plan de al lado en el desplegable, que deja una
   * orden diciendo 'Subir megas' y bajando la velocidad. Se avisa aquí y además lo
   * frena el backend — sólo se puede comprobar cuando los dos planes dicen megas.
   */
  const megasAlReves =
    planElegido?.megas != null && internetActual?.megas != null
      ? (subeMegas && planElegido.megas <= internetActual.megas) || (bajaMegas && planElegido.megas >= internetActual.megas)
      : false;
  const direccionNueva = direccionArmada(dir);
  /**
   * El cargo del detalle elegido, si es de los que se cobran y está encendido. Es
   * lo que hay que decirle a quien abre la orden ANTES de guardarla: la factura se
   * emite sola al crearla y la cajera tiene que cobrarla en ventanilla.
   */
  const cargoActual = useMemo(() => {
    const t = type.trim().toLowerCase();
    const c = cargos.find((x) => x.tipo.trim().toLowerCase() === t);
    return c && c.activo && c.precio > 0 ? c : null;
  }, [cargos, type]);

  /**
   * Las órdenes abiertas del cliente elegido. Se piden en cuanto se elige y no al
   * guardar: enterarse DESPUÉS de llenar el formulario es enterarse tarde. Van
   * con `all=1` porque el listado corta por defecto al año en curso y una orden
   * de hace catorce meses sigue abierta igual.
   */
  useEffect(() => {
    setAvisado(false);
    setAbiertas([]); setAbiertasTotal(0);
    if (!open || !sub) return;
    let vivo = true;
    const qs = new URLSearchParams({
      subscriberId: sub.id,
      status: TICKET_ESTADOS_ABIERTOS.join(","),
      all: "1",
      pageSize: "5",
    });
    void authFetch(`/support/tickets?${qs.toString()}`)
      .then(objetoJson)
      .then((d) => {
        if (!vivo || !d) return;
        setAbiertas(Array.isArray(d.items) ? d.items : []);
        setAbiertasTotal(Number(d.total) || 0);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [open, sub, authFetch]);

  // Los motivos, solo cuando se elige un retiro: son 20 renglones que no pintan
  // nada en el 98% de las órdenes. Se piden una vez por formulario abierto.
  useEffect(() => {
    if (!porRetiro || motivos.length) return;
    let vivo = true;
    void authFetch("/support/motivos-retiro")
      .then(listaJson)
      .then((d) => { if (vivo) setMotivos(d as string[]); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [porRetiro, motivos.length, authFetch]);

  // El catálogo de planes y lo que el cliente tiene hoy. Como los motivos de
  // retiro, sólo cuando la orden es de megas: en el 98% de las órdenes no pinta
  // nada. El catálogo se pide una vez por formulario abierto; lo contratado, cada
  // vez que se cambia de cliente.
  useEffect(() => {
    if (!porMegas || planes.length) return;
    let vivo = true;
    void authFetch("/plans?activeOnly=true&kind=INTERNET")
      .then(listaJson)
      .then((d) => { if (vivo) setPlanes(d as Plan[]); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [porMegas, planes.length, authFetch]);

  useEffect(() => {
    if (!porMegas || !sub) return;
    let vivo = true;
    void authFetch(`/subscribers/${sub.id}/plan`)
      .then(listaJson)
      .then((d) => { if (vivo) setServicios(d as ServicioActual[]); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [porMegas, sub, authFetch]);

  // La zona de hoy, para partir de ella. Se pide solo cuando hace falta: es una
  // consulta más y la mayoría de las órdenes no son traslados.
  useEffect(() => {
    if (!porTraslado || !sub) return;
    let vivo = true;
    void authFetch(`/subscribers/${sub.id}/form`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (!vivo) return;
        const nom = (d.nomenclature ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (v == null ? "" : String(v));
        setDir((p) => ({ ...p, ...Object.fromEntries(ZONA_KEYS.map((k) => [k, str(d[k])])) }));
        setDirActual(direccionArmada({
          ...Object.fromEntries(NOM_KEYS.map((k) => [k, str(nom[k])])),
          addressLine: str(d.addressLine),
        }) || null);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [porTraslado, sub, authFetch]);

  // Al cambiar de clase, el detalle anterior deja de existir: se elige el primero de
  // la nueva en vez de dejar puesto uno que no pertenece a esa clase.
  useEffect(() => {
    if (!claseActual) return;
    setType((t) => (claseActual.detalles.includes(t) ? t : claseActual.detalles[0] ?? ""));
  }, [claseActual]);

  /**
   * `forzar` = "ya vio el aviso de las órdenes abiertas y quiere crearla igual".
   * El aviso se levanta DESPUÉS de validar el formulario: preguntar y que luego
   * salte un campo obligatorio sería preguntar dos veces.
   */
  async function submit(forzar = false) {
    setErr(null);
    if (!sub) { setErr("Selecciona un cliente."); return; }
    if (!type) { setErr("Elige el detalle de la orden."); return; }
    if (agendar && !assigned) { setErr("Para agendarla hay que decir qué técnico la atiende."); return; }
    if (!fechaOrden) { setErr("Pon la fecha de la orden."); return; }
    if (fechaOrden > hoy()) { setErr("La fecha de la orden no puede ser futura. Para un trabajo por venir, agéndala."); return; }
    if (fechaOrden < hoyMenos(MAX_DIAS_ATRAS)) { setErr(`La fecha de la orden no puede ser de hace más de ${MAX_DIAS_ATRAS} días.`); return; }
    if (agendar && fecha < fechaOrden) { setErr("No se puede agendar la orden para antes de su propia fecha."); return; }
    const diasNum = Number(dias);
    if (porDias && (!Number.isInteger(diasNum) || diasNum < 1 || diasNum > 30)) {
      setErr("Los días de reconexión deben ser un número entre 1 y 30."); return;
    }
    if (porRetiro && !motivo) {
      setErr("Di por qué se retira el cliente."); return;
    }
    if (porMegas && !planNuevo) {
      setErr("Elige a qué plan se pasa el cliente: la orden tiene que decir cuántas megas."); return;
    }
    if (megasAlReves) {
      setErr(
        subeMegas
          ? `«${planElegido?.name}» no sube nada: el cliente ya tiene ${internetActual?.megas} Megas.`
          : `«${planElegido?.name}» no baja nada: el cliente tiene ${internetActual?.megas} Megas.`,
      );
      return;
    }
    if (porTraslado && !direccionNueva) {
      setErr("Escribe la dirección a la que se muda el cliente."); return;
    }
    if (porTraslado && dirActual && direccionNueva.toLowerCase() === dirActual.toLowerCase()) {
      setErr("La dirección nueva es la misma que ya tiene el cliente."); return;
    }
    if (abiertas.length && !forzar && !avisado) { setAvisando(true); return; }
    setSaving(true);
    try {
      const res = await authFetch("/support/tickets", {
        method: "POST",
        body: JSON.stringify({
          subscriberId: sub.id,
          subject: clase,
          type,
          assigned: assigned || undefined,
          priority,
          section: section || undefined,
          // En el retiro, `problem` es el motivo por el que se va (ver el catálogo
          // del backend); en el resto de las órdenes esa casilla es la falla, y
          // este formulario no la pide (se escribe en la observación).
          problem: porRetiro ? motivo : undefined,
          created: fechaOrden,
          scheduledFor: agendar ? fecha : undefined,
          graceDays: porDias ? diasNum : undefined,
          // A qué plan se pasa. El backend le cambia el plan al cliente en el acto
          // (igual que la dirección de un traslado): el precio de su próxima factura
          // y el perfil del router quedan al día desde que se abre la orden.
          planToId: porMegas ? planNuevo : undefined,
          moveTo: porTraslado
            ? {
                nomenclature: Object.fromEntries(NOM_KEYS.map((k) => [k, dir[k] || null])),
                ...Object.fromEntries(ZONA_KEYS.filter((k) => dir[k]).map((k) => [k, dir[k]])),
                ...(dir.addressLine ? { addressLine: dir.addressLine } : {}),
              }
            : undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo crear la orden");
      // En un traslado hay que decir DOS cosas más: que la dirección del cliente ya
      // quedó cambiada y con qué factura se le cobró — la cajera la va a cobrar en
      // ventanilla ahora mismo. En el resto de los trabajos con cargo (agregar
      // internet) basta con el número de la factura.
      toast(
        d?.traslado
          ? `Orden #${d.code} creada · dirección actualizada${d.traslado.factura ? ` · factura #${d.traslado.factura}` : ""}`
          : d?.cargo?.factura
            ? `Orden #${d.code} creada · factura #${d.cargo.factura} por ${fullCurrency(d.cargo.precio)}`
            : agendar ? `Orden #${d.code} creada y agendada` : `Orden #${d.code} creada`,
      );
      // El cargo que NO se pudo emitir se dice aparte y en tono de aviso: la orden
      // existe, pero no hay nada que cobrar en ventanilla y alguien tiene que
      // facturarlo a mano.
      if (d?.cargo && !d.cargo.cobrado && !d?.traslado) toast(d.cargo.mensaje, "alert-circle");
      if (d?.traslado && !d.traslado.cobrado) toast(d.traslado.mensaje, "alert-circle");
      // Las megas se aplican al abrir la orden, así que hay que decir si el cliente
      // YA quedó en el plan nuevo. Si no se pudo, queda trabajo pendiente en su
      // ficha y enterarse mañana es enterarse tarde.
      if (d?.megas) toast(d.megas.mensaje, d.megas.aplicado ? "check" : "alert-circle");
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  /**
   * Una línea por orden abierta. Se pinta en dos sitios —el aviso de dentro del
   * formulario y el diálogo de confirmación— así que vive aquí una sola vez.
   */
  const listaAbiertas = (
    <ul className="flex flex-col gap-1.5">
      {abiertas.map((o) => (
        <li key={o.id} className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-[12px]">
          {/* Qué es la orden arriba y de cuándo/de quién abajo: en una sola línea,
              dentro del diálogo estrecho, el nombre del técnico le comía el sitio
              al detalle y "Cambio de clave" se leía "C.". */}
          <div className="flex items-center gap-2">
            <span className="font-mono font-semibold text-text-primary">#{o.code ?? o.legacyId}</span>
            <span className="min-w-0 flex-1 truncate text-text-secondary">{o.type || o.subject}</span>
            <Badge label={TICKET_STATUS_LABEL[o.status] ?? o.status} tone={TICKET_STATUS_TONE[o.status] ?? "default"} />
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-text-tertiary">
            <span>{fmtDate(o.created)}</span>
            {o.assigned && <span>· {o.assigned}</span>}
          </div>
        </li>
      ))}
      {abiertasTotal > abiertas.length && (
        <li className="px-1 text-[11.5px] text-text-tertiary">y {abiertasTotal - abiertas.length} más sin cerrar.</li>
      )}
    </ul>
  );

  return (
    <Modal open={open} onClose={onClose} title="Nueva orden de trabajo" maxWidth="max-w-xl">
      <div className="flex flex-col gap-3">
        <Field label="Cliente" required>
          {fixedSub ? (
            <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] font-semibold text-text-primary">
              {fixedSub.name}
              {fixedSub.abonado != null && <span className="font-mono text-[11px] font-normal text-text-tertiary">#{fixedSub.abonado}</span>}
            </div>
          ) : (
            <SubscriberPicker value={sub} onChange={setSub} />
          )}
        </Field>

        {/* El aviso se queda a la vista mientras se llena el formulario, no sólo
            en el diálogo de al guardar: quien ya lo leyó aquí no se lleva la
            sorpresa al final, y quien no, se la lleva antes de crear nada. */}
        {!!abiertas.length && (
          <div className="rounded-lg border border-warning bg-warning-soft p-3">
            <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-warning-text">
              <Icon name="alert-circle" size={14} />
              {abiertasTotal === 1
                ? "Este cliente ya tiene una orden abierta"
                : `Este cliente ya tiene ${abiertasTotal} órdenes abiertas`}
            </span>
            <div className="mt-2">{listaAbiertas}</div>
          </div>
        )}

        {/* La clase primero y con botones, no en un desplegable: son tres y de ellas
            depende todo lo demás, así que conviene verlas de una. */}
        <Field label="Clase de orden" required>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {catalogo.map((c) => {
              const activa = c.clase === clase;
              return (
                <button
                  key={c.clase}
                  type="button"
                  title={c.descripcion}
                  onClick={() => setClase(c.clase)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    activa
                      ? "border-brand bg-brand-soft"
                      : "border-border-default bg-surface hover:bg-surface-2"
                  }`}
                >
                  <span className={`block text-[13px] font-semibold ${activa ? "text-text-primary" : "text-text-secondary"}`}>
                    {c.etiqueta}
                  </span>
                  <span className="block text-[11px] leading-snug text-text-tertiary">{c.descripcion}</span>
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Detalle" required hint={claseActual ? `Lo que se va a hacer (${claseActual.detalles.length} opciones)` : undefined}>
            <Select value={type} onChange={(e) => setType(e.target.value)} disabled={!claseActual}>
              {(claseActual?.detalles ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          {/* Este trabajo se cobra. El aviso va pegado al detalle y no dentro del
              bloque del traslado —que tiene el suyo, junto a la dirección— porque
              para el resto de los cargos éste es el único sitio donde se ve que
              abrir la orden le genera una factura al cliente. */}
          {cargoActual && !porTraslado && (
            <div className="sm:col-span-2 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2">
              <Icon name="receipt" className="mt-[2px] h-4 w-4 shrink-0 text-warning-text" />
              <p className="text-[12px] leading-snug text-text-secondary">
                Al crear la orden se le factura <b className="text-text-primary">{fullCurrency(cargoActual.precio)}</b>{" "}
                por {cargoActual.etiqueta.toLowerCase()}: un pago único, en factura aparte, que vence hoy.
              </p>
            </div>
          )}
          {porDias && (
            <Field label="Días de reconexión" required hint="Al vencer vuelve a ser cortable">
              <Input type="number" min={1} max={30} value={dias} onChange={(e) => setDias(e.target.value)} />
            </Field>
          )}
          {/* A CUÁNTAS MEGAS se pasa. Ocupa el ancho entero y va en su propio bloque
              porque no basta con el desplegable: hay que ver de cuánto viene el
              cliente y en cuánto queda ANTES de guardar. El plan NO se le cambia
              aquí: se le cambia al CERRAR la orden, que es cuando la velocidad
              nueva ya está puesta (y ahí se le reprecia la factura del mes). */}
          {porMegas && (
            <div className="rounded-lg border border-border-default bg-surface-2 p-3 sm:col-span-2">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-text-primary">
                  {bajaMegas ? "¿A cuántas megas se baja?" : "¿A cuántas megas se sube?"}
                </span>
                {internetActual && (
                  <span className="text-[12px] text-text-secondary">
                    Hoy tiene{" "}
                    <b className="text-text-primary">
                      {internetActual.megas != null ? `${internetActual.megas} Megas` : internetActual.planName ?? "plan sin registrar"}
                    </b>
                  </span>
                )}
              </div>
              {!sub && <p className="mb-2 text-[12px] text-text-tertiary">Elige primero el cliente para ver de cuántas megas viene.</p>}
              <Field label="Plan nuevo" required hint="La velocidad la pone el plan: es también el precio de la próxima factura y el perfil que se le empuja al router">
                <Select value={planNuevo} onChange={(e) => setPlanNuevo(e.target.value)} disabled={!planesInternet.length}>
                  <option value="">{planesInternet.length ? "— elige el plan —" : "Cargando…"}</option>
                  {planesInternet.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.megas != null ? `${p.megas} Megas · ${p.name}` : p.name} · {fullCurrency(p.price)}
                    </option>
                  ))}
                </Select>
              </Field>
              {planElegido && !megasAlReves && (
                <p className="mt-2 text-[12px] text-text-secondary">
                  Queda en{" "}
                  <b className="text-text-primary">{planElegido.megas != null ? `${planElegido.megas} Megas` : planElegido.name}</b>
                  {" · "}{fullCurrency(planElegido.price)} al mes. Se le aplica al cerrar la orden, y ahí se le
                  reprecia la factura de este mes.
                </p>
              )}
              {megasAlReves && (
                <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-text">
                  <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
                  {subeMegas
                    ? `«${planElegido?.name}» no sube nada: el cliente ya tiene ${internetActual?.megas} Megas.`
                    : `«${planElegido?.name}» no baja nada: el cliente tiene ${internetActual?.megas} Megas.`}
                </p>
              )}
            </div>
          )}
          {/* Por qué se va. Ocupa el ancho entero porque los motivos son frases
              largas ("Cambio de municipio que no cuenta con cobertura") y en media
              columna se leen a la mitad. */}
          {porRetiro && (
            <div className="sm:col-span-2">
              <Field
                label="Razón del retiro"
                required
                hint="Queda en la orden y es de donde sale el informe de por qué se van los clientes"
              >
                <Select value={motivo} onChange={(e) => setMotivo(e.target.value)} disabled={!motivos.length}>
                  <option value="">{motivos.length ? "— elige el motivo —" : "Cargando…"}</option>
                  {motivos.map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
              </Field>
            </div>
          )}
          <Field label="Técnico asignado" hint={agendar ? "Obligatorio para agendar" : undefined}>
            <Select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
              <option value="">— Sin asignar —</option>
              {techs.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Prioridad" hint="Manda el orden en que se reparte y se atiende">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          {/* La fecha con la que queda registrada, que no siempre es hoy: lo que se
              pidió ayer por teléfono se alcanza a registrar hoy, y de esta fecha
              cuelgan los reportes. */}
          <Field
            label="Fecha de la orden"
            required
            hint={fechaOrden !== hoy() ? "Se registra con fecha de otro día" : "Cámbiala si la orden es de un día anterior"}
          >
            <Input
              type="date"
              value={fechaOrden}
              min={hoyMenos(MAX_DIAS_ATRAS)}
              max={hoy()}
              onChange={(e) => setFechaOrden(e.target.value)}
            />
          </Field>
        </div>

        {/* Traslado: a dónde se muda y qué se le cobra. La dirección se le cambia
            al cliente en cuanto se abre la orden, así que aquí se enseña de dónde a
            dónde va antes de guardar. */}
        {porTraslado && (
          <div className="rounded-lg border border-border-default bg-surface-2 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-text-primary">Nueva dirección del cliente</span>
              {cargoActual && (
                <span className="text-[12px] text-text-secondary">
                  Se le facturarán <b className="text-text-primary">{fullCurrency(cargoActual.precio)}</b> por el traslado
                </span>
              )}
            </div>
            {dirActual && (
              <p className="mb-2 text-[12px] text-text-tertiary">
                Hoy vive en <span className="text-text-secondary">{dirActual}</span>. Al crear la orden la ficha queda con la dirección nueva.
              </p>
            )}
            {!sub && <p className="mb-2 text-[12px] text-text-tertiary">Elige primero el cliente para traer su zona.</p>}
            <DireccionFields value={dir} onChange={(patch) => setDir((p) => ({ ...p, ...patch }))} comercial={false} />
            <p className="mt-2 text-[12px] text-text-secondary">
              Queda como: <b className="text-text-primary">{direccionNueva || "— escribe la vía y su número —"}</b>
            </p>
          </div>
        )}

        {/* Agendar o no: sin agendar, la orden entra a la bandeja y la cajera la
            reparte después desde el tablero; agendada, entra directo a la cola del
            técnico ese día. */}
        <Field label="¿Se va a agendar?">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="grid grid-cols-2 gap-2 sm:w-72">
              <button
                type="button"
                onClick={() => setAgendar(false)}
                className={`rounded-lg border px-3 py-2 text-[13px] font-semibold transition-colors ${
                  !agendar ? "border-brand bg-brand-soft text-text-primary" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
                }`}
              >
                No por ahora
              </button>
              <button
                type="button"
                onClick={() => setAgendar(true)}
                className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-semibold transition-colors ${
                  agendar ? "border-brand bg-brand-soft text-text-primary" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
                }`}
              >
                <Icon name="calendar-clock" size={14} /> Agendar
              </button>
            </div>
            {agendar ? (
              <div className="flex flex-col gap-1 sm:w-64">
                {/* El tope de abajo es la fecha de la orden, no hoy: una orden de ayer
                    se agenda para ayer (se atendió y se está registrando), pero
                    agendarla antes de que exista no significa nada. */}
                <Input type="date" value={fecha} min={fechaOrden} onChange={(e) => setFecha(e.target.value)} className="sm:w-48" />
                {fecha < hoy() && (
                  <span className="text-[11px] text-text-tertiary">Día ya pasado: al técnico le aparece como atrasada.</span>
                )}
              </div>
            ) : (
              <span className="text-[11px] text-text-tertiary">Queda en la bandeja de sin agendar.</span>
            )}
          </div>
        </Field>

        <Field label="Observación" hint="Lo que hay que saber para atenderla: qué reporta el cliente, el paquete, la referencia…">
          <Textarea rows={3} value={section} onChange={(e) => setSection(e.target.value)} placeholder="Ej: el cliente reporta que no le funciona el canal 12 desde ayer" />
        </Field>

        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={() => void submit()} disabled={saving || !sub}>{saving ? "Creando…" : agendar ? "Crear y agendar" : "Crear orden"}</Button>
        </div>
      </div>

      {/* Avisar, no prohibir: dos órdenes abiertas a la vez suelen ser un error
          (dos técnicos al mismo trabajo), pero a veces es lo correcto — una avería
          nueva mientras arrastra un reclamo viejo, o una orden que quedó zombi. La
          decisión es de quien atiende al cliente, no del formulario. */}
      <ConfirmDialog
        open={avisando}
        tone="primary"
        icon="alert-circle"
        title={abiertasTotal === 1 ? "El cliente ya tiene una orden abierta" : "El cliente ya tiene órdenes abiertas"}
        message={
          <p>
            {sub?.name ? <b className="text-text-primary">{sub.name}</b> : "Este cliente"} tiene{" "}
            {abiertasTotal === 1 ? "una orden sin cerrar" : `${abiertasTotal} órdenes sin cerrar`}. Revisa si lo que
            vas a crear ya está pedido: si es así, mejor atiende la que existe en vez de abrir otra.
          </p>
        }
        detail={listaAbiertas}
        confirmLabel="Crear la orden igual"
        cancelLabel="Volver"
        busy={saving}
        onConfirm={() => { setAvisado(true); setAvisando(false); void submit(true); }}
        onClose={() => setAvisando(false)}
      />
    </Modal>
  );
}
