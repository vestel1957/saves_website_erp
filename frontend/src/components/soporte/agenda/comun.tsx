"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { Input } from "@/components/ui/Field";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { TICKET_PRIORITIES } from "@/lib/support";

/**
 * Las piezas que comparten las dos pestañas del agendamiento: "Repartir" (la lista
 * de órdenes sin día) y "Por técnico" (cómo quedó cada agenda).
 *
 * Vivían dentro de `/soporte/agenda/page.tsx`, que era la única vista que había.
 * Siguen aquí porque los filtros, el Excel y los tipos que se ofrecen tienen que ser
 * los MISMOS en las dos: la cajera reparte con los mismos filtros con los que luego
 * comprueba, y un Excel que cambia de columnas según la pestaña desde la que se bajó
 * se lee como otro informe.
 */

export type Tarjeta = {
  id: string; code: number | null; subject: string; type: string;
  priority: string | null; status: string; created: string;
  /** La falla en una línea (`problem`) y la observación (`section`), ya en texto plano.
   *  Casi todas las órdenes traen la segunda y no la primera: hay que mirar las dos. */
  problema: string | null; observacion: string | null;
  seq: number | null; agendadaPor: string | null;
  /** Puesto real en la jornada del técnico (cuenta lo atrasado). `seq` numera por día. */
  puesto: number | null;
  /** Día para el que se agendó (ISO) y si viene arrastrada de uno anterior. */
  agendadaPara: string | null; atrasada: boolean;
  /** El técnico fue y no la pudo hacer. Vuelve a esta bandeja para reagendarla. */
  noAtendida: { fecha: string; motivo: string | null; por: string | null } | null;
  staffId: string | null; tecnico: string | null;
  cliente: string | null; abonado: number | null; subscriberId: string | null;
  direccion: string | null; telefono: string | null; sede: string | null; barrio: string | null;
  /** Id legacy del barrio. Cruza contra `zonasDelDia` para la pista de zona al repartir. */
  barrioId?: string | null;
};
/** `ordenes` viene filtrada; `total`/`pendientes` son la carga real del día, sin filtro. */
export type Columna = { staffId: string; nombre: string; ordenes: Tarjeta[]; total: number; pendientes: number };
/** Un tipo de orden ofrecible en el filtro, con cuántas hay y de qué clase es. */
export type TipoOrden = { tipo: string; clase: string; total: number };
/**
 * Una sede que se le puede ofrecer a quien mira. La lista la manda el servidor ya
 * acotada a las suyas: pedir otra por la API es un 403, así que el desplegable nunca
 * puede ofrecer una puerta que el backend vaya a cerrar.
 */
export type Sede = { id: string; nombre: string };
/**
 * Una orden que la BÚSQUEDA encontró pero que no está en lo que se ve en pantalla:
 * ya tiene día y técnico (`YaAgendada`, en "Repartir") o ya está RESUELTA/ANULADA
 * (`cerradas`, en las dos pestañas — es el mismo campo `estado` el que distingue).
 * `staffId` sólo lo llevan las agendadas, para el botón "ir a su día".
 */
export type YaAgendada = {
  id: string; code: number | null; tipo: string | null; estado: string;
  fecha: string | null; tecnico: string | null; staffId?: string | null;
  cliente: string | null; abonado: number | null;
};

export type Tablero = {
  fecha: string; hoy: string; filtrando: boolean;
  sinAgendar: Tarjeta[]; sinAgendarTotal: number; sinAgendarSinFiltro: number | null;
  /** Lo que el texto encuentra pero ya está repartido. `null` = no se está buscando. */
  yaAgendadas: YaAgendada[] | null;
  yaAgendadasHayMas: boolean;
  /**
   * Lo que el texto encuentra pero ya está RESUELTO o ANULADO. `[]` casi siempre —
   * el servidor sólo la calcula cuando nada más coincidió con nada (último recurso
   * antes de decir "no hay nada"; ver `AgendaService.cerradasQueCoinciden`).
   */
  cerradas: YaAgendada[];
  tipos: TipoOrden[]; columnas: Columna[];
  sedes: Sede[]; sede: string | null;
};

/**
 * Los filtros del agendamiento. Filtran ÓRDENES, nunca técnicos: en "Por técnico"
 * siguen apareciendo todos, incluido aquel al que no le coincide nada, porque una
 * lista de la que desaparece gente se lee como que esa gente no existe.
 *
 * Van al servidor y no se aplican sobre lo ya cargado: la bandeja de "sin agendar"
 * llega recortada a las 200 más urgentes, así que filtrar en el navegador buscaría
 * dentro de esas 200 y una orden abierta que no esté ahí no aparecería nunca.
 */
