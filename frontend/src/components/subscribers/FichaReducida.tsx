"use client";

import { Icon } from "@/components/Icon";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { FotoVivienda, type FotoVivienda as Foto } from "@/components/subscribers/FotoVivienda";

/**
 * La ficha del cliente TAL COMO LA VE UN TÉCNICO DE PASO (2026-09-12).
 *
 * El cierre del 2026-09-10 dejó al técnico sólo con los clientes de sus órdenes, y
 * de rebote se llevó la foto de la vivienda: en la mayoría de las puertas la ficha
 * respondía 403 y la pantalla decía "Cliente no encontrado", así que no había dónde
 * tomar la foto. Ahora el backend, en vez del 403, devuelve la ficha con
 * `limitado: true` y esta pantalla pinta lo justo para hacer esa foto: quién es,
 * dónde vive y la cámara.
 *
 * Lo que NO está es tan importante como lo que está: ni teléfono, ni documento, ni
 * deuda, ni facturas, ni equipos, ni red, ni historial, ni notas, ni pestañas. Lo
 * que se cerró sigue cerrado; esto es una puerta del ancho de una foto.
 *
 * El "volver" no lleva a /clientes —al técnico esa ruta lo rebota a su agenda—:
 * sin `backHref`, `DetailHeader` retrocede en el historial, que es de donde vino.
 */
export function FichaReducida({
  id,
  cliente,
  fotos,
  onCambio,
}: {
  id: string;
  cliente: {
    name?: string | null;
    companyName?: string | null;
    abonado?: number | string | null;
    legacyId?: number | string | null;
    address?: string | null;
    addressRef?: string | null;
    neighborhood?: string | null;
    city?: string | null;
    branch?: string | null;
  };
  fotos: Foto[];
  /** Se llama tras subir la foto, para recargar los adjuntos de la ficha. */
  onCambio: () => void;
}) {
  return (
    <>
      <DetailHeader
        backLabel="Volver"
        avatar={
          <div className="hidden shrink-0 sm:block">
            <FotoVivienda subscriberId={id} fotos={fotos} variant="miniatura" onCambio={onCambio} />
          </div>
        }
        cover={
          <FotoVivienda
            subscriberId={id}
            fotos={fotos}
            variant="banda"
            onCambio={onCambio}
            className="mb-3 sm:hidden"
          />
        }
        title={cliente.name ?? "Cliente"}
        subtitle={
          <>
            {cliente.companyName && <span className="text-text-secondary">{cliente.companyName} · </span>}
            Abonado <span className="font-mono font-semibold text-text-secondary">{cliente.abonado ?? "—"}</span>
            {cliente.legacyId != null && <> · ID <span className="font-mono text-text-secondary">{cliente.legacyId}</span></>}
            {cliente.branch && <> · {cliente.branch}</>}
          </>
        }
      />

      {/* Dónde es. Es el dato que decide si la foto que se va a tomar es la casa
          correcta, así que va grande y solo, no escondido entre chips. */}
      <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <p className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
          <Icon name="map-pin" size={13} /> Dirección
        </p>
        <p className="text-[15px] font-bold leading-snug text-text-primary">{cliente.address || "Sin dirección registrada"}</p>
        {(cliente.neighborhood || cliente.city) && (
          <p className="mt-0.5 text-[12px] text-text-secondary">
            {[cliente.neighborhood, cliente.city].filter(Boolean).join(" · ")}
          </p>
        )}
        {cliente.addressRef && (
          <p className="mt-1.5 text-[12px] text-text-tertiary">Referencia: {cliente.addressRef}</p>
        )}
      </div>

      {/* Por qué la ficha se ve a medias: que no parezca que algo falló. */}
      <div className="flex items-start gap-2 rounded-xl border border-border-subtle bg-surface-2 p-3 text-[12px] leading-snug text-text-secondary">
        <Icon name="info" size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
        <span>
          Este cliente no corresponde a ninguna de tus órdenes, así que ves solo su nombre y su
          dirección. <b className="text-text-primary">La foto de la vivienda sí puedes tomarla</b>: toca la
          foto de arriba.
        </span>
      </div>
    </>
  );
}
