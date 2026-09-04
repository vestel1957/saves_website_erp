"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError, objetoJson } from "@/lib/errores";
import { fmtDate } from "@/lib/format";

/** Donde entra el cliente a pagar. Se enseña para poder dictarlo con la clave. */
const URL_PORTAL = "https://vestel.com.co/crm/user/login";

/**
 * Alfabeto de la clave sugerida: sin O/0 ni I/l/1, que son las que se equivocan
 * cuando la clave se dicta por teléfono. Todo en mayúsculas por lo mismo.
 */
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function sugerir(largo = 8) {
  const bytes = new Uint32Array(largo);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => ALFABETO[n % ALFABETO.length]).join("");
}

type Credencial = {
  usuario: string | null;
  tieneCuenta: boolean;
  puede: boolean;
  motivo: string | null;
  nombre: string | null;
  email: string | null;
  activa: boolean;
  ultimoCambio: { fecha: string; porQuien: string | null } | null;
};

/** Botón de copiar con acuse breve. */
function Copiar({ text, label }: { text: string; label?: string }) {
  const [hecho, setHecho] = useState(false);
  return (
    <button
      type="button"
      title="Copiar"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setHecho(true);
        setTimeout(() => setHecho(false), 1200);
      }}
      className="tap inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-text-tertiary transition-colors hover:text-text-secondary"
    >
      <Icon name={hecho ? "check" : "copy"} size={13} className={hecho ? "text-success-text" : ""} />
      {label && <span>{hecho ? "Copiado" : label}</span>}
    </button>
  );
}

/**
 * Contraseña del cliente para PAGAR EN LÍNEA (portal `vestel.com.co/crm`).
 *
 * Es la misma opción que el sistema anterior tenía en la ficha del cliente
 * ("Change Password"), y sigue el mismo camino: la clave se le fija al portal, que
 * es quien manda sobre su propia base de cuentas.
 *
 * OJO con el usuario: no es el correo ni el número de abonado, es el ID del cliente
 * en el sistema anterior — el portal entra comparando ese número contra la casilla
 * que en pantalla llama "email". Por eso el modal lo enseña con botón de copiar: es
 * la mitad de la respuesta que el cliente viene a pedir.
 *
 * NO tiene nada que ver con la contraseña del empleado ni con el portal de
 * autoservicio de este sistema (que entra con abonado + documento).
 */
