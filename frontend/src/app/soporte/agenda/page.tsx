"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";

type Tarjeta = {
  id: string; code: number | null; subject: string; type: string;
  priority: string | null; status: string; created: string; problema: string | null;
  seq: number | null; agendadaPor: string | null;
  /** El técnico fue y no la pudo hacer. Vuelve a esta bandeja para reagendarla. */
  noAtendida: { fecha: string; motivo: string | null; por: string | null } | null;
  staffId: string | null; tecnico: string | null;
  cliente: string | null; abonado: number | null; subscriberId: string | null;
  direccion: string | null; telefono: string | null; sede: string | null; barrio: string | null;
};
/** `ordenes` viene filtrada; `total`/`pendientes` son la carga real del día, sin filtro. */
type Columna = { staffId: string; nombre: string; ordenes: Tarjeta[]; total: number; pendientes: number };
/** Un tipo de orden ofrecible en el filtro, con cuántas hay y de qué clase es. */
type TipoOrden = { tipo: string; clase: string; total: number };
type Tablero = {
  fecha: string; hoy: string; filtrando: boolean;
  sinAgendar: Tarjeta[]; sinAgendarTotal: number; sinAgendarSinFiltro: number | null;
  tipos: TipoOrden[]; columnas: Columna[];
};

/**
 * Los filtros del tablero. Filtran ÓRDENES, no técnicos: las columnas se quedan
 * todas —incluida la del técnico al que hoy no le coincide nada—, porque es
 * justamente donde hay que poder soltar lo que se acaba de encontrar.
 *
 * Van al servidor y no se aplican sobre lo ya cargado: la bandeja de "sin agendar"
 * llega recortada a las 200 más urgentes, así que filtrar en el navegador buscaría
 * dentro de esas 200 y una orden abierta que no esté ahí no aparecería nunca.
 */
type Filtros = { q: string; clase: string; tipo: string; prioridad: string; estado: string; noAtendidas: boolean };
const SIN_FILTROS: Filtros = { q: "", clase: "", tipo: "", prioridad: "", estado: "", noAtendidas: false };
const hayFiltros = (f: Filtros) =>
  f.q.trim() !== "" || f.clase !== "" || f.tipo !== "" || f.prioridad !== "" || f.estado !== "" || f.noAtendidas;

const CLASES = [
  { valor: "servicio", etiqueta: "Servicio" },
  { valor: "reclamo", etiqueta: "Reclamo" },
  { valor: "incidente", etiqueta: "Incidente" },
];

/** La query del tablero: filtros (+ día, si se pide uno concreto). */
function queryTablero(f: Filtros, fecha?: string | null) {
  const qs = new URLSearchParams();
  if (fecha) qs.set("fecha", fecha);
  if (f.q.trim()) qs.set("q", f.q.trim());
  if (f.clase) qs.set("clase", f.clase);
  if (f.tipo) qs.set("tipo", f.tipo);
  if (f.prioridad) qs.set("prioridad", f.prioridad);
  if (f.estado) qs.set("estado", f.estado);
  if (f.noAtendidas) qs.set("noAtendidas", "1");
  return qs.toString();
}

/**
 * En qué puesto queda una orden al soltarla, en la numeración de la columna.
 *
 * Se calcula con `seq` —la posición REAL de la visita en el día— y no con el índice
 * del array: con un filtro puesto la columna en pantalla se salta tarjetas, y ahí el
 * índice deja de ser la posición. El servidor recibe siempre "ponla en el puesto N"
 * de la columna completa y renumera él.
 *
 * `destino` es la tarjeta sobre la que se suelta: la arrastrada se mete JUSTO ANTES
 * (es la línea que se pinta encima). Si venía de más arriba en la misma columna, al
 * sacarla las de abajo suben una, y por eso ahí el puesto es uno menos.
 */
