/**
 * Mini-gráfico de línea (sparkline) en SVG, sin dependencias.
 * Dibuja la tendencia de una serie de valores con relleno suave.
 */
export function Sparkline({
  values,
  width = 320,
  height = 64,
  className = "text-brand",
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (!values || values.length < 2) {
    return (
      <div className="flex h-16 items-center justify-center text-[11px] text-text-tertiary">
        Sin suficientes datos para la tendencia.
      </div>
    );
  }

  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1);
  const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
  const pts = values.map((v, i) => `${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M ${pts.join(" L ")}`;
  const area = `${line} L ${(pad + (values.length - 1) * stepX).toFixed(1)},${height - pad} L ${pad},${height - pad} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={`w-full ${className}`} preserveAspectRatio="none">
      <path d={area} fill="currentColor" opacity={0.1} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
