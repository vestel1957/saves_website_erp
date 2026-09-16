"use client";

import { useEffect, useRef, useState } from "react";
import {
  colorDe, cruzaElDia, diaISO, esFinDeSemana, finDe, horaCorta, inicioDe, mismoDia,
  repartirEnCarriles, repartirEnColumnas, tintaSobre, tramoDelDia, vaEnLaBanda,
  type Evento,
} from "./calendario";

/** Alto de una hora. A 48 px una cita de 30 minutos sigue admitiendo su título. */
const ALTO_HORA = 48;
const ANCHO_REGLA = 52;
const HORAS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Alto máximo de la banda de todo-el-día, en carriles.
 *
 * Aquí el desbordamiento no se pliega en un "+N" como en el mes: se desplaza. En una
 * semana la banda tiene ancho de sobra para leer la barra entera, así que lo caro es
 * esconderla, no enseñarla — y con cuatro carriles visibles la cuadrícula de horas
 * sigue empezando dentro de la pantalla. Sin tope no es una exageración: la ventana
 * de diciembre de 2025 trae 1.774 eventos que vienen de antes, todos barra.
 */
const MAX_CARRILES_BANDA = 4;

/**
 * Vista de SEMANA y de DÍA. Es el mismo tablero: cambia cuántas columnas recibe.
 *
 * No son dos componentes porque no son dos cosas: un día es una semana de una
 * columna, y tenerlos separados obliga a arreglar dos veces cada detalle del reparto
 * de solapes, de la línea de «ahora» y del clic para agendar.
 *
 * TRES ZONAS, de arriba abajo:
 *   · la cabecera con el día y su número (fija al desplazar),
 *   · la BANDA de todo-el-día / varios días, que no tiene hora y por tanto no tiene
 *     sitio en la cuadrícula,
 *   · la cuadrícula de 24 horas, que es la que se desplaza.
 */
