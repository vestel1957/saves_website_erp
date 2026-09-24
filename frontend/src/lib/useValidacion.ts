"use client";

import { useCallback, useState } from "react";
import { isValidPhone } from "@/lib/phone";

/**
 * Validación EN VIVO de formularios.
 *
 * Hasta ahora todos los formularios validaban al pulsar Guardar y avisaban por
 * toast: el aviso tapaba la pantalla, no decía QUÉ campo era y desaparecía solo a
 * los pocos segundos. Con 469 campos `<Field>` en el frontend y sólo 5 usando su
 * prop `error`, la pieza que faltaba no era la pantalla —el campo ya sabe pintar
 * el error, en rojo y con `aria-invalid`— sino de dónde sacar ese texto.
 *
 * CUÁNDO SE ENSEÑA EL ERROR (esto es lo importante):
 *   · Mientras se escribe por primera vez, NO. Un formulario recién abierto en el
 *     que todo está en rojo antes de teclear nada regaña sin motivo.
 *   · Al SALIR del campo (blur), sí: ya terminó con él.
 *   · Al pulsar Guardar, todos a la vez: `revisar()` marca el formulario entero,
 *     así se ven de un golpe los tres campos que faltan en vez de descubrirlos de
 *     uno en uno.
 *   · Y una vez visible, se recalcula EN VIVO con cada tecla: el error desaparece
 *     en el momento exacto en que se corrige, sin volver a guardar.
 *
 * Uso:
 *   const v = useValidacion(
 *     { holder, fixedFund },
 *     { holder: requerido("El nombre de la caja es obligatorio."),
 *       fixedFund: numero({ min: 0 }) },
 *   );
 *   <Field label="Nombre" required error={v.error("holder")}>
 *     <Input value={holder} onChange={…} {...v.campo("holder")} />
 *   </Field>
 *   <Button onClick={() => { if (!v.revisar()) return; …guardar… }}>Guardar</Button>
 *
 * El botón de guardar NO se deshabilita a propósito: un botón muerto no explica
 * qué le falta al formulario. Se deja pulsable y al pulsarlo se encienden los
 * campos que faltan, que es la respuesta que la persona vino a buscar.
 */

/** Devuelve el mensaje de error, o `undefined` si el valor está bien. */
export type Regla<V = unknown, T = Record<string, unknown>> = (valor: V, form: T) => string | undefined;

export type Reglas<T> = { [K in keyof T]?: Regla<T[K], T> | Regla<T[K], T>[] };

export type Validacion<T> = {
  /** Mensaje a pasarle a `<Field error=…>`; `undefined` mientras no toque enseñarlo. */
  error: (campo: keyof T) => string | undefined;
  /** Props para el control (`{...v.campo("nombre")}`): marca el campo al salir de él. */
  campo: (campo: keyof T) => { onBlur: () => void };
  /** Marca todo el formulario y responde si se puede guardar. Va en el onClick de Guardar. */
  revisar: () => boolean;
  /** ¿Está todo bien? (sin marcar nada; para un resumen o un aviso al pie). */
  valido: boolean;
  /** Cuántos campos están mal ahora mismo. */
  faltan: number;
  /** Olvida lo marcado. Al reabrir un modal, para no estrenarlo en rojo. */
  limpiar: () => void;
  /** Marca SÓLO esos campos (los de un paso) y responde si están bien. */
  revisarCampos: (nombres: (keyof T)[]) => boolean;
  /** Los fallos de ahora, se enseñen o no (para saber a qué paso volver). */
  errores: Partial<Record<keyof T, string>>;
};

export function useValidacion<T extends Record<string, unknown>>(valores: T, reglas: Reglas<T>): Validacion<T> {
  const [tocados, setTocados] = useState<Partial<Record<keyof T, boolean>>>({});
  const [intentado, setIntentado] = useState(false);

  // Se calcula EN EL RENDER, no en un efecto ni en un `useMemo`: `valores` y
  // `reglas` son literales que la página rearma en cada pintada, así que
  // memorizar no ahorraría nada (unas cuantas comparaciones de cadenas), y
  // calcularlo aquí garantiza que el error viaja en la MISMA pintada en la que
  // cambió el valor. Con un efecto se vería un fotograma tarde.
  const errores: Partial<Record<keyof T, string>> = {};
  for (const campo of Object.keys(reglas) as (keyof T)[]) {
    const regla = reglas[campo];
    if (!regla) continue;
    for (const r of Array.isArray(regla) ? regla : [regla]) {
      const mensaje = r(valores[campo], valores);
      // Manda el PRIMER fallo: apilar "es obligatorio" y "debe tener 10 dígitos"
      // en el mismo campo no ayuda a nadie.
      if (mensaje) { errores[campo] = mensaje; break; }
    }
  }

  const error = (campo: keyof T) => (tocados[campo] || intentado ? errores[campo] : undefined);

  const campo = useCallback(
    (nombre: keyof T) => ({
      onBlur: () => setTocados((t) => (t[nombre] ? t : { ...t, [nombre]: true })),
    }),
    [],
  );

  // Sin `useCallback` a propósito: tiene que ver los errores de AHORA. Memorizarla
  // exigiría un ref leído en render (que React desaconseja) para lo mismo, y se
  // llama una vez, desde el onClick de Guardar.
  const revisar = () => {
    setIntentado(true);
    return Object.keys(errores).length === 0;
  };

  /**
   * Como `revisar`, pero sólo para ALGUNOS campos: los de un paso de un asistente.
   * Marca ésos (y no el resto, que se estrenaría en rojo en un paso que la persona
   * aún no ha visto) y dice si están bien.
   */
  const revisarCampos = (nombres: (keyof T)[]) => {
    setTocados((t) => ({ ...t, ...Object.fromEntries(nombres.map((n) => [n, true])) }));
    return nombres.every((n) => !errores[n]);
  };

  const limpiar = useCallback(() => { setTocados({}); setIntentado(false); }, []);

  const faltan = Object.keys(errores).length;
  return { error, campo, revisar, revisarCampos, valido: faltan === 0, faltan, limpiar, errores };
}

