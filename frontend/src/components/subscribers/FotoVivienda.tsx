"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { fmtDate } from "@/lib/format";

/** Un adjunto del cliente marcado como foto de la vivienda (`kind = VIVIENDA`). */
export type FotoVivienda = {
  id: string;
  name: string;
  mimeType: string;
  uploadedBy?: string | null;
  createdAt: string;
};

/** `kind` con el que el backend marca estas fotos dentro de los adjuntos del cliente. */
export const KIND_VIVIENDA = "VIVIENDA";

/** Las fotos de la vivienda, de la más nueva a la más vieja (la primera es la portada). */
export function fotosDeVivienda(files: { kind?: string | null }[] | undefined): FotoVivienda[] {
  return ((files ?? []) as FotoVivienda[]).filter((f) => (f as { kind?: string | null }).kind === KIND_VIVIENDA);
}

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * La imagen del adjunto, ya descargada.
 *
 * El backend sirve los adjuntos con `attachment` y detrás del token, así que no se
 * puede apuntar un `<img src>` a la ruta: hay que traerla con la sesión puesta y
 * envolverla en un blob con su tipo real. Se cachea por id para que abrir el visor
 * no vuelva a bajar la foto que ya está arriba.
 */
function useImagenAdjunto(subscriberId: string, fileId: string | null, mimeType?: string) {
  const { authFetch } = useAuth();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!fileId) { setUrl(null); return; }
    let vivo = true;
    let creada: string | null = null;
    void (async () => {
      try {
        const res = await authFetch(`/subscribers/${subscriberId}/files/${fileId}/download`);
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        if (!vivo) return;
        creada = URL.createObjectURL(new Blob([blob], { type: mimeType || blob.type }));
        setUrl(creada);
      } catch {
        if (vivo) setUrl(null);
      }
    })();
    return () => {
      vivo = false;
      // Se libera al desmontar o al cambiar de foto: si no, cada visita a la ficha
      // deja la imagen entera retenida en memoria hasta recargar la página.
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [authFetch, subscriberId, fileId, mimeType]);

  return url;
}

/**
 * La foto de la vivienda del abonado, arriba de la ficha (entre la barra superior
 * y las pestañas).
 *
 * Dos formas para el mismo dato, porque el encabezado no se lee igual en los dos
 * sitios: en ESCRITORIO va como miniatura donde estaba el círculo de iniciales
 * (`variant="miniatura"`), y en MÓVIL, donde el encabezado se apila y una miniatura
 * se perdería, va de lado a lado antes del nombre (`variant="banda"`).
 *
 * La portada es SIEMPRE la última subida: "cambiar foto" es subir otra, y las
 * anteriores se quedan como historial (se ven en el visor y en la pestaña
 * Archivos). Así no hace falta una pantalla para elegir portada.
 */
export function FotoVivienda({
  subscriberId,
  fotos,
  variant,
  puedeEditar = true,
  onCambio,
  className = "",
}: {
  subscriberId: string;
  fotos: FotoVivienda[];
  variant: "miniatura" | "banda";
  /** Sin permiso para tocar adjuntos, la foto se ve pero no se cambia. */
  puedeEditar?: boolean;
  /** Se llama tras subir, para que la ficha recargue sus adjuntos. */
  onCambio: () => void;
  className?: string;
}) {
  const { authFetch } = useAuth();
  const [subiendo, setSubiendo] = useState(false);
  const [visor, setVisor] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const portada = fotos[0] ?? null;
  const url = useImagenAdjunto(subscriberId, portada?.id ?? null, portada?.mimeType);

  const subir = useCallback(
    async (file: File) => {
      if (file.size > MAX_BYTES) {
        toast("La foto supera el máximo de 20 MB", "alert-circle");
        return;
      }
      setSubiendo(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await authFetch(`/subscribers/${subscriberId}/house-photo`, { method: "POST", body: fd });
        if (!res.ok) {
          const m = await res.json().catch(() => null);
          throw new Error(m?.message ?? "No se pudo subir la foto");
        }
        toast("Foto de la vivienda actualizada");
        onCambio();
      } catch (e) {
        toast(mensajeDeError(e) ?? "No se pudo subir la foto", "alert-circle");
      } finally {
        setSubiendo(false);
      }
    },
    [authFetch, subscriberId, onCambio],
  );

  const elegir = () => input.current?.click();

  const campo = puedeEditar && (
    <input
      ref={input}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        // Se limpia el valor para que volver a elegir el MISMO fichero dispare el
        // change (si no, el navegador lo considera "sin cambios" y no pasa nada).
        e.target.value = "";
        if (f) void subir(f);
      }}
    />
  );

  const banda = variant === "banda";
  const marco = banda
    ? "h-[148px] w-full rounded-xl"
    : "h-[104px] w-[152px] rounded-lg";

  /* ── Sin foto: el hueco ES el botón de subirla ───────────────────────────── */
  if (!portada) {
    if (!puedeEditar) return null;
    return (
      <div className={className}>
        {campo}
        <button
          type="button"
          onClick={elegir}
          disabled={subiendo}
          className={`flex shrink-0 flex-col items-center justify-center gap-1 border border-dashed border-border-default bg-surface-2 text-center transition-colors hover:border-brand hover:bg-brand-soft disabled:opacity-60 ${marco}`}
        >
          {subiendo ? (
            <span className="text-[11px] font-semibold text-text-secondary">Subiendo…</span>
          ) : banda ? (
            <>
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-soft">
                <Icon name="house" size={20} className="text-brand" />
              </span>
              <span className="text-[12px] font-bold text-text-primary">Sin foto de la vivienda</span>
              <span className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[12px] font-semibold text-on-brand">
                <Icon name="camera" size={14} /> Tomar o subir foto
              </span>
            </>
          ) : (
            <>
              <Icon name="house" size={22} className="text-text-tertiary" />
              <span className="text-[11px] font-semibold text-text-secondary">Sin foto de la vivienda</span>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
                <Icon name="camera" size={12} /> Subir foto
              </span>
            </>
          )}
        </button>
      </div>
    );
  }

  /* ── Con foto ───────────────────────────────────────────────────────────── */
  return (
    <div className={className}>
      {campo}
      <div className={`relative shrink-0 overflow-hidden border border-border-subtle bg-surface-2 ${marco}`}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob descargado con la sesión puesta, no una URL servible
          <img src={url} alt="Foto de la vivienda del abonado" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full animate-pulse bg-surface-2" />
        )}

        {/* Velo inferior: el pie va sobre la foto y sin él no se lee en una fachada clara. */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-black/0 to-transparent" />

        <button
          type="button"
          onClick={() => setVisor(true)}
          aria-label="Ver las fotos de la vivienda"
          className="absolute inset-0"
        />

        <span className={`pointer-events-none absolute ${banda ? "bottom-3 left-3.5 text-[13px]" : "bottom-1.5 left-2 text-[10px]"} inline-flex items-center gap-1.5 font-semibold text-white`}>
          <Icon name="image" size={banda ? 14 : 11} />
          {banda ? "Vivienda" : "Vivienda"}
          {fotos.length > 1 && <span className="font-normal text-white/80">· {fotos.length} fotos</span>}
        </span>

        {puedeEditar && (
          <button
            type="button"
            onClick={elegir}
            disabled={subiendo}
            title="Cambiar la foto de la vivienda"
            aria-label="Cambiar la foto de la vivienda"
            className={`absolute flex items-center justify-center rounded-lg bg-surface/90 text-text-secondary transition-colors hover:bg-surface disabled:opacity-60 ${
              banda ? "right-3 top-3 h-9 w-9" : "bottom-1.5 right-1.5 h-6 w-6"
            }`}
          >
            <Icon name={subiendo ? "loader" : "camera"} size={banda ? 16 : 13} className={subiendo ? "animate-spin" : ""} />
          </button>
        )}
      </div>

      <VisorFotos
        open={visor}
        onClose={() => setVisor(false)}
        subscriberId={subscriberId}
        fotos={fotos}
        puedeEditar={puedeEditar}
        onCambiar={elegir}
      />
    </div>
  );
}

