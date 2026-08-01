"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { TabStrip } from "@/components/ui/TabStrip";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Field, Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { UserAvatar, notifyPhotoChanged } from "@/components/UserAvatar";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { FirmaOtpModal } from "@/components/FirmaOtpModal";
import { cargarPasswordPolicy, pedirPasswordCode, type PasswordOtpPolicy } from "@/lib/passwordOtp";
import {
  applyBrandColor,
  BRAND_PRESETS,
  contrastRatio,
  isValidHex,
  normalizeHex,
  onBrandColor,
  readStoredBrand,
} from "@/lib/brand";
import {
  applyTint,
  contrasteTexto,
  DEFAULT_LEVEL,
  NEUTROS,
  peorContraste,
  readStoredTint,
  superficieCon,
  TINT_LEVELS,
  TINT_PRESETS,
  type Modo,
  type TintLevel,
} from "@/lib/appearance";

type Tab = "cuenta" | "seguridad" | "actividad" | "preferencias" | "accesos";

// "Actividad" es lo que PASÓ con la cuenta (entradas, códigos de firma) y
// "Seguridad" lo que se CONFIGURA (contraseña, código de firma). Estaban juntas y
// la pestaña quedaba larga y mezclada: al entrar a cambiar la clave se leía primero
// un historial que no se iba a tocar.
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "cuenta", label: "Mis datos", icon: "user" },
  { key: "seguridad", label: "Seguridad", icon: "key-round" },
  { key: "actividad", label: "Actividad", icon: "history" },
  { key: "preferencias", label: "Preferencias", icon: "sliders-horizontal" },
  { key: "accesos", label: "Accesos", icon: "shield-check" },
];

type Perfil = {
  account: { id: string; email: string; name: string; isActive: boolean; createdAt: string; whatsappPhone: string | null };
  staff: null | {
    id: string;
    name: string;
    docNumber: string | null;
    phone: string | null;
    phoneAlt: string | null;
    address: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    rh: string | null;
    eps: string | null;
    pension: string | null;
    area: string | null;
    entryDate: string | null;
    lastLogin: string | null;
  };
  hasPhoto: boolean;
  access: {
    isSuperadmin: boolean;
    roles: { key: string; name: string; description: string | null }[];
    permissionCount: number;
    groups: { group: string; items: { key: string; label: string }[] }[];
    sedes: { legacyId: number; name: string }[];
    caja: string | null;
  };
};

/** Campos del formulario de datos personales (todos texto libre). */
const CAMPOS: { key: keyof NonNullable<Perfil["staff"]>; label: string; hint?: string }[] = [
  { key: "name", label: "Nombre completo" },
  { key: "docNumber", label: "Documento" },
  { key: "phone", label: "Teléfono" },
  { key: "phoneAlt", label: "Teléfono alterno" },
  { key: "address", label: "Dirección" },
  { key: "city", label: "Ciudad" },
  { key: "region", label: "Departamento" },
  { key: "country", label: "País" },
  { key: "rh", label: "Grupo sanguíneo (RH)" },
  { key: "eps", label: "EPS" },
  { key: "pension", label: "Fondo de pensiones" },
];

const fecha = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" }) : "—";

