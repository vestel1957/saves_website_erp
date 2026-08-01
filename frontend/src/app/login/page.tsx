"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { RecuperarClave } from "@/components/login/RecuperarClave";
import { useAuth } from "@/context/AuthProvider";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { login } = useAuth();
  const next = params.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  /** El asistente de recuperación reemplaza al formulario (no es un modal encima). */
  const [recuperando, setRecuperando] = useState(false);
  const [recuperada, setRecuperada] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await login(email, password);
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Panel de marca (izquierda) */}
      <aside className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-sidebar p-12 lg:flex">
        <div className="brand-gradient pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full opacity-20 blur-3xl" />
        <div className="brand-gradient pointer-events-none absolute -bottom-32 -left-20 h-96 w-96 rounded-full opacity-10 blur-3xl" />

        <div className="relative flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-vestel.png" alt="Vestel" className="h-14 w-auto shrink-0" />
        </div>

        <div className="relative max-w-md">
          <h2 className="text-[28px] font-bold leading-tight text-text-primary">
            Un solo lugar para operar todo tu negocio.
          </h2>
          <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
            Contabilidad de partida doble, inventario en tiempo real y control de
            acceso por roles. Cada usuario ve exactamente lo que le corresponde.
          </p>
          <ul className="mt-8 flex flex-col gap-3">
            {[
              { icon: "shield-check", text: "Acceso basado en roles (RBAC)" },
              { icon: "circle-dollar-sign", text: "Contabilidad con asientos automáticos" },
              { icon: "boxes", text: "Kardex y costo promedio móvil" },
            ].map((f) => (
              <li key={f.text} className="flex items-center gap-3 text-[13px] text-text-secondary">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sidebar-hover">
                  <Icon name={f.icon} size={15} className="text-brand" />
                </span>
                {f.text}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[11px] text-text-sidebar-muted">
          © {new Date().getFullYear()} Vestel · Todos los derechos reservados
        </p>
      </aside>

      {/* Formulario (derecha) */}
      <main className="flex flex-1 flex-col items-center justify-center p-6">
        <div className="absolute right-5 top-5">
          <ThemeToggle />
        </div>

        {/* logo compacto para móvil */}
        <div className="mb-8 flex w-full max-w-sm items-center gap-2.5 lg:hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-vestel.png" alt="Vestel" className="h-10 w-auto shrink-0" />
        </div>

        {recuperando ? (
          <RecuperarClave
            correoInicial={email}
            onVolver={() => setRecuperando(false)}
            onListo={(correo) => {
              setEmail(correo);
              setPassword("");
              setError("");
              setRecuperando(false);
              setRecuperada(true);
            }}
          />
        ) : (
        <div className="w-full max-w-sm">
          <h1 className="text-[22px] font-bold text-text-primary">Inicia sesión</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">
            Ingresa tus credenciales para acceder a tu espacio de trabajo.
          </p>

          <form onSubmit={submit} className="mt-7 flex flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-text-secondary">
                Correo electrónico
              </label>
              <div className="relative">
                <Icon
                  name="user"
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
                />
                <input
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@empresa.com"
                  className="w-full rounded-lg border border-border-default bg-surface px-3 py-2.5 pl-9 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-border-focus"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-text-secondary">
                Contraseña
              </label>
              <div className="relative">
                <Icon
                  name="lock"
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
                />
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-border-default bg-surface px-3 py-2.5 pl-9 pr-10 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-border-focus"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="tap absolute right-1 top-1/2 -translate-y-1/2 text-text-tertiary transition-colors hover:text-text-secondary"
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                >
                  <Icon name={showPassword ? "eye-off" : "eye"} size={16} />
                </button>
              </div>
            </div>

            {recuperada && !error && (
              <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success-soft px-3 py-2 text-[12px] text-success-text">
                <Icon name="check" size={15} className="mt-0.5 shrink-0" />
                <span className="min-w-0">Contraseña cambiada. Entra con la nueva.</span>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-error/30 bg-error-soft px-3 py-2 text-[12px] text-error-text">
                <Icon name="alert-circle" size={15} className="shrink-0" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <>
                  <Icon name="loader" size={15} className="animate-spin" />
                  Ingresando…
                </>
              ) : (
                <>
                  Iniciar sesión
                  <Icon name="arrow-right" size={15} />
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => { setRecuperada(false); setRecuperando(true); }}
              className="mx-auto inline-flex items-center gap-1.5 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
            >
              <Icon name="key-round" size={13} /> ¿Olvidaste tu contraseña?
            </button>
          </form>
        </div>
        )}
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
      <LoginForm />
    </Suspense>
  );
}
