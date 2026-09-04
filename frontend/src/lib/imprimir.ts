/**
 * Abrir e imprimir PDFs que devuelve la API.
 *
 * Existe por un fallo concreto: el recibo de caja "no salía". El código llamaba a
 * `window.open()` DESPUÉS de un `await` (el POST del pago y luego la descarga del
 * PDF), y para el navegador eso ya no es una ventana pedida por el usuario sino una
 * ventana emergente: Chrome, Edge y Firefox la bloquean en silencio. El `catch`
 * vacío que envolvía la llamada terminaba de esconderlo — la cajera cobraba y no
 * salía ningún papel, sin un solo mensaje.
 *
 * Aquí no se abre pestaña: el PDF se carga en un iframe oculto del mismo documento
 * —que ningún bloqueador toca— y se manda a imprimir desde ahí. De paso sale ya el
 * diálogo de impresión, que es lo que la cajera hace a continuación de todos modos.
 *
 * Si el navegador no deja imprimir dentro del iframe (algún visor de PDF no lo
 * permite), se cae hacia abrir la pestaña; y si TAMBIÉN la bloquean, se devuelve
 * `false` para que quien llama pueda ofrecer un enlace pulsable — un fallo visible
 * en vez de un papel que nunca sale.
 */

/** Cuánto se espera a que el visor de PDF del navegador cargue el documento. */
const ESPERA_CARGA_MS = 8_000;
/** Cuánto se deja vivo el iframe después de imprimir (el diálogo es asíncrono). */
const VIDA_IFRAME_MS = 60_000;

export type ResultadoImpresion = {
  /** Se llegó a mandar a imprimir (o al menos a abrir el documento). */
  ok: boolean;
  /** Cómo se resolvió, para poder decírselo a quien llama. */
  via: "iframe" | "pestana" | "bloqueado";
  /** URL del blob, viva un rato, por si hay que ofrecer un enlace manual. */
  url: string;
};

/**
 * Manda el PDF a la impresora (diálogo del navegador).
 *
 * @param blob PDF ya descargado.
 */
export async function imprimirPdf(blob: Blob): Promise<ResultadoImpresion> {
  const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "application/pdf" }));

  const impreso = await new Promise<boolean>((resolve) => {
    let resuelto = false;
    const terminar = (v: boolean) => { if (!resuelto) { resuelto = true; resolve(v); } };

    const iframe = document.createElement("iframe");
    // Fuera de la vista pero PRESENTE: con `display:none` algunos navegadores no
    // cargan el visor de PDF y `print()` no encuentra nada que imprimir.
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.opacity = "0";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");

    const limpiar = () => { setTimeout(() => iframe.remove(), VIDA_IFRAME_MS); };

    iframe.onload = () => {
      try {
        const w = iframe.contentWindow;
        if (!w) { terminar(false); limpiar(); return; }
        w.focus();
        w.print();
        terminar(true);
      } catch {
        terminar(false);
      } finally {
        limpiar();
      }
    };
    iframe.onerror = () => { terminar(false); limpiar(); };

    // Red de seguridad: si el visor nunca dispara `onload`, no dejamos a la cajera
    // esperando un papel que no viene.
    setTimeout(() => { if (!resuelto) { terminar(false); limpiar(); } }, ESPERA_CARGA_MS);

    iframe.src = url;
    document.body.appendChild(iframe);
  });

  if (impreso) {
    setTimeout(() => URL.revokeObjectURL(url), VIDA_IFRAME_MS);
    return { ok: true, via: "iframe", url };
  }

  const abierta = window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), VIDA_IFRAME_MS);
  return abierta ? { ok: true, via: "pestana", url } : { ok: false, via: "bloqueado", url };
}

/**
 * Guarda el PDF en el equipo (carpeta de descargas), sin abrir nada.
 *
 * Va por un enlace `download` y no por `window.open`: es el único camino que ningún
 * navegador bloquea después de un `await`, que es justo cuando se usa esto — el PDF
 * llega de la API, no de un clic.
 *
 * NOTA: el navegador no deja elegir la carpeta ni avisa de si el archivo ya existe;
 * si se cobra dos veces al mismo cliente, el segundo se guarda como `… (1).pdf`.
 */
export function descargarPdf(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre.toLowerCase().endsWith(".pdf") ? nombre : `${nombre}.pdf`;
  // En el documento: Firefox ignora el clic de un enlace que no esté montado.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), VIDA_IFRAME_MS);
}

/**
 * El nombre que trae el propio PDF en su cabecera `Content-Disposition`.
 *
 * Se prefiere al inventado aquí porque lo pone quien conoce el documento: el recibo
 * de caja viaja como `recibo-<consecutivo>.pdf`, y ese consecutivo es el que la
 * cajera busca cuando el cliente reclama. `respaldo` cubre el día que la cabecera no
 * venga (o que un proxy la quite).
 */
export function nombreDelPdf(res: Response, respaldo: string): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const utf8 = cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) { try { return decodeURIComponent(utf8); } catch { /* nombre roto: al respaldo */ } }
  return cd.match(/filename="([^"]+)"/i)?.[1] ?? respaldo;
}

/**
 * Abre el PDF para verlo (sin diálogo de impresión).
 *
 * Misma historia de bloqueadores: si `window.open` devuelve `null`, se intenta la
 * descarga con un enlace, que ningún navegador bloquea.
 */
export function abrirPdf(blob: Blob, nombre = "documento.pdf"): ResultadoImpresion {
  const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "application/pdf" }));
  const abierta = window.open(url, "_blank");
  if (!abierta) {
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), VIDA_IFRAME_MS);
  return { ok: true, via: abierta ? "pestana" : "iframe", url };
}
