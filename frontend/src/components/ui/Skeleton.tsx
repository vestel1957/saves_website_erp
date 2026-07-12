import type { CSSProperties } from "react";

/**
 * Bloque de carga reutilizable (placeholder con pulso). Úsalo para componer
 * skeletons en lugar de pintar `animate-pulse` a mano por toda la app.
 *
 * Respeta los tokens del sistema de diseño y funciona en claro/oscuro.
 */
export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-md bg-surface-2 ${className}`}
      style={style}
    />
  );
}

/** Varias líneas de texto simuladas; la última sale más corta para dar realismo. */
export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-3.5"
          style={{ width: i === lines - 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}

/** Tarjeta genérica (KPI / panel) con borde, para rejillas de carga. */
export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4 ${className}`}
    >
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-7 w-3/4" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}
