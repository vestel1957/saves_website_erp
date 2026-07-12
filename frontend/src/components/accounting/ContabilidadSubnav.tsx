"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Sub-navegación contextual de Contabilidad. Agrupa páginas hermanas para
 * descongestionar el sidebar: el menú lateral muestra solo el grupo, y aquí
 * aparecen las pestañas del grupo activo. No se muestra en páginas sueltas
 * (Resumen, Conciliación, Activos fijos, Cierre) ni bajo Nómina (que tiene
 * su propia navegación).
 */
type Tab = { href: string; label: string };

const GROUPS: Tab[][] = [
  [
    { href: "/contabilidad/compras", label: "Compras y gastos" },
    { href: "/contabilidad/cartera", label: "Cuentas por pagar" },
  ],
  [
    { href: "/contabilidad/libros", label: "Libro diario y mayor" },
    { href: "/contabilidad/recurrentes", label: "Asientos recurrentes" },
  ],
  [
    { href: "/contabilidad/informes", label: "Balance y estados" },
    { href: "/contabilidad/certificados", label: "Certificados de retención" },
    { href: "/contabilidad/exogena", label: "Exógena (DIAN)" },
  ],
  [
    { href: "/contabilidad/plan-de-cuentas", label: "Plan de cuentas" },
    { href: "/contabilidad/centros-costo", label: "Centros de costo" },
    { href: "/contabilidad/impuestos", label: "Impuestos" },
    { href: "/contabilidad/mapeo-cuentas", label: "Mapeo de cuentas" },
  ],
];

export function ContabilidadSubnav() {
  const pathname = usePathname();
  // Nómina maneja su propia navegación.
  if (pathname.startsWith("/contabilidad/nomina")) return null;

  const group = GROUPS.find((tabs) => tabs.some((t) => pathname.startsWith(t.href)));
  if (!group) return null;

  return (
    <nav className="flex flex-wrap gap-1 border-b border-border-subtle">
      {group.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px border-b-2 px-3.5 py-2 text-[13px] font-semibold transition-colors ${
              active
                ? "border-brand text-brand"
                : "border-transparent text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
