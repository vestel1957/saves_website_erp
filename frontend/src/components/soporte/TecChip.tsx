"use client";

/**
 * Chip de técnico: inicial en círculo + nombre. Da identidad visual a la columna.
 *
 * Vive aparte porque lo usan las DOS pantallas de soporte: la general (donde la
 * columna distingue de quién es cada orden) y la del técnico (donde repite su nombre
 * en cada fila a propósito, como constancia de que la lista es suya).
 */
export function TecChip({ name }: { name: string | null }) {
  if (!name || !name.trim()) return <span className="text-[12px] text-text-tertiary">Sin asignar</span>;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  // Color estable derivado del nombre (matiz determinístico).
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: `hsl(${h} 55% 45%)` }}>{initials}</span>
      <span className="truncate text-[12px] font-medium text-text-primary">{name}</span>
    </span>
  );
}
