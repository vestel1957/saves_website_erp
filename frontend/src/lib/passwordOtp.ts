/**
 * Código de WhatsApp para cambiar una contraseña.
 *
 * Tres pantallas hacen lo mismo con distintas rutas —Mi perfil, Usuarios y roles,
 * y la ficha del empleado—, así que la conversación con el backend vive aquí y no
 * copiada tres veces: consultar si hace falta código, pedirlo y leer el error del
 * servidor tal cual (los mensajes de "ese funcionario no tiene WhatsApp vinculado"
 * o "te quedan 3 intentos" son lo único útil que puede leer quien está atascado).
 *
 * Lo que hay que recordar de este flujo: **el código llega SIEMPRE al WhatsApp del
 * dueño de la cuenta**, no al de quien está en la pantalla. Cuando sistemas le
 * restablece la clave a un funcionario, es el funcionario quien lo recibe y quien
 * lo dicta.
 */

import type { FirmaOtpEnvio } from "@/components/FirmaOtpModal";

/** Lo que responde `…/password/policy`. */
export type PasswordOtpPolicy = {
  required: boolean;
  live: boolean;
  phoneMask: string | null;
  source: "propio" | "whatsapp-vinculado" | null;
  owner: string | null;
  /** Prosa de por qué NO se puede pedir el código (dueño sin WhatsApp), o null. */
  blocked: string | null;
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Lee el mensaje del backend de una respuesta fallida (o uno por defecto). */
async function fallo(res: Response, porDefecto: string): Promise<Error> {
  const d = await res.json().catch(() => null);
  const m = Array.isArray(d?.message) ? d.message[0] : d?.message;
  return new Error(typeof m === "string" && m.trim() ? m : porDefecto);
}

/**
 * ¿Este cambio va a pedir código? Si la consulta falla se asume que SÍ y sin
 * teléfono conocido: mejor un diálogo que quizás sobra que saltarse el código
 * porque un GET no respondió.
 */
export async function cargarPasswordPolicy(authFetch: Fetcher, base: string): Promise<PasswordOtpPolicy> {
  try {
    const res = await authFetch(`${base}/policy`);
    if (!res.ok) throw await fallo(res, "No se pudo consultar la política de contraseñas");
    return (await res.json()) as PasswordOtpPolicy;
  } catch {
    return { required: true, live: false, phoneMask: null, source: null, owner: null, blocked: null };
  }
}

/** Manda el código al WhatsApp del dueño de la cuenta. Lanza con el mensaje del backend. */
export async function pedirPasswordCode(authFetch: Fetcher, base: string): Promise<FirmaOtpEnvio> {
  const res = await authFetch(`${base}/code`, { method: "POST" });
  if (!res.ok) throw await fallo(res, "No se pudo enviar el código");
  return (await res.json()) as FirmaOtpEnvio;
}

/** Aviso del pie del diálogo cuando el código NO es de quien está en la pantalla. */
export const PIE_CODIGO_AJENO =
  "El código es de un solo uso, vence en 10 minutos y solo sirve para este cambio. Pídeselo al titular por " +
  "un canal en el que sepas que es él: si no lo tienes en frente, llámalo — no lo pidas por chat.";