export type Filtros = {
  q: string;
  /**
   * Los desplegables son de selección MÚLTIPLE: cada uno es una LISTA y lo marcado
   * dentro de él suma ("reclamo o incidente"), mientras que filtros distintos siguen
   * restando entre sí ("…y urgente"). Vacía = ese filtro no está puesto, que no es lo
   * mismo que tenerlo todo marcado. Hacia el servidor viajan en el parámetro de
   * siempre separadas por comas, así que un enlace viejo con un solo valor sigue
   * funcionando igual.
   */
  clase: string[]; tipo: string[]; prioridad: string[]; estado: string[];
  noAtendidas: boolean;
  /**
   * `Branch.id` de las sedes que se están mirando ([] = todas las mías).
   *
   * No es un filtro más y por eso el servidor lo trata aparte: los demás esconden
   * ÓRDENES y dejan a todos los técnicos en pantalla; la sede estrecha el ALCANCE y
   * se lleva por delante a los técnicos de las otras. Quien pide "Yopal" está
   * pidiendo la agenda de Yopal, no un subrayado dentro de la de la empresa — y
   * quien marca Yopal y Villanueva pide las dos agendas, no las cinco.
   */
  sede: string[];
};
export const SIN_FILTROS: Filtros = { q: "", clase: [], tipo: [], prioridad: [], estado: [], noAtendidas: false, sede: [] };
export const hayFiltros = (f: Filtros) =>
  f.q.trim() !== "" || f.clase.length > 0 || f.tipo.length > 0 || f.prioridad.length > 0
  || f.estado.length > 0 || f.noAtendidas || f.sede.length > 0;

export const CLASES = [
  { valor: "servicio", etiqueta: "Servicio" },
  { valor: "reclamo", etiqueta: "Reclamo" },
  { valor: "incidente", etiqueta: "Incidente" },
];

/**
 * La query de las dos pestañas: los filtros, más lo que cada una necesite para decir
 * qué tramo mira (`fecha`, o `desde`/`hasta`/`dias`).
 */
export function queryAgenda(f: Filtros, extra?: Record<string, string | number | null | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(extra ?? {})) if (v != null && v !== "") qs.set(k, String(v));
  if (f.q.trim()) qs.set("q", f.q.trim());
  // Las listas viajan en el parámetro de siempre, separadas por comas. Vacías no se
  // mandan: un `clase=` suelto sería un filtro puesto que no filtra nada.
  for (const [k, v] of [["clase", f.clase], ["tipo", f.tipo], ["prioridad", f.prioridad], ["estado", f.estado], ["sede", f.sede]] as const) {
    if (v.length) qs.set(k, v.join(","));
  }
  if (f.noAtendidas) qs.set("noAtendidas", "1");
  return qs.toString();
}

/**
 * El botón "Excel" de las dos pestañas.
 *
 * Descarga lo que hay EN PANTALLA: el mismo tramo (un día, o la semana) y los
 * mismos filtros. Vive aquí y no en cada vista porque el archivo tiene que ser el
 * mismo mire por donde mire quien lo pide — un Excel que cambia de columnas según la
 * pestaña desde la que se bajó se lee como otro informe.
 *
 * Lo que trae es la ficha del cliente entera (nombre, abonado, cédula, sus dos
 * teléfonos, dirección con la referencia detrás, barrio y sede): este archivo se
 * imprime y se sale con él a la calle.
 */
