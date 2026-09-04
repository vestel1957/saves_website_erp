"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "../Icon";
import { isNavLeaf } from "@/lib/nav";
import { volverA } from "@/lib/useFiltrosUrl";

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
  backHref,
  backLabel,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  /** Fuerza mostrar (true) u ocultar (false) el "Volver"; por defecto se decide por la ruta. */
  showBack?: boolean;
  /**
   * Destino fijo del "Volver". Sin esto se usa el historial del navegador, que
   * devuelve a donde se venía — y a una ficha se puede llegar desde media docena
   * de sitios. Cuando la pantalla tiene un padre claro (la sede de la que
   * cuelgan sus clientes), conviene nombrarlo y llevar siempre allí.
   */
  backHref?: string;
  /** Texto del volver (por defecto "Volver"); con `backHref`, nombra el destino. */
  backLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const back = showBack ?? (!!backHref || !isNavLeaf(pathname));

  /**
   * El "Volver" lleva al listado CON SUS FILTROS: si se venía de
   * `/soporte?estado=REALIZANDO`, vuelve ahí y no a la lista en blanco. La
   * dirección se completa tras montar (sessionStorage no existe en el servidor
   * y el HTML tiene que salir igual de los dos lados).
   */
  const [destino, setDestino] = useState(backHref);
  useEffect(() => { setDestino(backHref ? volverA(backHref) : undefined); }, [backHref]);
  const claseVolver =
    "-ml-1 mb-1 inline-flex min-h-8 items-center gap-1 px-1 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary";
  return (
    <div className="mb-4 min-w-0">
      {back && (backHref ? (
        <Link href={destino ?? backHref} className={claseVolver}>
          <Icon name="arrow-left" size={13} /> {backLabel ?? "Volver"}
        </Link>
      ) : (
        <button type="button" onClick={() => router.back()} className={claseVolver}>
          <Icon name="arrow-left" size={13} /> {backLabel ?? "Volver"}
        </button>
      ))}
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft">
          <Icon name={icon} size={18} className="text-brand" />
        </span>
        {/*
          MÓVIL: ni el título ni el subtítulo se recortan con `truncate`. En una
          pantalla de 390 px la caja del texto mide ~312 px, y subtítulos de 400
          a 870 px de ancho quedaban visibles en un tercio — la frase que explica
          para qué sirve la pantalla se perdía justo donde más falta hace. El
          título envuelve libre y el subtítulo se limita a dos líneas; desde `sm`
          vuelve el recorte de una línea de siempre.
        */}
        <div className="min-w-0">
          <h1 className="text-[18px] font-bold leading-tight text-text-primary sm:truncate">{title}</h1>
          {subtitle && (
            <p className="line-clamp-2 text-[12.5px] leading-tight text-text-tertiary sm:line-clamp-none sm:truncate">
              {subtitle}
            </p>
          )}
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
