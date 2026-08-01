"use client";

import { smoothPath, niceMax, colorAt, compact, padEjeY, type Point } from "./helpers";
import { ChartEmpty } from "./ChartCard";
import { useChartWidth } from "./useChartWidth";

export type LineSeries = { name: string; color?: string; points: number[] };

/**
 * Gráfica de área/línea multi-serie. SVG puro, dibujado a escala 1:1 sobre el
 * ancho real del contenedor (ver `useChartWidth`): así el alto es el que se pide
 * y las cifras de los ejes miden lo que dicen medir en cualquier pantalla.
 */
export function AreaLineChart({
  series,
  labels,
  height = 230,
  area = true,
  yFormat = compact,
  maxTicks = 4,
  smooth = true,
}: {
  series: LineSeries[];
  labels: string[];
  height?: number;
  area?: boolean;
  yFormat?: (n: number) => string;
  maxTicks?: number;
  /**
   * Curva suave (por defecto) o quebrada. Ponlo en `false` cuando los puntos sean
   * días sueltos con ceros de por medio: la curva se pasa de largo al entrar y salir
   * del cero y dibuja valles que no existen — un domingo sin caja parece un número
   * negativo.
   */
  smooth?: boolean;
}) {
  const { ref, width } = useChartWidth();
  const W = width;
  // `height` es el piso, no una camisa de fuerza: en un monitor ancho un lienzo
  // de 210px de alto sale como una raya. Crece hasta un 50% más, nunca al doble.
  const H = Math.round(Math.min(Math.max(height, W / 4.5), height * 1.5));

  const allValues = series.flatMap((s) => s.points);
  const hasData = allValues.length > 0 && labels.length > 0;
  if (!hasData) return <ChartEmpty />;

  const rawMax = Math.max(...allValues, 0);
  const max = niceMax(rawMax) || 1;
  const ticks = Array.from({ length: maxTicks + 1 }, (_, i) => (max / maxTicks) * i);

  // El margen izquierdo lo dicta la etiqueta más larga del eje, no un número fijo:
  // con 46px clavados, un "$20.0M" se salía del lienzo y perdía el signo de peso.
  const padL = padEjeY(ticks.map(yFormat));
  const padR = 14;
  const padT = 12;
  const padB = 24;
  const innerW = Math.max(W - padL - padR, 1);
  const innerH = H - padT - padB;

  // Primer render (aún sin medir): reservamos el alto para que nada salte.
  if (!W) return <div ref={ref} style={{ height: H }} />;

  const n = labels.length;
  const xAt = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v: number) => padT + innerH - (v / max) * innerH;

  // Cuántas etiquetas caben de verdad: ~54px cada una sin chocar. En el móvil
  // salen 3 o 4; en un monitor ancho salen todas.
  const caben = Math.max(2, Math.floor(innerW / 54));
  const labelStep = Math.ceil(n / caben);

  return (
    <div ref={ref} style={{ height: H }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img">
        {/* gridlines + y labels */}
        {ticks.map((t, i) => {
          const y = yAt(t);
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                className="stroke-border-subtle"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text x={padL - 8} y={y + 4} textAnchor="end" className="fill-text-tertiary" fontSize={11}>
                {yFormat(t)}
              </text>
            </g>
          );
        })}

        {/* x labels */}
        {labels.map((lb, i) =>
          i % labelStep === 0 ? (
            <text key={i} x={xAt(i)} y={H - 7} textAnchor="middle" className="fill-text-tertiary" fontSize={11}>
              {lb}
            </text>
          ) : null,
        )}

        {series.map((s, si) => {
          const color = s.color ?? colorAt(si);
          const pts = s.points.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
          const line = smooth
            ? smoothPath(pts)
            : pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`).join(" ");
          const gid = `area-grad-${si}`;
          return (
            <g key={si}>
              {area && si === 0 && pts.length > 1 && (
                <>
                  <defs>
                    <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <path d={`${line} L ${pts[pts.length - 1].x},${padT + innerH} L ${pts[0].x},${padT + innerH} Z`} fill={`url(#${gid})`} />
                </>
              )}
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={2.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* end dot */}
              {pts.length > 0 && (
                <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={3.2} fill={color} />
              )}
              {/* native hover tooltips per point */}
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={9} fill="transparent">
                  <title>{`${s.name ? s.name + " · " : ""}${labels[i]}: ${yFormat(s.points[i])}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export type { Point };