export function BotonExcel({ filtros, desde, hasta }: { filtros: Filtros; desde: string; hasta?: string }) {
  const { authFetch } = useAuth();
  const [bajando, setBajando] = useState(false);
  const unDia = !hasta || hasta === desde;
  const descargar = async () => {
    setBajando(true);
    try {
      const res = await authFetch(`/support/agenda/export.xlsx?${queryAgenda(filtros, { desde, hasta })}`);
      if (!res.ok) throw new Error("No se pudo exportar");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = unDia ? `agenda-${desde}.xlsx` : `agenda-${desde}_a_${hasta}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setBajando(false);
    }
  };
  return (
    <button
      type="button"
      onClick={descargar}
      disabled={bajando}
      title={unDia ? "Exportar la agenda del día a Excel (con cédula, teléfonos y dirección del cliente)" : "Exportar a Excel lo agendado en este tramo (con cédula, teléfonos y dirección del cliente)"}
      className="tap inline-flex items-center gap-1.5 rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2 disabled:opacity-50"
    >
      <Icon name={bajando ? "loader" : "download"} size={14} className={bajando ? "animate-spin" : ""} />
      {bajando ? "Descargando…" : "Descargar Excel"}
    </button>
  );
}

/**
 * ¿Coincide esta tarjeta con lo que se está tecleando?
 *
 * Es la MISMA pregunta que responde el servidor en `filtroDeOrdenes`, resuelta otra
 * vez aquí, y la duplicación es a propósito: en "Por técnico" el texto no recorta la
 * jornada —la ATENÚA—, así que hace falta saber quién coincide sobre lo que ya está
 * en pantalla. Recortar allí dejaría días vacíos que no lo están, y un día vacío se
 * lee como jornada libre.
 *
 * Cubre lo que se dicta y lo que se lee: el número, el cliente, el barrio, la
 * dirección, el teléfono y el trabajo. Varias palabras acotan — sale lo que las
 * lleva todas—, igual que en el servidor.
 */
export function coincideTexto(t: Tarjeta, q: string): boolean {
  const texto = q.trim().toLowerCase();
  if (!texto) return true;
  const heno = [
    t.code == null ? "" : String(t.code),
    t.type, t.subject, t.cliente ?? "", t.abonado == null ? "" : String(t.abonado),
    t.barrio ?? "", t.direccion ?? "", t.telefono ?? "", t.problema ?? "", t.observacion ?? "",
  ].join(" ").toLowerCase();
  return texto.split(/\s+/).every((palabra) => heno.includes(palabra));
}

/** Días que lleva abierta una orden. En la cola es la mitad de la decisión. */
export function diasEsperando(creada: string, hoy: string): number {
  const a = Date.parse(`${creada.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${hoy}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Dónde queda una orden al soltarla: se manda la tarjeta VECINA, no un número.
 *
 * El número no sirve: la columna de hoy mezcla las visitas de hoy con las atrasadas
 * de días anteriores, y cada día trae su propia numeración —dos tarjetas distintas
 * pueden ser las dos la "1"—. Una tarjeta identifica el sitio sin ambigüedad, y el
 * servidor lo traduce contra la columna completa, así que también sale bien con un
 * filtro puesto (donde en pantalla faltan visitas por el medio).
 */
export type Vecina = { antesDe?: string; despuesDe?: string };

export const TONO_BADGE: Record<string, string> = {
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  default: "bg-surface-2 text-text-secondary",
};

/** Suma días a un 'YYYY-MM-DD' sin pasar por la zona horaria del navegador. */
export function sumarDias(ymd: string, dias: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + dias));
  return t.toISOString().slice(0, 10);
}
export const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });


/** Nombre corto de un día: "mié 27 ago". El de los rótulos y los avisos. */
export const diaCorto = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short" });

/** El lunes de la semana en la que cae `ymd`. La semana laboral empieza ahí. */
export function lunesDe(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return sumarDias(ymd, -((t.getUTCDay() + 6) % 7));
}

/**
 * El alto de TODOS los mandos de la barra, en un sitio.
 *
 * Los desplegables se dibujan con su propio relleno (`py-2`, 37,5 px) mientras el
 * buscador y los botones se quedan en 36: la fila se veía escalonada aunque los tres
 * pidieran lo mismo. Se fija en 36 px —una medida de la escala, no el sobrante de un
 * relleno— y el `!py-0` es lo que hace que el alto mande sobre ese relleno propio.
 *
 * Quien añada un filtro aquí: usa esta constante y no escribas el alto a mano, o la
 * fila vuelve a escalonarse.
 */
const ALTO_FILTRO = "h-9 !py-0";

/**
 * La barra de filtros, común a las dos pestañas.
 *
 * Filtra ÓRDENES y nunca técnicos ni días: en "Por técnico" siguen saliendo todos,
 * incluido aquel al que no le coincide nada, porque quien desaparece de la lista se
 * lee como quien no tiene trabajo. Los filtros viajan al servidor: la lista de sin
 * agendar llega recortada a las 200 más urgentes y filtrar en el navegador buscaría
 * solo dentro de esas 200.
 */
