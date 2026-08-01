"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthProvider";
import { initials } from "@/lib/auth";

/** Se dispara al subir o quitar la foto para que todos los avatares se refresquen. */
export const PHOTO_CHANGED_EVENT = "nexus:profile-photo";

/**
 * Caché a nivel de módulo del blob de la foto propia.
 *
 * El endpoint pide token (`Authorization`), así que no se puede poner en el
 * `src` de un `<img>` y hay que traerlo por fetch. Sin esta caché, cada montaje
 * del sidebar o del perfil pediría la imagen otra vez; con ella se pide UNA vez
 * por sesión y los demás avatares reutilizan el mismo object URL.
 *
 * `null` = ya se consultó y no hay foto. `undefined` = todavía no se ha mirado.
 *
 * Se guarda CON el id del dueño: cerrar sesión no recarga la página (es un
 * `router.replace`), así que sin esa comprobación el siguiente que entrara desde
 * el mismo navegador vería la foto del anterior.
 */
let cache: string | null | undefined;
let cacheDe: string | null = null;
let enVuelo: Promise<string | null> | null = null;

function invalidar() {
  if (cache) URL.revokeObjectURL(cache);
  cache = undefined;
  cacheDe = null;
  enVuelo = null;
}

/** Avisa a todos los avatares montados de que la foto cambió. */
export function notifyPhotoChanged() {
  invalidar();
  window.dispatchEvent(new CustomEvent(PHOTO_CHANGED_EVENT));
}

function cargar(authFetch: (p: string) => Promise<Response>, userId: string): Promise<string | null> {
  if (cacheDe !== userId) invalidar();
  if (cache !== undefined) return Promise.resolve(cache);
  cacheDe = userId;
  enVuelo ??= authFetch("/profile/photo")
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => {
      cache = b ? URL.createObjectURL(b) : null;
      return cache;
    })
    .catch(() => {
      cache = null;
      return null;
    });
  return enVuelo;
}

/**
 * Avatar del usuario en sesión: su foto si la tiene, o sus iniciales.
 *
 * Las iniciales se pintan siempre debajo, así que mientras la foto viaja (o si
 * no hay) nunca se ve un hueco gris.
 */
export function UserAvatar({
  size = 32,
  className = "",
  title,
}: {
  /** Lado del círculo en píxeles. */
  size?: number;
  className?: string;
  title?: string;
}) {
  const { user, authFetch } = useAuth();
  const userId = user?.id ?? null;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setUrl(null); return; }
    let vivo = true;
    const sync = () => {
      void cargar(authFetch, userId).then((u) => { if (vivo) setUrl(u); });
    };
    sync();
    window.addEventListener(PHOTO_CHANGED_EVENT, sync);
    return () => {
      vivo = false;
      window.removeEventListener(PHOTO_CHANGED_EVENT, sync);
    };
  }, [authFetch, userId]);

  const texto = user ? initials(user.name) : "··";
  return (
    <span
      title={title ?? user?.name}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) }}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent font-semibold text-white ${className}`}
    >
      {texto}
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
    </span>
  );
}
