"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { AuthNotice } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
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
  operativo: boolean;
};

type Handoff = {
  convKey: string;
  handoffAt: string;
  handoffReason: string | null;
  updatedAt: string;
};

const telOf = (convKey: string) => convKey.split(":")[1] ?? convKey;
const miles = (n: number) => n.toLocaleString("es-CO");

export default function ChatbotPage() {
  const { can, authFetch } = useAuth();
  const isAdmin = can(PERM.WHATSAPP_MANAGE);

  const [status, setStatus] = useState<Status | null>(null);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
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
    const h = await authFetch("/admin/chatbot/handoffs");
    if (h.ok) setHandoffs(await h.json());
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

  if (!isAdmin) return <AuthNotice />;

  return (
    <div className="space-y-6">
      <PageHeading
        icon="sparkles"
        title="Agente de WhatsApp"
        subtitle="Interruptor, piloto por lista blanca, consumo y conversaciones escaladas."
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
                <th className="pb-1 font-medium">Día</th>
                <th className="pb-1 text-right font-medium">Tokens</th>
                <th className="pb-1 text-right font-medium">Llamadas</th>
              </tr>
            </thead>
            <tbody>
              {status.uso.historial.map((d) => (
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
