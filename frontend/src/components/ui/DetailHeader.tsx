"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "../Icon";
import { volverA } from "@/lib/useFiltrosUrl";

/**
 * Encabezado común de las fichas de detalle (`/clientes/123`, `/soporte/45`,
 * `/facturacion/9`, `/configuracion/empleados/7`…).
 *
 * Antes cada ficha se inventaba el suyo: cinco tipografías distintas para el
 * mismo rol (16, 17, 18, 19 y 20 px), el "volver" unas veces como enlace, otras
 * como botón cuadrado y otras ausente, y las acciones colgando a la derecha con
 * maquetaciones que en móvil se apretaban o se partían. Este componente fija un
 * solo contrato y una sola respuesta responsive.
 *
 * MÓVIL PRIMERO: el "volver" ocupa su renglón, identidad y texto se apilan, y
 * las acciones bajan a ancho completo (donde el pulgar las alcanza) en vez de
 * competir por la misma línea que el título. Desde `sm` vuelve a ser la fila de
 * escritorio de siempre: identidad a la izquierda, acciones a la derecha.
 */
export function DetailHeader({
  backHref,
  backLabel = "Volver",
  icon,
  avatar,
  title,
  badges,
  subtitle,
  meta,
  cover,
  actions,
  aside,
  className = "",
}: {
  /** Destino del "volver". Si se omite, retrocede en el historial. */
  backHref?: string;
  backLabel?: string;
  /** Icono en recuadro de marca. Se ignora si se pasa `avatar`. */
  icon?: string;
  /** Sustituye al icono (p. ej. las iniciales del cliente teñidas por estado). */
  avatar?: React.ReactNode;
  title: React.ReactNode;
  /** Etiquetas junto al título (estado, prioridad…). */
  badges?: React.ReactNode;
  /** Línea de identificación bajo el título (documento, fechas, sede…). */
  subtitle?: React.ReactNode;
  /** Fila extra bajo el subtítulo (chips de servicios, atajos…). */
  meta?: React.ReactNode;
  /**
   * Bloque a lo ancho entre el "volver" y la identidad (hoy, la foto de la vivienda
   * del abonado en móvil). Va aquí y no encima del componente para que el "volver"
   * siga siendo lo primero de la pantalla.
   */
  cover?: React.ReactNode;
  /** Botones de la ficha. A ancho completo en móvil, a la derecha desde `sm`. */
  actions?: React.ReactNode;
  /** Bloque destacado a la derecha (saldo, total…). Debajo en móvil. */
  aside?: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();

  /**
   * El "Volver" devuelve al listado CON SUS FILTROS puestos (`/soporte?estado=…`),
   * no a la lista en blanco: entrar a una ficha ya no cuesta rehacer el filtro.
   * Se completa tras montar porque sessionStorage no existe en el servidor.
   */
  const [destino, setDestino] = useState(backHref);
  useEffect(() => { setDestino(backHref ? volverA(backHref) : undefined); }, [backHref]);

  return (
    <div className={`mb-4 min-w-0 ${className}`}>
      {/* Volver — siempre en su propio renglón, nunca robándole ancho al título. */}
      {backHref ? (
        <Link
          href={destino ?? backHref}
          className="-ml-1 mb-1 inline-flex min-h-8 items-center gap-1 px-1 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
        >
          <Icon name="arrow-left" size={13} /> {backLabel}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => router.back()}
          className="-ml-1 mb-1 inline-flex min-h-8 items-center gap-1 px-1 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
        >
          <Icon name="arrow-left" size={13} /> {backLabel}
        </button>
      )}

      {cover}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {avatar ??
            (icon && (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft">
                <Icon name={icon} size={20} className="text-brand" />
              </span>
            ))}

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* Un único tamaño para el título de ficha en toda la app. En
                  móvil se parte en dos líneas antes que cortarse: un nombre
                  truncado no sirve para saber sobre quién se está actuando. */}
              <h1 className="text-[19px] font-bold leading-tight text-text-primary sm:truncate">
                {title}
              </h1>
              {badges}
            </div>
            {subtitle && (
              <p className="mt-0.5 text-[12px] leading-snug text-text-tertiary">{subtitle}</p>
            )}
            {meta && <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{meta}</div>}
          </div>
        </div>

        {(actions || aside) && (
          <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:items-end">
            {actions && (
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                {actions}
              </div>
            )}
            {aside}
          </div>
        )}
      </div>
    </div>
  );
}
