import { redirect } from "next/navigation";

/**
 * El envío masivo salió de Configuración a su propia sección (2026-09-14): se usa
 * cada mes, no se configura una vez. Se deja la ruta vieja redirigiendo para no
 * romper enlaces guardados ni los manuales que la citan.
 */
export default function EnvioMasivoMovido() {
  redirect("/whatsapp/masivo");
}
