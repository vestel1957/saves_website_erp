"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { StatCard } from "@/components/ui/StatCard";
import { Icon } from "@/components/Icon";
import { AuthNotice } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { BotonOrden, useTablaOrdenable } from "@/components/ui/tabla-ordenable";
import { PERM } from "@/lib/auth";

type Probe = {
  ok: boolean;
  error?: string;
  phone?: string | null;
  name?: string | null;
  quality?: string | null;
  codeVerification?: string | null;
};

type Uso = {
  hoy: number;
  budget: number | null;
  excedido: boolean;
  historial: { day: string; tokens: number; requests: number }[];
};

type Status = {
  enabled: boolean;
  source: "ajuste" | "env";
  envDefault: boolean;
  allowlist: string[];
  pilot: boolean;
  running: boolean;
  model: string | null;
  agents: string[];
  whatsapp: Probe;
  uso: Uso;
  /** Lo que el bot hace por su cuenta, sin que nadie escriba. */
  conductas: { confirmarSolucion: boolean; avisosProactivos: boolean };
  operativo: boolean;
};

/** Qué ha hecho el bot (endpoint `actividad`). */
type Actividad = {
  conversaciones: { bot: number; pendientes: number; asignadas: number; resueltas: number; esperandoConfirmacion: number };
  mensajes: { hoy: { recibidos: number; enviados: number }; semana: { recibidos: number; enviados: number } };
  notasDeVoz: { total: number; conAudio: number };
  solicitudes: {
    total: number;
    porTipo: { tipo: string; total: number }[];
    revisitasMes: number;
    ultimas: {
      id: string; code: number | null; type: string; subject: string; status: string;
      priority: string; createdAt: string; assigned: string | null;
      abonado: number | null; cliente: string | null;
    }[];
  };
  escaladas: {
    phone: string; motivo: string | null; status: string; lastMessageAt: string | null;
    atiende: string | null; abonado: number | null; cliente: string | null;
  }[];
};

type Handoff = {
  convKey: string;
  handoffAt: string;
  handoffReason: string | null;
  updatedAt: string;
};

type Vinculo = {
  userId: string;
  name: string;
  email: string;
  active: boolean;
  phone: string;
};

/** Funcionario sin vincular. `phoneSugerido` sale de su ficha de empleado. */
type UserOption = { id: string; name: string; email: string; phoneSugerido: string | null };

type Plan = { id: string; name: string; kind: string; price: number; megas: number | null };
type Catalogo = { elegidos: string[]; planes: Plan[] };

const telOf = (convKey: string) => convKey.split(":")[1] ?? convKey;
const miles = (n: number) => n.toLocaleString("es-CO");

