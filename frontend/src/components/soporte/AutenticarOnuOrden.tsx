"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

/**
 * Autenticación de la ONU DENTRO de la orden de instalación.
 *
 * Un desplegable y un botón. El técnico solo decide lo que solo él puede saber
 * —cuál de las ONUs que se están anunciando es la que acaba de instalar— y el
 * resto (OLT de la sede, puerto, VLAN, perfiles, comentario, vínculo con el
 * abonado) lo resuelve el servidor.
 *
 * La VELOCIDAD ya no se elige: sale del plan contratado. Si el plan no tiene su
 * equivalencia configurada en la OLT, el bloque no deja autenticar y dice dónde
 * arreglarlo — antes se podía dar de alta una ONU sin tope de velocidad sin que
 * nadie se enterara hasta ver el consumo.
 */

/**
 * Tipos de orden donde este bloque tiene sentido (espejo de `modoDeOrden` en el
 * backend — si cambia uno hay que cambiar el otro).
 *
 * Son los CINCO trabajos que dejan al cliente conectado —Instalación, Traslado,
 * Migración, Cambio de equipo y AgregarInternet, que va por el predicado de
 * abajo— más «Subir megas». La REINSTALACIÓN queda fuera desde el 2026-09-08 (lo
 * pidió el usuario): el equipo ya está puesto y ya está de alta en la OLT, así que
 * el bloque entero no se pinta. Calza con 'instalac', de modo que hay que
 * descontarla a mano, igual que en el backend (`esReinstalacion`). En el backend la lista de los
 * cinco vive una sola vez, en `FRAGMENTOS_TRABAJO_DE_CONEXION`
 * (`support/order-types.ts`), y de ella dependen también las reglas de estado al
 * cerrar la orden.
 *
 * «Subir megas» está en las dos listas a propósito: normalmente solo hay que
 * aplicarle la velocidad a la ONU que el cliente ya tiene, pero si el equipo
 * viejo no da el plan nuevo el técnico monta otro y hay que autenticarlo. Esas
 * órdenes salen en modo `AMBOS` y enseñan las dos acciones.
 */
const TIPOS_AUTENTICAR = ["instalac", "traslado", "cambio de equipo", "migraci", "subir megas"];

/** Sin tildes y por fragmento: en la base conviven 'Reinstalación' y 'Reinstalacion'. */
const esReinstalacion = (t: string) =>
  t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes("reinstalac");
const TIPOS_VELOCIDAD = ["subir megas", "bajar megas", "cambio de plan"];

/**
 * 'AgregarInternet' se compara ENTERO y no por fragmento: el nombre real del
 * detalle va sin espacio y no casa con ninguna de las palabras de arriba, así
 * que el bloque no salía en esas órdenes. Sale en modo `AMBOS` porque las dos
 * cosas son posibles: la ONU de la televisión ya está puesta y solo falta
 * aplicarle la velocidad del plan nuevo, o el técnico monta un equipo y hay que
 * autenticarlo (ver `modoDeOrden` en el backend, que es quien manda).
 */
const esAgregarInternet = (t: string) => t.trim() === "agregarinternet";

type Modo = "AUTENTICAR" | "VELOCIDAD" | "AMBOS" | null;

export function modoDeOrden(type: string | null | undefined): Modo {
  const t = (type ?? "").toLowerCase();
  if (!t.trim()) return null;
  // Va antes que nada: 'reinstalac' contiene 'instalac' y entraría por ahí.
  if (esReinstalacion(t)) return null;
  if (esAgregarInternet(t)) return "AMBOS";
  // Cada lista se evalúa entera: «Cambio de equipo» y «Cambio de plan» empiezan
  // igual y con un `else if` una taparía a la otra.
  const autentica = TIPOS_AUTENTICAR.some((k) => t.includes(k));
  const velocidad = TIPOS_VELOCIDAD.some((k) => t.includes(k));
  if (autentica && velocidad) return "AMBOS";
  if (velocidad) return "VELOCIDAD";
  if (autentica) return "AUTENTICAR";
  return null;
}

/** ¿Se puede autenticar una ONU en una orden de este modo? */
const modoAutentica = (m: Modo) => m === "AUTENTICAR" || m === "AMBOS";
/** ¿Se puede aplicar la velocidad del plan a la ONU que ya tiene? */
const modoVelocidad = (m: Modo) => m === "VELOCIDAD" || m === "AMBOS";

type EquipoInv = { code: number; serial: string | null; bodega: string | null; status: string | null };
type Candidato = {
  sn: string; fsp: string; model: string | null; vendor: string | null; mac: string | null;
  /**
   * Minutos que lleva anunciándose (`Ont autofind time` de la OLT). Es el dato
   * que separa la ONU recién conectada del ruido: el autofind de VILLANUEVA
   * arrastra 66 equipos, alguno desde hace 15 días.
   */
  haceMin: number | null;
  delAbonado: boolean;
  /** Ficha del equipo en el inventario, si ese serial está registrado. */
  equipo: EquipoInv | null;
  /** Motivo por el que este equipo NO se puede autenticar (ya es de otro cliente). */
  impedimento: string | null;
  /** Aviso que no bloquea (bodega de otra sede, equipo depurado…). */
  aviso: string | null;
};
/**
 * Lo que el sistema autenticaría solo, sin preguntar. `sn` en null = hace falta
 * una persona, y `motivo` dice por qué.
 */
