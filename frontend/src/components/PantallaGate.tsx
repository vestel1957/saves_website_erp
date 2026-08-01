"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthProvider";
import { can } from "@/lib/auth";
import { navLeafExacta, firstAccessibleHref } from "@/lib/nav";

/**
 * Puerta de acceso por PANTALLA, con la misma llave que gatea el sidebar.
 *
 * Hasta ahora quitarle una pantalla a un rol sólo la escondía del menú: el
 * middleware bloquea por ÁREA (`/tesoreria` entera, `/facturacion` entera), no por
 * hoja, así que quien conocía la URL entraba igual. Con secciones que un mismo área
 * comparte —la cajera conserva /tesoreria/ingresos pero ya no /tesoreria— el área
 * no alcanza para expresar la regla.
 *
 * Sólo actúa sobre hojas EXACTAS del menú: las fichas de detalle (/clientes/123,
 * /facturacion/9) no son hojas y siguen gateadas por área, que es como se llega a
 * ellas desde las pantallas que sí tiene.
 *
 * Sigue siendo una puerta de UX: la de verdad son los guards del backend, que
 * revalidan permisos contra la BD en cada llamada.
 */
export function PantallaGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  // Sin usuario resuelto no se bloquea nada: encerrar a alguien por una carrera de
  // hidratación sería peor que enseñar de más durante un instante.
  if (loading || !user) return <>{children}</>;

  const hoja = navLeafExacta(pathname);
  if (!hoja || can(user, hoja.perm)) return <>{children}</>;

  const destino = firstAccessibleHref((perm) => can(user, perm)) ?? "/";
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-border-subtle bg-surface p-6 text-center shadow-sm">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-warning-soft text-warning-text">
          <Icon name="lock" size={20} />
        </span>
        <h2 className="text-[15px] font-bold text-text-primary">Esta pantalla no es de tu perfil</h2>
        <p className="mt-1.5 text-[13px] text-text-secondary">
          <b>{hoja.label}</b> no está entre tus accesos. Si la necesitas, pídesela a quien
          administra los usuarios.
        </p>
        <Link
          href={destino}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[12.5px] font-semibold text-on-brand"
        >
          <Icon name="arrow-right" size={14} /> Ir a mi inicio
        </Link>
      </div>
    </div>
  );
}
