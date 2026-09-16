"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { NOM_KEYS } from "@/components/subscribers/DireccionFields";
import { useValidacion, type Reglas, type Validacion } from "@/lib/useValidacion";

/* ── Piezas de lectura (viven aquí porque las comparten la ficha y las tarjetas
      que se editan en sitio) ─────────────────────────────────────── */

export function Card({ title, icon, action, children }: { title: string; icon: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Icon name={icon} size={15} className="text-brand" />
          {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border-subtle py-1.5 last:border-0">
      <span className="text-[12px] text-text-tertiary">{label}</span>
      <span className="text-right text-[12px] font-medium text-text-primary">{value ?? "—"}</span>
    </div>
  );
}

/** Botón de copiar al portapapeles con feedback breve. */
export function CopyBtn({ text }: { text?: string | null }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      title="Copiar"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="tap shrink-0 text-text-tertiary transition-colors hover:text-text-secondary"
    >
      <Icon name={done ? "check" : "copy"} size={13} className={done ? "text-success-text" : ""} />
    </button>
  );
}

/** Fila de contacto accionable: se oculta si no hay valor. */
export function ContactRow({ icon, value, href, onClick, copy }: { icon: string; value?: string | null; href?: string | null; onClick?: () => void; copy?: boolean }) {
  if (!value) return null;
  const content = onClick ? (
    <button type="button" onClick={onClick} className="truncate text-left text-text-primary hover:text-brand hover:underline">
      {value}
    </button>
  ) : href ? (
    <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="truncate text-text-primary hover:text-brand hover:underline">
      {value}
    </a>
  ) : (
    <span className="truncate text-text-primary">{value}</span>
  );
  return (
    <div className="flex items-center gap-2.5 border-b border-border-subtle py-2 text-[13px] last:border-0">
      <Icon name={icon} size={14} className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1">{content}</span>
      {copy && <CopyBtn text={value} />}
    </div>
  );
}

/* ── Edición en sitio ──────────────────────────────────────────── */

/** El formulario del cliente en plano: una clave por casilla, todo texto. */
export type Borrador = Record<string, string>;

/** La ficha que devuelve el servidor tras guardar (`GET/PATCH /subscribers/:id`). */
export type FichaDetalle = Record<string, unknown>;

/** Borrador vacío: el hook de validación necesita valores aunque no se esté editando. */
const VACIO: Borrador = {};

const str = (v: unknown) => (v == null ? "" : String(v));
/** Las fechas llegan en ISO y se editan como `yyyy-mm-dd`. */
const fecha = (v: unknown) => (v ? String(v).slice(0, 10) : "");

/**
 * Lo que devuelve `GET /subscribers/:id/form`, pasado a borrador plano.
 *
 * Es el mismo mapeo que hace el wizard al abrir en modo edición: la ficha
 * (`GET /subscribers/:id`) trae los datos ya resueltos para leerlos —el barrio
 * por su nombre, la dirección armada— y con eso no se puede editar; el `/form`
 * los trae crudos, como se guardan.
 */
export function borradorDeFicha(d: Record<string, unknown>): Borrador {
  const nom = (d.nomenclature ?? {}) as Record<string, unknown>;
  return {
    firstName: str(d.firstName), secondName: str(d.secondName),
    lastName1: str(d.lastName1), lastName2: str(d.lastName2), companyName: str(d.companyName),
    customerType: str(d.customerType), docType: str(d.docType) || "CC", docNumber: str(d.docNumber),
    email: str(d.email), phone1: str(d.phone1), phone2: str(d.phone2),
    birthDate: fecha(d.birthDate), estrato: str(d.estrato), suscripcion: str(d.suscripcion),
    contractDate: fecha(d.contractDate), clausula: str(d.clausula), departmentRef: str(d.departmentRef), cityRef: str(d.cityRef),
    localityRef: str(d.localityRef), neighborhood: str(d.neighborhood), addressLine: str(d.addressLine),
    branchId: str(d.branchId),
    pppUsername: str(d.pppUsername), pppPassword: str(d.pppPassword), pppProfile: str(d.pppProfile),
    ipRemote: str(d.ipRemote), ipLocal: str(d.ipLocal), installTech: str(d.installTech),
    macEquipo: str(d.macEquipo), macOnt: str(d.macOnt),
    netComment: str(d.netComment), vlan: str(d.vlan),
    ...Object.fromEntries(NOM_KEYS.map((k) => [k, str(nom[k])])),
  };
}

/**
 * El PATCH con lo que de verdad se TOCÓ en esta tarjeta.
 *
 * Sólo viajan los campos de la tarjeta que cambiaron: `PATCH /subscribers/:id`
 * es parcial, y mandar el formulario entero desde una tarjeta que sólo edita el
 * teléfono haría dos cosas que nadie pidió — sellar `editedAt` sobre datos que
 * no se tocaron (el sync deja de traerlos del legacy) y disparar la escritura al
 * Mikrotik, que el backend decide justamente por si vienen los campos de red.
 */
export function parcheDeCampos(campos: readonly string[], f: Borrador, base: Borrador) {
  const cambio = (k: string) => String(f[k] ?? "") !== String(base[k] ?? "");
  const out: Record<string, unknown> = {};
  for (const k of campos) {
    // La dirección va entera y aparte (es un objeto, no una columna).
    if ((NOM_KEYS as readonly string[]).includes(k)) continue;
    if (!cambio(k)) continue;
    // La VLAN es un número dentro del comentario del secret: vacía = quitarla.
    if (k === "vlan") { out.vlan = f.vlan === "" ? null : Number(f.vlan); continue; }
    // La cláusula viaja como número; vacía = quitarle la permanencia, que es una
    // decisión que se toma y el backend acepta como `null`.
    if (k === "clausula") { out.clausula = f.clausula === "" ? null : Number(f.clausula); continue; }
    out[k] = f[k];
  }
  const casillas = campos.filter((k) => (NOM_KEYS as readonly string[]).includes(k));
  if (casillas.some(cambio)) {
    out.nomenclature = Object.fromEntries(NOM_KEYS.map((k) => [k, f[k] || null]));
  }
  return out;
}

