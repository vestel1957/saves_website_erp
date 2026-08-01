"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthProvider";
import { can } from "@/lib/auth";
import { screenKey } from "@/lib/nav";

/**
 * Atajo a Movimientos desde las pantallas de tesorería, sólo para quien tiene esa
 * pantalla. La cajera ya no la tiene (trabaja por Ingresos/Egresos/Nueva/
 * Transferencia y su arqueo), y un botón que lleva a "no es de tu perfil" es peor
 * que no tener botón.
 */
export function LinkMovimientos() {
  const { user } = useAuth();
  if (!can(user, screenKey("/tesoreria"))) return null;
  return (
    <Link
      href="/tesoreria"
      className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
    >
      <Icon name="banknote" size={14} /> Movimientos
    </Link>
  );
}
