/**
 * Credenciales PPPoE del alta, calculadas igual que en el backend
 * (`backend/src/subscribers/conexion-alta.ts`).
 *
 * Aquí sólo sirven para ENSEÑAR lo que se va a crear: quien manda es el
 * servidor, que las vuelve a derivar y además numera la variante si el nombre
 * ya está tomado. El formulario no las pide.
 */

/** Sin tildes, sin Ñ, sin espacios ni signos, y en mayúsculas. */
function soloLetrasYNumeros(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // tildes, diéresis y la virgulilla de la Ñ
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

/** Usuario PPPoE: el nombre completo pegado y en mayúsculas. */
export function usuarioPppDe(p: {
  firstName?: string | null; secondName?: string | null;
  lastName1?: string | null; lastName2?: string | null; companyName?: string | null;
}): string {
  const persona = [p.firstName, p.secondName, p.lastName1, p.lastName2]
    .map((s) => soloLetrasYNumeros((s ?? "").trim()))
    .join("");
  return persona || soloLetrasYNumeros((p.companyName ?? "").trim());
}

/** Clave PPPoE: el número de documento. */
export function clavePppDe(docNumber?: string | null): string {
  return (docNumber ?? "").replace(/[^A-Za-z0-9]/g, "");
}

/** Etiqueta comercial de la única tecnología que se vende hoy. */
export const ETIQUETA_FTTH = "FTTH (fibra óptica)";
