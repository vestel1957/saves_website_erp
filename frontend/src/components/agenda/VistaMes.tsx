"use client";

import {
  DIAS_CORTOS, colorDe, cruzaElDia, diaISO, esFinDeSemana, finDe, horaCorta, inicioDe,
  inicioDeDia, mismoDia, repartirEnCarriles, sumarDias, tintaSobre, vaEnLaBanda,
  type Evento,
} from "./calendario";

/** Alto de una casilla. Seis semanas a este alto caben en pantalla sin desplazar. */
const ALTO_CASILLA = 118;
const ALTO_CABECERA_CASILLA = 24; // el número del día
const ALTO_TIRA = 19; // una barra de varios días

/**
 * Cuántas barras de varios días se dibujan por semana antes de plegar el resto.
 *
 * Hace falta un tope y no es teoría: en la ventana de diciembre de 2025 hay 1.774
 * eventos que vienen de antes y siguen dentro, y todos son barra. Sin límite, esa
 * fila de semana mide 1.774 × 19 px = 34 metros de pantalla y las casillas del mes
 * quedan empujadas fuera de la vista. Las que no caben no se pierden: se suman al
 * "+N más" de cada día que cruzan, que es donde ya se va a buscar lo que no cabe.
 */
const MAX_TIRAS = 3;

/**
 * Vista de MES: seis semanas completas, de lunes a domingo.
 *
 * Dos capas por semana, y son dos porque son dos clases de evento:
 *
 *  · Las TIRAS de arriba — todo el día, o cualquier cosa que cruce la medianoche —
 *    van por encima de las casillas y ocupan sus días de punta a punta. Una
 *    instalación del martes al viernes es UNA barra; partida en cuatro citas sueltas
 *    se lee como cuatro trabajos distintos.
 *  · Los CHIPS de cada casilla — lo que tiene hora — van dentro de su día y en orden
 *    de reloj, que es como se lee «qué hay el jueves».
 *
 * Las casillas reservan arriba el hueco de las tiras de SU semana (ni una fija que
 * sobra en las semanas tranquilas, ni una que se queda corta cuando hay tres).
 */
