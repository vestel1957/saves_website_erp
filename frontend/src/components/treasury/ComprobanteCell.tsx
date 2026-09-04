"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { ACCEPT_IMAGEN_PDF } from "@/lib/adjuntos";

/**
 * Tipo con el que se va a pintar el comprobante.
 *
 * Se prefiere el que diga el servidor, pero se cae a la extensión del nombre cuando
 * llega un `application/octet-stream`: los 26.153 comprobantes del legacy los nombró
 * el legacy, y un binario anónimo el navegador no lo enseña, se lo baja.
 */
function tipoDe(blob: Blob, nombre: string | null): string {
  const suyo = (blob.type || "").toLowerCase();
  if (suyo && suyo !== "application/octet-stream") return suyo;
  const ext = (nombre ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".heic": "image/heic", ".pdf": "application/pdf",
  } as Record<string, string>)[ext] ?? suyo;
}

/**
 * Celda de comprobante de un movimiento de caja: "Ver" si ya hay adjunto; si no, botón
 * para subirlo (imagen o PDF).
 *
 * Vive aquí —y no dentro de la tabla de movimientos— porque el comprobante se pide desde
 * dos sitios distintos: los listados de Ingresos/Egresos/Anulaciones y la tabla de
 * movimientos del CIERRE, que es donde de verdad se revisa el gasto del día. Tener una
 * sola celda evita que una de las dos se quede sin el botón, como pasó hasta ahora.
 *
 * Guarda el resultado de la subida en estado local (`recien`) para que la fila cambie a
 * "Ver" al instante aunque quien la pinte no sepa recargarse; `onChange` es opcional y
 * sólo lo usan las pantallas que sí tienen recarga.
 */
export function ComprobanteCell({ id, attach, attachName, onChange, soloLectura }: {
  id: string;
  attach: string | null;
  attachName: string | null;
  onChange?: () => void;
  /** Sin permiso para adjuntar: si no hay comprobante, la celda queda en blanco. */
  soloLectura?: boolean;
}) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [recien, setRecien] = useState<string | null>(null);
  const [abriendo, setAbriendo] = useState(false);
  /** El comprobante ya descargado, mientras el visor está abierto. */
  const [vista, setVista] = useState<{ url: string; tipo: string; nombre: string } | null>(null);

  const nombre = recien ?? attachName;
  const tiene = !!attach || !!recien;

  // El blob ocupa memoria del navegador hasta que se suelta; al cerrar el visor (o al
  // irse de la pantalla con él abierto) se libera.
  useEffect(() => () => { if (vista) URL.revokeObjectURL(vista.url); }, [vista]);

  /**
   * Trae el comprobante y lo enseña AQUÍ MISMO, en un visor sobre la tabla.
   *
   * Antes se abría en otra pestaña, y eso fallaba por los dos lados: el navegador
   * bloqueaba la pestaña porque el fichero tarda en llegar (un comprobante que no esté
   * en la copia local se baja del legacy vivo la primera vez) y, cuando no la bloqueaba,
   * lo que se veía era una descarga. Revisar un cierre es mirar los soportes uno tras
   * otro: cada uno en su pestaña, o en la carpeta de descargas, es justo lo que estorba.
   */
  async function ver() {
    if (abriendo) return;
    setAbriendo(true);
    try {
      const res = await authFetch(`/treasury/transactions/${id}/attachment`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const visible = nombre ?? "comprobante";
      const tipo = tipoDe(blob, visible);
      // Se re-etiqueta el blob con el tipo bueno: es lo que decide si el navegador lo
      // pinta o se lo baja, y en un `<img>`/`<iframe>` no hay cabeceras que valgan.
      setVista({ url: URL.createObjectURL(new Blob([blob], { type: tipo })), tipo, nombre: visible });
    } catch { toast("No se pudo abrir el comprobante", "alert-triangle"); }
    finally { setAbriendo(false); }
  }

  async function subir(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetch(`/treasury/transactions/${id}/attach`, { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo subir");
      toast("Comprobante adjuntado", "check");
      setRecien(file.name);
      onChange?.();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(false); }
  }

  return (
    <>
      {tiene ? (
        <button type="button" onClick={ver} disabled={abriendo} title={nombre ?? "Ver comprobante"}
          className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-brand hover:underline disabled:opacity-60">
          <Icon name={abriendo ? "loader" : "file-text"} size={13}
            className={abriendo ? "animate-spin" : undefined} /> Ver
        </button>
      ) : soloLectura ? (
        <span className="text-text-tertiary">—</span>
      ) : (
        <label className="inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium text-text-tertiary hover:text-text-secondary">
          <Icon name="upload" size={13} /> {busy ? "Subiendo…" : "Adjuntar"}
          <input type="file" accept={ACCEPT_IMAGEN_PDF} className="hidden" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void subir(f); e.target.value = ""; }} />
        </label>
      )}

      {/* Al `body`: esta celda vive dentro de un `<td>`, y un diálogo colgado de una
          tabla hereda su tipografía y depende de que ningún antepasado tenga
          `transform` (que le quitaría el `fixed` y lo dejaría a mitad de la página). */}
      {vista && createPortal(
        <Modal open onClose={() => setVista(null)} title={vista.nombre} maxWidth="max-w-4xl">
          <VistaComprobante {...vista} />
        </Modal>,
        document.body,
      )}
    </>
  );
}

/**
 * El comprobante dentro del visor. Tres formas, según lo que sea:
 * imagen (3 de cada 4 son fotos de WhatsApp), PDF, y lo que el navegador no sabe pintar
 * —un Word o un Excel—, que sólo se puede ofrecer para bajar.
 *
 * `shrink-0` en los pies: el panel del modal es una columna flex y sin él los botones se
 * aplastan contra el borde cuando la imagen es alta (ver la nota de `main` en el layout).
 */
function VistaComprobante({ url, tipo, nombre }: { url: string; tipo: string; nombre: string }) {
  const esImagen = tipo.startsWith("image/");
  const esPdf = tipo === "application/pdf";

  return (
    <>
      {esImagen && (
        // `max-h` y no alto fijo: una foto de recibo suele venir apaisada y otra vertical,
        // y lo que no puede pasar es que el visor haga scroll dentro del scroll del modal.
        // eslint-disable-next-line @next/next/no-img-element -- `next/image` no sirve un blob:
        <img src={url} alt={nombre} className="mx-auto max-h-[72dvh] w-auto max-w-full rounded-lg object-contain" />
      )}
      {esPdf && (
        // El PDF necesita alto explícito: dentro de una columna flex, un iframe sin alto
        // se queda en cero y el visor sale en blanco.
        <iframe src={url} title={nombre} className="h-[72dvh] w-full rounded-lg border border-border-subtle bg-surface-2" />
      )}
      {!esImagen && !esPdf && (
        <p className="rounded-lg bg-surface-2 px-4 py-8 text-center text-[13px] text-text-secondary">
          Este comprobante es un documento que el navegador no puede mostrar. Descárgalo para abrirlo.
        </p>
      )}

      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border-subtle pt-3">
        <a href={url} download={nombre}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border-default px-3 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
          <Icon name="download" size={13} /> Descargar
        </a>
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border-default px-3 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
          <Icon name="external-link" size={13} /> Abrir en otra pestaña
        </a>
      </div>
    </>
  );
}
