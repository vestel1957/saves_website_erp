"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/auth";

/**
 * "Olvidé mi contraseña" — tres pasos en la propia pantalla de ingreso.
 *
 *   1. el correo  →  2. el código que llega a su WhatsApp  →  3. la contraseña nueva
 *
 * Vive aparte del formulario de login (y no en un modal) porque es un camino
 * completo, no un aparte: quien llega aquí no puede entrar, y meterlo en una
 * ventanita encima del formulario que acaba de fallar solo consigue que no sepa
 * dónde está.
 *
 * Dos cosas que conviene no "mejorar":
 *
 *  · **El paso 1 dice siempre lo mismo**, exista o no la cuenta. Es literal lo que
 *    responde el servidor, y es a propósito: esta pantalla la ve cualquiera que
 *    llegue a la IP, y un "ese correo no existe" le regala la lista de empleados a
 *    quien la esté tanteando. Por eso tampoco se muestra a qué número salió.
 *
 *  · **El código se comprueba en el paso 2 pero se gasta en el 3.** Si el paso
 *    intermedio lo consumiera, el último no tendría con qué demostrar nada.
 */

/** Estilo de los campos: el mismo del formulario de al lado, que es standalone. */
const INPUT =
  "w-full rounded-lg border border-border-default bg-surface px-3 py-2.5 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-border-focus";

type Paso = 1 | 2 | 3;

/** Lee el mensaje del backend de una respuesta fallida. */
async function fallo(res: Response, porDefecto: string) {
  const d = await res.json().catch(() => null);
  const m = Array.isArray(d?.message) ? d.message[0] : d?.message;
  return new Error(typeof m === "string" && m.trim() ? m : porDefecto);
}

