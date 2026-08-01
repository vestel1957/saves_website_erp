"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Select } from "@/components/ui/Field";
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
  staffId: string | null; tecnico: string | null;
  cliente: string | null; abonado: number | null; subscriberId: string | null;
  direccion: string | null; telefono: string | null; sede: string | null; barrio: string | null;
};
type Columna = { staffId: string; nombre: string; ordenes: Tarjeta[] };
type Tablero = { fecha: string; hoy: string; sinAgendar: Tarjeta[]; sinAgendarTotal: number; columnas: Columna[] };

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
  zona, setZona, antesDe, setAntesDe, arrastrando, setArrastrando, mover, resaltar,
}: {
  clave: string; titulo: string; subtitulo: string; icono: string;
  tarjetas: Tarjeta[]; staffId: string | null; tecnicos: Columna[];
  zona: string | null; setZona: Dispatch<SetStateAction<string | null>>;
  antesDe: string | null; setAntesDe: Dispatch<SetStateAction<string | null>>;
  arrastrando: string | null; setArrastrando: (id: string | null) => void;
  mover: (ticketId: string, staffId: string | null, posicion?: number) => void;
  /** Filtro visual: lo que no coincide se ATENÚA en vez de ocultarse. Quitar
      tarjetas correría los índices con los que se calcula la posición del drop. */
  resaltar?: (t: Tarjeta) => boolean;
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

  /**
   * Suelta ENCIMA de la tarjeta `i`: la arrastrada toma su puesto. Si viene de más
   * arriba en la MISMA columna, al sacarla las de abajo suben una — por eso ahí la
   * posición es `i` y no `i + 1`.
   */
  const soltarSobre = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setZona(null);
    setAntesDe(null);
    const id = e.dataTransfer.getData("text/plain") || arrastrando;
    setArrastrando(null);
    if (!id || id === tarjetas[i]?.id) return;
    const desde = tarjetas.findIndex((t) => t.id === id);
    void mover(id, staffId, desde !== -1 && desde < i ? i : i + 1);
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
            {staffId ? "Arrastra aquí sus visitas del día" : "Nada sin agendar"}
          </div>
        ) : tarjetas.map((t, i) => (
          <div
            key={t.id}
            className={`relative transition-opacity ${resaltar && !resaltar(t) ? "opacity-25" : ""}`}
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
            <TarjetaOrden
              t={t}
              indice={staffId ? i + 1 : undefined}
              tecnicos={tecnicos}
              arrastrando={arrastrando}
              setArrastrando={setArrastrando}
              onAgendar={(destino) => void mover(t.id, destino)}
              onSubir={staffId && i > 0 ? () => void mover(t.id, staffId, i) : undefined}
              onBajar={staffId && i < tarjetas.length - 1 ? () => void mover(t.id, staffId, i + 2) : undefined}
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

  // Filtros del tablero. Técnico oculta las demás columnas; estado y prioridad
  // solo atenúan (ver `resaltar` en ColumnaTablero).
  const [fTecnico, setFTecnico] = useState("");
  const [fEstado, setFEstado] = useState("");
  const [fPrioridad, setFPrioridad] = useState("");
  const resaltar = useMemo(() => {
    if (!fEstado && !fPrioridad) return undefined;
    return (t: Tarjeta) => {
      const okEstado = !fEstado || (fEstado === "__cerradas__"
        ? t.status === "RESUELTO" || t.status === "ANULADA"
        : t.status === fEstado);
      const okPrioridad = !fPrioridad || (t.priority ?? "").trim().toLowerCase() === fPrioridad.toLowerCase();
      return okEstado && okPrioridad;
    };
  }, [fEstado, fPrioridad]);

  const cargar = useCallback(async (f?: string | null) => {
    setErr(false);
    try {
      const qs = f ? `?fecha=${f}` : "";
      const r = await authFetch(`/support/agenda${qs}`);
      if (!r.ok) throw new Error(String(r.status));
      const j: Tablero = await r.json();
      setD(j);
      setFecha(j.fecha);
    } catch { setErr(true); }
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void cargar(null); }, [authLoading, cargar]);

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

  const esAbierta = (o: Tarjeta) => o.status === "PENDIENTE" || o.status === "REALIZANDO";
  const totalAgendadas = useMemo(() => (d?.columnas ?? []).reduce((s, c) => s + c.ordenes.length, 0), [d]);
  const totalPendientes = useMemo(
    () => (d?.columnas ?? []).reduce((s, c) => s + c.ordenes.filter(esAbierta).length, 0),
    [d],
  );

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d) return <div className="p-6"><LoadError message="No se pudo cargar la agenda." onRetry={() => void cargar(fecha)} /></div>;
  if (!d) return <PageSkeleton />;

  const esHoy = d.fecha === d.hoy;
  const irA = (f: string) => { setFecha(f); void cargar(f); };

  /** Descarga el Excel del tablero completo del día que está en pantalla. */
  const exportar = async () => {
    setExportando(true);
    try {
      const res = await authFetch(`/support/agenda/export.xlsx?fecha=${d.fecha}`);
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
        <span><b className="text-text-primary">{d.sinAgendarTotal}</b> sin agendar</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={fTecnico} onChange={(e) => setFTecnico(e.target.value)} className="h-8 w-auto text-[12px]" aria-label="Filtrar por técnico">
          <option value="">Todos los técnicos</option>
          {d.columnas.map((c) => <option key={c.staffId} value={c.staffId}>{c.nombre}</option>)}
        </Select>
        <Select value={fEstado} onChange={(e) => setFEstado(e.target.value)} className="h-8 w-auto text-[12px]" aria-label="Filtrar por estado">
          <option value="">Todos los estados</option>
          <option value="PENDIENTE">Pendientes</option>
          <option value="REALIZANDO">En curso</option>
          <option value="__cerradas__">Cerradas</option>
        </Select>
        <Select value={fPrioridad} onChange={(e) => setFPrioridad(e.target.value)} className="h-8 w-auto text-[12px]" aria-label="Filtrar por prioridad">
          <option value="">Toda prioridad</option>
          {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        {(fTecnico || fEstado || fPrioridad) && (
          <button
            type="button"
            onClick={() => { setFTecnico(""); setFEstado(""); setFPrioridad(""); }}
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
          subtitulo={d.sinAgendar.length < d.sinAgendarTotal
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
          resaltar={resaltar}
        />
        {d.columnas.filter((c) => !fTecnico || c.staffId === fTecnico).map((c) => {
          const pendientes = c.ordenes.filter(esAbierta).length;
          const cerradas = c.ordenes.length - pendientes;
          return (
            <ColumnaTablero
              key={c.staffId}
              clave={c.staffId}
              titulo={c.nombre}
              subtitulo={`${pendientes} ${pendientes === 1 ? "pendiente" : "pendientes"}${cerradas ? ` · ${cerradas} ${cerradas === 1 ? "cerrada" : "cerradas"}` : ""}`}
              icono="hard-hat"
              tarjetas={c.ordenes}
              staffId={c.staffId}
              tecnicos={d.columnas}
              zona={zona} setZona={setZona}
              antesDe={antesDe} setAntesDe={setAntesDe}
              arrastrando={arrastrando} setArrastrando={alArrastrar}
              mover={mover}
              resaltar={resaltar}
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
          Se muestran las {d.sinAgendar.length} más urgentes y antiguas de {d.sinAgendarTotal} sin agendar.
          El resto aparece a medida que vayas repartiendo estas.
        </p>
      )}
    </div>
  );
}
