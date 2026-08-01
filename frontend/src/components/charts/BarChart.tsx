"use client";

import { niceMax, colorAt, compact, padEjeY } from "./helpers";
import { ChartEmpty } from "./ChartCard";
import { useChartWidth } from "./useChartWidth";

export type BarDatum = { label: string; value: number; color?: string };

/**
 * Gráfica de barras verticales con rejilla y valor al pasar el mouse (una sola
 * serie). SVG puro dibujado a escala 1:1 sobre el ancho real del contenedor
 * (ver `useChartWidth`), para que las cifras no crezcan con la pantalla.
 */
export function BarChart({
  data,
  height = 230,
  yFormat = compact,
  maxTicks = 4,
  accent = "var(--color-brand)",
}: {
  data: BarDatum[];
  height?: number;
  yFormat?: (n: number) => string;
  maxTicks?: number;
  accent?: string;
}) {
  const { ref, width } = useChartWidth();
  const W = width;
  // Igual que en AreaLineChart: el alto pedido es el piso y crece un poco en
  // pantallas anchas para que las barras no queden achatadas.
  const H = Math.round(Math.min(Math.max(height, W / 4.5), height * 1.5));

  if (!data.length || data.every((d) => d.value === 0)) return <ChartEmpty />;

  const max = niceMax(Math.max(...data.map((d) => d.value), 0)) || 1;
  const ticks = Array.from({ length: maxTicks + 1 }, (_, i) => (max / maxTicks) * i);

  // Igual que en AreaLineChart: el margen izquierdo lo dicta la etiqueta más larga
  // del eje. Fijo en 46 cortaba las cifras largas contra el borde.
  const padL = padEjeY(ticks.map(yFormat));
  const padR = 14;
  const padT = 12;
  const padB = 26;
  const innerW = Math.max(W - padL - padR, 1);
  const innerH = H - padT - padB;

  // Primer render (aún sin medir): reservamos el alto para que nada salte.
  if (!W) return <div ref={ref} style={{ height: H }} />;

  const n = data.length;
  const slot = innerW / n;
  const bw = Math.min(slot * 0.62, 46);
  const yAt = (v: number) => padT + innerH - (v / max) * innerH;
  // Solo tantas etiquetas como quepan sin pisarse (~54px cada una).
  const labelStep = Math.ceil(n / Math.max(2, Math.floor(innerW / 54)));

  return (
    <div ref={ref} style={{ height: H }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img">
        {ticks.map((t, i) => {
          const y = yAt(t);
          return (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} className="stroke-border-subtle" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <text x={padL - 8} y={y + 4} textAnchor="end" className="fill-text-tertiary" fontSize={11}>
                {yFormat(t)}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const x = padL + i * slot + (slot - bw) / 2;
          const y = yAt(d.value);
          const h = padT + innerH - y;
          const color = d.color ?? accent;
          return (
            <g key={i}>
              <rect x={x} y={y} width={bw} height={Math.max(h, 0)} rx={4} fill={color}>
                <title>{`${d.label}: ${yFormat(d.value)}`}</title>
              </rect>
              {i % labelStep === 0 && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="fill-text-tertiary" fontSize={11}>
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export { colorAt };
