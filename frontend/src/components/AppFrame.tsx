"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { TopNav } from "@/components/TopNav";
import { GeoGate } from "@/components/map/GeoGate";

// Rutas públicas que NO llevan el chrome de staff (mismo criterio que el
// middleware `PUBLIC_PATHS`): login y el portal del abonado.
const BARE_PREFIXES = ["/login", "/portal"];

/**
 * Shell de la app montado UNA sola vez en el root layout: así el Sidebar y el
 * TopNav persisten entre navegaciones (nunca se desmontan) y cambiar de sección
 * es instantáneo (SPA), sin el "refresh"/remonte que causaba tener el shell
 * duplicado en el layout de cada sección.
 */
export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = BARE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (bare) return <>{children}</>;
  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopNav />
        <main className="flex flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-6">
          {/* Puerta de ubicación: a un técnico con el permiso denegado no se le
              enseña nada hasta que lo reactive. Envuelve el contenido y no el
              marco, para que le queden el menú y el botón de salir. */}
          <GeoGate>{children}</GeoGate>
        </main>
      </div>
    </div>
  );
}