export function VistaTiempo({
  dias,
  eventos,
  onNuevo,
  onAbrir,
}: {
  dias: Date[];
  eventos: Evento[];
  /** Agendar: llega la fecha Y la hora de donde se pulsó, redondeada al cuarto. */
  onNuevo: (fecha: Date) => void;
  onAbrir: (evento: Evento) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [ahora, setAhora] = useState(() => new Date());

  /*
    Al abrir se baja a las 7:00 y no al arranque del día. Las 24 horas no caben en
    pantalla, y las primeras seis están siempre vacías: sin esto la vista abre en la
    madrugada y hay que desplazar cada vez para ver la jornada.
  */
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 7 * ALTO_HORA;
  }, []);

  // La línea de «ahora» se mueve sola. Cada minuto basta: es la resolución con la que
  // se dibuja, y un intervalo más corto sólo gasta renders.
  useEffect(() => {
    const t = setInterval(() => setAhora(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const columnas = `${ANCHO_REGLA}px repeat(${dias.length}, minmax(0, 1fr))`;

  // La banda de arriba: los de todo el día y los que cruzan la medianoche. Se reparte
  // en carriles sobre los días VISIBLES, igual que las tiras del mes.
  const enBanda = eventos.filter((e) => vaEnLaBanda(e) && dias.some((d) => cruzaElDia(e, d)));
  const tiras = enBanda.map((e) => {
    const col = dias.findIndex((d) => cruzaElDia(e, d));
    const ultima = dias.reduce((acc, d, i) => (cruzaElDia(e, d) ? i : acc), col);
    return { evento: e, col, ancho: ultima - col + 1 };
  });
  const carriles = repartirEnCarriles(tiras, (t) => ({ col: t.col, ancho: t.ancho }));
  const nCarriles = carriles.length ? Math.max(...carriles.map((c) => c.carril)) + 1 : 0;
  const bandaDesborda = nCarriles > MAX_CARRILES_BANDA;
  const altoBanda = Math.min(nCarriles, MAX_CARRILES_BANDA) * 20 + 6;

  /** Minuto del día en que se pulsó, redondeado al cuarto de hora hacia abajo. */
  const minutoDelClic = (ev: React.MouseEvent<HTMLDivElement>) => {
    const caja = ev.currentTarget.getBoundingClientRect();
    const minutos = ((ev.clientY - caja.top) / ALTO_HORA) * 60;
    return Math.max(0, Math.min(23 * 60 + 45, Math.floor(minutos / 15) * 15));
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
      {/* Cabecera */}
      <div className="grid border-b border-border-subtle bg-surface-2" style={{ gridTemplateColumns: columnas }}>
        <div className="border-r border-border-subtle" />
        {dias.map((d) => {
          const esHoy = mismoDia(d, ahora);
          return (
            <div
              key={diaISO(d)}
              className={`flex items-baseline justify-center gap-1.5 border-r border-border-subtle px-2 py-1.5 last:border-r-0 ${
                esFinDeSemana(d) ? "bg-canvas/40" : ""
              }`}
            >
              <span className="text-[10px] font-bold uppercase tracking-wide text-text-tertiary">
                {d.toLocaleDateString("es-CO", { weekday: "short" }).replace(".", "")}
              </span>
              <span
                className={`flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-1 text-[12.5px] font-bold tabular-nums ${
                  esHoy ? "bg-brand text-on-brand" : "text-text-primary"
                }`}
              >
                {d.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      {/* Banda de todo el día. Sólo existe si hay algo: una franja vacía fija se come
          40 px de cuadrícula todos los días para no decir nada. */}
      {nCarriles > 0 && (
        <div
          className={`relative grid border-b border-border-subtle bg-surface-2/50 ${bandaDesborda ? "overflow-y-auto" : ""}`}
          style={{ gridTemplateColumns: columnas, height: altoBanda }}
        >
          <div className="sticky top-0 flex items-start justify-end border-r border-border-subtle pr-1.5 pt-1 text-[9.5px] font-bold uppercase tracking-wide text-text-tertiary">
            Día
            {bandaDesborda && <span className="ml-1 font-bold text-brand" title={`${nCarriles} carriles`}>·{nCarriles}</span>}
          </div>
          {dias.map((d) => (
            // Con la banda desplazable, las divisiones de columna tienen que medir lo
            // que mide el CONTENIDO y no la caja: si no, la última barra queda sobre
            // un fondo sin líneas y se pierde de qué día a qué día va.
            <div
              key={`b-${diaISO(d)}`}
              style={bandaDesborda ? { height: nCarriles * 20 + 6 } : undefined}
              className="border-r border-border-subtle last:border-r-0"
            />
          ))}
          {carriles.map(({ item, carril }) => (
            <button
              type="button"
              key={item.evento.id}
              onClick={() => onAbrir(item.evento)}
              title={item.evento.title ?? "(sin título)"}
              style={{
                top: 3 + carril * 20,
                left: `calc(${ANCHO_REGLA}px + (100% - ${ANCHO_REGLA}px) * ${item.col / dias.length} + 3px)`,
                width: `calc((100% - ${ANCHO_REGLA}px) * ${item.ancho / dias.length} - 6px)`,
                backgroundColor: colorDe(item.evento),
                color: tintaSobre(item.evento.color),
              }}
              className="foco absolute h-[17px] truncate rounded px-1.5 text-left text-[11px] font-semibold leading-[17px]"
            >
              {item.evento.title || "(sin título)"}
            </button>
          ))}
        </div>
      )}

      {/* Cuadrícula */}
      <div ref={scroll} className="max-h-[58vh] overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: columnas, height: 24 * ALTO_HORA }}>
          {/* Regla de horas */}
          <div className="relative border-r border-border-subtle">
            {HORAS.slice(1).map((h) => (
              <span
                key={h}
                style={{ top: h * ALTO_HORA - 6 }}
                className="absolute right-1.5 text-[10.5px] font-semibold tabular-nums text-text-tertiary"
              >
                {h.toString().padStart(2, "0")}:00
              </span>
            ))}
          </div>

          {dias.map((dia) => {
            const conHora = eventos.filter((e) => !vaEnLaBanda(e) && cruzaElDia(e, dia));
            const repartidos = repartirEnColumnas(conHora, (e) => tramoDelDia(e, dia));
            return (
              <div
                key={`c-${diaISO(dia)}`}
                onClick={(ev) => {
                  const min = minutoDelClic(ev);
                  onNuevo(new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), Math.floor(min / 60), min % 60));
                }}
                title="Agendar a esta hora"
                className={`relative border-r border-border-subtle last:border-r-0 ${esFinDeSemana(dia) ? "bg-surface-2/40" : ""}`}
              >
                {/* Las líneas de hora se dibujan por columna y no como una capa que
                    cruza toda la rejilla: una capa por encima se traga los clics. */}
                {HORAS.slice(1).map((h) => (
                  <span key={h} style={{ top: h * ALTO_HORA }} className="pointer-events-none absolute inset-x-0 border-t border-border-subtle/70" />
                ))}

                {repartidos.map(({ item, columna, columnas: n }) => {
                  const { desde, hasta } = tramoDelDia(item, dia);
                  const cabeElTitulo = hasta - desde >= 45;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      onClick={(ev) => { ev.stopPropagation(); onAbrir(item); }}
                      title={`${horaCorta(inicioDe(item))} – ${horaCorta(finDe(item))} · ${item.title ?? "(sin título)"}`}
                      style={{
                        top: (desde / 60) * ALTO_HORA,
                        height: ((hasta - desde) / 60) * ALTO_HORA - 2,
                        left: `calc(${(columna / n) * 100}% + 2px)`,
                        width: `calc(${(1 / n) * 100}% - 4px)`,
                        backgroundColor: colorDe(item),
                        color: tintaSobre(item.color),
                      }}
                      className="foco absolute overflow-hidden rounded-md px-1.5 py-[2px] text-left leading-tight shadow-sm"
                    >
                      <span className={`block truncate text-[11.5px] font-semibold ${cabeElTitulo ? "" : "leading-[13px]"}`}>
                        {item.title || "(sin título)"}
                      </span>
                      {cabeElTitulo && (
                        <span className="block truncate text-[10.5px] tabular-nums opacity-90">
                          {horaCorta(inicioDe(item))} – {horaCorta(finDe(item))}
                        </span>
                      )}
                    </button>
                  );
                })}

                {mismoDia(dia, ahora) && (
                  <span
                    aria-hidden
                    style={{ top: ((ahora.getHours() * 60 + ahora.getMinutes()) / 60) * ALTO_HORA }}
                    className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-error"
                  >
                    <span className="absolute -left-[3px] -top-[5px] h-[8px] w-[8px] rounded-full bg-error" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
