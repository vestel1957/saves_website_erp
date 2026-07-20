"use client";

import { usePathname, useRouter } from "next/navigation";
import { Icon } from "../Icon";
import { isNavLeaf } from "@/lib/nav";

/**
 * Encabezado de vista: botón "Volver" (compacto, arriba) + ícono + título +
 * subtítulo. Es el título visible de cada pantalla — clave en móvil, donde el
 * breadcrumb del TopNav se oculta. Funciona suelto o como hijo izquierdo de una
 * fila `flex justify-between` con un botón de acción a la derecha.
 *
 * El "Volver" solo aparece en subpáginas que NO son sección del sidebar (fichas
 * de detalle: /clientes/123, /soporte/45). En una sección del menú se navega por
 * el sidebar, así que se omite. Se puede forzar con `backHref`/`showBack`.
 */
export function PageHeading({
  icon,
  title,
  subtitle,
  showBack,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  /** Fuerza mostrar (true) u ocultar (false) el "Volver"; por defecto se decide por la ruta. */
  showBack?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const back = showBack ?? !isNavLeaf(pathname);
  return (
    <div className="mb-4 min-w-0">
      {back && (
        <button
          type="button"
          onClick={() => router.back()}
          className="mb-1 inline-flex items-center gap-1 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
        >
          <Icon name="arrow-left" size={13} /> Volver
        </button>
      )}
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft">
          <Icon name={icon} size={18} className="text-brand" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-bold leading-tight text-text-primary">{title}</h1>
          {subtitle && <p className="truncate text-[12.5px] leading-tight text-text-tertiary">{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}

export function StubNotice({ feature }: { feature: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center">
      <Icon name="sparkles" size={22} className="text-text-tertiary" />
      <h2 className="text-[15px] font-bold text-text-primary">{feature}</h2>
      <p className="max-w-md text-[13px] text-text-tertiary">
        El backend para este módulo ya está implementado y expuesto vía API. La interfaz visual
        está disponible como vista preliminar y se ampliará en la siguiente iteración.
      </p>
    </div>
  );
}