/**
 * Visor de las fotos de la vivienda: la elegida en grande y el resto como tiras
 * abajo. No hay "hacer portada" a propósito — la portada es la última subida.
 */
function VisorFotos({
  open,
  onClose,
  subscriberId,
  fotos,
  puedeEditar,
  onCambiar,
}: {
  open: boolean;
  onClose: () => void;
  subscriberId: string;
  fotos: FotoVivienda[];
  puedeEditar: boolean;
  onCambiar: () => void;
}) {
  const [activa, setActiva] = useState(0);
  const foto = fotos[activa] ?? fotos[0];
  const url = useImagenAdjunto(subscriberId, open && foto ? foto.id : null, foto?.mimeType);

  // Al reabrir se vuelve a la portada: es lo que se espera del "ver la foto".
  useEffect(() => { if (open) setActiva(0); }, [open]);

  if (!foto) return null;

  return (
    <Modal open={open} onClose={onClose} title="Foto de la vivienda" maxWidth="max-w-3xl">
      <div className="flex flex-col gap-3">
        <div className="flex max-h-[60vh] items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-surface-2">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element -- blob descargado con la sesión puesta
            <img src={url} alt={foto.name} className="max-h-[60vh] w-auto object-contain" />
          ) : (
            <div className="h-64 w-full animate-pulse bg-surface-2" />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] text-text-tertiary">
            {activa === 0 && <span className="font-semibold text-text-secondary">Foto actual · </span>}
            {fmtDate(foto.createdAt)}
            {foto.uploadedBy && <> · subida por {foto.uploadedBy}</>}
          </p>
          {puedeEditar && (
            <button
              type="button"
              onClick={() => { onClose(); onCambiar(); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
            >
              <Icon name="camera" size={14} /> Cambiar foto
            </button>
          )}
        </div>

        {fotos.length > 1 && (
          <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3">
            {fotos.map((f, i) => (
              <Miniatura
                key={f.id}
                subscriberId={subscriberId}
                foto={f}
                activa={i === activa}
                onClick={() => setActiva(i)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Una tira del visor. Baja su propia imagen; el visor sólo se ocupa de la grande. */
function Miniatura({
  subscriberId,
  foto,
  activa,
  onClick,
}: {
  subscriberId: string;
  foto: FotoVivienda;
  activa: boolean;
  onClick: () => void;
}) {
  const url = useImagenAdjunto(subscriberId, foto.id, foto.mimeType);
  return (
    <button
      type="button"
      onClick={onClick}
      title={fmtDate(foto.createdAt)}
      className={`h-14 w-20 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
        activa ? "border-brand" : "border-border-subtle hover:border-border-default"
      }`}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- blob descargado con la sesión puesta
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="block h-full w-full animate-pulse bg-surface-2" />
      )}
    </button>
  );
}