export function VistaMes({
  dias,
  mes,
  eventos,
  onNuevo,
  onAbrir,
  onVerDia,
}: {
  dias: Date[];
  /** El mes que se está mirando: los días de fuera se atenúan pero se siguen viendo. */
  mes: Date;
  eventos: Evento[];
  onNuevo: (fecha: Date) => void;
  onAbrir: (evento: Evento) => void;
  onVerDia: (fecha: Date) => void;
}) {
  const semanas = Array.from({ length: dias.length / 7 }, (_, i) => dias.slice(i * 7, i * 7 + 7));
  const hoy = new Date();

  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface">
      <div className="grid grid-cols-7 border-b border-border-subtle bg-surface-2">
        {DIAS_CORTOS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-wide text-text-tertiary">
            {d}
          </div>
        ))}
      </div>

      {semanas.map((semana, i) => {
        const arranque = semana[0];
        const finSemana = sumarDias(arranque, 7);

        // Las tiras de ESTA semana, recortadas a sus siete días: una barra que viene
        // del mes pasado empieza en el lunes, no fuera de la pantalla.
        const tiras = eventos
          .filter((e) => vaEnLaBanda(e) && semana.some((d) => cruzaElDia(e, d)))
          .map((e) => {
            const desde = Math.max(inicioDeDia(inicioDe(e)).getTime(), arranque.getTime());
            const hasta = Math.min(finDe(e).getTime(), finSemana.getTime());
            const col = semana.findIndex((d) => mismoDia(d, new Date(desde)));
            const ultima = semana.findIndex((d) => mismoDia(d, new Date(hasta - 1)));
            return {
              evento: e,
              col: col < 0 ? 0 : col,
              ancho: Math.max(1, (ultima < 0 ? 6 : ultima) - (col < 0 ? 0 : col) + 1),
              // Para saber si dibujar la punta redondeada o el corte de «sigue».
              empiezaAntes: inicioDe(e).getTime() < arranque.getTime(),
              acabaDespues: finDe(e).getTime() > finSemana.getTime(),
            };
          });

        const carriles = repartirEnCarriles(tiras, (t) => ({ col: t.col, ancho: t.ancho }));
        const dibujadas = carriles.filter((c) => c.carril < MAX_TIRAS);
        const plegadas = carriles.filter((c) => c.carril >= MAX_TIRAS);
        /** Barras que no cupieron y cruzan esta columna: se cuentan en su "+N más". */
        const plegadasEn = (col: number) =>
          plegadas.filter(({ item }) => item.col <= col && col < item.col + item.ancho).length;
        const nCarriles = dibujadas.length ? Math.max(...dibujadas.map((c) => c.carril)) + 1 : 0;
        const reservado = ALTO_CABECERA_CASILLA + nCarriles * ALTO_TIRA;
        // Cuántos chips con hora caben debajo de las tiras sin desbordar la casilla.
        const caben = Math.max(1, Math.floor((ALTO_CASILLA - reservado - 4) / 19));

        return (
          <div
            key={diaISO(arranque)}
            className={`relative grid grid-cols-7 ${i < semanas.length - 1 ? "border-b border-border-subtle" : ""}`}
          >
            {semana.map((dia, col) => {
              const conHora = eventos
                .filter((e) => !vaEnLaBanda(e) && cruzaElDia(e, dia))
                .sort((a, b) => inicioDe(a).getTime() - inicioDe(b).getTime());
              const enBandaPlegadas = plegadasEn(col);
              // Si algo va a quedar fuera, el "+N más" ocupa una línea: hay que
              // descontarla de los chips o el contador desborda la casilla.
              const seCorta = conHora.length > caben || enBandaPlegadas > 0;
              const visibles = seCorta ? conHora.slice(0, Math.max(0, caben - 1)) : conHora;
              const ocultos = conHora.length - visibles.length + enBandaPlegadas;
              const delMes = dia.getMonth() === mes.getMonth();

              return (
                <button
                  type="button"
                  key={diaISO(dia)}
                  /* Toda la casilla crea: es el gesto de Google y de Apple, y ahorra ir
                     a buscar el botón de arriba para agendar el jueves. La hora que se
                     propone son las 9:00 — no la hora actual, que agendaría a las 15:47.
                     En el TELÉFONO (< sm) la casilla mide ~50 px y los chips, el "+N más"
                     y las tiras la tapan casi entera: el dedo caía en ellos y abría un
                     evento o saltaba al día en vez de agendar. Ahí se vuelven
                     transparentes al toque (`max-sm:pointer-events-none`) y tocar el
                     día SIEMPRE abre el modal; los eventos se abren en Día o Lista. */
                  onClick={() => onNuevo(new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 9, 0))}
                  title="Agendar en este día"
                  style={{ minHeight: ALTO_CASILLA, paddingTop: reservado }}
                  className={`foco group flex flex-col items-stretch gap-[2px] border-r border-border-subtle px-1 pb-1 text-left last:border-r-0 ${
                    delMes ? (esFinDeSemana(dia) ? "bg-surface-2/40" : "bg-surface") : "bg-surface-2/70"
                  } hover:bg-brand-soft/40`}
                >
                  {visibles.map((e) => (
                    <ChipDeEvento key={e.id} evento={e} onAbrir={onAbrir} />
                  ))}
                  {ocultos > 0 && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(ev) => { ev.stopPropagation(); onVerDia(dia); }}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.stopPropagation(); ev.preventDefault(); onVerDia(dia); } }}
                      className="foco cursor-pointer rounded px-1 text-[11px] font-semibold text-text-tertiary hover:text-brand hover:underline max-sm:pointer-events-none"
                    >
                      +{ocultos} más
                    </span>
                  )}
                </button>
              );
            })}

            {/* El número del día va por encima de las casillas para que el hueco que
                reservan arriba lo puedan ocupar las tiras sin empujarlo. */}
            {semana.map((dia, col) => {
              const esHoy = mismoDia(dia, hoy);
              const delMes = dia.getMonth() === mes.getMonth();
              return (
                <span
                  key={`n-${diaISO(dia)}`}
                  aria-hidden
                  style={{ left: `calc(${(col / 7) * 100}% + 4px)` }}
                  className="pointer-events-none absolute top-[3px]"
                >
                  <span
                    className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11.5px] font-bold tabular-nums ${
                      esHoy
                        ? "bg-brand text-on-brand"
                        : delMes
                          ? "text-text-secondary"
                          : "text-text-tertiary/70"
                    }`}
                  >
                    {dia.getDate()}
                  </span>
                </span>
              );
            })}

            {dibujadas.map(({ item, carril }) => (
              <button
                type="button"
                key={`${item.evento.id}-${carril}`}
                onClick={(ev) => { ev.stopPropagation(); onAbrir(item.evento); }}
                title={item.evento.title ?? "(sin título)"}
                style={{
                  top: ALTO_CABECERA_CASILLA + carril * ALTO_TIRA,
                  left: `calc(${(item.col / 7) * 100}% + 3px)`,
                  width: `calc(${(item.ancho / 7) * 100}% - 6px)`,
                  backgroundColor: colorDe(item.evento),
                  color: tintaSobre(item.evento.color),
                  // La punta cortada dice «esto viene de antes / sigue después»; la
                  // redondeada, «empieza aquí / acaba aquí». Es la única señal que
                  // distingue una barra que cabe entera de una que se continúa.
                  borderTopLeftRadius: item.empiezaAntes ? 0 : 4,
                  borderBottomLeftRadius: item.empiezaAntes ? 0 : 4,
                  borderTopRightRadius: item.acabaDespues ? 0 : 4,
                  borderBottomRightRadius: item.acabaDespues ? 0 : 4,
                }}
                className="foco absolute z-10 h-[16px] truncate px-1.5 text-left text-[11px] font-semibold leading-[16px] opacity-95 hover:opacity-100 max-sm:pointer-events-none"
              >
                {item.empiezaAntes && "◂ "}
                {item.evento.title || "(sin título)"}
                {item.acabaDespues && " ▸"}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Un evento con hora dentro de la casilla del mes.
 *
 * Punto de color + hora + título, en vez del rectángulo relleno de las tiras: en una
 * casilla de 118 px caben cuatro, y cuatro rectángulos de color a todo ancho
 * convierten el mes en un mosaico donde ya no se distingue el fin de semana.
 */
function ChipDeEvento({ evento, onAbrir }: { evento: Evento; onAbrir: (e: Evento) => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(ev) => { ev.stopPropagation(); onAbrir(evento); }}
      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.stopPropagation(); ev.preventDefault(); onAbrir(evento); } }}
      title={`${horaCorta(inicioDe(evento))} · ${evento.title ?? "(sin título)"}`}
      className="foco flex h-[17px] cursor-pointer items-center gap-1 rounded px-1 text-[11px] leading-none hover:bg-surface-2 max-sm:pointer-events-none"
    >
      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: colorDe(evento) }} />
      <span className="shrink-0 tabular-nums font-semibold text-text-tertiary">{horaCorta(inicioDe(evento))}</span>
      <span className="truncate text-text-secondary">{evento.title || "(sin título)"}</span>
    </span>
  );
}