export function ClavePortalModal({
  subscriberId,
  nombreCliente,
  open,
  onClose,
}: {
  subscriberId: string;
  nombreCliente?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { authFetch } = useAuth();
  const [cred, setCred] = useState<Credencial | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clave, setClave] = useState("");
  const [busy, setBusy] = useState(false);
  /** Lo fijado en esta sesión: la clave sólo se puede enseñar aquí y ahora. */
  const [hecha, setHecha] = useState<{ usuario: string; clave: string } | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await authFetch(`/online-payments/clave/${subscriberId}`);
      if (!res.ok) throw new Error((await objetoJson<any>(res))?.message || "No se pudo consultar el portal");
      setCred(await res.json());
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo consultar el portal de pagos"));
    } finally {
      setCargando(false);
    }
  }, [authFetch, subscriberId]);

  useEffect(() => {
    if (!open) return;
    setClave("");
    setHecha(null);
    void cargar();
  }, [open, cargar]);

  async function guardar() {
    if (clave.trim().length < 6) return;
    setBusy(true);
    try {
      const res = await authFetch(`/online-payments/clave/${subscriberId}`, {
        method: "POST",
        body: JSON.stringify({ password: clave.trim() }),
      });
      if (!res.ok) throw new Error((await objetoJson<any>(res))?.message || "No se pudo cambiar la contraseña");
      const r = await res.json();
      setHecha({ usuario: r.usuario, clave: clave.trim() });
      toast(r.creada ? "Cuenta del portal creada" : "Contraseña del portal actualizada", "check");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo cambiar la contraseña"), "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  const mensaje = hecha
    ? `Para pagar en línea:\n${URL_PORTAL}\nUsuario: ${hecha.usuario}\nContraseña: ${hecha.clave}`
    : "";

  return (
    <Modal open={open} onClose={onClose} title="Contraseña para pagar en línea">
      <div className="flex flex-col gap-3">
        {cargando ? (
          <p className="py-4 text-center text-[12px] text-text-tertiary">Consultando el portal…</p>
        ) : error ? (
          <div className="rounded-lg border border-error/40 bg-error-soft p-3 text-[12px] text-error-text">{error}</div>
        ) : hecha ? (
          /* Hecho: la clave se enseña UNA vez. No queda guardada en ningún sitio
             —ni aquí ni en el portal, que sólo tiene su hash—, así que si se cierra
             sin copiarla hay que volver a fijar otra. */
          <>
            <div className="flex flex-col gap-2 rounded-lg border border-success/40 bg-success-soft p-3">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-success-text">
                <Icon name="check" size={16} /> Listo. Ya puede entrar a pagar.
              </div>
              <dl className="flex flex-col gap-1 text-[12px]">
                <div className="flex items-center gap-2">
                  <dt className="w-20 text-text-tertiary">Usuario</dt>
                  <dd className="flex-1 font-mono font-semibold text-text-primary">{hecha.usuario}</dd>
                  <Copiar text={hecha.usuario} />
                </div>
                <div className="flex items-center gap-2">
                  <dt className="w-20 text-text-tertiary">Contraseña</dt>
                  <dd className="flex-1 font-mono font-semibold text-text-primary">{hecha.clave}</dd>
                  <Copiar text={hecha.clave} />
                </div>
              </dl>
              <p className="text-[11px] text-text-tertiary">
                Apúntala o cópiala ahora: no se puede volver a consultar, sólo fijar una nueva.
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Copiar text={mensaje} label="Copiar mensaje para el cliente" />
              <Button onClick={onClose}>Cerrar</Button>
            </div>
          </>
        ) : (
          <>
            {/* El usuario del portal: la otra mitad de lo que el cliente pregunta. */}
            <div className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-surface-2 p-3 text-[12px]">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-text-tertiary">Cliente</span>
                <span className="flex-1 truncate font-medium text-text-primary">{cred?.nombre || nombreCliente || "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-text-tertiary">Usuario</span>
                <span className="flex-1 font-mono font-semibold text-text-primary">{cred?.usuario ?? "—"}</span>
                {cred?.usuario && <Copiar text={cred.usuario} />}
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-text-tertiary">Portal</span>
                <a href={URL_PORTAL} target="_blank" rel="noreferrer" className="flex-1 truncate text-brand hover:underline">
                  {URL_PORTAL}
                </a>
              </div>
              {cred?.ultimoCambio && (
                <div className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-text-tertiary">Último cambio</span>
                  <span className="flex-1 text-text-secondary">
                    {fmtDate(cred.ultimoCambio.fecha)}
                    {cred.ultimoCambio.porQuien ? ` · ${cred.ultimoCambio.porQuien}` : ""}
                  </span>
                </div>
              )}
            </div>

            {!cred?.puede ? (
              <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-[12px] text-text-secondary">
                {cred?.motivo ?? "Este cliente todavía no puede tener clave del portal."}
              </div>
            ) : (
              <>
                {!cred.tieneCuenta && (
                  <p className="text-[12px] text-text-secondary">
                    Este cliente aún no tiene cuenta en el portal. Al guardar se le crea con la
                    contraseña que escribas.
                  </p>
                )}
                {cred.tieneCuenta && !cred.activa && (
                  <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-[12px] text-text-secondary">
                    La cuenta está inhabilitada en el portal: aunque le cambies la contraseña, no
                    podrá entrar hasta que allá la reactiven.
                  </div>
                )}

                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-text-secondary">Contraseña nueva</span>
                  <div className="flex gap-2">
                    {/* Va a la vista, como en el sistema anterior: quien atiende la
                        dicta en el momento y un punto negro no se puede dictar. */}
                    <Input
                      value={clave}
                      onChange={(e) => setClave(e.target.value)}
                      placeholder="Mínimo 6 caracteres"
                      autoComplete="off"
                      spellCheck={false}
                      className="flex-1 font-mono"
                    />
                    <Button type="button" variant="secondary" onClick={() => setClave(sugerir())}>
                      Sugerir
                    </Button>
                  </div>
                  <span className="text-[11px] text-text-tertiary">
                    Sin tildes ni ñ: el portal no las admite.
                  </span>
                </label>

                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={onClose}>Cancelar</Button>
                  <Button onClick={guardar} disabled={busy || clave.trim().length < 6}>
                    {busy ? "Guardando…" : "Guardar contraseña"}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
