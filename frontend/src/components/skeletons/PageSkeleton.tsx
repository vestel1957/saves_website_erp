import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

/**
 * Skeleton del área de contenido de una sección (encabezado + KPIs + tabla).
 * Pensado para los `loading.tsx` de las rutas que ya viven dentro de un layout
 * con Sidebar + TopNav, así que solo cubre lo que va dentro de `<main>`.
 */
export function PageSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-5">
      {/* encabezado */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3.5 w-64" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      {/* fila de KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>

      {/* tabla / panel principal */}
      <div className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4">
        <Skeleton className="h-4 w-40" />
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <Skeleton className="h-3.5 flex-1" style={{ opacity: 1 - i * 0.07 }} />
              <Skeleton className="hidden h-3.5 w-24 sm:block" />
              <Skeleton className="hidden h-3.5 w-16 md:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