/**
 * Una tarjeta de la ficha que se edita DONDE SE LEE.
 *
 * El lápiz de la cabecera cambia la tarjeta por su formulario, se guarda y
 * vuelve a lo que había, con el dato ya corregido. Antes cualquier corrección
 * —un teléfono mal tecleado, una VLAN, la fecha del contrato— obligaba a abrir
 * el wizard de edición entero y adivinar en cuál de sus cuatro pasos vivía el
 * campo.
 *
 * Mientras se edita, la tarjeta ocupa la fila entera (`lg:col-span-3`): en un
 * tercio de ancho, los seis desplegables de la dirección no caben.
 */
export function CardEditable({
  title, icon, subscriberId, campos, puedeEditar, onSaved, accion, reglas, editor, children,
}: {
  title: string;
  icon: string;
  subscriberId: string;
  /** Claves del borrador que edita esta tarjeta (lo que puede viajar en el PATCH). */
  campos: readonly string[];
  puedeEditar: boolean;
  /** La ficha fresca que devuelve el guardado, para repintar sin recargar. */
  onSaved: (detalle: FichaDetalle) => void;
  /** Botones que sólo tienen sentido leyendo (cambiar el WiFi, ver el mapa…). */
  accion?: React.ReactNode;
  /** Validación en vivo del formulario (ver `lib/useValidacion.ts`). */
  reglas?: Reglas<Borrador>;
  /** El formulario: recibe el borrador, cómo parchearlo y la validación. */
  editor: (f: Borrador, set: (patch: Borrador) => void, v: Validacion<Borrador>) => React.ReactNode;
  children: React.ReactNode;
}) {
  const { authFetch } = useAuth();
  const [f, setF] = useState<Borrador | null>(null);
  const [base, setBase] = useState<Borrador | null>(null);
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  // El error sale bajo el campo al salir de él (regla de la casa), no en un toast
  // al guardar. `VACIO` es sólo para que el hook tenga valores mientras se lee.
  const v = useValidacion<Borrador>(f ?? VACIO, reglas ?? {});

  const editando = f !== null;
  const cerrar = () => { setF(null); setBase(null); v.limpiar(); };

  async function abrir() {
    setCargando(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}/form`);
      if (!res.ok) throw new Error("No se pudieron cargar los datos del cliente");
      const b = borradorDeFicha(await res.json());
      // Se estrena limpio: si no, el intento anterior lo abre en rojo.
      v.limpiar();
      setBase(b);
      setF(b);
    } catch (e) {
      toast(mensajeDeError(e) ?? "No se pudo abrir la edición", "alert-circle");
    } finally {
      setCargando(false);
    }
  }

  async function guardar() {
    if (!f || !base) return;
    // Marca de golpe lo que falte y no llama al servidor con un correo a medias.
    if (!v.revisar()) return;
    const patch = parcheDeCampos(campos, f, base);
    // Sin cambios no se llama al servidor: guardar por guardar sellaría `editedAt`.
    if (!Object.keys(patch).length) { cerrar(); return; }
    setGuardando(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(Array.isArray(m?.message) ? m.message[0] : m?.message ?? "No se pudo guardar");
      }
      const out = (await res.json()) as FichaDetalle;
      // Al tocar la conexión, el servidor lleva lo guardado al Mikrotik. Si eso falló
      // hay que decirlo: la ficha quedó bien pero el abonado sigue como estaba en la red.
      const router = out.router as { ok: boolean; dryRun: boolean; message?: string } | undefined;
      if (router && !router.ok) {
        toast(router.message ?? "Se guardó, pero no llegó al router", "alert-circle");
      } else {
        toast(
          router
            ? `Datos guardados · ${router.dryRun ? "router en simulación" : "sincronizado con el Mikrotik"}`
            : "Datos guardados",
        );
      }
      onSaved(out);
      cerrar();
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al guardar", "alert-circle");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className={`rounded-xl border bg-surface p-4 shadow-sm ${editando ? "border-brand/50 lg:col-span-3" : "border-border-subtle"}`}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Icon name={icon} size={15} className="text-brand" />
          {title}
          {editando && <span className="text-[11px] font-medium text-text-tertiary">· editando</span>}
        </div>
        {!editando && (
          <div className="flex items-center gap-1">
            {accion}
            {puedeEditar && (
              <button
                type="button"
                onClick={() => void abrir()}
                disabled={cargando}
                title={`Editar ${title.toLowerCase()}`}
                aria-label={`Editar ${title.toLowerCase()}`}
                className="tap inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-2 hover:text-brand disabled:opacity-50"
              >
                <Icon name={cargando ? "loader" : "pencil"} size={14} className={cargando ? "animate-spin" : ""} />
              </button>
            )}
          </div>
        )}
      </div>

      {editando ? (
        <form onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
          {editor(f, (patch) => setF((p) => ({ ...(p as Borrador), ...patch })), v)}
          <div className="mt-3 flex justify-end gap-2 border-t border-border-subtle pt-3">
            <Button type="button" variant="secondary" size="sm" onClick={cerrar} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={guardando}>
              <Icon name={guardando ? "loader" : "check"} size={14} className={guardando ? "animate-spin" : ""} />
              {guardando ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </form>
      ) : (
        children
      )}
    </div>
  );
}