export default function ChatbotPage() {
  const { can, authFetch } = useAuth();
  const isAdmin = can(PERM.WHATSAPP_MANAGE);

  const [status, setStatus] = useState<Status | null>(null);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [vinculos, setVinculos] = useState<Vinculo[]>([]);
  const [opciones, setOpciones] = useState<UserOption[]>([]);
  const [nuevoUserId, setNuevoUserId] = useState("");
  const [nuevoTel, setNuevoTel] = useState("");
  const [actividad, setActividad] = useState<Actividad | null>(null);

  // Las dos tablas de esta pantalla se montan a mano; el orden va aparte. Los
  // hooks van aquí arriba porque las tablas se pintan dentro de condicionales.
  const tSolic = useTablaOrdenable(actividad?.solicitudes.ultimas ?? [], {
    orden: (t) => t.code,
    tipo: (t) => t.type,
    cliente: (t) => t.cliente,
    estado: (t) => t.status,
    cuando: (t) => t.createdAt,
  });
  const tUso = useTablaOrdenable(status?.uso.historial ?? [], {
    dia: (d) => String(d.day).slice(0, 10),
    tokens: (d) => d.tokens,
    llamadas: (d) => d.requests,
  });
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [elegidos, setElegidos] = useState<string[]>([]);
  const [lista, setLista] = useState("");
  const [tope, setTope] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const s = await authFetch("/admin/chatbot/status");
    if (s.ok) {
      const data: Status = await s.json();
      setStatus(data);
      setLista(data.allowlist.join(", "));
      setTope(String(data.uso.budget ?? 0));
    }
    const a = await authFetch("/admin/chatbot/actividad");
    if (a.ok) setActividad(await a.json());
    const h = await authFetch("/admin/chatbot/handoffs");
    if (h.ok) setHandoffs(await h.json());
    const v = await authFetch("/admin/chatbot/vinculos");
    if (v.ok) setVinculos(await v.json());
    const o = await authFetch("/admin/chatbot/vinculos/candidatos");
    if (o.ok) setOpciones(await o.json());
    const p = await authFetch("/admin/chatbot/planes");
    if (p.ok) {
      const data: Catalogo = await p.json();
      setCatalogo(data);
      setElegidos(data.elegidos);
    }
  }, [authFetch]);

  useEffect(() => {
    if (isAdmin) void refresh();
  }, [isAdmin, refresh]);

  const accion = async (fn: () => Promise<Response>, exito: string) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fn();
      setMsg(r.ok ? exito : `Error: ${(await r.json().catch(() => ({}))).message ?? r.status}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const conmutarConducta = (cual: "confirmarSolucion" | "avisosProactivos", activa: boolean) =>
    accion(
      () =>
        authFetch(`/admin/chatbot/conductas/${cual}`, {
          method: "PUT",
          body: JSON.stringify({ activa }),
        }),
      activa ? "Conducta activada." : "Conducta desactivada.",
    );

  const conmutar = (enabled: boolean) =>
    accion(
      () =>
        authFetch("/admin/chatbot/switch", {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        }),
      enabled ? "Bot encendido." : "Bot apagado. Los mensajes los atiende una persona.",
    );

  const guardarLista = () =>
    accion(
      () =>
        authFetch("/admin/chatbot/allowlist", {
          method: "PUT",
          body: JSON.stringify({ phones: lista.split(/[,;\s]+/).filter(Boolean) }),
        }),
      "Lista blanca guardada.",
    );

  const guardarTope = () =>
    accion(
      () =>
        authFetch("/admin/chatbot/budget", {
          method: "PUT",
          body: JSON.stringify({ dailyTokens: Number(tope) || 0 }),
        }),
      "Tope diario guardado.",
    );

  const liberar = (convKey: string) =>
    accion(
      () => authFetch(`/admin/chatbot/handoffs/${encodeURIComponent(convKey)}`, { method: "DELETE" }),
      "Conversación devuelta al bot.",
    );

  const vincular = () =>
    accion(
      () =>
        authFetch(`/admin/chatbot/vinculos/${nuevoUserId}`, {
          method: "PUT",
          body: JSON.stringify({ phone: nuevoTel }),
        }),
      "Funcionario vinculado. Ya lo atiende el agente interno con sus permisos.",
    ).then(() => {
      setNuevoUserId("");
      setNuevoTel("");
    });

  const guardarPlanes = () =>
    accion(
      () =>
        authFetch("/admin/chatbot/planes", {
          method: "PUT",
          body: JSON.stringify({ planIds: elegidos }),
        }),
      elegidos.length
        ? `Catálogo guardado: el bot ofrecerá ${elegidos.length} plan(es).`
        : "Catálogo vacío: el bot ofrecerá los planes activos que encuentre.",
    );

  const desvincular = (userId: string) =>
    accion(
      () => authFetch(`/admin/chatbot/vinculos/${userId}`, { method: "DELETE" }),
      "Funcionario desvinculado: si escribe, se le atiende como cliente o público.",
    );

  if (!isAdmin) return <AuthNotice />;

  return (
    <div className="space-y-6">
      <PageHeading
        icon="sparkles"
        title="Agente de WhatsApp"
        subtitle="Interruptor, piloto por lista blanca, funcionarios vinculados, consumo y conversaciones escaladas."
      />

      {msg && <div className="rounded-lg bg-surface-2 px-4 py-2 text-sm text-text-secondary">{msg}</div>}

      {/* ── Estado ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">
                {status?.operativo ? "El bot está atendiendo" : "El bot NO está atendiendo"}
              </h2>
              <Badge
                label={status?.operativo ? "operativo" : "detenido"}
                tone={status?.operativo ? "success" : "error"}
              />
              {status?.pilot && <Badge label="piloto" tone="warning" />}
            </div>
            {/*
              El detalle importa: "encendido" no significa que pueda responder. Se
              enumera cada condición para que se vea CUÁL falta, en vez de un
              semáforo rojo sin explicación.
            */}
            <ul className="space-y-0.5 text-xs text-text-secondary">
              <li>{status?.enabled ? "✓" : "✗"} Interruptor encendido {status && `(según ${status.source})`}</li>
              <li>{status?.running ? "✓" : "✗"} Motor montado {status?.model && `· ${status.model}`}</li>
              <li>{status?.whatsapp.ok ? "✓" : "✗"} WhatsApp puede enviar</li>
              <li>{status && !status.uso.excedido ? "✓" : "✗"} Dentro del tope de tokens</li>
            </ul>
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void refresh()} disabled={busy}>
              <Icon name="refresh-cw" className="mr-1 h-4 w-4" />
              Refrescar
            </Button>
            {status?.enabled ? (
              <Button variant="danger" onClick={() => void conmutar(false)} disabled={busy}>
                <Icon name="toggle-left" className="mr-1 h-4 w-4" />
                Apagar el bot
              </Button>
            ) : (
              <Button onClick={() => void conmutar(true)} disabled={busy}>
                <Icon name="toggle-right" className="mr-1 h-4 w-4" />
                Encender el bot
              </Button>
            )}
          </div>
        </div>

        {/* El diagnóstico REAL contra Kapso: es la diferencia entre "configurado" y
            "funciona". Con credenciales muertas el bot pensaría en el vacío. */}
        {status && !status.whatsapp.ok && (
          <div className="mt-4 rounded-lg bg-error-soft px-4 py-3 text-sm text-error-text">
            <strong>No puede responder:</strong> {status.whatsapp.error}
            <div className="mt-1 text-xs opacity-80">
              Aunque lo enciendas, el bot leería los mensajes y sus respuestas no saldrían. Hay que
              reponer las credenciales de WhatsApp antes de usarlo.
            </div>
          </div>
        )}
        {status?.whatsapp.ok && (
          <div className="mt-4 text-xs text-text-secondary">
            {status.whatsapp.name} ({status.whatsapp.phone}) · calidad {status.whatsapp.quality ?? "?"}
            {status.whatsapp.codeVerification && status.whatsapp.codeVerification !== "VERIFIED" && (
              <span className="text-warning-text"> · número {status.whatsapp.codeVerification}</span>
            )}
          </div>
        )}
        {!status?.enabled && (
          <p className="mt-3 text-xs text-text-secondary">
            Apagado, los mensajes entrantes se siguen registrando y los atiende una persona desde el
            Inbox, igual que antes de que el bot existiera.
          </p>
        )}
      </section>


      {/* ── Qué ha hecho el bot ────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Qué ha hecho el bot</h2>
        <p className="mb-3 text-xs text-text-secondary">
          Todo sale de lo que ya se registraba: no hay contadores aparte que puedan
          quedar desfasados de la realidad.
        </p>

        {!actividad ? (
          <p className="text-xs text-text-tertiary">Cargando…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard
                icon="message-circle"
                label="Recibidos hoy"
                value={miles(actividad.mensajes.hoy.recibidos)}
              />
              <StatCard
                icon="send"
                label="Respondidos hoy"
                value={miles(actividad.mensajes.hoy.enviados)}
              />
              <StatCard
                icon="wrench"
                label="Solicitudes registradas"
                value={miles(actividad.solicitudes.total)}
              />
              <StatCard
                icon="user-check"
                label="Con una persona"
                value={miles(actividad.conversaciones.pendientes + actividad.conversaciones.asignadas)}
                tone={actividad.conversaciones.pendientes ? "text-warning-text" : undefined}
              />
              <StatCard
                icon="headphones"
                label="Notas de voz (30 d)"
                value={miles(actividad.notasDeVoz.total)}
              />
            </div>

            <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-text-tertiary">
              <span>Últimos 7 días: {miles(actividad.mensajes.semana.recibidos)} recibidos · {miles(actividad.mensajes.semana.enviados)} respondidos</span>
              <span>{miles(actividad.notasDeVoz.conAudio)} de {miles(actividad.notasDeVoz.total)} notas de voz se pueden escuchar</span>
              {actividad.conversaciones.esperandoConfirmacion > 0 && (
                <span>{actividad.conversaciones.esperandoConfirmacion} esperando que el cliente confirme si le quedó</span>
              )}
              {/* Este número es el que hay que mirar: si sube, se está cerrando en falso
                  en campo y el bucle de confirmación lo está cazando. */}
              {actividad.solicitudes.revisitasMes > 0 && (
                <span className="text-warning-text">
                  {actividad.solicitudes.revisitasMes} re-visita(s) en 30 días porque el cliente dijo que no le quedó
                </span>
              )}
            </div>

            {actividad.solicitudes.porTipo.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 text-[12px] font-semibold text-text-secondary">Por tipo de trámite</h3>
                <div className="flex flex-wrap gap-2">
                  {actividad.solicitudes.porTipo.map((t) => (
                    <span
                      key={t.tipo}
                      className="rounded-lg bg-surface-2 px-2.5 py-1 text-[11px] text-text-secondary"
                    >
                      {t.tipo} <strong className="text-text-primary">{t.total}</strong>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {actividad.solicitudes.ultimas.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <h3 className="mb-2 text-[12px] font-semibold text-text-secondary">Últimas solicitudes que abrió</h3>
                <table className="w-full min-w-[560px] text-[12px]">
                  <thead className="text-left text-[11px] uppercase text-text-tertiary">
                    <tr>
                      <th className="pb-1 pr-3"><BotonOrden t={tSolic} clave="orden">Orden</BotonOrden></th>
                      <th className="pb-1 pr-3"><BotonOrden t={tSolic} clave="tipo">Tipo</BotonOrden></th>
                      <th className="pb-1 pr-3"><BotonOrden t={tSolic} clave="cliente">Cliente</BotonOrden></th>
                      <th className="pb-1 pr-3"><BotonOrden t={tSolic} clave="estado">Estado</BotonOrden></th>
                      <th className="pb-1"><BotonOrden t={tSolic} clave="cuando">Cuándo</BotonOrden></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tSolic.filas.map((t) => (
                      <tr key={t.id} className="border-t border-border-subtle">
                        <td className="py-1.5 pr-3">
                          <Link href={`/soporte/${t.id}`} className="text-brand hover:underline">
                            #{t.code ?? "—"}
                          </Link>
                        </td>
                        <td className="py-1.5 pr-3 text-text-secondary">{t.type}</td>
                        <td className="py-1.5 pr-3 text-text-secondary">
                          {t.cliente ?? "—"}
                          {t.abonado ? ` (${t.abonado})` : ""}
                        </td>
                        <td className="py-1.5 pr-3">
                          <Badge
                            label={t.status}
                            tone={t.status === "RESUELTO" ? "success" : t.status === "ANULADA" ? "error" : "warning"}
                          />
                        </td>
                        <td className="py-1.5 text-text-tertiary">
                          {new Date(t.createdAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {actividad.escaladas.length > 0 && (
              <div className="mt-4">
                {/* Los motivos son la lista de tareas para mejorar el bot: cada uno es
                    algo que no supo resolver y le costó tiempo a una persona. */}
                <h3 className="mb-2 text-[12px] font-semibold text-text-secondary">
                  En qué se queda corto (lo que pasó a una persona)
                </h3>
                <ul className="space-y-1.5">
                  {actividad.escaladas.map((c) => (
                    <li key={c.phone} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                      <Link href={`/whatsapp?chat=${c.phone}`} className="text-brand hover:underline">
                        {c.cliente ?? `+${c.phone}`}
                      </Link>
                      <span className="text-text-secondary">{c.motivo ?? "sin motivo registrado"}</span>
                      <span className="text-[11px] text-text-tertiary">
                        {c.atiende ? `· ${c.atiende}` : "· sin dueño"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Lo que el bot hace por su cuenta ───────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Lo que hace por su cuenta</h2>
        <p className="mb-3 text-xs text-text-secondary">
          Las dos únicas conductas en las que el bot escribe sin que le pregunten.
        </p>

        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-surface-2 px-4 py-3">
            <div className="max-w-[640px] space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">Preguntar si la solución quedó bien</span>
                <Badge
                  label={status?.conductas?.confirmarSolucion ? "activa" : "apagada"}
                  tone={status?.conductas?.confirmarSolucion ? "success" : "default"}
                />
              </div>
              <p className="text-[11px] text-text-secondary">
                Cuando se cierra una orden que el cliente abrió por WhatsApp, le escribe para
                que verifique. Si dice que no le quedó, abre una re-visita en prioridad alta y
                avisa al equipo. Solo aplica a órdenes del bot: nunca a los cortes y
                reconexiones que el sistema cierra a diario.
              </p>
            </div>
            <Button
              variant={status?.conductas?.confirmarSolucion ? "secondary" : "primary"}
              size="sm"
              disabled={busy}
              onClick={() => void conmutarConducta("confirmarSolucion", !status?.conductas?.confirmarSolucion)}
            >
              {status?.conductas?.confirmarSolucion ? "Desactivar" : "Activar"}
            </Button>
          </div>

          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-surface-2 px-4 py-3">
            <div className="max-w-[640px] space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">Avisar sin que pregunten</span>
                <Badge
                  label={status?.conductas?.avisosProactivos ? "activa" : "apagada"}
                  tone={status?.conductas?.avisosProactivos ? "success" : "default"}
                />
              </div>
              <p className="text-[11px] text-text-secondary">
                Le avisa al cliente cuando su orden queda con técnico asignado y cuando se le
                aplica un pago y vuelve el servicio. Es lo único que le llega a alguien que no
                escribió nada, así que nace apagado: un aviso de más no es un mensaje raro,
                es una queja y un golpe a la calificación del número en Meta.
              </p>
            </div>
            <Button
              variant={status?.conductas?.avisosProactivos ? "secondary" : "primary"}
              size="sm"
              disabled={busy}
              onClick={() => void conmutarConducta("avisosProactivos", !status?.conductas?.avisosProactivos)}
            >
              {status?.conductas?.avisosProactivos ? "Desactivar" : "Activar"}
            </Button>
          </div>
        </div>
      </section>

      {/* ── Piloto ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Lista blanca (piloto)</h2>
        <p className="mb-3 text-xs text-text-secondary">
          Con números, el bot <strong>solo</strong> le responde a ellos y el resto sigue como hoy.
          Vacía, le responde a <strong>todo</strong> el que escriba: son miles de abonados, así que
          déjala vacía solo cuando el piloto te convenza.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[320px] flex-1">
            <Field label="Teléfonos separados por coma">
              <Input
                value={lista}
                onChange={(e) => setLista(e.target.value)}
                placeholder="3001112233, 573009998877"
              />
            </Field>
          </div>
          <Button variant="secondary" onClick={() => void guardarLista()} disabled={busy}>
            Guardar lista
          </Button>
        </div>
        {status && !status.pilot && status.enabled && (
          <div className="mt-3 rounded-lg bg-warning-soft px-4 py-2 text-xs text-warning-text">
            La lista está vacía: el bot le responderá a cualquiera que escriba.
          </div>
        )}
      </section>

      {/* ── Catálogo comercial ─────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Planes que ofrece el bot</h2>
        <p className="mb-3 text-xs text-text-secondary">
          Lo que el bot le responde a un interesado que pregunta por planes. El catálogo tiene{" "}
          {catalogo?.planes.length ?? 0} planes activos heredados del sistema viejo (tarifas
          repetidas y descontinuadas): marca solo los que se venden hoy. Sin marcar ninguno, el bot
          ofrece los primeros que encuentre, que casi nunca son los correctos.
        </p>
        {!elegidos.length && (
          <div className="mb-3 rounded-lg bg-warning-soft px-4 py-2 text-xs text-warning-text">
            Todavía no has definido el catálogo comercial: el bot puede estar cotizando tarifas
            viejas a quien quiere contratar.
          </div>
        )}
        <div className="mb-3 max-h-64 overflow-y-auto rounded-lg border border-border">
          {(catalogo?.planes ?? []).map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-surface-2"
            >
              <input
                type="checkbox"
                checked={elegidos.includes(p.id)}
                onChange={(e) =>
                  setElegidos((prev) =>
                    e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id),
                  )
                }
              />
              <span className="flex-1 truncate">
                {p.name} <span className="text-xs text-text-secondary">({p.kind})</span>
              </span>
              <span className="text-xs text-text-secondary">
                $ {p.price.toLocaleString("es-CO")}/mes
              </span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => void guardarPlanes()} disabled={busy}>
            Guardar catálogo
          </Button>
          <span className="text-xs text-text-secondary">{elegidos.length} marcado(s)</span>
        </div>
      </section>

      {/* ── Funcionarios vinculados ────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Funcionarios vinculados</h2>
        <p className="mb-3 text-xs text-text-secondary">
          Un funcionario vinculado es atendido por el <strong>agente interno</strong> con sus mismos
          permisos del ERP (caja, tickets, red…). Sin vincular, aunque sea empleado, el bot lo trata
          como cliente o público. Cuidado: vincular el número equivocado le entrega esos permisos a
          un desconocido por WhatsApp.
        </p>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Field label="Funcionario">
              <Select
                value={nuevoUserId}
                onChange={(e) => {
                  const id = e.target.value;
                  setNuevoUserId(id);
                  // Se propone el celular de su ficha de empleado, pero queda editable:
                  // teclear 95 números a mano es donde se cuela el dígito equivocado.
                  setNuevoTel(opciones.find((o) => o.id === id)?.phoneSugerido ?? "");
                }}
              >
                <option value="">— elegir —</option>
                {opciones
                  .filter((o) => !vinculos.some((v) => v.userId === o.id))
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.email}){o.phoneSugerido ? ` · ${o.phoneSugerido}` : " · sin celular en su ficha"}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className="w-56">
            <Field label="WhatsApp personal">
              <Input
                value={nuevoTel}
                onChange={(e) => setNuevoTel(e.target.value)}
                placeholder="3001234567"
              />
            </Field>
          </div>
          <Button onClick={() => void vincular()} disabled={busy || !nuevoUserId || !nuevoTel}>
            Vincular
          </Button>
        </div>
        {!vinculos.length ? (
          <p className="text-sm text-text-secondary">
            Nadie está vinculado todavía: hoy ningún empleado puede operar el ERP por WhatsApp.
          </p>
        ) : (
          <ul className="space-y-2">
            {vinculos.map((v) => (
              <li
                key={v.userId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 px-4 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {v.name}
                    {!v.active && <Badge label="cuenta inactiva" tone="warning" />}
                  </div>
                  <div className="truncate text-xs text-text-secondary">
                    {v.email} · {v.phone}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => void desvincular(v.userId)} disabled={busy}>
                  Desvincular
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Consumo ────────────────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Consumo del modelo</h2>
        <p className="mb-3 text-xs text-text-secondary">
          Al superar el tope, el bot deja de atender hasta el día siguiente. Es un freno de
          emergencia: sin él, nadie cuenta los tokens y cualquiera que escriba gasta. 0 = sin tope.
        </p>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="rounded-lg bg-surface-2 px-4 py-2">
            <div className="text-xs text-text-secondary">Hoy</div>
            <div className="text-lg font-semibold">
              {miles(status?.uso.hoy ?? 0)}
              {status?.uso.budget ? (
                <span className="text-sm font-normal text-text-secondary">
                  {" "}/ {miles(status.uso.budget)}
                </span>
              ) : null}
              <span className="ml-1 text-xs font-normal text-text-secondary">tokens</span>
            </div>
          </div>
          <div className="w-48">
            <Field label="Tope diario (tokens)">
              <Input type="number" min={0} value={tope} onChange={(e) => setTope(e.target.value)} />
            </Field>
          </div>
          <Button variant="secondary" onClick={() => void guardarTope()} disabled={busy}>
            Guardar tope
          </Button>
          {status?.uso.excedido && <Badge label="tope superado" tone="error" />}
        </div>
        {!!status?.uso.historial.length && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-secondary">
                <th className="pb-1 font-medium"><BotonOrden t={tUso} clave="dia">Día</BotonOrden></th>
                <th className="pb-1 text-right font-medium"><BotonOrden t={tUso} clave="tokens">Tokens</BotonOrden></th>
                <th className="pb-1 text-right font-medium"><BotonOrden t={tUso} clave="llamadas">Llamadas</BotonOrden></th>
              </tr>
            </thead>
            <tbody>
              {tUso.filas.map((d) => (
                <tr key={d.day} className="border-t border-border">
                  <td className="py-1">{String(d.day).slice(0, 10)}</td>
                  <td className="py-1 text-right">{miles(d.tokens)}</td>
                  <td className="py-1 text-right">{miles(d.requests)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Escaladas ──────────────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-base font-semibold">Esperando a una persona</h2>
          {!!handoffs.length && <Badge label={String(handoffs.length)} tone="warning" />}
        </div>
        <p className="mb-3 text-xs text-text-secondary">
          Clientes que pidieron hablar con alguien. El bot ya no responde en esos chats: atiéndelos
          desde el Inbox y devuélvelos al bot cuando termines.
        </p>
        {!handoffs.length ? (
          <p className="text-sm text-text-secondary">Ninguna conversación pendiente. 🎉</p>
        ) : (
          <ul className="space-y-2">
            {handoffs.map((h) => (
              <li
                key={h.convKey}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 px-4 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{telOf(h.convKey)}</div>
                  <div className="truncate text-xs text-text-secondary">
                    {h.handoffReason ?? "sin motivo"} · {new Date(h.handoffAt).toLocaleString("es-CO")}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => void liberar(h.convKey)} disabled={busy}>
                  Devolver al bot
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
