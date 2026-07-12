"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/context/AuthProvider";

const DEMO_ACCOUNTS = [
  { label: "Superadmin", email: "admin@bhdc.dev", password: "admin123", icon: "shield-check", hint: "Acceso total" },
  { label: "Contador", email: "contador@bhdc.dev", password: "contador123", icon: "calculator", hint: "Contabilidad" },
  { label: "Jefe de bodega", email: "bodega@bhdc.dev", password: "bodega123", icon: "warehouse", hint: "Inventario" },
  { label: "Auditoría", email: "consulta@bhdc.dev", password: "consulta123", icon: "search", hint: "Solo lectura" },
];

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

  function quickFill(account: (typeof DEMO_ACCOUNTS)[number]) {
    setEmail(account.email);
    setPassword(account.password);
    setError("");
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

        <div className="w-full max-w-sm">
          {/* logo compacto para móvil */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-vestel.png" alt="Vestel" className="h-10 w-auto shrink-0" />
          </div>

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
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary transition-colors hover:text-text-secondary"
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                >
                  <Icon name={showPassword ? "eye-off" : "eye"} size={16} />
                </button>
              </div>
            </div>

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
          </form>

          {/* accesos rápidos demo */}
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-3">
              <span className="h-px flex-1 bg-border-subtle" />
              <span className="text-[11px] font-medium text-text-tertiary">
                Cuentas de demostración
              </span>
              <span className="h-px flex-1 bg-border-subtle" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((a) => (
                <button
                  key={a.email}
                  type="button"
                  onClick={() => quickFill(a)}
                  className="group flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-left transition-colors hover:border-border-default hover:bg-surface-2"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 group-hover:bg-surface">
                    <Icon name={a.icon} size={14} className="text-brand" />
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate text-[12px] font-semibold text-text-primary">
                      {a.label}
                    </span>
                    <span className="truncate text-[10px] text-text-tertiary">{a.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
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