export function RecuperarClave({
  correoInicial,
  onVolver,
  onListo,
}: {
  /** Lo que ya había tecleado en el login: no se le hace escribirlo otra vez. */
  correoInicial: string;
  onVolver: () => void;
  /** Contraseña cambiada: vuelve al login con el correo puesto. */
  onListo: (email: string) => void;
}) {
  const [paso, setPaso] = useState<Paso>(1);
  const [email, setEmail] = useState(correoInicial);
  const [code, setCode] = useState("");
  const [nueva, setNueva] = useState("");
  const [repite, setRepite] = useState("");
  const [ver, setVer] = useState(false);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  /** ¿El canal puede entregar códigos? Si no, se dice antes de que espere en vano. */
  const [canal, setCanal] = useState<{ live: boolean; whatsappEnabled: boolean } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/auth/password/forgot/available`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setCanal)
      .catch(() => null);
  }, []);

  const canalApagado = canal !== null && (!canal.live || !canal.whatsappEnabled);

  async function pedirCodigo(reenvio = false) {
    setCargando(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/auth/password/forgot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) throw await fallo(res, "No se pudo enviar el código.");
      const d = await res.json();
      setAviso(reenvio ? "Te mandamos otro código." : String(d?.message ?? ""));
      setPaso(2);
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }

  async function comprobarCodigo() {
    setCargando(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/auth/password/forgot/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code }),
      });
      if (!res.ok) throw await fallo(res, "Ese código no sirve.");
      setAviso("");
      setPaso(3);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }

  async function cambiar() {
    setCargando(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/auth/password/forgot/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code, password: nueva }),
      });
      if (!res.ok) throw await fallo(res, "No se pudo cambiar la contraseña.");
      onListo(email.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }

  const errorRepite = repite.length > 0 && repite !== nueva ? "Las contraseñas no coinciden." : "";
  const listoPaso3 = nueva.length >= 8 && nueva === repite;

  return (
    <div className="w-full max-w-sm">
      <button
        type="button"
        onClick={onVolver}
        className="mb-5 inline-flex items-center gap-1.5 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
      >
        <Icon name="arrow-left" size={14} /> Volver a iniciar sesión
      </button>

      <h1 className="text-[22px] font-bold text-text-primary">Recuperar contraseña</h1>
      <p className="mt-1 text-[13px] text-text-tertiary">
        Te mandamos un código de 6 dígitos al WhatsApp vinculado a tu cuenta.
      </p>

      {/* Los tres pasos, siempre a la vista: se sabe cuánto falta. */}
      <ol className="mt-6 flex items-center gap-2">
        {[
          { n: 1 as Paso, t: "Correo" },
          { n: 2 as Paso, t: "Código" },
          { n: 3 as Paso, t: "Contraseña" },
        ].map((p, i) => (
          <li key={p.n} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                paso > p.n
                  ? "bg-success-soft text-success-text"
                  : paso === p.n
                    ? "bg-brand text-on-brand"
                    : "bg-surface-2 text-text-tertiary"
              }`}
            >
              {paso > p.n ? <Icon name="check" size={13} /> : p.n}
            </span>
            <span className={`text-[11.5px] font-medium ${paso === p.n ? "text-text-primary" : "text-text-tertiary"}`}>{p.t}</span>
            {i < 2 && <span className="h-px flex-1 bg-border-subtle" />}
          </li>
        ))}
      </ol>

      {canalApagado && paso === 1 && (
        <p className="mt-5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
          <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            El envío de códigos por WhatsApp está apagado ahora mismo, así que puede que no te llegue nada.
            Si no lo recibes, pídele a sistemas que te restablezca la contraseña.
          </span>
        </p>
      )}

      <div className="mt-5 flex flex-col gap-4">
        {paso === 1 && (
          <>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Correo electrónico</label>
              <input
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && email.trim()) void pedirCodigo(); }}
                placeholder="tu@empresa.com"
                className={INPUT}
              />
              <p className="mt-1.5 text-[11px] leading-snug text-text-tertiary">
                El código va al celular que tengas vinculado en el sistema, no al correo.
              </p>
            </div>
            <Boton onClick={() => void pedirCodigo()} cargando={cargando} disabled={!email.trim()}>
              Enviar código
            </Boton>
          </>
        )}

        {paso === 2 && (
          <>
            {aviso && (
              <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] leading-snug text-text-secondary">
                <Icon name="message-circle" size={15} className="mt-0.5 shrink-0 text-brand" />
                <span className="min-w-0">{aviso}</span>
              </p>
            )}
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Código de 6 dígitos</label>
              <input
                value={code}
                autoFocus
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => { if (e.key === "Enter" && code.length === 6) void comprobarCodigo(); }}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="••••••"
                className={`${INPUT} text-center font-mono text-[24px] font-bold tracking-[0.45em]`}
              />
            </div>
            <Boton onClick={() => void comprobarCodigo()} cargando={cargando} disabled={code.length !== 6}>
              Continuar
            </Boton>
            <button
              type="button"
              onClick={() => void pedirCodigo(true)}
              disabled={cargando}
              className="inline-flex items-center justify-center gap-1.5 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary disabled:opacity-60"
            >
              <Icon name="rotate-cw" size={13} /> Enviar otro código
            </button>
          </>
        )}

        {paso === 3 && (
          <>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Contraseña nueva</label>
              <div className="relative">
                <input
                  type={ver ? "text" : "password"}
                  autoFocus
                  autoComplete="new-password"
                  value={nueva}
                  onChange={(e) => setNueva(e.target.value)}
                  placeholder="Al menos 8 caracteres"
                  className={`${INPUT} pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setVer((v) => !v)}
                  className="tap absolute right-1 top-1/2 -translate-y-1/2 text-text-tertiary transition-colors hover:text-text-secondary"
                  aria-label={ver ? "Ocultar contraseña" : "Mostrar contraseña"}
                >
                  <Icon name={ver ? "eye-off" : "eye"} size={16} />
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-text-secondary">Repite la contraseña</label>
              <input
                type={ver ? "text" : "password"}
                autoComplete="new-password"
                value={repite}
                onChange={(e) => setRepite(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && listoPaso3) void cambiar(); }}
                className={INPUT}
              />
              {errorRepite && <p className="mt-1 text-[11px] text-error-text">{errorRepite}</p>}
            </div>
            <Boton onClick={() => void cambiar()} cargando={cargando} disabled={!listoPaso3}>
              Cambiar contraseña
            </Boton>
          </>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-error/30 bg-error-soft px-3 py-2 text-[12px] text-error-text">
            <Icon name="alert-circle" size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{error}</span>
          </div>
        )}
      </div>

      <p className="mt-6 text-[11px] leading-snug text-text-tertiary">
        El código sirve una sola vez y vence en 10 minutos. Nadie del equipo te lo va a pedir: si te lo
        piden, no lo des y avisa a sistemas.
      </p>
    </div>
  );
}

/** Botón principal del asistente: mismo aspecto que el de "Iniciar sesión". */
function Boton({
  onClick, cargando, disabled, children,
}: { onClick: () => void; cargando: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={cargando || disabled}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      {cargando ? (
        <>
          <Icon name="loader" size={15} className="animate-spin" /> Un momento…
        </>
      ) : (
        <>
          {children}
          <Icon name="arrow-right" size={15} />
        </>
      )}
    </button>
  );
}