export function BarraFiltros({
  filtros, setFiltros, tipos, sedes,
}: {
  filtros: Filtros;
  setFiltros: Dispatch<SetStateAction<Filtros>>;
  tipos: TipoOrden[];
  /** Las sedes que se le pueden ofrecer. Con una sola, el desplegable no se pinta. */
  sedes: Sede[];
}) {
  const puso = <K extends keyof Filtros>(k: K, v: Filtros[K]) => setFiltros((f) => ({ ...f, [k]: v }));
  const filtrando = hayFiltros(filtros);
  // Con clases elegidas solo se ofrecen SUS tipos: mezclar 'Instalacion' con
  // 'Revision de Internet' cuando ya se pidió "reclamo" es ofrecer nada.
  const ofrecidos = filtros.clase.length ? tipos.filter((t) => filtros.clase.includes(t.clase)) : tipos;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* En móvil el buscador se lleva el renglón entero (`basis-full`): compartiéndolo
          con el desplegable de sede se quedaba en 68 px y no se leía ni lo que uno
          acababa de teclear. Desde sm vuelve a repartirse el ancho con el resto. */}
      <div className="relative min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto">
        <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <Input
          value={filtros.q}
          onChange={(e) => puso("q", e.target.value)}
          placeholder="N° de orden, abonado, cliente, barrio, dirección, teléfono…"
          aria-label="Buscar órdenes en la agenda"
          className="h-9 !py-0 pl-8 text-[13px]"
        />
        {filtros.q && (
          <button type="button" onClick={() => puso("q", "")} aria-label="Borrar la búsqueda"
            className="tap absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary">
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      {/* La SEDE va la primera: es la que decide de quién es la agenda que se mira,
          y los demás filtros se leen dentro de ella.

          Solo se pinta con más de una para elegir. A la cajera de una sola sede no se
          le enseña una elección que no tiene (decisión del 2026-08-03), y con esto
          sale de los datos y no de un permiso: quien tenga dos sedes marcadas verá
          el desplegable, que es justo lo que necesita. */}
      {sedes.length > 1 && (
        <MultiSelect
          label="Sedes" todos="Todas mis sedes" className={ALTO_FILTRO}
          value={filtros.sede} onChange={(v) => puso("sede", v)}
          options={sedes.map((b) => ({ value: b.id, label: b.nombre }))}
        />
      )}
      {/* Elegir clase acota los tipos, y por eso limpia los tipos que ya no pertenecen
          a ninguna de las clases marcadas: dejarlos puestos daría una agenda vacía con
          dos filtros que se contradicen sin decirlo. */}
      <MultiSelect
        label="Clase" todos="Toda clase" className={ALTO_FILTRO}
        value={filtros.clase}
        onChange={(clases) =>
          setFiltros((f) => ({
            ...f,
            clase: clases,
            tipo: clases.length
              ? f.tipo.filter((tipo) => tipos.some((t) => t.tipo === tipo && clases.includes(t.clase)))
              : f.tipo,
          }))
        }
        options={CLASES.map((c) => ({ value: c.valor, label: c.etiqueta }))}
      />
      {/* Los tipos salen de las órdenes que hay, ordenados por cuántas son: lo que
          más se repite —y lo que más se reparte— queda arriba. El número al lado
          evita el clic a ciegas en un tipo que solo tiene una. */}
      <MultiSelect
        label="Tipos" todos="Todo tipo" className={ALTO_FILTRO} width={300}
        value={filtros.tipo} onChange={(v) => puso("tipo", v)}
        options={[
          ...ofrecidos.map((t) => ({ value: t.tipo, label: `${t.tipo} (${t.total})` })),
          // Un tipo puesto que ya no está en la lista (cambió el tramo) se ofrece
          // igual: si no, quedaría marcado sin poder desmarcarlo desde aquí.
          ...filtros.tipo
            .filter((tipo) => !ofrecidos.some((t) => t.tipo === tipo))
            .map((tipo) => ({ value: tipo, label: tipo })),
        ]}
      />
      <MultiSelect
        label="Estado" todos="Todos los estados" className={ALTO_FILTRO}
        value={filtros.estado} onChange={(v) => puso("estado", v)}
        options={[
          { value: "PENDIENTE", label: "Pendientes" },
          { value: "REALIZANDO", label: "En curso" },
          { value: "cerradas", label: "Cerradas" },
        ]}
      />
      <MultiSelect
        label="Prioridad" todos="Toda prioridad" className={ALTO_FILTRO}
        value={filtros.prioridad} onChange={(v) => puso("prioridad", v)}
        options={TICKET_PRIORITIES.map((p) => ({ value: p, label: p }))}
      />
      {/* Las que un técnico fue a hacer y no pudo son la cola que se reagenda
          primero: merecen un botón y no ir escondidas dentro de un desplegable. */}
      <button
        type="button"
        onClick={() => puso("noAtendidas", !filtros.noAtendidas)}
        aria-pressed={filtros.noAtendidas}
        className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-semibold transition-colors ${
          filtros.noAtendidas ? "border-warning-border bg-warning-soft text-warning-text" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
        }`}
      >
        <Icon name="alert-triangle" size={13} /> No atendidas
      </button>
      {filtrando && (
        <button type="button" onClick={() => setFiltros(SIN_FILTROS)} className="text-[13px] font-semibold text-brand hover:underline">
          Limpiar filtros
        </button>
      )}
    </div>
  );
}
