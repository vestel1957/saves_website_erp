"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { listaJson, mensajeDeError } from "@/lib/errores";
import { fullCurrency } from "@/lib/format";
import { type Plan } from "@/lib/plans";
import { TitularFields, faltaEnTitular, titularDesde, titularPayload, titularTexto, type TitularValor } from "@/components/soporte/TitularFields";
import { DireccionFields, DIRECCION_VACIA, NOM_KEYS, ZONA_KEYS, direccionArmada, type DireccionValor } from "@/components/subscribers/DireccionFields";

/** Una clase de orden con sus detalles, tal como la sirve `/support/order-catalog`. */
type ClaseOrden = { clase: string; etiqueta: string; descripcion: string; detalles: string[] };

/** Lo que esta pantalla necesita saber de la orden que va a corregir. */
export type OrdenEditable = {
  id: string;
  code: number | null;
  subject: string | null;
  type: string;
  problem: string | null;
  section: string | null;
  created: string;
  status: string;
  graceDays: number | null;
  score: number | null;
  /** El cliente de la orden: hace falta para traer su zona en un traslado. */
  subscriberId?: string | null;
  /** La dirección destino que la orden ya tiene registrada, si tiene alguna. */
  moveToText?: string | null;
  /**
   * El plan destino que la orden ya tiene registrado, si tiene alguno. `null` en las
   * de megas que nacieron sin decirlo: las del legacy (allá el plan vive en su tabla
   * `temporales`) y las que abre el chatbot con el plan por confirmar.
   */
  megas?: { planId: string | null; plan: string | null; a: number | null; de: number | null } | null;
  /** El cambio de titular que la orden ya tiene registrado, si tiene alguno. */
  cambioTitular?: { desde: string | null; hasta: string; datos: Record<string, unknown> | null } | null;
};

/** El plan de internet que el cliente tiene HOY (`/subscribers/:id/plan`). */
type ServicioActual = { kind: string; planId: string | null; planName: string | null; megas: number | null };

/** Hoy en Colombia, en el formato que espera <input type="date">. */
const hoy = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());

/** `hoy() - n` días, también en formato de <input type="date">. */
const hoyMenos = (dias: number) => {
  const [y, m, d] = hoy().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - dias)).toISOString().slice(0, 10);
};

/** Mismo tope que el backend para las órdenes nuevas (`MAX_DIAS_ATRAS_ORDEN`). */
const MAX_DIAS_ATRAS = 90;

/** Los topes reales del legacy: `tickets.problema` y `tickets.section`. */
const MAX_PROBLEM = 150;
const MAX_SECTION = 1500;

/** La fecha guardada de la orden (ISO con o sin hora) en formato de <input type="date">. */
const soloDia = (iso: string) => (iso ?? "").slice(0, 10);

/**
 * Corregir una orden de servicio ya abierta.
 *
 * Hasta ahora, una orden mal registrada solo se podía anular y volver a abrir: se
 * perdía el número, el hilo de seguimiento y el equipo y material ya cargados, y
 * quedaban dos filas donde hubo un trabajo. Esto corrige el TRABAJO —clase, detalle,
 * falla, observación, fecha y plazo—, que es lo que se escribe de afán mientras el
 * cliente está al teléfono.
 *
 * El técnico y la prioridad NO están aquí: tienen su propio mando en la ficha, que
 * guarda solo. Dos sitios para lo mismo es la forma segura de que digan cosas
 * distintas.
 */