const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Tarjeta blanca estándar de la app. */
function Card({ title, icon, children, action, className = "" }: { title?: string; icon?: string; children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-border-subtle bg-surface p-4 sm:p-5 ${className}`}>
      {title && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-[14px] font-bold text-text-primary">
            {icon && <Icon name={icon} size={15} className="text-brand" />}
            {title}
          </h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Par etiqueta/valor en modo lectura. */
function Dato({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-[11px] font-semibold text-text-tertiary">{label}</span>
      <span className="block truncate text-[13px] text-text-primary">{value || "—"}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mis datos                                                                  */
/* -------------------------------------------------------------------------- */

function TabCuenta({ perfil, onSaved }: { perfil: Perfil; onSaved: (p: Perfil) => void }) {
  const { authFetch, refresh } = useAuth();
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(CAMPOS.map((c) => [c.key, (perfil.staff?.[c.key] as string | null) ?? ""])),
  );
  const [saving, setSaving] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function guardar() {
    setSaving(true);
    try {
      const res = await authFetch("/profile", { method: "PATCH", body: JSON.stringify(form) });
      const body = await res.json();
      if (!res.ok) throw new Error(Array.isArray(body?.message) ? body.message[0] : body?.message);
      onSaved(body as Perfil);
      // El nombre pudo cambiar: el sidebar lo lee de la sesión, no del perfil.
      await refresh();
      toast("Datos actualizados", "check");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudieron guardar los datos"), "x");
    } finally {
      setSaving(false);
    }
  }

  async function subirFoto(file: File) {
    setSubiendo(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetch("/profile/photo", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message);
      notifyPhotoChanged();
      toast("Foto actualizada", "camera");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo subir la foto"), "x");
    } finally {
      setSubiendo(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function quitarFoto() {
    try {
      const res = await authFetch("/profile/photo", { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message);
      notifyPhotoChanged();
      toast("Foto eliminada", "trash");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo quitar la foto"), "x");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* Tarjeta de identidad */}
      <Card>
        <div className="flex flex-col items-center gap-3 text-center">
          <UserAvatar size={104} className="text-[30px]" />
          {perfil.staff && (
            <div className="flex gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void subirFoto(f); }}
              />
              <Button size="sm" variant="secondary" disabled={subiendo} onClick={() => fileRef.current?.click()}>
                <Icon name={subiendo ? "loader" : "camera"} size={13} className={subiendo ? "animate-spin" : ""} />
                {subiendo ? "Subiendo…" : "Cambiar foto"}
              </Button>
              {perfil.hasPhoto && (
                <Button size="sm" variant="danger" onClick={quitarFoto} title="Quitar foto">
                  <Icon name="trash" size={13} />
                </Button>
              )}
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-text-primary">{perfil.account.name}</p>
            <p className="truncate text-[12px] text-text-tertiary">{perfil.account.email}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {perfil.access.roles.map((r) => (
              <Badge key={r.key} label={r.name} tone="brand" />
            ))}
            {perfil.access.roles.length === 0 && <Badge label="Sin rol asignado" />}
          </div>
        </div>

        <div className="mt-4 grid gap-3 border-t border-border-subtle pt-4">
          <Dato label="Área" value={perfil.staff?.area} />
          <Dato label="Fecha de ingreso" value={fecha(perfil.staff?.entryDate)} />
          <Dato label="Cuenta creada" value={fecha(perfil.account.createdAt)} />
          <Dato label="WhatsApp vinculado" value={perfil.account.whatsappPhone} />
        </div>
        <p className="mt-3 text-[11px] leading-snug text-text-tertiary">
          El área y la fecha de ingreso las administra Recursos Humanos desde la ficha del empleado.
        </p>
      </Card>

      {/* Datos editables */}
      <Card
        title="Datos personales"
        icon="contact"
        action={
          perfil.staff && (
            <Button size="sm" onClick={guardar} disabled={saving}>
              <Icon name={saving ? "loader" : "save"} size={13} className={saving ? "animate-spin" : ""} />
              {saving ? "Guardando…" : "Guardar cambios"}
            </Button>
          )
        }
      >
        {!perfil.staff ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-subtle p-8 text-center">
            <Icon name="user-cog" size={20} className="text-text-tertiary" />
            <p className="text-[13px] font-semibold text-text-primary">Tu cuenta no tiene ficha de empleado</p>
            <p className="max-w-md text-[12px] text-text-tertiary">
              Los datos personales viven en la ficha del empleado, que se vincula a la cuenta por el
              correo. Pídele a sistemas que vincule <strong>{perfil.account.email}</strong> con tu ficha.
              Mientras tanto puedes cambiar tu contraseña y tus preferencias.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {CAMPOS.map((c) => (
              <Field key={c.key} label={c.label} hint={c.hint}>
                <Input value={form[c.key] ?? ""} onChange={set(c.key)} />
              </Field>
            ))}
            <Field label="Correo (usuario de acceso)" hint="Lo cambia sistemas: es la llave de tu sesión.">
              <Input value={perfil.account.email} disabled />
            </Field>
          </div>
        )}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Seguridad                                                                  */
/* -------------------------------------------------------------------------- */

type Login = { id: string; action: string; ipAddress: string | null; createdAt: string };

/* --- Código de firma (OTP por WhatsApp) ----------------------------------- */

type FirmaEstado = {
  channel: "whatsapp";
  phone: string | null;
  phoneMask: string | null;
  source: "propio" | "whatsapp-vinculado" | null;
  verifiedAt: string | null;
  required: boolean;
  live: boolean;
  whatsappEnabled: boolean;
  firmaExigidaEn: string[];
};

type FirmaEnvio = { phoneMask: string | null; expiresAt: string; resendAt: string; simulated: boolean; codigoSimulado?: string };

type FirmaHistorial = {
  id: string;
  purpose: string;
  targetId: string | null;
  phoneMask: string | null;
  simulated: boolean;
  attempts: number;
  createdAt: string;
  estado: "usado" | "vencido" | "pendiente";
};

/** Nombre legible de lo que se firmaba (el backend guarda la clave técnica). */
const PROPOSITO: Record<string, string> = {
  "purchase.approve": "Aprobación de orden de compra",
  "profile.verify": "Prueba del código",
  "equipment.dispatch": "Salida de equipo entre sedes",
  "equipment.receive": "Recepción de equipo entre sedes",
  "material.receive": "Recepción de traspaso de material",
  "password.change": "Cambio de tu contraseña",
  // Este es el que hay que poder ver de un vistazo: si aparece y no fuiste tú,
  // alguien pidió restablecer tu clave desde el panel de sistemas.
  "password.reset": "Restablecimiento de tu contraseña (sistemas)",
};

/**
 * "Código de firma": el segundo factor de las operaciones que se firman.
 *
 * Lo que el usuario administra aquí no es el código —ése lo genera el sistema cada
 * vez y vive cinco minutos— sino A DÓNDE le llega: su celular de WhatsApp. Es la
 * parte que solo él puede saber, y la que hacía falta para que la firma signifique
 * algo más que "tenía la sesión abierta".
 *
 * La prueba de envío no es un adorno: un número mal tecleado no se descubre el día
 * que se configura, se descubre cuando hay una orden de $8 millones esperando y el
 * código no llega.
 */
function CardCodigoFirma() {
  const { authFetch } = useAuth();
  const [estado, setEstado] = useState<FirmaEstado | null>(null);
  const [historial, setHistorial] = useState<FirmaHistorial[]>([]);
  const [tel, setTel] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [envio, setEnvio] = useState<FirmaEnvio | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [code, setCode] = useState("");
  const [verificando, setVerificando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [e, h] = await Promise.all([
        authFetch("/profile/signature").then((r) => (r.ok ? r.json() : null)),
        authFetch("/profile/signature/history").then((r) => (r.ok ? r.json() : [])),
      ]);
      setEstado(e);
      setHistorial(Array.isArray(h) ? h : []);
      setTel(e?.phone ?? "");
    } catch {
      setEstado(null);
    }
  }, [authFetch]);

  useEffect(() => { void cargar(); }, [cargar]);

  async function guardarTelefono() {
    setGuardando(true);
    try {
      const res = await authFetch("/profile/signature/phone", { method: "PUT", body: JSON.stringify({ phone: tel }) });
      const body = await res.json();
      if (!res.ok) throw new Error(Array.isArray(body?.message) ? body.message[0] : body?.message);
      setEstado(body as FirmaEstado);
      setEnvio(null);
      toast("Teléfono de firma guardado", "check");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo guardar el teléfono"), "x");
    } finally {
      setGuardando(false);
    }
  }

  async function quitarTelefono() {
    try {
      const res = await authFetch("/profile/signature/phone", { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message);
      setEstado(body as FirmaEstado);
      setTel(body?.phone ?? "");
      setEnvio(null);
      toast("Teléfono propio quitado", "trash");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo quitar el teléfono"), "x");
    }
  }

  async function probar() {
    setEnviando(true);
    try {
      const res = await authFetch("/profile/signature/test", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(Array.isArray(body?.message) ? body.message[0] : body?.message);
      setEnvio(body as FirmaEnvio);
      setCode("");
      toast(body?.simulated ? "Modo simulación: el código se muestra en pantalla" : "Código enviado a tu WhatsApp", "send");
      void cargar();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo enviar el código"), "x");
    } finally {
      setEnviando(false);
    }
  }

  async function verificar() {
    setVerificando(true);
    try {
      const res = await authFetch("/profile/signature/verify", { method: "POST", body: JSON.stringify({ code }) });
      const body = await res.json();
      if (!res.ok) throw new Error(Array.isArray(body?.message) ? body.message[0] : body?.message);
      setEstado(body as FirmaEstado);
      setEnvio(null);
      setCode("");
      toast("Teléfono verificado: los códigos de firma te llegan bien", "shield-check");
      void cargar();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo verificar el código"), "x");
    } finally {
      setVerificando(false);
    }
  }

  if (!estado) {
    return (
      <Card title="Código de firma" icon="file-signature">
        <div className="h-24 animate-pulse rounded-lg bg-surface-2" />
      </Card>
    );
  }

  const sinTelefono = !estado.phoneMask;

  return (
    <Card
      title="Código de firma"
      icon="file-signature"
      action={
        sinTelefono ? (
          <Badge label="Sin configurar" tone="error" />
        ) : estado.verifiedAt ? (
          <Badge label="Verificado" tone="success" />
        ) : (
          <Badge label="Sin verificar" tone="warning" />
        )
      }
    >
      <p className="mb-3 text-[12px] leading-snug text-text-secondary">
        Las operaciones que se <strong>firman</strong> piden un código de 6 dígitos que el sistema te manda
        por WhatsApp en el momento. Sirve una sola vez y vence en 10 minutos: sin tu celular en la mano,
        nadie puede firmar en tu nombre aunque se siente en tu computador con la sesión abierta.
      </p>

      <ul className="mb-3 grid gap-1">
        {estado.firmaExigidaEn.map((q) => (
          <li key={q} className="flex items-start gap-1.5 text-[12px] text-text-secondary">
            <Icon name="file-signature" size={13} className="mt-0.5 shrink-0 text-brand" />
            <span className="min-w-0">{q}</span>
          </li>
        ))}
      </ul>

      <div className="grid gap-3 border-t border-border-subtle pt-3">
        <Field
          label="Celular que recibe los códigos"
          hint={
            estado.source === "whatsapp-vinculado"
              ? `Hoy usa el WhatsApp que sistemas vinculó a tu cuenta (${estado.phoneMask}). Escribe otro si prefieres recibirlos aparte.`
              : "El celular con WhatsApp que tengas a mano. 10 dígitos (ej. 3001112233)."
          }
        >
          <Input
            value={tel}
            onChange={(e) => setTel(e.target.value)}
            placeholder={estado.source === "whatsapp-vinculado" ? (estado.phoneMask ?? "3001112233") : "3001112233"}
            inputMode="tel"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={guardarTelefono} disabled={guardando || !tel.trim()}>
            <Icon name={guardando ? "loader" : "save"} size={13} className={guardando ? "animate-spin" : ""} />
            {guardando ? "Guardando…" : "Guardar celular"}
          </Button>
          <Button size="sm" variant="secondary" onClick={probar} disabled={enviando || sinTelefono}>
            <Icon name={enviando ? "loader" : "send"} size={13} className={enviando ? "animate-spin" : ""} />
            {enviando ? "Enviando…" : "Enviar código de prueba"}
          </Button>
          {estado.source === "propio" && (
            <Button size="sm" variant="danger" onClick={quitarTelefono} title="Quitar el celular propio">
              <Icon name="trash" size={13} />
            </Button>
          )}
        </div>

        {envio && (
          <div className="grid gap-2 rounded-lg border border-border-subtle bg-surface-2 p-3">
            {envio.simulated ? (
              <p className="text-[12px] leading-snug text-text-secondary">
                Modo <strong>simulación</strong>: no salió ningún WhatsApp. Este es el código que valdría:
                <span className="ml-1 font-mono text-[15px] font-bold tracking-[0.2em] text-warning-text">{envio.codigoSimulado}</span>
              </p>
            ) : (
              <p className="text-[12px] text-text-secondary">
                Escribe el código que le llegó a <strong>{envio.phoneMask}</strong>.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => { if (e.key === "Enter" && code.length === 6) void verificar(); }}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="••••••"
                aria-label="Código de prueba"
                className="w-36 rounded-lg border border-border-default bg-surface px-3 py-2 text-center font-mono text-[17px] font-bold tracking-[0.3em] text-text-primary outline-none focus:border-brand"
              />
              <Button size="sm" onClick={verificar} disabled={code.length !== 6 || verificando}>
                <Icon name={verificando ? "loader" : "shield-check"} size={13} className={verificando ? "animate-spin" : ""} />
                {verificando ? "Verificando…" : "Verificar"}
              </Button>
            </div>
          </div>
        )}

        {/* Avisos: lo que puede hacer que el código no llegue el día que importe. */}
        {sinTelefono && estado.required && (
          <p className="flex items-start gap-1.5 rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">
            <Icon name="shield-alert" size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              No tienes celular para los códigos: hoy no podrías firmar. Guarda tu número aquí arriba.
            </span>
          </p>
        )}
        {!estado.live && (
          <p className="flex items-start gap-1.5 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
            <Icon name="flask-conical" size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              Las firmas están en <strong>modo simulación</strong>: el código no sale por WhatsApp, se muestra
              en pantalla. Sirve para probar; no protege nada hasta que sistemas active el envío real.
            </span>
          </p>
        )}
        {estado.live && !estado.whatsappEnabled && (
          <p className="flex items-start gap-1.5 rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">
            <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0">WhatsApp no está configurado en el servidor: los códigos no van a poder salir. Avisa a sistemas.</span>
          </p>
        )}
        {!estado.required && (
          <p className="text-[11px] leading-snug text-text-tertiary">
            Ahora mismo las firmas <strong>no</strong> están exigiendo el código (lo apagó sistemas). Igual
            conviene tener tu celular listo aquí.
          </p>
        )}
      </div>

      {historial.length > 0 && (
        <div className="mt-4 border-t border-border-subtle pt-3">
          <span className="mb-1.5 block text-[11px] font-semibold text-text-tertiary">Últimos códigos</span>
          <ul className="divide-y divide-border-subtle">
            {historial.map((h) => (
              <li key={h.id} className="flex items-center gap-2.5 py-1.5">
                <Icon
                  name={h.estado === "usado" ? "check" : h.estado === "pendiente" ? "clock" : "x"}
                  size={13}
                  className={h.estado === "usado" ? "text-success-text" : h.estado === "pendiente" ? "text-warning-text" : "text-text-tertiary"}
                />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-text-primary">
                    {PROPOSITO[h.purpose] ?? h.purpose}
                  </span>
                  <span className="block text-[11px] text-text-tertiary">
                    {fechaHora(h.createdAt)} · {h.estado}
                    {h.simulated ? " · simulado" : h.phoneMask ? ` · ${h.phoneMask}` : ""}
                    {h.attempts > 0 ? ` · ${h.attempts} intento(s) fallido(s)` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function TabSeguridad() {
  const { authFetch } = useAuth();
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [repite, setRepite] = useState("");
  const [ver, setVer] = useState(false);
  const [saving, setSaving] = useState(false);
  const [policy, setPolicy] = useState<PasswordOtpPolicy | null>(null);
  const [otpOpen, setOtpOpen] = useState(false);

  useEffect(() => {
    void cargarPasswordPolicy(authFetch, "/profile/password").then(setPolicy);
  }, [authFetch]);

  const errorRepite = repite.length > 0 && repite !== nueva ? "Las contraseñas no coinciden." : undefined;
  const errorNueva = nueva.length > 0 && nueva.length < 8 ? "Mínimo 8 caracteres." : undefined;
  const listo = actual.length > 0 && nueva.length >= 8 && nueva === repite && !saving;

  /** Guarda la contraseña. `code` va solo cuando el cambio pide código. */
  async function guardar(code?: string) {
    setSaving(true);
    try {
      const res = await authFetch("/profile/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: actual, newPassword: nueva, code }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(Array.isArray(body?.message) ? body.message[0] : body?.message);
      setActual(""); setNueva(""); setRepite("");
      toast("Contraseña actualizada", "key-round");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Con código de por medio el error NO se puede tragar en un toast: el diálogo
   * lo muestra dentro ("te quedan 3 intentos") y se queda abierto para reintentar.
   */
  async function cambiar() {
    if (policy?.required) { setOtpOpen(true); return; }
    try {
      await guardar();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo cambiar la contraseña"), "x");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Cambiar contraseña" icon="key-round">
        <div className="grid gap-3">
          <Field label="Contraseña actual" required>
            <Input type={ver ? "text" : "password"} autoComplete="current-password" value={actual} onChange={(e) => setActual(e.target.value)} />
          </Field>
          <Field label="Contraseña nueva" required error={errorNueva} hint="Al menos 8 caracteres.">
            <Input type={ver ? "text" : "password"} autoComplete="new-password" value={nueva} onChange={(e) => setNueva(e.target.value)} />
          </Field>
          <Field label="Repite la contraseña nueva" required error={errorRepite}>
            <Input type={ver ? "text" : "password"} autoComplete="new-password" value={repite} onChange={(e) => setRepite(e.target.value)} />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setVer((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
            >
              <Icon name={ver ? "eye-off" : "eye"} size={13} /> {ver ? "Ocultar" : "Ver"} contraseñas
            </button>
            <Button onClick={cambiar} disabled={!listo}>
              <Icon name={saving ? "loader" : "check"} size={13} className={saving ? "animate-spin" : ""} />
              {saving ? "Guardando…" : "Cambiar contraseña"}
            </Button>
          </div>

          {policy?.required && (
            <p className="flex items-start gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-[11.5px] leading-snug text-text-secondary">
              <Icon name="shield-check" size={14} className="mt-0.5 shrink-0 text-brand" />
              <span className="min-w-0">
                {policy.blocked ? (
                  policy.blocked
                ) : (
                  <>
                    Al confirmar te mandamos un código de 6 dígitos al WhatsApp{" "}
                    <strong>{policy.phoneMask}</strong>. Sin él la contraseña no cambia — así una sesión
                    abierta y sin bloquear no basta para quedarse con tu cuenta.
                  </>
                )}
              </span>
            </p>
          )}

          <p className="text-[11px] leading-snug text-text-tertiary">
            Al cambiarla, la sesión abierta sigue activa hasta que venza (12 h). Si crees que alguien
            más entró con tu cuenta, cámbiala y avísale a sistemas.
          </p>
        </div>
      </Card>

      <CardCodigoFirma />

      {/* El código llega al WhatsApp del propio usuario: es él quien la está cambiando. */}
      <FirmaOtpModal
        open={otpOpen}
        onClose={() => setOtpOpen(false)}
        titulo="Confirma con tu código"
        textoBoton="Cambiar contraseña"
        textoBotonOcupado="Cambiando…"
        icono="key-round"
        queFirma={<>Vas a cambiar la contraseña de tu cuenta.</>}
        solicitar={() => pedirPasswordCode(authFetch, "/profile/password")}
        firmar={(code) => guardar(code)}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Actividad                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Lo que ha pasado con la cuenta. Hoy son las entradas (y los intentos fallidos,
 * que es la señal de que alguien está probando la clave de uno).
 *
 * Vive aparte de Seguridad a propósito: ahí se CONFIGURA (contraseña, código de
 * firma) y aquí se MIRA. Mezclado, quien entraba a cambiar la clave se comía
 * primero un historial que no iba a tocar.
 */
function TabActividad() {
  const { authFetch } = useAuth();
  const [logins, setLogins] = useState<Login[] | null>(null);

  useEffect(() => {
    void authFetch("/profile/logins")
      .then((r) => (r.ok ? r.json() : []))
      .then(setLogins)
      .catch(() => setLogins([]));
  }, [authFetch]);

  return (
    <div className="grid gap-4">
      <Card title="Últimos accesos" icon="history">
        {logins === null ? (
          <div className="h-24 animate-pulse rounded-lg bg-surface-2" />
        ) : logins.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-text-tertiary">Todavía no hay accesos registrados.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {logins.map((l) => {
              const fallo = l.action === "LOGIN_FAILED";
              return (
                <li key={l.id} className="flex items-center gap-2.5 py-2">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${fallo ? "bg-error-soft" : "bg-success-soft"}`}>
                    <Icon name={fallo ? "shield-alert" : "check"} size={13} className={fallo ? "text-error-text" : "text-success-text"} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-semibold text-text-primary">
                      {fallo ? "Intento fallido" : "Inicio de sesión"}
                    </span>
                    <span className="block text-[11px] text-text-tertiary">
                      {fechaHora(l.createdAt)}
                      {l.ipAddress ? ` · ${l.ipAddress}` : ""}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 border-t border-border-subtle pt-3 text-[11px] leading-snug text-text-tertiary">
          Se guardan los últimos 15. Si ves una entrada que no reconoces, cambia tu contraseña en
          Seguridad y avísale a sistemas.
        </p>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Preferencias                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Muestra de un tinte de fondo.
 *
 * Enseña el RESULTADO (canvas teñido con una tarjeta y una línea de texto
 * encima), no el tono crudo: un swatch con el tinte puro no dice nada de cómo va
 * a quedar la pantalla, porque antes de mezclarse se le acota la luminosidad y
 * se aplica en una proporción pequeña. Se previsualiza en el modo que se está
 * viendo, que es el único que el usuario puede juzgar ahora mismo.
 */
function MuestraFondo({
  modo,
  tinte,
  nivel,
  nombre,
  activo,
  onClick,
}: {
  modo: Modo;
  tinte: string | null;
  nivel: TintLevel;
  nombre: string;
  activo: boolean;
  onClick: () => void;
}) {
  const canvas = superficieCon(modo, tinte, nivel, "canvas");
  const surface = superficieCon(modo, tinte, nivel, "surface");
  const texto = NEUTROS[modo].textoDebil;
  return (
    <button
      type="button"
      title={nombre}
      aria-label={`Fondo: ${nombre}`}
      aria-pressed={activo}
      onClick={onClick}
      className={`flex flex-col gap-1 rounded-lg border-2 p-1 transition-transform hover:scale-[1.03] ${
        activo ? "border-brand" : "border-border-subtle"
      }`}
    >
      <span
        className="flex h-11 items-center justify-center rounded-md"
        style={{ background: canvas }}
      >
        <span
          className="flex h-7 w-[80%] items-center gap-1 rounded px-1.5"
          style={{ background: surface }}
        >
          <span className="h-1 flex-1 rounded-full" style={{ background: texto }} />
          {/* los iconos de lucide pintan con currentColor: el color va en el padre */}
          {activo && (
            <span style={{ color: texto }} className="flex">
              <Icon name="check" size={11} />
            </span>
          )}
        </span>
      </span>
      <span className="truncate text-[10.5px] font-semibold text-text-tertiary">{nombre}</span>
    </button>
  );
}

function TabPreferencias() {
  const [dark, setDark] = useState(false);
  const [color, setColor] = useState<string | null>(null); // null = aún no montado
  const [draft, setDraft] = useState("");
  const [tinte, setTinte] = useState<string | null>(null); // null = sin tinte
  const [nivel, setNivel] = useState<TintLevel>(DEFAULT_LEVEL);
  const [tinteDraft, setTinteDraft] = useState("");

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    const c = readStoredBrand();
    setColor(c);
    setDraft(c.toUpperCase());
    const t = readStoredTint();
    setTinte(t.tinte);
    setNivel(t.level);
    setTinteDraft(t.tinte?.toUpperCase() ?? "");
  }, []);

  function setTema(oscuro: boolean) {
    setDark(oscuro);
    document.documentElement.classList.toggle("dark", oscuro);
    localStorage.setItem("theme", oscuro ? "dark" : "light");
  }

  function elegir(hex: string) {
    if (!isValidHex(hex)) return;
    const c = normalizeHex(hex);
    setColor(c);
    setDraft(c.toUpperCase());
    applyBrandColor(c);
  }

  /** Aplica un tinte (o lo quita con `null`) y lo persiste. */
  function elegirTinte(hex: string | null, level: TintLevel = nivel) {
    if (hex !== null && !isValidHex(hex)) return;
    const t = hex === null ? null : normalizeHex(hex);
    setTinte(t);
    setNivel(level);
    setTinteDraft(t?.toUpperCase() ?? "");
    applyTint(t, level);
  }

  const ratio = color ? contrastRatio(color, onBrandColor(color)) : 0;
  // El contraste del fondo se mide en el modo que se está viendo: es el que el
  // usuario puede juzgar ahora mismo.
  const modo: Modo = dark ? "oscuro" : "claro";
  const ratioFondo = contrasteTexto(modo, tinte, nivel);
  const ratioPeor = peorContraste(tinte, nivel);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Apariencia" icon="moon">
        <span className="mb-1.5 block text-[11px] font-semibold text-text-tertiary">Tema</span>
        <div className="flex gap-2">
          {[
            { on: false, label: "Claro", icon: "sun" },
            { on: true, label: "Oscuro", icon: "moon" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => setTema(o.on)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[13px] font-semibold transition-colors ${
                dark === o.on
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-border-default text-text-secondary hover:bg-surface-2"
              }`}
            >
              <Icon name={o.icon} size={15} /> {o.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-snug text-text-tertiary">
          El tema y el color se guardan en este navegador, no en tu cuenta: si entras desde otro
          equipo verás los valores por defecto.
        </p>
      </Card>

      <Card title="Color primario" icon="palette">
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8 lg:grid-cols-4">
          {BRAND_PRESETS.map((p) => (
            <button
              key={p.hex}
              type="button"
              title={p.name}
              // Con nombre: hay dos paletas en esta pantalla y varios tonos se
              // llaman igual en las dos ("Verde" de marca vs. "Verde" de fondo).
              aria-label={`Color primario: ${p.name}`}
              aria-pressed={color === p.hex}
              onClick={() => elegir(p.hex)}
              className={`flex h-11 items-center justify-center rounded-lg border-2 transition-transform hover:scale-105 ${
                color === p.hex ? "border-text-primary" : "border-transparent"
              }`}
              style={{ background: p.hex }}
            >
              {color === p.hex && <Icon name="check" size={16} className="text-white" />}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-end gap-2">
          <Field label="Color personalizado (hex)">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => elegir(draft)}
              onKeyDown={(e) => { if (e.key === "Enter") elegir(draft); }}
              placeholder="#0E7490"
            />
          </Field>
          <span
            className="mb-[1px] flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg text-[11px] font-bold"
            style={{ background: color ?? "transparent", color: color ? onBrandColor(color) : undefined }}
          >
            Aa
          </span>
        </div>
        {color && (
          <p className="mt-2 text-[11px] text-text-tertiary">
            Contraste del texto sobre el color: {ratio.toFixed(2)}:1{" "}
            {ratio >= 4.5 ? "(AA — legible)" : ratio >= 3 ? "(solo texto grande)" : "(bajo, se lee mal)"}
          </p>
        )}
      </Card>

      {/* A todo el ancho: son nueve muestras + intensidad, y en media columna
          quedaban tres filas de swatches y un hueco al lado. */}
      <Card title="Fondo de la interfaz" icon="layers" className="lg:col-span-2">
        <p className="mb-3 text-[12px] leading-snug text-text-secondary">
          Tiñe el fondo, las tarjetas, el menú y los bordes con el tono que elijas. Eliges el
          <strong> tono</strong>, no el fondo: el sistema le ajusta la luminosidad y lo mezcla sobre
          el gris de siempre, para que el texto siga leyéndose igual de bien en claro y en oscuro.
        </p>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
          <MuestraFondo
            modo={modo}
            tinte={null}
            nivel={nivel}
            nombre="Sin tinte"
            activo={tinte === null}
            onClick={() => elegirTinte(null)}
          />
          {TINT_PRESETS.map((p) => (
            <MuestraFondo
              key={p.hex}
              modo={modo}
              tinte={p.hex}
              nivel={nivel}
              nombre={p.name}
              activo={tinte === p.hex}
              onClick={() => elegirTinte(p.hex)}
            />
          ))}
        </div>

        <span className="mb-1.5 mt-4 block text-[11px] font-semibold text-text-tertiary">Intensidad</span>
        <div className="flex max-w-md gap-2">
          {TINT_LEVELS.map((l) => (
            <button
              key={l.key}
              type="button"
              disabled={tinte === null}
              onClick={() => elegirTinte(tinte, l.key)}
              className={`flex-1 rounded-lg border px-3 py-2 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                nivel === l.key
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-border-default text-text-secondary hover:bg-surface-2"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex max-w-md items-end gap-2">
          <Field label="Tono personalizado (hex)">
            <Input
              value={tinteDraft}
              onChange={(e) => setTinteDraft(e.target.value)}
              onBlur={() => tinteDraft.trim() && elegirTinte(tinteDraft)}
              onKeyDown={(e) => { if (e.key === "Enter" && tinteDraft.trim()) elegirTinte(tinteDraft); }}
              placeholder="#475569"
            />
          </Field>
          {tinte && (
            <Button variant="secondary" onClick={() => elegirTinte(null)} title="Quitar el tinte">
              <Icon name="rotate-cw" size={13} /> Restablecer
            </Button>
          )}
        </div>

        <p className="mt-2 text-[11px] leading-snug text-text-tertiary">
          Contraste del texto sobre las tarjetas en modo {dark ? "oscuro" : "claro"}:{" "}
          {ratioFondo.toFixed(2)}:1{" "}
          {ratioFondo >= 4.5 ? "(AA — legible)" : ratioFondo >= 3 ? "(justo, sólo texto grande)" : "(bajo, se lee mal)"}
          {ratioPeor < 4.5 && ratioFondo >= 4.5 && (
            <>
              {" "}· ojo: en el otro modo baja a {ratioPeor.toFixed(2)}:1.
            </>
          )}
        </p>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Accesos                                                                    */
/* -------------------------------------------------------------------------- */

function TabAccesos({ perfil }: { perfil: Perfil }) {
  const { access } = perfil;
  const [abierto, setAbierto] = useState<string | null>(access.groups[0]?.group ?? null);

  return (
    <div className="grid gap-4">
      <Card title="Qué puedo hacer" icon="shield-check">
        <div className="grid gap-3 sm:grid-cols-3">
          <Dato
            label="Roles"
            value={access.roles.length ? access.roles.map((r) => r.name).join(", ") : "Sin rol asignado"}
          />
          <Dato
            label="Sedes a las que accedo"
            value={access.sedes.length ? access.sedes.map((s) => s.name).join(", ") : "Todas las sedes"}
          />
          <Dato label="Caja asignada" value={access.caja} />
        </div>
        {access.isSuperadmin && (
          <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-2 text-[12px] font-semibold text-brand">
            <Icon name="shield" size={14} /> Eres superusuario: tienes acceso a todo el sistema.
          </p>
        )}
        <p className="mt-3 text-[11px] leading-snug text-text-tertiary">
          Los permisos los asigna el superusuario desde la ficha del empleado. Aquí sólo se consultan.
        </p>
      </Card>

      <Card title={`Permisos concedidos (${access.permissionCount})`} icon="lock">
        {access.groups.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-text-tertiary">
            Tu cuenta no tiene permisos asignados. Si no puedes entrar a nada, habla con sistemas.
          </p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {access.groups.map((g) => {
              const on = abierto === g.group;
              return (
                <div key={g.group}>
                  <button
                    type="button"
                    onClick={() => setAbierto(on ? null : g.group)}
                    className="flex w-full items-center gap-2 py-2.5 text-left"
                  >
                    <Icon name={on ? "chevron-down" : "chevron-right"} size={14} className="text-text-tertiary" />
                    <span className="flex-1 text-[13px] font-semibold text-text-primary">{g.group}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-text-tertiary">
                      {g.items.length}
                    </span>
                  </button>
                  {on && (
                    <ul className="grid gap-1.5 pb-3 pl-6 sm:grid-cols-2">
                      {g.items.map((i) => (
                        <li key={i.key} className="flex items-start gap-1.5 text-[12px] text-text-secondary">
                          <Icon name="check" size={13} className="mt-0.5 shrink-0 text-success-text" />
                          <span className="min-w-0">{i.label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PerfilContenido() {
  const { authFetch } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [error, setError] = useState<string | null>(null);

  // La pestaña activa se DERIVA de la URL, no se copia a estado: el menú del
  // sidebar entra con `?tab=…` y, si ya estabas en /perfil, la página no se
  // remonta — con una copia en estado el enlace no habría hecho nada.
  const tabURL = params.get("tab");
  const tab: Tab = TABS.some((t) => t.key === tabURL) ? (tabURL as Tab) : "cuenta";

  const cargar = useCallback(async () => {
    try {
      const res = await authFetch("/profile");
      if (!res.ok) throw new Error("No se pudo cargar el perfil");
      setPerfil(await res.json());
    } catch (e) {
      setError(mensajeDeError(e));
    }
  }, [authFetch]);

  useEffect(() => { void cargar(); }, [cargar]);

  function cambiarTab(k: Tab) {
    router.replace(k === "cuenta" ? "/perfil" : `/perfil?tab=${k}`, { scroll: false });
  }

  if (error) {
    return (
      <>
        <PageHeading icon="user" title="Mi perfil" showBack={false} />
        <p className="rounded-xl border border-border-subtle bg-surface p-6 text-center text-[13px] text-error-text">{error}</p>
      </>
    );
  }
  if (!perfil) return <PageSkeleton />;

  return (
    <>
      <PageHeading
        icon="user"
        title="Mi perfil"
        subtitle={`${perfil.account.name} · ${perfil.access.roles[0]?.name ?? "Sin rol"}`}
        showBack={false}
      />
      <TabStrip tabs={TABS} active={tab} onChange={cambiarTab} />
      {tab === "cuenta" && <TabCuenta perfil={perfil} onSaved={setPerfil} />}
      {tab === "seguridad" && <TabSeguridad />}
      {tab === "actividad" && <TabActividad />}
      {tab === "preferencias" && <TabPreferencias />}
      {tab === "accesos" && <TabAccesos perfil={perfil} />}
    </>
  );
}

export default function PerfilPage() {
  // `useSearchParams` obliga a un límite de Suspense en el App Router.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <PerfilContenido />
    </Suspense>
  );
}