const puestoAntesDe = (destino: Tarjeta, arrastrada: Tarjeta | undefined, indiceDestino: number) => {
  const s = destino.seq ?? indiceDestino + 1;
  const d = arrastrada?.seq ?? null;
  return d != null && d < s ? s - 1 : s;
};

/**
 * Puesto para quedar JUSTO DESPUÉS de `destino`, viniendo de más arriba (es el botón
 * "bajar"). Al sacar la arrastrada, `destino` sube un puesto: meterla en el número
 * que ocupaba `destino` la deja detrás de ella.
 */
const puestoDespuesDe = (destino: Tarjeta, indiceDestino: number) => destino.seq ?? indiceDestino + 1;

const TONO_BADGE: Record<string, string> = {
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  default: "bg-surface-2 text-text-secondary",
};

/** Suma días a un 'YYYY-MM-DD' sin pasar por la zona horaria del navegador. */
function sumarDias(ymd: string, dias: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + dias));
  return t.toISOString().slice(0, 10);
}
const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });

/**
 * Una orden en el tablero. Se arrastra en escritorio y se mueve con botones en el
 * celular: la cajera trabaja en ventanilla, pero el mismo tablero se abre desde una
 * tablet y un tablero que sólo entiende `dragstart` ahí no sirve para nada.
 */