type Auto = {
  sn: string | null;
  /**
   * `DEL_ABONADO` el equipo ya figura a nombre del cliente · `BODEGA_SEDE` es una
   * unidad libre de una bodega de su sede · `STOCK_SEDE` el serial no está en el
   * inventario y se le carga una unidad del stock de su sede.
   */
  origen: "DEL_ABONADO" | "BODEGA_SEDE" | "STOCK_SEDE" | null;
  /** Minutos que llevaba anunciándose la elegida. */
  haceMin?: number | null;
  equipo: { id: string; code: number; serial: string | null; bodega: string | null; reservado?: boolean } | null;
  deStock: boolean;
  motivo: string;
};
type VlanPuerto = { fsp: string; vlan: number | null; origen: string | null; ok: boolean | null; falta: string[]; vlanCatalogoId: string | null; branchId: string | null };
type Estado = {
  /**
   * Por dónde se le da servicio a este abonado. `MIKROTIK` = tecnología sin OLT
   * (hoy EPON): no hay ONU que autenticar, lo que se aplica es el perfil PPP de
   * su plan en el `/ppp/secret`. El servidor manda los mismos campos en las dos
   * vías —`candidatos`, `auto` y demás vienen vacíos— así que esto es lo único
   * que hay que mirar para saber qué cara pintar.
   */
  via: "OLT" | "MIKROTIK";
  modo: Modo;
  live: boolean;
  olt: { id: string; name: string } | null;
  /** Vía Mikrotik: el router elegido por sede+tecnología y el perfil que se aplicará. */
  mikrotik?: { id: string; name: string; host: string; tech: string } | null;
  /**
   * El abonado estrena internet y todavía no tiene usuario PPPoE: al autenticar
   * se le crean solos sus datos de red (usuario, clave y `/ppp/secret` con el
   * perfil de su plan). Se avisa ANTES para que nadie salga a crearlo a mano.
   */
  altaMikrotikPendiente?: boolean;
  perfil?: string | null;
  pppUsername?: string | null;
  /**
   * `derivado` = el plan no está registrado en la ficha; sale de lo que se le viene
   * facturando. `estado: "DE_LA_ORDEN"` = es el plan DESTINO que porta la orden de
   * megas: el abonado todavía está en el suyo y pasa al nuevo al cerrarla.
   */
  plan: { id: string | null; name: string | null; megas: number | null; estado: string; derivado?: boolean } | null;
  velocidad: { trafficIn: number | null; trafficOut: number | null; mbpsIn: number | null; mbpsOut: number | null; origen: string } | null;
  bloqueo: { code: string; message: string } | null;
  candidatos: Candidato[];
  auto: Auto | null;
  /**
   * El equipo que el inventario ya da por de este cliente —asignado, o apartado
   * al abrir la orden— y qué dice la OLT de él. `anunciandose` es lo único que
   * significa "listo para autenticar": el papel no enciende la fibra.
   */
  /** ONUs vinculadas al abonado en el inventario de la OLT (más de una = cambio de equipo a medias). */
  onusDelCliente?: { sn: string; frame: number; slot: number; port: number; ontId: number; runState: string | null; olt: { name: string } | null }[];
  equipoAsignado: {
    code: number; serial: string | null; status: string | null; bodega: string | null;
    reservado: boolean; anunciandose: boolean; sn: string | null; haceMin: number | null;
    impedimento: string | null; autenticada: boolean;
    /** Dónde la tiene dada de alta la OLT (leído en vivo por su serial). */
    autenticadaEn?: { fsp: string; ontId: number; descripcion: string; runState: string } | null;
  } | null;
  onuActual: { sn: string | null; frame: number | null; slot: number | null; port: number | null; ontId: number | null; runState: string | null } | null;
  /**
   * ¿La VLAN del puerto donde está la ONU llega al PPPoE? (existe en la OLT, sale
   * por el uplink, y el Mikrotik tiene su interfaz y servidor PPPoE). `ok: false`
   * = si se autentica, la ONU quedará en línea y SIN internet (la 590 de
   * Villanueva, sep-2026). `ok: null` = no se pudo comprobar.
   */
  vlanPuerto?: VlanPuerto | null;
  /** El mismo chequeo por cada puerto con ONUs esperando (hasta 3): se enseña el de la elegida. */
  vlanPuertos?: VlanPuerto[];
  /** Lo que dio la comprobación "¿navega?" 60 s después de autenticar. */
  navegacion?: { at: number; estado: "PENDIENTE" | "NAVEGANDO" | "SIN_PPPOE" | "SIN_REVISAR"; mensaje: string } | null;
};
type Resultado = {
  ok: boolean; dryRun?: boolean; message?: string; error?: string; ontId?: string; fsp?: string;
  commands?: string[];
  /** La ONU ya estaba dada de alta y se adoptó en vez de volver a autenticarla. */
  adoptada?: boolean;
  /** Subir megas: la ONU se desautenticó y se volvió a autenticar con el plan nuevo. */
  reautenticada?: boolean;
  /** Subir megas fallido: si se pudo dejar la ONU como estaba. */
  restaurada?: boolean | null;
  cambios?: string[];
  avisos?: string[];
  antes?: { traffic_in: string; traffic_out: string };
  despues?: { traffic_in: string; traffic_out: string };
  equipo?: { code: number; serialCorregido: boolean; bodega: string | null } | null;
  /** La ONU la eligió el sistema: de dónde salió y qué quedó pendiente. */
  auto?: { origen: string | null; deStock: boolean; aviso: string | null } | null;
  /**
   * El alta del abonado en la Mikrotik que se hizo antes de autenticar. La ONU le
   * da enlace; esto es lo que le da internet. null = esta orden no lo toca.
   */
  altaMikrotik?: {
    ok: boolean; creado: boolean; usuarioCreado: boolean; dryRun: boolean;
    pppUsername: string | null; perfil: string | null; router: string | null; mensaje: string;
  } | null;
  /** Vía Mikrotik: qué se escribió, en qué router y con qué perfil. */
  steps?: string[];
  perfil?: string | null;
  mikrotik?: { name: string; host: string } | null;
  /** Lo que se cuadró en el inventario: reservas devueltas a bodega y ONU vieja retirada. */
  conciliacion?: { liberados: number[]; devuelto: number | null } | null;
  /** Traslado: de dónde se desautenticó la ONU antes de darla de alta en el puerto nuevo. */
  liberacion?: { borrado: boolean; dryRun: boolean; anterior: string | null; tambienEn: string[]; avisos: string[] } | null;
  verificacion?: {
    run_state: string | null; config_state: string | null; match_state: string | null;
    servicePorts: string[]; avisos: string[]; nota?: string | null;
  } | null;
};

