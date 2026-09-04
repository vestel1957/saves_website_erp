/**
 * Normaliza un correo para compararlo y guardarlo: sin espacios y en minúsculas.
 *
 * El correo es la llave de dos cosas a la vez —con él se entra al sistema y con él
 * la ficha del empleado encuentra su cuenta—, y el legacy lo trae tal como lo tecleó
 * cada quien. Comparándolo exacto, 'PEPE@X.COM' y 'pepe@x.com' son dos personas
 * distintas: al empleado su ficha le sale "sin cuenta" y le crean una segunda, vacía
 * de roles, con la que entra y no ve nada.
 */
export function normalizarCorreo(email?: string | null): string {
  return String(email ?? '').trim().toLowerCase();
}