function TarjetaOrden({
  t, indice, tecnicos, onAgendar, onSubir, onBajar, onQuitar, arrastrando, setArrastrando,
}: {
  t: Tarjeta; indice?: number; tecnicos: Columna[];
  onAgendar: (staffId: string) => void;
  onSubir?: () => void; onBajar?: () => void; onQuitar?: () => void;
  arrastrando: string | null; setArrastrando: (id: string | null) => void;
}) {
  const tono = TICKET_PRIORITY_TONE[t.priority ?? ""] ?? "default";
  const enCurso = t.status === "REALIZANDO";
  const cerrada = t.status === "RESUELTO" || t.status === "ANULADA";
  return (
    <div
      draggable
      onDragStart={(e) => { setArrastrando(t.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.id); }}
      onDragEnd={() => setArrastrando(null)}
      className={`group flex cursor-grab flex-col gap-1.5 rounded-lg border bg-surface px-2.5 pb-3 pt-2.5 shadow-sm transition-opacity active:cursor-grabbing ${
        arrastrando === t.id ? "opacity-40" : ""
      } ${cerrada ? "opacity-60" : ""} ${enCurso ? "border-warning-border" : "border-border-subtle"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {indice != null && (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-on-brand">{indice}</span>
          )}
          <Link href={`/soporte/${t.id}`} className="truncate font-mono text-[11px] font-semibold text-text-secondary hover:text-brand hover:underline">
            #{t.code ?? "—"}
          </Link>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {enCurso && <span className="rounded bg-warning-soft px-1 py-0.5 text-[9px] font-bold uppercase text-warning-text">En curso</span>}
          {t.status === "RESUELTO" && <span className="rounded bg-success-soft px-1 py-0.5 text-[9px] font-bold uppercase text-success-text">Resuelta</span>}
          {t.status === "ANULADA" && <span className="rounded bg-surface-2 px-1 py-0.5 text-[9px] font-bold uppercase text-text-tertiary">Anulada</span>}
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TONO_BADGE[tono]}`}>{t.priority ?? "—"}</span>
        </span>
      </div>

      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold leading-snug text-text-primary" title={t.type}>{t.type}</div>
        {t.cliente && <div className="truncate text-[11px] text-text-secondary">{t.cliente}{t.abonado ? ` · ${t.abonado}` : ""}</div>}
        {(t.barrio || t.direccion) && (
          <div className="flex items-start gap-1 text-[10.5px] text-text-tertiary">
            <Icon name="map-pin" size={10} className="mt-0.5 shrink-0" />
            <span className="truncate" title={t.direccion ?? undefined}>{t.barrio ?? t.direccion}</span>
          </div>
        )}
        {/* Una orden que el técnico intentó y no pudo NO es lo mismo que una que
            nunca se agendó, aunque las dos caigan en esta bandeja: en la primera ya
            hubo un viaje. El motivo va a la vista para que se pueda decidir sin
            abrir la orden (llamar antes, cambiar de día, mandar material). */}
        {t.noAtendida && (
          <div className="mt-1 flex items-start gap-1 rounded bg-warning-soft px-1.5 py-1 text-[10.5px] text-warning-text">
            <Icon name="alert-triangle" size={10} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              <b>No se pudo atender</b>
              {t.noAtendida.motivo ? `: ${t.noAtendida.motivo}` : ""}
              {t.noAtendida.por ? <span className="block opacity-80">— {t.noAtendida.por}</span> : null}
            </span>
          </div>
        )}
        {t.telefono && (
          <div className="flex items-center gap-1 text-[10.5px] text-text-tertiary">
            <Icon name="phone" size={10} className="shrink-0" />
            <span className="truncate">{t.telefono}</span>
          </div>
        )}
        {t.problema && (
          <div className="line-clamp-2 text-[10.5px] italic text-text-tertiary" title={t.problema}>{t.problema}</div>
        )}
      </div>

      {/* Controles sin arrastre, siempre visibles: en táctil no hay otra forma de
          mover una tarjeta, y esconderlos tras el hover en escritorio dejaba el
          hueco reservado igual — media tarjeta en blanco a cambio de nada. */}
      <div className={`mt-1 flex items-center gap-1.5 border-t border-border-subtle ${indice == null ? "pt-3" : "pt-2"}`}>
        {indice == null ? (
          <Select
            value=""
            onChange={(e) => e.target.value && onAgendar(e.target.value)}
            className="h-8 w-full !py-0 text-[11px]"
            aria-label={`Agendar la orden ${t.code ?? ""} a un técnico`}
          >
            <option value="">Agendar a…</option>
            {tecnicos.map((c) => <option key={c.staffId} value={c.staffId}>{c.nombre}</option>)}
          </Select>
        ) : (
          <>
            <Select
              value=""
              onChange={(e) => e.target.value && onAgendar(e.target.value)}
              className="h-7 min-w-0 flex-1 !py-0 text-[11px]"
              aria-label="Pasar a otro técnico"
            >
              <option value="">Pasar a…</option>
              {tecnicos.map((c) => <option key={c.staffId} value={c.staffId}>{c.nombre}</option>)}
            </Select>
            {/* Los tres botones van apretados entre sí y separados del selector:
                así el selector gana el ancho sobrante. */}
            <span className="flex shrink-0 items-center">
              <button type="button" onClick={onSubir} disabled={!onSubir} title="Subir" aria-label="Subir en la agenda"
                className="tap rounded p-0.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30">
                <Icon name="chevron-up" size={14} />
              </button>
              <button type="button" onClick={onBajar} disabled={!onBajar} title="Bajar" aria-label="Bajar en la agenda"
                className="tap rounded p-0.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary disabled:opacity-30">
                <Icon name="chevron-down" size={14} />
              </button>
              <button type="button" onClick={onQuitar} title="Quitar del día" aria-label="Quitar del día"
                className="tap ml-0.5 rounded p-0.5 text-text-tertiary hover:bg-error-soft hover:text-error-text">
                <Icon name="x" size={14} />
              </button>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Columna del tablero. Vive FUERA de `AgendaPage` a propósito: definida adentro,
 * cada `setState` del arrastre creaba un TIPO de componente nuevo y React
 * desmontaba el DOM completo de las columnas en pleno gesto — el navegador
 * cancelaba el arrastre y el `drop` no llegaba nunca. Aquí afuera la identidad es
 * estable y un re-render actualiza los nodos en vez de recrearlos.
 */
function ColumnaTablero({
  clave, titulo, subtitulo, icono, tarjetas, staffId, tecnicos,
  zona, setZona, antesDe, setAntesDe, arrastrando, setArrastrando, mover, vacia,
}: {
  clave: string; titulo: string; subtitulo: string; icono: string;
  tarjetas: Tarjeta[]; staffId: string | null; tecnicos: Columna[];
  zona: string | null; setZona: Dispatch<SetStateAction<string | null>>;
  antesDe: string | null; setAntesDe: Dispatch<SetStateAction<string | null>>;
  arrastrando: string | null; setArrastrando: (id: string | null) => void;
  mover: (ticketId: string, staffId: string | null, posicion?: number) => void;
  /** Qué decir cuando no hay tarjetas que pintar (cambia si hay filtro puesto). */
  vacia: string;
}) {
  // `dragover` dispara sin parar mientras el puntero se mueve: los setters van
  // guardados contra el valor previo para no re-renderizar el tablero por evento.
  const marcarZona = () => setZona((z) => (z === clave ? z : clave));

  /** Suelta la tarjeta arrastrada: sin `posicion`, al final de la columna. */
  const soltar = (posicion?: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setZona(null);
    setAntesDe(null);
    const id = e.dataTransfer.getData("text/plain") || arrastrando;
    setArrastrando(null);
    if (id) void mover(id, staffId, posicion);
  };

  /** Suelta ENCIMA de la tarjeta `i`: la arrastrada se mete justo antes que ella. */
  const soltarSobre = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setZona(null);
    setAntesDe(null);
    const id = e.dataTransfer.getData("text/plain") || arrastrando;
    setArrastrando(null);
    const destino = tarjetas[i];
    if (!id || !destino || id === destino.id) return;
    void mover(id, staffId, puestoAntesDe(destino, tarjetas.find((t) => t.id === id), i));
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); marcarZona(); }}
      onDragLeave={(e) => {
        // `dragleave` burbujea desde las tarjetas: solo cuenta salir de la columna.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setZona((z) => (z === clave ? null : z));
        setAntesDe(null);
      }}
      onDrop={soltar()}
      className={`flex w-[270px] shrink-0 flex-col rounded-xl border bg-surface-2/40 p-2 transition-colors ${
        zona === clave ? "border-brand bg-brand-soft/40" : "border-border-subtle"
      }`}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
          <Icon name={icono} size={14} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-bold text-text-primary" title={titulo}>{titulo}</div>
          <div className="text-[10.5px] text-text-tertiary">{subtitulo}</div>
        </div>
      </div>
      <div className="flex max-h-[calc(100vh-290px)] flex-col gap-2 overflow-y-auto pr-0.5">
        {tarjetas.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-default px-3 py-6 text-center text-[11px] text-text-tertiary">
            {vacia}
          </div>
        ) : tarjetas.map((t, i) => (
          <div
            key={t.id}
            className="relative"
            onDragOver={staffId ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              marcarZona();
              if (arrastrando !== t.id) setAntesDe((a) => (a === t.id ? a : t.id));
            } : undefined}
            onDragLeave={staffId ? (e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setAntesDe((a) => (a === t.id ? null : a));
            } : undefined}
            onDrop={staffId ? soltarSobre(i) : undefined}
          >
            {antesDe === t.id && (
              <div aria-hidden className="absolute -top-[6px] left-1 right-1 h-[3px] rounded-full bg-brand" />
            )}
            {/* El número es el puesto REAL de la visita en el día (`seq`), no el de la
                lista en pantalla: con un filtro puesto la numeración se salta huecos
                —1, 4, 7— y eso es lo correcto, porque el técnico va a hacer la 4 en
                cuarto lugar aunque la cajera solo esté mirando las urgentes.
                Subir/bajar mueven respecto a la tarjeta VISIBLE de al lado. */}
            <TarjetaOrden
              t={t}
              indice={staffId ? t.seq ?? i + 1 : undefined}
              tecnicos={tecnicos}
              arrastrando={arrastrando}
              setArrastrando={setArrastrando}
              onAgendar={(destino) => void mover(t.id, destino)}
              onSubir={staffId && i > 0 ? () => void mover(t.id, staffId, puestoAntesDe(tarjetas[i - 1], t, i - 1)) : undefined}
              onBajar={staffId && i < tarjetas.length - 1 ? () => void mover(t.id, staffId, puestoDespuesDe(tarjetas[i + 1], i + 1)) : undefined}
              onQuitar={staffId ? () => void mover(t.id, null) : undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Agendamiento de órdenes de trabajo.
 *
 * Quien agenda es la CAJERA: reparte el trabajo del día entre los técnicos y decide
 * en qué orden va cada visita. El técnico no arma su agenda, la sigue — por eso esta
 * pantalla no está en su perfil y `AgendaService.mover` se lo vuelve a negar aunque
 * llegue por API.
 *
 * El tablero es de columnas y no una tabla con un campo "posición" porque la
 * pregunta que responde es espacial: qué tanto trabajo lleva cada uno y en qué punto
 * del día meto esta visita. Eso se ve de un vistazo con columnas y no leyendo números.
 *
 * La posición NO se manda como un cálculo del navegador: se manda "ponla en el puesto
 * N" y el servidor renumera la columna entera. Si dos personas agendan a la vez, la
 * última gana pero la agenda nunca queda con dos órdenes en el mismo puesto.
 */
export default function AgendaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  // `null` = hoy, y lo resuelve el backend (que es quien sabe qué día es en Colombia).
  // La respuesta NO se guarda aquí: hacerlo disparaba una segunda carga al montar.
  const [fecha, setFecha] = useState<string | null>(null);
  const [d, setD] = useState<Tablero | null>(null);
  const [err, setErr] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [arrastrando, setArrastrando] = useState<string | null>(null);
  const [zona, setZona] = useState<string | null>(null); // columna sobre la que se suelta
  const [antesDe, setAntesDe] = useState<string | null>(null); // tarjeta que marca el punto de inserción
  const [exportando, setExportando] = useState(false);

  /** Limpia todo el estado del gesto cuando el arrastre termina, llegue o no el drop. */
  const alArrastrar = useCallback((id: string | null) => {
    setArrastrando(id);
    if (id === null) { setZona(null); setAntesDe(null); }
  }, []);

  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);
  const puso = <K extends keyof Filtros>(k: K, v: Filtros[K]) => setFiltros((f) => ({ ...f, [k]: v }));
  const filtrando = hayFiltros(filtros);
  const claveFiltros = useMemo(() => queryTablero(filtros), [filtros]);

  // Los filtros los lee `cargar` de una ref para que la función no cambie de
  // identidad al teclear: es la que llama `mover` después de cada arrastre, y una
  // referencia nueva por letra volvería a montar medio tablero en mitad del gesto.
  // La ref se sincroniza en un efecto declarado ANTES del de carga: los efectos
  // corren en orden de declaración, así que cuando el de abajo pide el tablero la
  // ref ya trae los filtros de este render.
  const filtrosRef = useRef(filtros);
  useEffect(() => { filtrosRef.current = filtros; }, [filtros]);

  const cargar = useCallback(async (f?: string | null) => {
    setErr(false);
    try {
      const qs = queryTablero(filtrosRef.current, f);
      const r = await authFetch(`/support/agenda${qs ? `?${qs}` : ""}`);
      if (!r.ok) throw new Error(String(r.status));
      setD(await r.json());
    } catch { setErr(true); }
  }, [authFetch]);

  // Una sola carga por cambio: día o filtros. El buscador espera a que se deje de
  // teclear; lo demás (desplegables) va sin retardo, que es lo que se espera al
  // elegir una opción.
  useEffect(() => {
    if (authLoading) return;
    const t = window.setTimeout(() => { void cargar(fecha); }, filtrosRef.current.q.trim() ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [authLoading, fecha, claveFiltros, cargar]);

  const mover = useCallback(async (ticketId: string, staffId: string | null, posicion?: number) => {
    if (!fecha) return;
    setGuardando(true);
    try {
      const r = await authFetch("/support/agenda/mover", {
        method: "POST",
        body: JSON.stringify({ ticketId, staffId, fecha: staffId ? fecha : null, posicion }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || "No se pudo mover la orden");
      await cargar(fecha);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setGuardando(false); }
  }, [authFetch, fecha, cargar]);

  // Las cifras del día van SIN filtro (`total`/`pendientes` los manda el backend):
  // lo repartido no cambia porque se busque una orden, y un contador que baja al
  // teclear es justo el dato con el que se reparte mal el día.
  const totalAgendadas = useMemo(() => (d?.columnas ?? []).reduce((s, c) => s + c.total, 0), [d]);
  const totalPendientes = useMemo(() => (d?.columnas ?? []).reduce((s, c) => s + c.pendientes, 0), [d]);
  /** Cuántas coinciden con el filtro, contando la bandeja y las ya repartidas. */
  const coinciden = useMemo(
    () => (d ? d.sinAgendarTotal + d.columnas.reduce((s, c) => s + c.ordenes.length, 0) : 0),
    [d],
  );

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d) return <div className="p-6"><LoadError message="No se pudo cargar la agenda." onRetry={() => void cargar(fecha)} /></div>;
  if (!d) return <PageSkeleton />;

  const esHoy = d.fecha === d.hoy;
  // Con una clase elegida solo se ofrecen sus tipos: mezclar 'Instalacion' con
  // 'Revision de Internet' cuando ya se pidió "reclamo" es ofrecer nada.
  const tiposOfrecidos = filtros.clase ? d.tipos.filter((t) => t.clase === filtros.clase) : d.tipos;
  // Solo cambia el día: de recargar se encarga el efecto, que es el único sitio
  // desde el que se pide el tablero al cambiar día o filtros.
  const irA = (f: string) => setFecha(f);

  /** Descarga el Excel de lo que hay en pantalla: mismo día y mismos filtros. */
  const exportar = async () => {
    setExportando(true);
    try {
      const res = await authFetch(`/support/agenda/export.xlsx?${queryTablero(filtros, d.fecha)}`);
      if (!res.ok) throw new Error("No se pudo exportar");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `agenda-${d.fecha}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setExportando(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="calendar-clock"
          title="Agendamiento"
          subtitle="Reparte el día entre los técnicos y decide en qué orden va cada visita"
        />
        <div className="flex items-center gap-1.5">
          {guardando && <Icon name="loader" size={15} className="animate-spin text-text-tertiary" />}
          <button type="button" onClick={exportar} disabled={exportando} title="Exportar la agenda del día a Excel"
            className="tap inline-flex items-center gap-1.5 rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2 disabled:opacity-50">
            <Icon name={exportando ? "loader" : "download"} size={14} className={exportando ? "animate-spin" : ""} /> Excel
          </button>
          <button type="button" onClick={() => irA(sumarDias(d.fecha, -1))} aria-label="Día anterior"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2">
            <Icon name="chevron-left" size={15} />
          </button>
          <input
            type="date"
            value={d.fecha}
            onChange={(e) => e.target.value && irA(e.target.value)}
            className="rounded-lg border border-border-default bg-surface px-2.5 py-1.5 text-[12.5px] font-semibold text-text-primary"
            aria-label="Día de la agenda"
          />
          <button type="button" onClick={() => irA(sumarDias(d.fecha, 1))} aria-label="Día siguiente"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2">
            <Icon name="chevron-right" size={15} />
          </button>
          {!esHoy && (
            <button type="button" onClick={() => irA(d.hoy)}
              className="rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
              Hoy
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-secondary">
        <span className="font-semibold text-text-primary first-letter:uppercase">{diaLargo(d.fecha)}</span>
        <span>·</span>
        <span><b className="text-text-primary">{totalAgendadas}</b> {totalAgendadas === 1 ? "visita agendada" : "visitas agendadas"}</span>
        {totalPendientes < totalAgendadas && (
          <>
            <span>·</span>
            <span><b className="text-text-primary">{totalPendientes}</b> aún pendientes</span>
          </>
        )}
        <span>·</span>
        <span><b className="text-text-primary">{d.sinAgendarSinFiltro ?? d.sinAgendarTotal}</b> sin agendar</span>
        {filtrando && (
          <>
            <span>·</span>
            <span className="font-semibold text-brand">
              {coinciden === 1 ? "1 orden coincide" : `${coinciden} órdenes coinciden`} con el filtro
            </span>
          </>
        )}
      </div>

      {/* Los filtros buscan ÓRDENES, no técnicos: la pregunta de la ventanilla es
          "dónde quedó la orden de la señora del barrio Centro" o "qué instalaciones
          me faltan", y ninguna de las dos se responde eligiendo un técnico. Las
          columnas se quedan todas: la del técnico sin coincidencias también, porque
          es donde hay que poder soltar lo que se acaba de encontrar. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            value={filtros.q}
            onChange={(e) => puso("q", e.target.value)}
            placeholder="N° de orden, cliente, barrio, dirección, teléfono…"
            aria-label="Buscar órdenes en la agenda"
            className="h-8 !py-0 pl-8 text-[12px]"
          />
          {filtros.q && (
            <button type="button" onClick={() => puso("q", "")} aria-label="Borrar la búsqueda"
              className="tap absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary">
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
        {/* Elegir clase acota los tipos, y por eso limpia el tipo que ya no
            pertenece a ella: dejarlo puesto habría dado un tablero vacío con dos
            filtros que se contradicen sin decirlo. */}
        <Select
          value={filtros.clase}
          onChange={(e) => {
            const clase = e.target.value;
            setFiltros((f) => ({
              ...f,
              clase,
              tipo: clase && !d.tipos.some((t) => t.tipo === f.tipo && t.clase === clase) ? "" : f.tipo,
            }));
          }}
          className="h-8 w-auto text-[12px]"
          aria-label="Filtrar por clase de orden"
        >
          <option value="">Toda clase</option>
          {CLASES.map((c) => <option key={c.valor} value={c.valor}>{c.etiqueta}</option>)}
        </Select>
        {/* Los tipos salen de las órdenes que hay, ordenados por cuántas son: lo que
            más se repite —y lo que más se reparte— queda arriba. El número al lado
            evita el clic a ciegas en un tipo que solo tiene una. */}
        <Select value={filtros.tipo} onChange={(e) => puso("tipo", e.target.value)} className="h-8 w-auto max-w-[15rem] text-[12px]" aria-label="Filtrar por tipo de orden">
          <option value="">Todo tipo</option>
          {tiposOfrecidos.map((t) => (
            <option key={t.tipo} value={t.tipo}>{t.tipo} ({t.total})</option>
          ))}
          {/* Si el tipo puesto ya no está en la lista (cambió el día), se ofrece
              igual: si no, el desplegable enseñaría "Todo tipo" con un filtro activo. */}
          {filtros.tipo && !tiposOfrecidos.some((t) => t.tipo === filtros.tipo) && (
            <option value={filtros.tipo}>{filtros.tipo}</option>
          )}
        </Select>
        <Select value={filtros.estado} onChange={(e) => puso("estado", e.target.value)} className="h-8 w-auto text-[12px]" aria-label="Filtrar por estado">
          <option value="">Todos los estados</option>
          <option value="PENDIENTE">Pendientes</option>
          <option value="REALIZANDO">En curso</option>
          <option value="cerradas">Cerradas</option>
        </Select>
        <Select value={filtros.prioridad} onChange={(e) => puso("prioridad", e.target.value)} className="h-8 w-auto text-[12px]" aria-label="Filtrar por prioridad">
          <option value="">Toda prioridad</option>
          {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        {/* Las que un técnico fue a hacer y no pudo son la cola que se reagenda
            primero: merecen un botón y no ir escondidas dentro de un desplegable. */}
        <button
          type="button"
          onClick={() => puso("noAtendidas", !filtros.noAtendidas)}
          aria-pressed={filtros.noAtendidas}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-semibold transition-colors ${
            filtros.noAtendidas ? "border-warning-border bg-warning-soft text-warning-text" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
          }`}
        >
          <Icon name="alert-triangle" size={13} /> No atendidas
        </button>
        {filtrando && (
          <button
            type="button"
            onClick={() => setFiltros(SIN_FILTROS)}
            className="text-[12px] font-semibold text-brand hover:underline"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* El tablero se desplaza en horizontal: con 12 técnicos no caben todas las
          columnas, y apilarlas en vertical rompe justo la comparación que la cajera
          necesita hacer (quién va cargado y quién no). */}
      <div className="-mx-1 flex shrink-0 gap-3 overflow-x-auto px-1 pb-2">
        <ColumnaTablero
          clave="__sin__"
          titulo="Sin agendar"
          subtitulo={filtrando
            ? `${d.sinAgendarTotal} de ${d.sinAgendarSinFiltro ?? d.sinAgendarTotal} coinciden`
            : d.sinAgendar.length < d.sinAgendarTotal
              ? `${d.sinAgendar.length} de ${d.sinAgendarTotal} · lo urgente primero`
              : `${d.sinAgendarTotal} abiertas sin día`}
          icono="inbox"
          tarjetas={d.sinAgendar}
          staffId={null}
          tecnicos={d.columnas}
          zona={zona} setZona={setZona}
          antesDe={antesDe} setAntesDe={setAntesDe}
          arrastrando={arrastrando} setArrastrando={alArrastrar}
          mover={mover}
          vacia={filtrando ? "Ninguna sin agendar coincide" : "Nada sin agendar"}
        />
        {d.columnas.map((c) => {
          const cerradas = c.total - c.pendientes;
          // La carga del técnico se sigue leyendo entera aunque haya filtro; lo que
          // el filtro cambia es cuántas de esas se están viendo.
          const carga = `${c.pendientes} ${c.pendientes === 1 ? "pendiente" : "pendientes"}${cerradas ? ` · ${cerradas} ${cerradas === 1 ? "cerrada" : "cerradas"}` : ""}`;
          return (
            <ColumnaTablero
              key={c.staffId}
              clave={c.staffId}
              titulo={c.nombre}
              // "a la vista" solo cuando hay algo que recortar: en un técnico sin
              // nada agendado, "0 pendientes · 0 a la vista" dice dos veces cero.
              subtitulo={filtrando && c.total > 0 ? `${carga} · ${c.ordenes.length} a la vista` : carga}
              icono="hard-hat"
              tarjetas={c.ordenes}
              staffId={c.staffId}
              tecnicos={d.columnas}
              zona={zona} setZona={setZona}
              antesDe={antesDe} setAntesDe={setAntesDe}
              arrastrando={arrastrando} setArrastrando={alArrastrar}
              mover={mover}
              vacia={filtrando
                ? c.total > 0 ? "Ninguna de sus visitas coincide" : "Sin visitas hoy"
                : "Arrastra aquí sus visitas del día"}
            />
          );
        })}
        {d.columnas.length === 0 && (
          <div className="rounded-xl border border-dashed border-border-default px-6 py-10 text-center text-[12px] text-text-tertiary">
            No hay técnicos de tu sede para agendar.
          </div>
        )}
      </div>

      {d.sinAgendar.length < d.sinAgendarTotal && (
        <p className="text-[11.5px] text-text-tertiary">
          Se muestran las {d.sinAgendar.length} más urgentes y antiguas de {d.sinAgendarTotal} sin agendar
          {filtrando ? " que coinciden con el filtro" : ""}. El resto aparece a medida que vayas repartiendo estas
          {filtrando ? ", o afinando la búsqueda" : ""}.
        </p>
      )}
    </div>
  );
}