/** Etiqueta del desplegable: lo que el técnico necesita para reconocer SU equipo. */
/** "hace 4 min" / "hace 3 h" / "hace 15 días" — sin decimales ni jerga. */
function desdeHace(min: number | null | undefined): string | null {
  if (min == null) return null;
  if (min < 60) return `hace ${min} min`;
  if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / (60 * 24))} días`;
}

/**
 * "El cliente ya tiene equipo, ¿por qué me pide elegir?" y "¿ya está listo para
 * autenticar?" — las dos se contestan con lo mismo: qué caja es la suya y si la
 * OLT la está viendo.
 *
 * El inventario dice de quién es un aparato; solo la OLT sabe cuál está colgado
 * del puerto de esa casa. Por eso "asignado" no es "listo": mientras el equipo no
 * se anuncie en el autofind no hay nada que autenticar, y el automático manda a
 * elegir a mano sin que se viera el motivo de verdad.
 */
function EquipoDelCliente({ e, onUsar }: { e: NonNullable<Estado["equipoAsignado"]>; onUsar: (sn: string) => void }) {
  const nombre = (
    <>
      <span className="font-mono font-semibold text-text-primary">{e.serial || e.sn || "sin serial"}</span>
      {" · código "}<span className="font-semibold text-text-primary">{e.code}</span>
      {e.bodega ? ` · bodega ${e.bodega}` : ""}
    </>
  );
  const titulo = e.reservado ? "Equipo apartado para esta orden" : "Equipo asignado al cliente";

  // Listo: la OLT lo ve y nada impide montarlo. Es el caso en que el automático
  // lo elige solo, así que aquí solo se confirma en una línea.
  if (e.anunciandose && !e.impedimento) {
    return (
      <div className="rounded-lg border border-success/40 bg-success-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
        <Icon name="check" size={13} className="mr-1 inline text-success-text" />
        {titulo}: {nombre}. La OLT ya lo está viendo{desdeHace(e.haceMin) ? ` (apareció ${desdeHace(e.haceMin)})` : ""}:
        <b> listo para autenticar</b>.
      </div>
    );
  }
  // Dada de alta en la OLT pero sin que el sistema lo supiera (alta de SmartOLT o
  // del cliente anterior). No sale en el autofind por eso, no por la fibra: se dice
  // dónde está y se ofrece adoptarla para este cliente sin volver a darla de alta.
  if (e.autenticadaEn) {
    const a = e.autenticadaEn;
    return (
      <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
        <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
        {titulo}: {nombre}. <b>Ya está autenticado en la OLT</b> en el puerto {a.fsp} · ONT {a.ontId}
        {a.descripcion ? <> con el nombre «<span className="font-mono">{a.descripcion}</span>»</> : null}
        {a.runState ? ` (${a.runState})` : ""}, por eso no aparece en la lista de espera.
        {e.sn && (
          <button type="button" className="ml-1 font-semibold text-brand hover:underline" onClick={() => onUsar(e.sn!)}>
            Usarlo en este cliente
          </button>
        )}
        <span className="mt-1 block text-text-tertiary">
          Se aprovecha el alta que ya tiene: se le pone el nombre y la velocidad de este cliente sin desconectarlo.
        </span>
      </div>
    );
  }
  // Ya tiene alta: no sale en el autofind y eso es lo normal, no un problema.
  if (e.autenticada) {
    return (
      <p className="text-[11.5px] text-text-tertiary">
        <Icon name="info" size={13} className="mr-1 inline" />
        {titulo}: {nombre}. Ya está autenticado en la OLT, por eso no aparece en la lista de espera.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
      <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
      {titulo}: {nombre}.{" "}
      <b>La OLT todavía no lo ve</b>, así que no está listo para autenticar: compruebe que está conectado
      a la fibra y encendido, y refresque. Si el técnico montó otro equipo, elíjalo abajo — al autenticarlo,
      este vuelve solo a la bodega.
      {e.impedimento && <span className="mt-1 block text-error-text">{e.impedimento}</span>}
    </div>
  );
}

function etiquetaCandidato(c: Candidato): string {
  const partes = [c.sn];
  // Lo primero después del serial: cuándo apareció. En una lista de 66 ONUs es
  // lo único que distingue la que el técnico acaba de conectar.
  const hace = desdeHace(c.haceMin);
  if (hace) partes.push(hace);
  if (c.model) partes.push(c.model);
  if (c.fsp) partes.push(`puerto ${c.fsp}`);
  // La bodega de la que salió el equipo va en la propia línea: es el dato con el
  // que el técnico reconoce si es suyo o si lo cogió de otro sitio.
  if (c.equipo?.bodega) partes.push(`bodega ${c.equipo.bodega}`);
  else if (!c.equipo) partes.push("sin registrar en inventario");
  const marca = c.impedimento ? "⛔ " : c.delAbonado ? "★ " : c.aviso ? "⚠ " : "";
  return marca + partes.join(" · ");
}

/** Qué va a hacer el botón automático, dicho en una línea y sin jerga. */
function fraseDelAuto(a: Auto): string {
  const eq = a.equipo;
  if (a.origen === "DEL_ABONADO") {
    return eq?.reservado
      ? `Es el equipo que se reservó para esta orden al abrirla (código ${eq.code}).`
      : `Es el equipo que ya figura a nombre de este cliente${eq ? ` (código ${eq.code})` : ""}.`;
  }
  if (a.origen === "BODEGA_SEDE") {
    return `Es una unidad de la bodega ${eq?.bodega ?? "de su sede"}${eq ? ` (código ${eq.code})` : ""}: `
      + "al autenticar sale del stock y queda a nombre del cliente.";
  }
  // STOCK_SEDE: el serial no lo conoce el inventario. Es el caso del cliente
  // nuevo y el que va limpiando los ~3.400 equipos con el serial sin poner.
  return eq
    ? `Este serial no está en el inventario: se le carga la unidad ${eq.code} de la bodega ${eq.bodega ?? "de su sede"} `
      + "y se le graba el serial que reporta la OLT."
    : "Este serial no está en el inventario.";
}

export function AutenticarOnuOrden({
  ticketId, tipo, estadoOrden, onDone,
}: {
  ticketId: string;
  tipo: string | null;
  /** Estado de la orden: en las cerradas no se interroga la OLT sola. */
  estadoOrden?: string | null;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const modo = modoDeOrden(tipo);
  /** Cambia el texto del bloque: aquí la ONU de la TV puede estar ya autenticada. */
  const porAgregarInternet = esAgregarInternet((tipo ?? "").toLowerCase());
  /** «Subir megas»: aplicar la velocidad es desautenticar y volver a autenticar la ONU. */
  const subeMegas = /megas/i.test(tipo ?? "") && /subir/i.test(tipo ?? "");
  // Cada consulta es una sesión SSH real contra la OLT. En una orden abierta
  // vale la pena (el técnico está a punto de autenticar); en una ya cerrada —y
  // hay miles en el histórico— sería interrogar el equipo cada vez que alguien
  // abre la ficha para leerla. Ahí se pide bajo demanda.
  const abierta = !estadoOrden || estadoOrden === "PENDIENTE" || estadoOrden === "REALIZANDO";
  const [est, setEst] = useState<Estado | null>(null);
  const [cargando, setCargando] = useState(false);
  const [sn, setSn] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Resultado | null>(null);
  /**
   * Por qué no se pudo autenticar. Va en un recuadro fijo, no en un aviso que se
   * va solo: estos mensajes explican qué falta (perfiles del puerto, ONU que ya
   * no se anuncia, equipo de otro cliente) y el técnico necesita releerlos —con
   * el toast la pantalla se quedaba igual y parecía que el botón no hacía nada.
   */
  const [error, setError] = useState<string | null>(null);
  /** Serial escrito a mano: la ONU no está en el autofind porque YA está autenticada. */
  const [manual, setManual] = useState(false);
  /** El técnico ha pedido elegir él la ONU, teniendo el sistema una elegida. */
  const [aMano, setAMano] = useState(false);
  /** Equipo del inventario al que corresponde la ONU, cuando su SN no está registrado. */
  const [equipmentId, setEquipmentId] = useState("");
  const [inventario, setInventario] = useState<{ id: string; code: number; serial: string | null; mac: string | null; warehouse: string | null }[]>([]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const r = await authFetch(`/support/tickets/${ticketId}/onu`);
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo consultar la OLT");
      setEst(d);
      // Preselecciona la ONU que ya está registrada a nombre del abonado: en la
      // mayoría de instalaciones es la única candidata correcta y el técnico solo
      // tiene que confirmar.
      // Preselecciona solo entre las que SE PUEDEN autenticar: nunca dejar el
      // desplegable apuntando a un equipo que está a nombre de otro cliente.
      const libres = (d.candidatos ?? []).filter((c: Candidato) => !c.impedimento);
      const suya = libres.find((c: Candidato) => c.delAbonado);
      // La que elegiría el sistema manda en la preselección: si el técnico abre
      // el desplegable, tiene que ver marcada la misma que dice el recuadro.
      setSn(d.auto?.sn ?? suya?.sn ?? (libres.length === 1 ? libres[0].sn : ""));
      setEquipmentId("");
      setAMano(false);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
      setEst(null);
    } finally {
      setCargando(false);
    }
  }, [authFetch, ticketId]);

  useEffect(() => {
    if (!modo || !abierta) return;
    void cargar();
  }, [modo, abierta, cargar]);

  // Recién autenticada, el servidor mira a los 60 s si el abonado levantó PPPoE:
  // se vuelve a consultar sola un poco después para enseñar el resultado.
  const navPendienteDesde = est?.navegacion?.estado === "PENDIENTE" ? est.navegacion.at : null;
  useEffect(() => {
    if (navPendienteDesde == null) return;
    const espera = Math.max(5_000, navPendienteDesde + 65_000 - Date.now());
    const t = setTimeout(() => void cargar(), espera);
    return () => clearTimeout(t);
  }, [navPendienteDesde, cargar]);

  if (!modo) return null;

  async function ejecutar(url: string, body?: unknown) {
    setBusy(true);
    setRes(null);
    setError(null);
    try {
      const r = await authFetch(url, { method: "POST", body: JSON.stringify(body ?? {}) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo completar la operación");
      setRes(d);
      if (d.ok) {
        toast(d.dryRun ? "Plan generado (dry-run)" : "Listo", "check");
        onDone?.();
        void cargar();
      } else {
        // El equipo que rechaza es la OLT o la Mikrotik según la vía del abonado:
        // el mensaje va sin nombrarlo, y el detalle real lo trae `d.error`.
        toast(d.error || "El equipo rechazó la operación", "alert-triangle");
      }
    } catch (e) {
      const msg = mensajeDeError(e);
      setError(msg);
      toast(msg, "alert-triangle");
    } finally {
      setBusy(false);
    }
  }

  const vel = est?.velocidad;
  /**
   * Abonado sin OLT (EPON): el bloque entero cambia de cara. No hay autofind, ni
   * desplegable, ni equipo que elegir — solo el perfil de su plan y el router al
   * que se le va a escribir.
   */
  const viaMk = est?.via === "MIKROTIK";
  const elegida = est?.candidatos.find((c) => c.sn === sn) ?? null;
  /**
   * La OLT no ve ninguna ONU esperando. El motivo más común en esta planta no es
   * que el equipo esté apagado: es que YA está autenticado (alta anterior o
   * hecha desde SmartOLT). Eso no es un callejón sin salida —el servidor la
   * adopta— pero hay que poder decirle cuál es, y ahí no hay lista de la que
   * elegir: se escribe el serial de la etiqueta.
   */
  const soloManual = est?.bloqueo?.code === "AUTOFIND_VACIO";
  const escribiendo = manual || soloManual;
  /**
   * El sistema tiene ONU elegida y el técnico no ha pedido elegir él. Entonces no
   * se enseña ningún desplegable: un botón y lo que va a hacer, escrito.
   */
  const autoListo = !!est?.auto?.sn && !aMano && !escribiendo;
  const bloqueoDuro = !!est?.bloqueo && !soloManual;
  const puedeAutenticar = !!est && !bloqueoDuro && !!sn.trim() && !elegida?.impedimento && modoAutentica(modo);
  /** El SN no está en el inventario: se ofrece decir a qué equipo corresponde. */
  const sinRegistrar = escribiendo ? sn.trim().length >= 8 : !!elegida && !elegida.equipo;

  /** Carga el stock disponible solo cuando hace falta el vinculador (no en cada apertura). */
  const buscarInventario = useCallback(async (q: string) => {
    try {
      const r = await authFetch(`/support/equipment/available${q ? `?search=${encodeURIComponent(q)}` : ""}`);
      setInventario(r.ok ? await r.json() : []);
    } catch { setInventario([]); }
  }, [authFetch]);
  useEffect(() => {
    if (sinRegistrar) void buscarInventario("");
  }, [sinRegistrar, buscarInventario]);

  return (
    <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Icon name={viaMk ? "gauge" : "radio-tower"} size={15} className="text-brand" />
          {viaMk
            ? "Plan del abonado en la Mikrotik"
            : modo === "AMBOS" ? "ONU del abonado" : modo === "AUTENTICAR" ? "Autenticación de la ONU" : "Velocidad de la ONU"}
        </div>
        <div className="flex items-center gap-2">
          {est && !est.live && <Badge label="DRY-RUN" tone="info" />}
          <Button variant="secondary" size="sm" disabled={cargando || busy} onClick={() => void cargar()}>
            <Icon name="refresh-cw" size={13} /> {cargando ? "Consultando…" : est ? "Refrescar" : "Consultar"}
          </Button>
        </div>
      </div>

      {cargando && !est && <p className="text-[12px] text-text-tertiary">Consultando… (unos segundos)</p>}
      {!cargando && !est && !abierta && (
        <p className="text-[12px] text-text-tertiary">
          Esta orden ya está cerrada. Pulse <b>Consultar</b> si necesita revisar o rehacer la autenticación.
        </p>
      )}

      {est && viaMk && (
        <BloqueMikrotik
          est={est}
          busy={busy}
          res={res}
          error={error}
          onAplicar={() => void ejecutar(`/support/tickets/${ticketId}/onu/autenticar`)}
        />
      )}

      {est && !viaMk && (
        <>
          {/* Qué se va a aplicar: OLT, plan y velocidad. Sin números de índice a la vista. */}
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-text-secondary">
            <span><b className="text-text-primary">OLT:</b> {est.olt?.name ?? "—"}</span>
            <span>
              <b className="text-text-primary">Plan:</b> {est.plan?.name ?? "—"}
              {est.plan?.megas != null && ` · ${est.plan.megas} Megas`}
            </span>
            {est.plan?.estado === "DE_LA_ORDEN" && (
              /* La velocidad sale del plan que pide la orden, no del que el abonado
                 tiene hoy: el cambio de plan se aplica al CERRARLA. Se dice aquí
                 porque si no, el técnico ve un plan que no casa con la ficha. */
              <span className="inline-flex items-center gap-1 text-text-tertiary" title="El abonado pasa a este plan cuando se cierre la orden">
                <Icon name="info" size={13} />
                el plan que pide la orden
              </span>
            )}
            {est.plan?.derivado && (
              /* El abonado no tiene el servicio registrado (pasa en 3.036 vivos que la
                 migración dejó sin fila): el plan se leyó de sus últimas facturas. Se
                 avisa porque de ese plan sale la velocidad que se va a aplicar. */
              <span className="inline-flex items-center gap-1 text-warning-text" title="Este abonado no tiene el servicio registrado en su ficha">
                <Icon name="alert-triangle" size={13} />
                leído de sus facturas
              </span>
            )}
            {vel && (
              <span className="inline-flex items-center gap-1">
                <Icon name="gauge" size={13} className="text-brand" />
                {/* `trafficIn` es el índice `inbound` = columna RX = BAJADA del
                    abonado; `trafficOut` (`outbound`/TX) es la subida. */}
                <b className="text-text-primary">Velocidad del plan:</b>
                {vel.mbpsIn != null ? `${vel.mbpsIn.toLocaleString("es-CO")} Mbps bajada` : `traffic-table ${vel.trafficIn ?? "—"} bajada`}
                {" / "}
                {vel.mbpsOut != null ? `${vel.mbpsOut.toLocaleString("es-CO")} Mbps subida` : `traffic-table ${vel.trafficOut ?? "—"} subida`}
              </span>
            )}
          </div>

          {est.navegacion && <AvisoNavegacion n={est.navegacion} />}

          {bloqueoDuro ? (
            <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
              <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
              {est.bloqueo!.message}
              {est.bloqueo!.code === "SIN_VELOCIDAD" && (
                <Link href="/configuracion/planes?tab=olt" className="ml-1 font-semibold text-brand hover:underline">
                  Abrir Velocidad en OLT
                </Link>
              )}
            </div>
          ) : (<>
            {modoAutentica(modo) && (
            <div className="flex flex-col gap-2">
              {/* En una orden de megas esta mitad solo hace falta si el técnico
                  cambió el equipo: se dice, para que no parezca que en una subida
                  de velocidad normal haya que autenticar algo. */}
              {modo === "AMBOS" && (
                <p className="text-[12px] font-semibold text-text-secondary">
                  ¿Le montó un equipo nuevo? Autentíquelo:
                </p>
              )}
              {soloManual && (
                <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
                  <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
                  {est.bloqueo!.message} Si el equipo <b>ya estaba autenticado</b> (instalación anterior o
                  dada de alta desde SmartOLT), escriba abajo el serial de su etiqueta: se aprovecha el alta
                  que ya tiene y solo se le ajusta lo que le falte.
                </div>
              )}

              {/* La caja que el papel dice que es suya, y si la OLT la ve.
                  Sin esto, un cliente CON equipo asignado veía "elija a mano" sin
                  enterarse de que su equipo no era ninguna de las que suenan, y
                  no había forma de saber si ya se podía autenticar o no. */}
              {est.equipoAsignado && (
                <EquipoDelCliente
                  e={est.equipoAsignado}
                  onUsar={(s) => { setAMano(true); setManual(true); setSn(s); setEquipmentId(""); }}
                />
              )}
              {(est.onusDelCliente?.length ?? 0) > 1 && (
                <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
                  <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
                  <b>El cliente tiene {est.onusDelCliente!.length} ONUs autenticadas a su nombre:</b>{" "}
                  {est.onusDelCliente!.map((o) => `${o.sn} en ${o.olt?.name ?? "OLT"} ${o.frame}/${o.slot}/${o.port} ONT ${o.ontId} (${o.runState ?? "—"})`).join(" · ")}.
                  {" "}Si una es el equipo retirado, hay que eliminarla en Red › OLT: autenticar la nueva no la borra.
                </div>
              )}

              {autoListo && est.auto && (
                <div className="rounded-lg border border-brand/40 bg-brand-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
                  <p>
                    <Icon name="wand-sparkles" size={13} className="mr-1 inline text-brand" />
                    Se autenticará la ONU <span className="font-mono font-semibold text-text-primary">{est.auto.sn}</span>
                    {desdeHace(est.auto.haceMin) ? `, que apareció ${desdeHace(est.auto.haceMin)}` : ""}
                    {" — "}{fraseDelAuto(est.auto)}
                  </p>
                  {/* El único caso en que el automático sigue adelante avisando:
                      no quedaban unidades en la bodega de la sede. El cliente
                      navega igual; lo que queda pendiente es el inventario. */}
                  {est.auto.motivo && (
                    <p className="mt-1 text-warning-text">
                      <Icon name="alert-triangle" size={13} className="mr-1 inline" />
                      {est.auto.motivo}
                    </p>
                  )}
                  {/* La comprobación que ningún dato puede hacer por él: dos
                      instalaciones a la vez en la misma sede ven la misma ONU
                      recién aparecida, y el sistema no sabe en qué casa está.
                      Un vistazo a la etiqueta lo resuelve; sin pedirlo, el
                      automático sería confiar a ciegas. */}
                  <p className="mt-1 text-text-tertiary">
                    Compruebe que coincide con el serial de la etiqueta del equipo que acaba de instalar.
                  </p>
                  <button type="button" className="mt-1 font-semibold text-brand hover:underline" onClick={() => setAMano(true)}>
                    No es esa: prefiero elegirla yo
                  </button>
                </div>
              )}
              {/* Por qué NO se decide sola: dos ONUs anunciándose, ninguna del
                  cliente, una de otra bodega… El técnico tiene que saber qué mira. */}
              {!autoListo && !escribiendo && est.auto && !est.auto.sn && (
                <p className="text-[11.5px] text-text-tertiary">
                  <Icon name="info" size={13} className="mr-1 inline" />
                  {est.auto.motivo}
                </p>
              )}

              {!autoListo && (<>
              {escribiendo ? (
                <label className="text-[12px] text-text-secondary">
                  Serial (SN) de la ONU instalada
                  <input
                    value={sn}
                    onChange={(e) => setSn(e.target.value.toUpperCase().trim())}
                    placeholder="Ej.: 5A544547C9E3311B o ZTEGC9E3311B"
                    className="mt-0.5 w-full rounded-lg border border-border-default bg-surface px-3 py-1.5 font-mono text-[12.5px] text-text-primary"
                  />
                </label>
              ) : (
                <label className="text-[12px] text-text-secondary">
                  ONU a autenticar
                  <Select value={sn} onChange={(e) => setSn(e.target.value)} className="mt-0.5">
                    <option value="">— Elija el equipo instalado ({est.candidatos.length} esperando) —</option>
                    {est.candidatos.map((c) => (
                      <option key={c.sn} value={c.sn}>{etiquetaCandidato(c)}</option>
                    ))}
                  </Select>
                </label>
              )}
              <p className="text-[11.5px] text-text-tertiary">
                {escribiendo ? (
                  <>
                    Se busca ese serial en la OLT: si está esperando, se autentica; si ya estaba dado de alta,
                    se adopta sin tocar su enlace (el abonado no se queda sin servicio).
                    {!soloManual && (
                      <button type="button" className="ml-1 font-semibold text-brand hover:underline" onClick={() => { setManual(false); setSn(""); }}>
                        Volver a la lista
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    Ordenadas por la que apareció hace menos. ★ equipo ya registrado a este abonado · ⚠ revise el aviso · ⛔ instalado en otro cliente, no se puede usar.
                    <button type="button" className="ml-1 font-semibold text-brand hover:underline" onClick={() => { setManual(true); setSn(""); }}>
                      ¿No aparece el suyo?
                    </button>
                  </>
                )}
              </p>

              {/* Lo que pasa con el equipo elegido: de qué bodega salió, si está
                  en otro cliente (no se deja seguir) o si no está en inventario. */}
              {elegida?.impedimento && (
                <p className="rounded-lg border border-error-text/40 bg-error-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
                  <Icon name="alert-triangle" size={13} className="mr-1 inline text-error-text" />
                  {elegida.impedimento}
                </p>
              )}
              {elegida?.aviso && !elegida.impedimento && (
                <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
                  <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
                  {elegida.aviso} Revise que sea el equipo que usted instaló antes de continuar.
                </p>
              )}
              {elegida?.equipo && !elegida.impedimento && (
                <p className="text-[11.5px] text-text-tertiary">
                  Equipo <b>{elegida.equipo.code}</b> · bodega {elegida.equipo.bodega ?? "—"}
                  {elegida.equipo.status ? ` · ${elegida.equipo.status}` : ""} — al autenticar queda registrado a nombre del abonado.
                </p>
              )}

              {/* SN que no está en el inventario. No se inventa una unidad nueva:
                  se pregunta a cuál corresponde y se le graba el serial bueno.
                  Es opcional — el alta en la OLT no depende de esto. */}
              {sinRegistrar && (
                <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
                  <p className="mb-1.5 text-[12px] text-text-secondary">
                    Este serial no está en el inventario. Si sabe a qué equipo de bodega corresponde,
                    indíquelo: quedará a nombre del abonado y se le corregirá el serial con el que
                    reporta la OLT. <span className="text-text-tertiary">(opcional)</span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} className="min-w-[240px] flex-1">
                      <option value="">— No indicar —</option>
                      {inventario.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.code} · {e.serial || "sin serial"} · {e.mac || "sin MAC"}{e.warehouse ? ` · ${e.warehouse}` : ""}
                        </option>
                      ))}
                    </Select>
                    <input
                      className="min-w-[140px] flex-1 rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[12px] text-text-primary"
                      placeholder="Buscar por serial o MAC…"
                      onChange={(e) => void buscarInventario(e.target.value)}
                    />
                  </div>
                </div>
              )}
              </>)}
              {/* La otra mitad del trabajo, dicha antes de hacerla: autenticar la
                  ONU le da ENLACE, pero quien le da internet es su secret en la
                  Mikrotik, y este cliente todavía no lo tiene. */}
              {est.altaMikrotikPendiente && (
                <p className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[11.5px] text-text-secondary">
                  <Icon name="info" size={13} className="mr-1 inline text-text-tertiary" />
                  Este abonado todavía no tiene datos de conexión en la Mikrotik. Al autenticar se le crean
                  solos —usuario, clave y su secret con el perfil del plan—: no hace falta ir a crearlos a mano.
                </p>
              )}
              {(() => {
                // El aviso del puerto de la ONU que está elegida (o, sin elegir, el primero).
                const norm = (f: string) => f.replace(/\s+/g, "");
                const v = (elegida?.fsp ? est.vlanPuertos?.find((x) => norm(x.fsp) === norm(String(elegida.fsp))) : null) ?? est.vlanPuerto;
                return v ? <AvisoVlanPuerto v={v} /> : null;
              })()}
              {est.onuActual?.sn && (
                <p className="rounded-lg bg-surface-2 px-3 py-1.5 text-[11.5px] text-text-tertiary">
                  Ojo: este abonado ya tiene la ONU <span className="font-mono">{est.onuActual.sn}</span> vinculada
                  {est.onuActual.slot != null ? ` en ${est.onuActual.frame}/${est.onuActual.slot}/${est.onuActual.port}` : ""}.
                  Si es un cambio de equipo, retire la anterior desde Red › OLT cuando termine.
                </p>
              )}
              <div className="flex justify-end">
                <Button
                  disabled={busy || (!autoListo && !puedeAutenticar)}
                  onClick={() => void ejecutar(
                    `/support/tickets/${ticketId}/onu/autenticar`,
                    // Sin `sn` el servidor vuelve a decidir con el autofind del
                    // momento: entre que se pintó el recuadro y se pulsa el botón,
                    // la ONU pudo apagarse o autenticarla otro.
                    autoListo ? {} : { sn, ...(equipmentId ? { equipmentId } : {}) },
                  )}
                >
                  <Icon name="wand-sparkles" size={15} className="mr-1" />
                  {busy ? "Autenticando…"
                    : !est.live ? "Generar plan (dry-run)"
                    : autoListo ? "Autenticar automáticamente"
                    : escribiendo ? "Autenticar o adoptar ONU"
                    : "Autenticar ONU"}
                </Button>
              </div>
            </div>
            )}

            {modoVelocidad(modo) && (
            <div className={`flex flex-col gap-2${modo === "AMBOS" ? " mt-3 border-t border-border-subtle pt-3" : ""}`}>
              {modo === "AMBOS" && (
                <p className="text-[12px] font-semibold text-text-secondary">
                  {porAgregarInternet
                    /* El cliente venía con televisión sola: su ONU ya está dada de
                       alta y lo único que falta es ponerle la velocidad del plan
                       de internet que acaba de contratar. */
                    ? "¿El equipo ya está autenticado (tenía televisión)? Solo hay que aplicarle la velocidad del plan de internet:"
                    : subeMegas
                      ? "¿Sigue con la misma ONU? Se desautentica y se vuelve a autenticar con las megas del plan nuevo:"
                      : "¿Sigue con la misma ONU? Solo hay que aplicarle la velocidad del plan nuevo:"}
                </p>
              )}
              {subeMegas && (
                <p className="text-[11.5px] text-text-tertiary">
                  <Icon name="info" size={13} className="mr-1 inline" />
                  Queda en el mismo puerto y con la misma configuración; el cliente pierde la conexión unos segundos mientras se vuelve a autenticar.
                </p>
              )}
              <p className="text-[12.5px] text-text-secondary">
                ONU del abonado: <span className="font-mono font-semibold text-text-primary">{est.onuActual?.sn ?? "—"}</span>
                {est.onuActual?.slot != null && <span className="ml-2 text-text-tertiary">puerto {est.onuActual.frame}/{est.onuActual.slot}/{est.onuActual.port}</span>}
                {est.onuActual?.runState && <span className="ml-2 text-text-tertiary">({est.onuActual.runState})</span>}
              </p>
              <div className="flex justify-end">
                {/* Sin ONU vinculada no hay service-port que tocar. En modo AMBOS
                    eso ya no bloquea la pantalla —arriba puede autenticar—, pero
                    el botón sí tiene que estar apagado y decir por qué. */}
                <Button
                  disabled={busy || !est.onuActual?.sn}
                  onClick={() => void ejecutar(`/support/tickets/${ticketId}/onu/velocidad`)}
                >
                  <Icon name="gauge" size={15} className="mr-1" />
                  {busy ? (subeMegas ? "Re-autenticando…" : "Aplicando…")
                    : !est.onuActual?.sn ? "Sin ONU vinculada"
                    : !est.live ? "Generar plan (dry-run)"
                    : subeMegas ? "Re-autenticar con el plan nuevo" : "Aplicar velocidad del plan"}
                </Button>
              </div>
            </div>
            )}
          </>)}

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-error-subtle bg-error-soft p-3 text-[12px] text-text-primary">
              <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0 text-error-text" />
              <div>
                <div className="font-semibold">No se pudo autenticar</div>
                <p className="mt-0.5 text-text-secondary">{error}</p>
              </div>
            </div>
          )}

          {res && <ResultadoOnu res={res} />}
        </>
      )}
    </div>
  );
}

/**
 * Resultado del alta. Que el comando no fallara no significa que el abonado
 * tenga servicio: la OLT acepta el alta y luego marca la config como fallida.
 * Por eso se enseña la verificación, no solo un "OK".
 */
function ResultadoOnu({ res }: { res: Resultado }) {
  const v = res.verificacion;
  // Que el abonado quede sin su alta en la Mikrotik es un problema aunque la ONU
  // haya quedado perfecta: tiene enlace y no navega.
  const problema = !res.ok || !!v?.avisos?.length || res.altaMikrotik?.ok === false;
  return (
    <div className={`mt-3 rounded-lg border p-3 text-[12px] ${problema ? "border-warning bg-warning-soft" : "border-success-text/30 bg-success-soft"}`}>
      <div className="flex items-center gap-1.5 font-semibold text-text-primary">
        <Icon name={problema ? "alert-triangle" : "check"} size={14} className={problema ? "text-warning-text" : "text-success-text"} />
        {res.ok ? (res.message ?? "Listo") : (res.error ?? "No se pudo completar")}
      </div>
      {res.ontId && (
        <div className="mt-1">
          {res.adoptada ? "ONT-ID" : "ONT-ID asignado"}: <span className="font-mono font-bold">{res.ontId}</span>{res.fsp ? ` · puerto ${res.fsp}` : ""}
        </div>
      )}
      {res.adoptada && (
        <div className="mt-1 text-text-secondary">
          La ONU ya estaba dada de alta en la OLT: <b>no se volvió a autenticar</b> (el abonado no perdió el enlace).
          {!!res.cambios?.length && <> Se ajustó: {res.cambios.join(" · ")}.</>}
        </div>
      )}
      {res.reautenticada && (
        <div className="mt-1 text-text-secondary">
          La ONU se <b>desautenticó y se volvió a autenticar</b> con la velocidad del plan nuevo, en el mismo puerto.
        </div>
      )}
      {!res.ok && res.restaurada === true && (
        <div className="mt-1 text-text-secondary">Se dejó la ONU como estaba, con la velocidad anterior.</div>
      )}
      {!res.ok && res.restaurada === false && (
        <div className="mt-1 font-semibold text-error-text">La ONU quedó sin alta en la OLT: autentíquela desde Red › OLT.</div>
      )}
      {!!res.avisos?.length && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-text-secondary">
          {res.avisos.map((a, i) => <li key={`aviso-${i}`}>{a}</li>)}
        </ul>
      )}
      {/* Lo que hace que el cliente NAVEGUE, no solo que la fibra enlace. Se
          enseña siempre que la orden lo tocó: en verde si quedó, en ámbar si no
          —una ONU online sin secret es un cliente que llama mañana—. */}
      {res.altaMikrotik && (
        <div className={`mt-1 ${res.altaMikrotik.ok ? "text-text-secondary" : "text-warning-text"}`}>
          <b>Mikrotik:</b> {res.altaMikrotik.mensaje}
        </div>
      )}
      {res.equipo && (
        <div className="mt-1 text-text-secondary">
          Equipo <b>{res.equipo.code}</b> registrado a nombre del abonado
          {res.equipo.bodega ? ` · salió de la bodega ${res.equipo.bodega}` : ""}
          {res.equipo.serialCorregido ? " · se corrigió su serial con el que reporta la OLT" : ""}.
        </div>
      )}
      {/* El automático siguió adelante pero el inventario quedó a medias (no
          había unidades en la bodega de la sede). Se dice: alguien tiene que
          cargarle el equipo a mano. */}
      {res.auto?.aviso && (
        <div className="mt-1 text-warning-text">{res.auto.aviso}</div>
      )}
      {/* Traslado: la ONU es la misma de siempre, lo que cambió es el puerto. Se
          dice de dónde se quitó, que es la mitad del trabajo que nadie ve. */}
      {res.liberacion?.anterior && (
        <div className="mt-1 text-text-secondary">
          {res.liberacion.borrado
            ? <>Se desautenticó la ONU de su puerto anterior <b>{res.liberacion.anterior}</b> para volver a darla de alta aquí.</>
            : <span className="text-warning-text">No se pudo desautenticar la ONU de su puerto anterior {res.liberacion.anterior}.</span>}
          {!!res.liberacion.tambienEn?.length && ` También se quitó el alta que quedaba en ${res.liberacion.tambienEn.join(", ")}.`}
        </div>
      )}
      {!!res.liberacion?.avisos?.length && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-warning-text">
          {res.liberacion.avisos.map((a, i) => <li key={`lib-${i}`}>{a}</li>)}
        </ul>
      )}
      {!!res.conciliacion?.liberados?.length && (
        <div className="mt-1 text-text-secondary">
          El equipo reservado {res.conciliacion.liberados.join(", ")} no fue el instalado: volvió a la bodega.
        </div>
      )}
      {res.conciliacion?.devuelto != null && (
        <div className="mt-1 text-text-secondary">
          ONU anterior <b>{res.conciliacion.devuelto}</b> retirada de la ficha y devuelta a la bodega como «Por revisar».
        </div>
      )}
      {res.despues && (
        <div className="mt-1 text-text-secondary">
          Traffic-table: bajada {res.antes?.traffic_in} → <b>{res.despues.traffic_in}</b> · subida {res.antes?.traffic_out} → <b>{res.despues.traffic_out}</b>
        </div>
      )}
      {v && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Badge label={`estado: ${v.run_state ?? "—"}`} tone={/online/i.test(v.run_state ?? "") ? "success" : "error"} />
          <Badge label={`config: ${v.config_state ?? "—"}`} tone={/normal/i.test(v.config_state ?? "") ? "success" : "default"} />
          <Badge label={`${v.servicePorts?.length ?? 0} service-port(s)`} tone={v.servicePorts?.length ? "success" : "error"} />
        </div>
      )}
      {!!v?.avisos?.length && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-text-secondary">
          {v.avisos.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      )}
      {v?.nota && !v.avisos?.length && <p className="mt-1.5 text-[11.5px] text-text-tertiary">{v.nota}</p>}
      {!!res.commands?.length && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-black/80 p-2 font-mono text-[11px] text-green-300">{res.commands.join("\n")}</pre>
      )}
    </div>
  );
}

/**
 * El bloque de un abonado SIN OLT (hoy, EPON).
 *
 * Aquí no hay nada que elegir: el plan dice qué perfil PPP le toca y la sede más
 * su tecnología dicen a qué Mikrotik se escribe. El técnico solo confirma. Es la
 * misma escritura que el botón de la ficha del cliente, así que no hay dos formas
 * de cambiarle la velocidad a nadie.
 *
 * Se avisa de que se le cae la sesión: el perfil no lo toma el enlace hasta que
 * el PPPoE vuelve a levantar, y el técnico suele estar en la casa mirando.
 */
function BloqueMikrotik({
  est, busy, res, error, onAplicar,
}: {
  est: Estado;
  busy: boolean;
  res: Resultado | null;
  error: string | null;
  onAplicar: () => void;
}) {
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-text-secondary">
        <span>
          <b className="text-text-primary">Plan:</b> {est.plan?.name ?? "—"}
          {est.plan?.megas != null && ` · ${est.plan.megas} Megas`}
        </span>
        {est.plan?.estado === "DE_LA_ORDEN" && (
          <span className="inline-flex items-center gap-1 text-text-tertiary" title="El abonado pasa a este plan cuando se cierre la orden">
            <Icon name="info" size={13} />
            el plan que pide la orden
          </span>
        )}
        {est.plan?.derivado && (
          <span className="inline-flex items-center gap-1 text-warning-text" title="Este abonado no tiene el servicio registrado en su ficha">
            <Icon name="alert-triangle" size={13} />
            leído de sus facturas
          </span>
        )}
        {est.perfil && (
          <span>
            <b className="text-text-primary">Perfil:</b> <span className="font-mono">{est.perfil}</span>
          </span>
        )}
        {est.mikrotik && (
          <span title={est.mikrotik.host}>
            <b className="text-text-primary">Mikrotik:</b> {est.mikrotik.name}
          </span>
        )}
      </div>

      {est.bloqueo ? (
        <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
          <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
          {est.bloqueo.message}
          {est.bloqueo.code === "SIN_PERFIL" && (
            <Link href="/configuracion/planes" className="ml-1 font-semibold text-brand hover:underline">
              Abrir Planes
            </Link>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Por qué este bloque no pide ninguna ONU: es la duda que trae el
              técnico acostumbrado a las órdenes de fibra. */}
          <p className="rounded-lg border border-brand/40 bg-brand-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
            <Icon name="info" size={13} className="mr-1 inline text-brand" />
            Este abonado es <b>EPON</b>: no pasa por la OLT, así que no hay ONU que autenticar.
            Lo que le da la velocidad es el perfil de su plan en la Mikrotik. Al aplicarlo se le
            reinicia la sesión y <b>se le cae el internet unos segundos</b>.
          </p>
          <div>
            <Button size="sm" disabled={busy} onClick={onAplicar}>
              <Icon name="gauge" size={13} /> {busy ? "Aplicando…" : `Aplicar ${est.perfil} en ${est.mikrotik?.name ?? "la Mikrotik"}`}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
          <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
          {error}
        </div>
      )}

      {res && (
        <div className={`mt-3 rounded-lg border p-3 text-[12px] ${res.ok ? "border-success-text/30 bg-success-soft" : "border-warning bg-warning-soft"}`}>
          <div className="flex items-center gap-1.5 font-semibold text-text-primary">
            <Icon name={res.ok ? "check" : "alert-triangle"} size={14} className={res.ok ? "text-success-text" : "text-warning-text"} />
            {res.ok ? (res.message ?? "Listo") : (res.error ?? "No se pudo aplicar")}
          </div>
          {!!res.steps?.length && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-text-secondary">
              {res.steps.map((s, i) => <li key={`paso-${i}`}>{s}</li>)}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/**
 * La VLAN del puerto, dicha ANTES de autenticar. Si no llega al PPPoE la ONU
 * quedaría en línea y sin internet, y el técnico se iría creyendo que la dejó
 * funcionando. No bloquea: lo arregla quien administra la red.
 */
function AvisoVlanPuerto({ v }: { v: VlanPuerto }) {
  const enlace = v.branchId && v.vlan ? `/red/vlans?sede=${v.branchId}&q=${v.vlan}` : null;
  if (v.ok === true) {
    return (
      <p className="text-[11.5px] text-text-tertiary">
        <Icon name="check" size={13} className="mr-1 inline text-success-text" />
        VLAN {v.vlan} de {v.fsp}: completa en la OLT, el uplink y el Mikrotik.
      </p>
    );
  }
  if (v.ok === null) {
    return v.falta.length ? (
      <p className="text-[11.5px] text-text-tertiary">
        <Icon name="info" size={13} className="mr-1 inline" />
        No se pudo comprobar la VLAN{v.vlan ? ` ${v.vlan}` : ""} de {v.fsp}: {v.falta.join("; ")}.
      </p>
    ) : null;
  }
  return (
    <div className="rounded-lg border border-error-text/40 bg-error-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
      <p>
        <Icon name="alert-triangle" size={13} className="mr-1 inline text-error-text" />
        <b>La VLAN{v.vlan ? ` ${v.vlan}` : ""} del puerto {v.fsp} no llega al PPPoE:</b> {v.falta.join("; ")}.
      </p>
      <p className="mt-1">
        Si autentica así, la ONU quedará en línea pero el cliente <b>no navegará</b>. Avise a administración / redes para
        que la configuren en Red › VLANs → <i>Configurar en equipos</i>
        {enlace && (
          <>
            {" "}(<a href={enlace} className="font-semibold text-brand hover:underline" target="_blank" rel="noreferrer">abrir</a>)
          </>
        )}.
      </p>
    </div>
  );
}

/** Resultado de "¿navega?" tras autenticar (lo mismo queda en el seguimiento de la orden). */
function AvisoNavegacion({ n }: { n: NonNullable<Estado["navegacion"]> }) {
  if (n.estado === "PENDIENTE") {
    return (
      <p className="mb-2 flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-[12px] text-text-secondary">
        <Icon name="refresh-cw" size={13} className="animate-spin" /> {n.mensaje} Se actualiza sola.
      </p>
    );
  }
  const tono = n.estado === "NAVEGANDO"
    ? "border-success-soft bg-success-soft text-success-text"
    : n.estado === "SIN_PPPOE" ? "border-error-text/40 bg-error-soft text-text-secondary" : "border-border-subtle bg-surface-2 text-text-secondary";
  return (
    <p className={`mb-2 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed ${tono}`}>
      <Icon name={n.estado === "NAVEGANDO" ? "check" : n.estado === "SIN_PPPOE" ? "alert-triangle" : "info"} size={13} className="mr-1 inline" />
      <b>{n.estado === "NAVEGANDO" ? "Navegando." : n.estado === "SIN_PPPOE" ? "Sin sesión PPPoE." : "Sin comprobar."}</b> {n.mensaje}
    </p>
  );
}
