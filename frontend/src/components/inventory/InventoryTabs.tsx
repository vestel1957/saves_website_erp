"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthProvider";
import { can } from "@/lib/auth";

export type InvTab = {
  href: string;
  label: string;
  /** Permiso(s) requeridos para ver la pestaña. Omitido = visible para todos. */
  perm?: string | string[];
};

/** href de la pestaña MÁS específica que corresponde a la ruta (-1 = no coincide). */
function activeHref(tabs: InvTab[], pathname: string): string {
  let best = "";
  let bestLen = -1;
  for (const t of tabs) {
    let len = -1;
    if (pathname === t.href) len = t.href.length;
    else if (pathname.startsWith(`${t.href}/`)) len = t.href.length;
    if (len > bestLen) {
      bestLen = len;
      best = t.href;
    }
  }
  return best;
}

/**
 * Barra de pestañas para agrupar sub-páginas de un módulo de inventario bajo un
 * solo ítem de navegación. Oculta las pestañas que el usuario no tiene permiso
 * de ver (igual que el sidebar). La pestaña activa se resuelve por el prefijo de
 * ruta más largo, de modo que la pestaña índice no quede activa a la vez que una
 * sub-ruta.
 */
export function InventoryTabs({ tabs }: { tabs: InvTab[] }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const visible = tabs.filter((t) => !t.perm || can(user, t.perm));
  if (visible.length <= 1) return null;
  const active = activeHref(visible, pathname);

  return (
    <div className="flex shrink-0 flex-wrap gap-1 self-start rounded-lg border border-border-subtle bg-surface p-0.5">
      {visible.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${
            t.href === active ? "bg-brand text-on-brand" : "text-text-secondary hover:bg-surface-2"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
