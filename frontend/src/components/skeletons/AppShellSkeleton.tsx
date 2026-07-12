import { Skeleton } from "@/components/ui/Skeleton";
import { PageSkeleton } from "./PageSkeleton";

/**
 * Skeleton del shell completo: rail de Sidebar + barra de TopNav + contenido.
 * Se usa en rutas que pintan su propio Sidebar/TopNav (p. ej. el dashboard raíz),
 * donde el layout padre no aporta el chrome de navegación.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* Sidebar (oculto en móvil, igual que el real) */}
      <aside className="hidden h-screen w-[260px] shrink-0 flex-col border-r border-border-subtle bg-sidebar lg:flex">
        <div className="flex h-16 items-center gap-2.5 border-b border-border-subtle px-4">
          <Skeleton className="h-8 w-8 rounded-lg bg-sidebar-hover" />
          <Skeleton className="h-4 w-28 bg-sidebar-hover" />
        </div>
        <div className="flex flex-col gap-2 px-2.5 pt-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-7 bg-sidebar-hover"
              style={{ opacity: 1 - i * 0.09 }}
            />
          ))}
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* TopNav */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-4 md:px-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <Skeleton className="h-9 w-9 rounded-full" />
          </div>
        </header>

        <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">
          <PageSkeleton />
        </main>
      </div>
    </div>
  );
}