export function EditarOrdenModal({
  open, onClose, onDone, orden,
}: { open: boolean; onClose: () => void; onDone: () => void; orden: OrdenEditable }) {
  const { authFetch } = useAuth();
  const [catalogo, setCatalogo] = useState<ClaseOrden[]>([]);
  /** `null` mientras nadie la haya tocado: la que vale entonces es la de la orden. */
  const [clase, setClase] = useState<string | null>(null);
  const [type, setType] = useState(orden.type);
  const [problem, setProblem] = useState(orden.problem ?? "");
  /**
   * Los motivos de retiro (`/support/motivos-retiro`). En una orden de baja, la
   * casilla de la falla es POR QUÉ se va el cliente y es lista cerrada: si aquí se
   * pudiera escribir a mano, corregir una orden sería la rendija por la que entra
   * texto libre a la columna por la que agrupa el informe de retiros.
   */
  const [motivos, setMotivos] = useState<string[]>([]);
  const [section, setSection] = useState(orden.section ?? "");
  /**
   * Lo que se pintó al abrir. Sirve para mandar la falla y la observación SOLO si
   * se tocaron: la ficha las sirve ya pasadas a texto plano (el legacy las guardó
   * con etiquetas del WYSIWYG viejo), así que reenviarlas sin más las reescribiría
   * —y dejaría un "se corrigió la observación" en el seguimiento— por el simple
   * hecho de haber abierto este modal.
   */
  const [inicial] = useState({ problem: orden.problem ?? "", section: orden.section ?? "" });
  const [fecha, setFecha] = useState(soloDia(orden.created));
  const [dias, setDias] = useState(String(orden.graceDays ?? 3));
  /** Las casillas del destino de un traslado, y la dirección que la ficha tiene hoy. */
  const [dir, setDir] = useState<DireccionValor>(DIRECCION_VACIA);
  const [dirActual, setDirActual] = useState<string | null>(null);
  /** El catálogo de internet y lo que el cliente tiene hoy, para las órdenes de megas. */
  const [planes, setPlanes] = useState<Plan[]>([]);
  const [servicios, setServicios] = useState<ServicioActual[]>([]);
  const [planNuevo, setPlanNuevo] = useState(orden.megas?.planId ?? "");
  /** Los datos del nuevo titular, desde los que la orden ya tenga. */
  const [titularInicial] = useState(() => titularDesde(orden.cambioTitular?.datos));
  const [titular, setTitular] = useState<TitularValor>(titularInicial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // El formulario arranca con lo que la orden dice HOY y no se vuelve a sembrar: la
  // ficha monta este modal solo mientras está abierto, así que cada vez que se abre
  // es un componente nuevo. Sembrarlo desde un efecto sobre `orden` —que es un objeto
  // literal del padre, distinto en cada render— borraría lo que se está escribiendo
  // en cuanto la ficha se recargara por detrás.
  useEffect(() => {
    void authFetch("/support/order-catalog").then(listaJson).then(setCatalogo).catch(() => {});
  }, [authFetch]);

  /**
   * La clase que vale ahora mismo. Se DERIVA en vez de sembrarse, porque las órdenes
   * viejas no siempre traen una de las tres: en el legacy `subject` guardó de todo
   * —"Reclamo", una frase entera— y esos valores siguen ahí. Se resuelven a la clase
   * a la que pertenece su detalle, que es lo mismo que hace el servidor con lo que le
   * llega del chatbot; así el modal marca desde el principio la clase con la que se
   * va a guardar, en vez de abrirse sin ninguna marcada.
   */
  const claseEfectiva = useMemo(() => {
    if (clase) return clase;
    const propia = (orden.subject ?? "").trim().toLowerCase();
    if (!catalogo.length) return propia || "servicio";
    if (catalogo.some((c) => c.clase === propia)) return propia;
    return (catalogo.find((c) => c.detalles.includes(orden.type)) ?? catalogo[0]).clase;
  }, [clase, catalogo, orden.subject, orden.type]);

  const claseActual = useMemo(
    () => catalogo.find((c) => c.clase === claseEfectiva) ?? null,
    [catalogo, claseEfectiva],
  );

  /**
   * Las opciones de detalle. Se le añade el tipo que la orden trae si no está en el
   * catálogo: las 320.000 órdenes del legacy tienen tipos que ya no se ofrecen, y un
   * select que no puede mostrar el valor actual lo cambiaría solo al abrirlo — una
   * corrección de la observación acabaría cambiándole el trabajo a la orden.
   */
  const detalles = useMemo(() => {
    const base = claseActual?.detalles ?? [];
    return base.includes(type) || !type ? base : [type, ...base];
  }, [claseActual, type]);

  /** Esta orden concede el servicio por un plazo, así que pide un dato que ninguna otra. */
  const porDias = type.trim().toLowerCase() === "reconexion combo por dias";
  /**
   * El traslado dice a dónde se muda el cliente. Se puede registrar AQUÍ porque hay
   * dos caminos por los que una orden de traslado nace sin destino: las que se
   * abren en el sistema viejo (allá no hay dónde guardarlo) y las que entran por el
   * chatbot (el cliente lo dicta en texto libre y falta confirmar cobertura). Sin
   * esto, esas órdenes salían a la calle sin decir a qué dirección hay que ir.
   */
  const porTraslado = type.trim().toLowerCase() === "traslado";
  /** La baja del cliente: su "falla reportada" es el motivo del retiro. */
  const porRetiro = type.trim().toLowerCase() === "retiro voluntario";
  /**
   * El cambio de titular: las que abre el chatbot nacen sin los datos (por chat
   * solo se dicta el nombre) y se completan aquí.
   */
  const porTitular = type.trim().toLowerCase() === "cambio de titular";
  const titularTocado = JSON.stringify(titular) !== JSON.stringify(titularInicial);
  /**
   * 'Subir megas' / 'Bajar megas': las únicas órdenes que dicen a CUÁNTAS. Se
   * corrige aquí por lo mismo que el destino de un traslado — hay órdenes que nacen
   * sin plan (las del legacy, donde vive en su tabla `temporales`, y las que abre el
   * chatbot con el plan por confirmar) y hasta ahora no había por dónde ponérselo:
   * el técnico salía sin saber a qué velocidad tenía que dejar al cliente.
   */
  const porMegas = type.trim().toLowerCase().includes("megas");
  const subeMegas = porMegas && type.trim().toLowerCase().includes("subir");
  const bajaMegas = porMegas && type.trim().toLowerCase().includes("bajar");
  /**
   * 'AgregarInternet' lleva el mismo plan destino, y corregirlo aquí es lo que
   * rescata las que ya se cerraron sin él: se le pone el plan y se vuelve a cerrar
   * la orden, en vez de anularla y repetir la visita.
   */
  const porAgregarInternet = type.trim().toLowerCase() === "agregarinternet";
  /** ¿Este trabajo lleva plan de internet destino? (backend: `ordenLlevaPlanInternet`) */
  const conPlanInternet = porMegas || porAgregarInternet;
  /** Los de internet, del más lento al más rápido: así se lee el desplegable. */
  const planesInternet = useMemo(
    () => planes
      .filter((p) => p.kind === "INTERNET")
      .sort((a, b) => (a.megas ?? 0) - (b.megas ?? 0) || a.name.localeCompare(b.name)),
    [planes],
  );
  const planElegido = useMemo(() => planesInternet.find((p) => p.id === planNuevo) ?? null, [planesInternet, planNuevo]);
  const internetActual = useMemo(() => servicios.find((s) => s.kind === "INTERNET") ?? null, [servicios]);
  /**
   * DE CUÁNTO VIENE. Espejo de lo que hace el servidor al corregir: si la orden ya
   * le cambió el plan al cliente, el origen es el que ella misma dejó anotado —no el
   * que la ficha tiene hoy, que es el que puso esta misma orden—. Medir contra el de
   * hoy haría que arreglar un 'Subir megas' de 5→100 mal tecleado (debía ser 50) se
   * leyera como una bajada.
   */
  const origenMegas = useMemo(() => {
    if (orden.megas?.planId) return { megas: orden.megas.de ?? null, nombre: null as string | null };
    return { megas: internetActual?.megas ?? null, nombre: internetActual?.planName ?? null };
  }, [orden.megas, internetActual]);
  /**
   * El error de dedo de siempre: el plan de al lado en el desplegable, que deja una
   * orden diciendo 'Subir megas' y bajando la velocidad. Se avisa aquí y además lo
   * frena el backend — sólo se puede comprobar cuando los dos planes dicen megas.
   */
  const megasAlReves =
    planElegido?.megas != null && origenMegas.megas != null
      ? (subeMegas && planElegido.megas <= origenMegas.megas) || (bajaMegas && planElegido.megas >= origenMegas.megas)
      : false;
  const destinoNuevo = direccionArmada(dir);
  const cerrada = orden.status === "RESUELTO" || orden.status === "ANULADA";

  // Los motivos, solo si la orden es un retiro.
  useEffect(() => {
    if (!porRetiro || motivos.length) return;
    let vivo = true;
    void authFetch("/support/motivos-retiro")
      .then(listaJson)
      .then((d) => { if (vivo) setMotivos(d as string[]); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [porRetiro, motivos.length, authFetch]);

  // El catálogo de internet y lo que el cliente tiene contratado, solo cuando la
  // orden es de megas: en el resto no pinta nada y son dos consultas más.
  useEffect(() => {
    if (!conPlanInternet || planes.length) return;
    let vivo = true;
    void authFetch("/plans?activeOnly=true&kind=INTERNET")
      .then(listaJson)
      .then((d) => { if (vivo) setPlanes(d as Plan[]); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [conPlanInternet, planes.length, authFetch]);

  useEffect(() => {
    if (!conPlanInternet || !orden.subscriberId) return;
    let vivo = true;
    void authFetch(`/subscribers/${orden.subscriberId}/plan`)
      .then(listaJson)
      .then((d) => { if (vivo) setServicios(d as ServicioActual[]); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [conPlanInternet, orden.subscriberId, authFetch]);

  // La dirección de hoy y la zona del cliente, para partir de ellas. Solo se pide
  // en un traslado: es una consulta más y la mayoría de las órdenes no lo son.
  useEffect(() => {
    if (!porTraslado || !orden.subscriberId) return;
    let vivo = true;
    void authFetch(`/subscribers/${orden.subscriberId}/form`)
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
  }, [porTraslado, orden.subscriberId, authFetch]);

  /**
   * Cambiar de clase cambia la lista de detalles. Se ajusta AQUÍ y no en un efecto
   * sobre `clase`: en un efecto también saltaría al abrir el modal, y la orden que
   * se venía a corregir cambiaría de tipo sola antes de tocar nada.
   */
  function elegirClase(c: ClaseOrden) {
    setClase(c.clase);
    if (!c.detalles.includes(type)) setType(c.detalles[0] ?? "");
  }

  const minFecha = useMemo(() => {
    const suelo = hoyMenos(MAX_DIAS_ATRAS);
    const propia = soloDia(orden.created);
    // Una orden de hace dos años tiene que poder moverse un día: el suelo baja
    // hasta su propia fecha. Mismo criterio que el backend.
    return propia && propia < suelo ? propia : suelo;
  }, [orden.created]);

  async function submit() {
    setErr(null);
    if (!type.trim()) { setErr("Elige el detalle de la orden."); return; }
    if (!fecha) { setErr("Pon la fecha de la orden."); return; }
    if (fecha > hoy()) { setErr("La fecha de la orden no puede ser futura."); return; }
    if (fecha < minFecha) { setErr("La fecha no puede quedar antes de la que ya tenía la orden."); return; }
    const diasNum = Number(dias);
    if (porDias && (!Number.isInteger(diasNum) || diasNum < 1 || diasNum > 30)) {
      setErr("Los días de reconexión deben ser un número entre 1 y 30."); return;
    }
    if (porMegas && megasAlReves) {
      setErr(`«${planElegido?.name}» ${subeMegas ? "no sube" : "no baja"} nada: el cliente venía de ${origenMegas.megas} Megas.`);
      return;
    }
    if (porTitular && titularTocado) {
      const falta = faltaEnTitular(titular);
      if (falta) { setErr(falta); return; }
    }
    setSaving(true);
    try {
      const res = await authFetch(`/support/tickets/${orden.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          subject: claseEfectiva,
          type: type.trim(),
          ...(problem !== inicial.problem ? { problem } : {}),
          ...(section !== inicial.section ? { section } : {}),
          created: fecha,
          ...(porDias ? { graceDays: diasNum } : {}),
          // El plan solo viaja si se eligió otro: abrir este modal en una orden de
          // megas y guardar la observación no puede volver a cambiarle el plan al
          // cliente (y con él el precio de su próxima factura).
          ...(conPlanInternet && planNuevo && planNuevo !== (orden.megas?.planId ?? "")
            ? { planToId: planNuevo }
            : {}),
          // El titular solo viaja si se tocó: guardar la observación no puede
          // reescribirle la ficha al cliente.
          ...(porTitular && titularTocado ? { newHolder: titularPayload(titular) } : {}),
          // El destino solo viaja si se escribió algo: abrir este modal en una orden
          // de traslado y guardar la observación no puede reescribir la dirección.
          ...(porTraslado && destinoNuevo
            ? {
                moveTo: {
                  nomenclature: Object.fromEntries(NOM_KEYS.map((k) => [k, dir[k] || null])),
                  ...Object.fromEntries(ZONA_KEYS.filter((k) => dir[k]).map((k) => [k, dir[k]])),
                  ...(dir.addressLine ? { addressLine: dir.addressLine } : {}),
                },
              }
            : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo guardar la orden");
      toast(d?.cambios?.length ? "Orden corregida" : "No había nada que cambiar");
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Corregir orden Nº ${orden.code ?? "—"}`} maxWidth="max-w-xl">
      <div className="flex flex-col gap-3">
        {/* Corregir una orden cerrada es arreglar el dato, no rehacer el trabajo:
            conviene decirlo antes de que alguien espere que el servicio se mueva. */}
        {cerrada && (
          <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
            Esta orden ya está {orden.status === "ANULADA" ? "anulada" : "cerrada"}. Corregirla arregla el dato para
            los reportes; no vuelve a cortar ni a reconectar el servicio
            {orden.score != null ? " y no cambia los puntos que ya se le abonaron al técnico" : ""}.
          </p>
        )}

        <Field label="Clase de orden" required>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {catalogo.map((c) => {
              const activa = c.clase === claseEfectiva;
              return (
                <button
                  key={c.clase}
                  type="button"
                  title={c.descripcion}
                  onClick={() => elegirClase(c)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    activa ? "border-brand bg-brand-soft" : "border-border-default bg-surface hover:bg-surface-2"
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
          <Field label="Detalle" required hint="Lo que se va a hacer">
            <Select value={type} onChange={(e) => setType(e.target.value)} disabled={!catalogo.length}>
              {detalles.map((d) => <option key={d} value={d}>{d}</option>)}
            </Select>
          </Field>

          <Field
            label="Fecha de la orden"
            required
            hint={fecha !== soloDia(orden.created) ? "Se moverá de día en los reportes" : "Con la que queda registrada"}
          >
            <Input type="date" value={fecha} min={minFecha} max={hoy()} onChange={(e) => setFecha(e.target.value)} />
          </Field>

          {porDias && (
            <Field label="Días de reconexión" required hint="Al vencer vuelve a ser cortable">
              <Input type="number" min={1} max={30} value={dias} onChange={(e) => setDias(e.target.value)} />
            </Field>
          )}
        </div>

        {/* A CUÁNTAS MEGAS se pasa. Va en su propio bloque y no en una casilla más
            porque no basta con el desplegable: hay que ver de cuánto venía el cliente
            y en cuánto queda ANTES de guardar. Corregirlo no le mueve el plan: eso
            pasa al CERRAR la orden. */}
        {conPlanInternet && (
          <div className="rounded-lg border border-border-default bg-surface-2 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-text-primary">
                {porAgregarInternet
                  ? orden.megas?.planId ? "Corregir con qué plan de internet queda" : "¿Con qué plan de internet queda?"
                  : orden.megas?.planId
                    ? "Corregir a cuántas megas se pasa"
                    : bajaMegas ? "¿A cuántas megas se baja?" : "¿A cuántas megas se sube?"}
              </span>
              {origenMegas.megas != null && (
                <span className="text-[12px] text-text-secondary">
                  Venía de <b className="text-text-primary">{origenMegas.megas} Megas</b>
                </span>
              )}
            </div>
            {orden.megas?.planId ? (
              <p className="mb-2 text-[12px] text-text-tertiary">
                La orden dice <span className="text-text-secondary">
                  {orden.megas.a != null ? `${orden.megas.a} Megas` : orden.megas.plan}
                  {orden.megas.plan ? ` · plan «${orden.megas.plan}»` : ""}
                </span>. Elige otro solo si ese está mal; el cliente pasa a él cuando se cierre la orden.
              </p>
            ) : (
              <p className="mb-2 text-[12px] text-text-tertiary">
                {porAgregarInternet
                  ? "Esta orden no dice con qué plan de internet queda el cliente: elígelo y vuelve a cerrarla para que se le monte el servicio."
                  : "Esta orden no dice a cuántas megas se pasa el cliente"}
                {!porAgregarInternet && origenMegas.nombre
                  ? <> · hoy tiene <span className="text-text-secondary">{origenMegas.nombre}</span>.</>
                  : porAgregarInternet ? null : "."}
              </p>
            )}
            <Field label="Plan nuevo" hint="La velocidad la pone el plan: es también el precio de la próxima factura y el perfil que se le empuja al router">
              <Select value={planNuevo} onChange={(e) => setPlanNuevo(e.target.value)} disabled={!planesInternet.length}>
                <option value="">{planesInternet.length ? "— sin cambiar el plan —" : "Cargando…"}</option>
                {planesInternet.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.megas != null ? `${p.megas} Megas · ${p.name}` : p.name} · {fullCurrency(p.price)}
                  </option>
                ))}
              </Select>
            </Field>
            {/* El plan que la orden trae puede estar OCULTO en el catálogo (72 de 85
                lo están): el desplegable solo ofrece los activos, así que si el suyo
                no está se dice aquí en vez de dejar la casilla en blanco, que se lee
                como "esta orden no tiene plan". */}
            {orden.megas?.planId && !planesInternet.some((p) => p.id === orden.megas?.planId) && planesInternet.length > 0 && (
              <p className="mt-1 text-[11.5px] text-text-tertiary">
                El plan que tiene puesto («{orden.megas.plan}») está oculto en el catálogo y no sale en la lista.
              </p>
            )}
            {planElegido && !megasAlReves && planNuevo !== (orden.megas?.planId ?? "") && (
              <p className="mt-2 text-[12px] text-text-secondary">
                Queda en{" "}
                <b className="text-text-primary">{planElegido.megas != null ? `${planElegido.megas} Megas` : planElegido.name}</b>
                {" · "}{fullCurrency(planElegido.price)} al mes. Se le aplica al cerrar la orden.
              </p>
            )}
            {megasAlReves && (
              <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-text">
                {subeMegas
                  ? `«${planElegido?.name}» no sube nada: el cliente venía de ${origenMegas.megas} Megas.`
                  : `«${planElegido?.name}» no baja nada: el cliente venía de ${origenMegas.megas} Megas.`}
              </p>
            )}
          </div>
        )}

        {/* A dónde se muda. Al guardarlo, la ficha del cliente queda con la dirección
            nueva —salvo que ya la tenga, que es lo normal en las órdenes que vienen
            del sistema viejo: allá la cambian a mano al abrir el traslado. */}
        {porTraslado && (
          <div className="rounded-lg border border-border-default bg-surface-2 p-3">
            <div className="mb-2 text-[13px] font-semibold text-text-primary">
              {orden.moveToText ? "Corregir la dirección del traslado" : "¿A dónde se muda el cliente?"}
            </div>
            {orden.moveToText ? (
              <p className="mb-2 text-[12px] text-text-tertiary">
                La orden dice <span className="text-text-secondary">{orden.moveToText}</span>. Escribe la nueva solo si esa está mal.
              </p>
            ) : (
              <p className="mb-2 text-[12px] text-text-tertiary">
                Esta orden no dice a dónde va el técnico
                {dirActual ? <> · el cliente figura hoy en <span className="text-text-secondary">{dirActual}</span></> : null}.
              </p>
            )}
            <DireccionFields value={dir} onChange={(patch) => setDir((p) => ({ ...p, ...patch }))} comercial={false} />
            <p className="mt-2 text-[12px] text-text-secondary">
              Queda como: <b className="text-text-primary">{destinoNuevo || "— escribe la vía y su número —"}</b>
            </p>
            <p className="mt-1 text-[11.5px] text-text-tertiary">
              Si es distinta a la que tiene la ficha, el cliente queda registrado ahí. El cobro del traslado no se
              toca: esta orden ya nació con su factura (o sin ella).
            </p>
          </div>
        )}

        {porTitular && (
          <div className="rounded-lg border border-border-default bg-surface-2 p-3">
            <div className="mb-1 text-[13px] font-semibold text-text-primary">
              {orden.cambioTitular ? "Corregir los datos del nuevo titular" : "Datos del nuevo titular"}
            </div>
            <p className="mb-3 text-[12px] text-text-tertiary">
              {orden.cambioTitular
                ? <>La orden dice <span className="text-text-secondary">{orden.cambioTitular.hasta}</span>
                    {orden.cambioTitular.desde ? <> (antes: {orden.cambioTitular.desde})</> : null}. </>
                : <>Esta orden todavía no dice a nombre de quién queda el servicio. </>}
              Al guardar, la ficha del cliente queda con estos datos.
            </p>
            <TitularFields value={titular} onChange={(patch) => setTitular((p) => ({ ...p, ...patch }))} />
            {titularTocado && titularTexto(titular) && (
              <p className="mt-2 text-[12px] text-text-secondary">
                Queda a nombre de: <b className="text-text-primary">{titularTexto(titular)}</b>
              </p>
            )}
          </div>
        )}

        {porRetiro ? (
          /* El motivo del retiro se elige, no se escribe. Si la orden trae uno que
             ya no está en la lista —las viejas del legacy traen de todo— se añade
             como opción para no cambiárselo solo al abrir este modal. */
          <Field label="Razón del retiro" hint="De aquí sale el informe de por qué se van los clientes">
            <Select value={problem} onChange={(e) => setProblem(e.target.value)} disabled={!motivos.length}>
              <option value="">{motivos.length ? "— sin motivo —" : "Cargando…"}</option>
              {(problem && !motivos.includes(problem) ? [problem, ...motivos] : motivos).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Falla reportada" hint={`Lo que dijo el cliente · ${problem.length}/${MAX_PROBLEM}`}>
            <Textarea
              rows={2}
              maxLength={MAX_PROBLEM}
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              placeholder="Ej: no le llega señal desde anoche"
            />
          </Field>
        )}

        <Field label="Observación" hint={`Lo que hay que saber para atenderla · ${section.length}/${MAX_SECTION}`}>
          <Textarea
            rows={3}
            maxLength={MAX_SECTION}
            value={section}
            onChange={(e) => setSection(e.target.value)}
            placeholder="Ej: vive en el segundo piso, timbre de la izquierda"
          />
        </Field>

        <p className="text-[11px] text-text-tertiary">
          El técnico y la prioridad se cambian en «Gestión de la orden», ahí mismo en la ficha. Lo que se corrija aquí
          queda anotado en el seguimiento con tu nombre.
        </p>

        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Guardar cambios"}</Button>
        </div>
      </div>
    </Modal>
  );
}