/* ─────────────────────────── Reglas de siempre ─────────────────────────── */
/* Los mensajes se escriben enteros en cada uso ("El nombre de la caja es
   obligatorio") en vez de armarlos con el nombre del campo: en español el
   género obliga a "obligatorio"/"obligatoria" y una plantilla los mezcla. */

const vacio = (v: unknown) =>
  v === null || v === undefined || v === false ||
  (typeof v === "string" && !v.trim()) ||
  (Array.isArray(v) && v.length === 0);

/** No puede quedar en blanco (ni un select sin elegir, ni una lista vacía). */
export const requerido =
  <V,>(mensaje = "Este dato es obligatorio."): Regla<V> =>
  (v) => (vacio(v) ? mensaje : undefined);

/** Mínimo de caracteres. */
export const minimo =
  <V,>(n: number, mensaje?: string): Regla<V> =>
  (v) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined; // el vacío lo denuncia `requerido`, no esta regla
    return s.length < n ? (mensaje ?? `Debe tener al menos ${n} caracteres.`) : undefined;
  };

/** Máximo de caracteres (los campos del legacy tienen columnas cortas). */
export const maximo =
  <V,>(n: number, mensaje?: string): Regla<V> =>
  (v) => (String(v ?? "").length > n ? (mensaje ?? `No puede pasar de ${n} caracteres.`) : undefined);

/**
 * Número válido, con tope opcional. `min: 0` no es lo mismo que "mayor que 0":
 * para un monto que no puede ser cero va `min: 1` (o `positivo`).
 */
export const numero =
  <V,>(opts: { min?: number; max?: number; entero?: boolean } = {}, mensaje?: string): Regla<V> =>
  (v) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) return mensaje ?? "Escribe un número.";
    if (opts.entero && !Number.isInteger(n)) return mensaje ?? "Debe ser un número entero.";
    if (opts.min !== undefined && n < opts.min)
      return mensaje ?? (opts.min === 0 ? "No puede ser negativo." : `No puede ser menor que ${opts.min}.`);
    if (opts.max !== undefined && n > opts.max) return mensaje ?? `No puede pasar de ${opts.max}.`;
    return undefined;
  };

/** Monto de dinero: número y mayor que cero. */
export const monto =
  <V,>(mensaje = "El monto debe ser mayor que cero."): Regla<V> =>
  (v) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return mensaje;
    return undefined;
  };

/**
 * Correo. Se valida con una regla laxa a propósito (algo@algo.algo): las reglas
 * estrictas rechazan direcciones legítimas y aquí el correo sólo sirve para
 * escribirle a la persona, no para autenticar.
 *
 * OJO con las MAYÚSCULAS: el correo se guarda tal cual y un `Pepe@…` distinto de
 * `pepe@…` le abrió a un empleado una segunda cuenta vacía sin rol. Quien guarde
 * un correo debe bajarlo a minúsculas al enviarlo, no sólo validarlo aquí.
 */
export const email =
  <V,>(mensaje = "El correo no parece válido."): Regla<V> =>
  (v) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? undefined : mensaje;
  };

/** Celular/teléfono, con la misma regla que usa el backend (10 dígitos → +57). */
export const telefono =
  <V,>(mensaje = "El número debe tener 10 dígitos (celular colombiano)."): Regla<V> =>
  (v) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    return isValidPhone(s) ? undefined : mensaje;
  };

/** Cédula o NIT: sólo dígitos (el NIT va sin el guion del dígito de verificación). */
export const documento =
  <V,>(mensaje = "Escribe sólo los números del documento (sin puntos ni guiones)."): Regla<V> =>
  (v) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    return /^\d{5,15}$/.test(s) ? undefined : mensaje;
  };

/** Fecha que no puede estar en el futuro (un movimiento de caja, un pago). */
export const noFutura =
  <V,>(mensaje = "La fecha no puede ser futura."): Regla<V> =>
  (v) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    const hoy = new Date().toISOString().slice(0, 10);
    return s > hoy ? mensaje : undefined;
  };

/** Debe ser igual a otro campo del mismo formulario (repetir contraseña). */
export const igualA =
  <T extends Record<string, unknown>>(otro: keyof T, mensaje = "Los dos valores no coinciden."): Regla<unknown, T> =>
  (v, form) => {
    const s = String(v ?? "");
    if (!s) return undefined;
    return s === String(form[otro] ?? "") ? undefined : mensaje;
  };

/** Escape para lo que no cubre el resto. */
export const patron =
  <V,>(re: RegExp, mensaje: string): Regla<V> =>
  (v) => {
    const s = String(v ?? "").trim();
    if (!s) return undefined;
    return re.test(s) ? undefined : mensaje;
  };

/**
 * Regla condicional: sólo aplica si se cumple algo del propio formulario.
 * Ej. el documento del tercero sólo es obligatorio si se va a guardar en el
 * directorio; quien no lo tenga a mano desmarca la casilla y sigue.
 */
export const cuando =
  <T extends Record<string, unknown>, V = unknown>(condicion: (form: T) => boolean, regla: Regla<V, T>): Regla<V, T> =>
  (v, form) => (condicion(form) ? regla(v, form) : undefined);
