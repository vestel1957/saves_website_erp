"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageHeading } from "@/components/ui/PageHeading";
import { TabStrip } from "@/components/ui/TabStrip";
import { AuthNotice } from "@/components/ui/AuthNotice";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { useNotifications } from "@/context/NotificationsProvider";
import { PERM } from "@/lib/auth";

type Estado = "BOT" | "PENDIENTE" | "ASIGNADA" | "RESUELTA";

type Ventana = { abierta: boolean; minutos: number };

type Conversacion = {
  id: string;
  phone: string;
  status: Estado;
  handoffReason: string | null;
  unread: number;
  preview: string | null;
  lastDirection: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  subscriberId: string | null;
  subscriberName: string | null;
  abonado: number | null;
  subscriberStatus: string | null;
  subscriberAddress: string | null;
  /** Se le preguntó si su servicio quedó bien y aún no contesta. */
  esperandoConfirmacion?: boolean;
  ventana: Ventana;
};

type Mensaje = {
  id: string;
  direction: "IN" | "OUT";
  body: string;
  hasAudio: boolean;
  /** Ruta para escuchar la nota de voz. null = no hay binario guardado (mensajes viejos). */
  audioUrl: string | null;
  createdAt: string;
  autor: string | null;
  autorId: string | null;
};

type Lista = {
  items: Conversacion[];
  total: number;
  contadores: { pendientes: number; asignadas: number; bot: number; resueltas: number; mias: number };
};

type Agente = { id: string; name: string };

type Filtro = "PENDIENTES" | "MIAS" | "ABIERTAS" | "TODAS";

const TABS: { key: Filtro; label: string; icon: string }[] = [
  { key: "PENDIENTES", label: "Sin atender", icon: "hourglass" },
  { key: "MIAS", label: "Mías", icon: "user-check" },
  { key: "ABIERTAS", label: "Abiertas", icon: "inbox" },
  { key: "TODAS", label: "Todas", icon: "list" },
];

const TONO: Record<Estado, "default" | "warning" | "info" | "success"> = {
  BOT: "default",
  PENDIENTE: "warning",
  ASIGNADA: "info",
  RESUELTA: "success",
};

const ETIQUETA: Record<Estado, string> = {
  BOT: "La atiende el bot",
  PENDIENTE: "Sin atender",
  ASIGNADA: "En atención",
  RESUELTA: "Resuelta",
};

/** Refresco de la bandeja. WhatsApp no empuja al navegador: se consulta. */
const REFRESCO_MS = 15_000;

const nombreDe = (c: Conversacion) => c.subscriberName || `+${c.phone}`;

/**
 * Nota de voz del cliente, reproducible en el hilo.
 *
 * Se descarga cuando se pulsa, no al abrir el chat: un hilo con quince notas de voz
 * no puede bajarse quince audios de golpe para que se escuche uno.
 *
 * Va por `fetch` + blob y no como `<audio src="/api/…">` porque la API se autentica con
 * un Bearer en la cabecera, y un `<audio>` no la manda: pediría el archivo sin token y
 * se comería un 401. De paso, el blob queda en memoria y se puede rebobinar sin volver
 * a pedirlo al servidor.
 */
function NotaDeVoz({ url }: { url: string }) {
  const { authFetch } = useAuth();
  const [src, setSrc] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // El blob ocupa memoria hasta que se libera: al cambiar de chat hay que soltarlo.
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  // Ya descargado: suena. Si el navegador bloquea el autoplay no se insiste — quedan
  // los controles nativos, que es lo que el usuario acabará usando de todas formas.
  useEffect(() => {
    if (src) void audioRef.current?.play().catch(() => {});
  }, [src]);

  const cargar = useCallback(async () => {
    if (src || cargando) return;
    setCargando(true);
    setError(null);
    try {
      const r = await authFetch(url);
      if (!r.ok) {
        throw new Error(
          r.status === 404
            ? "Esta nota de voz no quedó guardada en el servidor."
            : "No se pudo cargar el audio.",
        );
      }
      setSrc(URL.createObjectURL(await r.blob()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }, [authFetch, cargando, src, url]);

  if (error) {
    return (
      <p className="mt-1 text-[11px] text-danger-text">
        <Icon name="alert-triangle" size={11} className="mr-1 inline" />
        {error}
      </p>
    );
  }

  if (!src) {
    return (
      <Button size="sm" variant="secondary" onClick={cargar} disabled={cargando} className="mt-1">
        <Icon name={cargando ? "hourglass" : "play"} size={13} />
        {cargando ? "Cargando…" : "Escuchar nota de voz"}
      </Button>
    );
  }

  // `controls` nativo: da play/pausa, barra de avance, velocidad y descarga sin que
  // haya que mantener un reproductor propio.
  return <audio ref={audioRef} src={src} controls preload="metadata" className="mt-1 h-9 w-full max-w-[260px]" />;
}

function cuando(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  if (min < 60 * 24) return d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}

/**
 * Bandeja de WhatsApp: ver los chats y responderlos.
 *
 * Dos paneles en escritorio (lista + hilo) y uno en móvil: al abrir un chat, la lista
 * cede la pantalla completa, que es como se lee un chat en un teléfono.
 *
 * Lo que el bot deja escalado (`Sin atender`) es la cola de trabajo real; el resto de
 * pestañas están para buscar una conversación concreta, no para vigilarlas todas.
 */
export default function WhatsappInboxPage() {
  const { can, authFetch, user } = useAuth();
  const puede = can(PERM.WHATSAPP_INBOX);

  const [filtro, setFiltro] = useState<Filtro>("PENDIENTES");
  const [busqueda, setBusqueda] = useState("");
  const [lista, setLista] = useState<Lista | null>(null);
  const [activo, setActivo] = useState<string | null>(null);
  const [agentes, setAgentes] = useState<Agente[]>([]);

  // Llegada desde la campanita (`/whatsapp?chat=57300…`): abre ese chat y muestra la
  // pestaña que lo contiene — si el aviso te trae aquí y no ves el chat, el aviso no
  // sirvió de nada. Se lee de `window` y no con `useSearchParams` para no arrastrar la
  // frontera de Suspense que ese hook exige.
  useEffect(() => {
    const chat = new URLSearchParams(window.location.search).get("chat");
    if (chat) {
      setActivo(chat.replace(/\D/g, ""));
      setFiltro("TODAS");
    }
  }, []);

  const cargarLista = useCallback(async () => {
    const qs = new URLSearchParams({ pageSize: "50" });
    if (filtro === "MIAS") qs.set("mias", "true");
    else if (filtro !== "TODAS") qs.set("estado", filtro);
    if (busqueda.trim()) qs.set("search", busqueda.trim());
    const r = await authFetch(`/whatsapp/conversaciones?${qs.toString()}`);
    if (r.ok) setLista(await r.json());
  }, [authFetch, filtro, busqueda]);

  useEffect(() => {
    if (!puede) return;
    void cargarLista();
    const t = setInterval(() => void cargarLista(), REFRESCO_MS);
    return () => clearInterval(t);
  }, [puede, cargarLista]);

  useEffect(() => {
    if (!puede) return;
    void authFetch("/whatsapp/agentes")
      .then((r) => (r.ok ? r.json() : []))
      .then(setAgentes)
      .catch(() => {});
  }, [puede, authFetch]);

  const c = lista?.contadores;
  const tabs = useMemo(
    () =>
      TABS.map((t) => ({
        ...t,
        count:
          t.key === "PENDIENTES" ? c?.pendientes
          : t.key === "MIAS" ? c?.mias
          : t.key === "ABIERTAS" ? (c ? c.pendientes + c.asignadas : undefined)
          : undefined,
      })),
    [c],
  );

  if (!puede) return <AuthNotice />;

  return (
    <div className="flex min-h-0 flex-col">
      <PageHeading
        icon="message-circle"
        title="Chats de WhatsApp"
        subtitle="Conversaciones con clientes. Lo que el bot no puede resolver aparece aquí como “sin atender”."
      />

      <div className={`gap-4 lg:grid lg:grid-cols-[minmax(300px,360px)_1fr] ${activo ? "" : ""}`}>
        {/* ── Lista ─────────────────────────────────────────────────────── */}
        <div className={`min-w-0 flex-col ${activo ? "hidden lg:flex" : "flex"}`}>
          <TabStrip tabs={tabs} active={filtro} onChange={setFiltro} />
          <div className="relative my-3">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
              <Icon name="search" size={14} />
            </span>
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre, abonado o teléfono…"
              className="w-full rounded-lg border border-border-default bg-surface py-2 pl-9 pr-3 text-[13px]"
            />
          </div>

          <div className="space-y-1.5 lg:max-h-[calc(100vh-16rem)] lg:overflow-y-auto lg:pr-1">
            {!lista ? (
              <p className="p-3 text-[13px] text-text-tertiary">Cargando…</p>
            ) : lista.items.length === 0 ? (
              <p className="rounded-xl border border-border-subtle bg-surface p-4 text-[13px] text-text-tertiary">
                {filtro === "PENDIENTES"
                  ? "Nadie está esperando. Cuando el bot no pueda resolver algo, el chat aparece aquí."
                  : "Sin conversaciones para este filtro."}
              </p>
            ) : (
              lista.items.map((conv) => (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => setActivo(conv.phone)}
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${
                    activo === conv.phone
                      ? "border-brand bg-brand-soft"
                      : "border-border-subtle bg-surface hover:bg-surface-2"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold text-text-primary">{nombreDe(conv)}</span>
                    <span className="shrink-0 text-[11px] text-text-tertiary">{cuando(conv.lastMessageAt)}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[12px] text-text-secondary">
                    {conv.lastDirection === "OUT" && <span className="text-text-tertiary">Tú: </span>}
                    {conv.preview || "—"}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge label={ETIQUETA[conv.status]} tone={TONO[conv.status]} />
                    {conv.unread > 0 && <Badge label={`${conv.unread} sin leer`} tone="error" />}
                    {conv.assignedToName && (
                      <span className="text-[11px] text-text-tertiary">· {conv.assignedToName}</span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* ── Hilo ──────────────────────────────────────────────────────── */}
        <div className={`min-w-0 ${activo ? "block" : "hidden lg:block"}`}>
          {activo ? (
            <Hilo
              phone={activo}
              agentes={agentes}
              miId={user?.id ?? ""}
              onCerrar={() => setActivo(null)}
              onCambio={cargarLista}
            />
          ) : (
            <div className="hidden h-full min-h-[24rem] items-center justify-center rounded-xl border border-dashed border-border-default text-[13px] text-text-tertiary lg:flex">
              Elige una conversación para leerla y responder.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Hilo de una conversación + acciones + caja de respuesta. */
function Hilo({
  phone,
  agentes,
  miId,
  onCerrar,
  onCambio,
}: {
  phone: string;
  agentes: Agente[];
  miId: string;
  onCerrar: () => void;
  onCambio: () => void;
}) {
  const { authFetch } = useAuth();
  const { refrescar: refrescarAvisos } = useNotifications();
  const [conv, setConv] = useState<Conversacion | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const finRef = useRef<HTMLDivElement>(null);

  const cargar = useCallback(
    async (marcarLeido = false) => {
      const r = await authFetch(`/whatsapp/conversaciones/${phone}`);
      if (!r.ok) return;
      const data = await r.json();
      setConv(data.conversacion);
      setMensajes(data.mensajes);
      if (marcarLeido) {
        // Marcar leído apaga también los avisos de ESE chat en la campanita: se
        // refresca para que el distintivo del sidebar baje ya, sin esperar al sondeo.
        await authFetch(`/whatsapp/conversaciones/${phone}/leido`, { method: "POST" }).catch(() => {});
        void refrescarAvisos();
        onCambio();
      }
    },
    [authFetch, phone, onCambio, refrescarAvisos],
  );

  useEffect(() => {
    setConv(null);
    setMensajes([]);
    setTexto("");
    void cargar(true);
    const t = setInterval(() => void cargar(), REFRESCO_MS);
    return () => clearInterval(t);
    // `cargar` cambia con phone; se recarga entero al cambiar de chat.
  }, [cargar]);

  useEffect(() => {
    finRef.current?.scrollIntoView({ block: "end" });
  }, [mensajes.length]);

  const accion = async (ruta: string, body?: unknown, exito?: string) => {
    const r = await authFetch(`/whatsapp/conversaciones/${phone}/${ruta}`, {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r.ok) {
      if (exito) toast(exito);
      await cargar();
      onCambio();
    } else {
      toast("No se pudo completar la acción", "x");
    }
  };

  const enviar = async () => {
    const cuerpo = texto.trim();
    if (!cuerpo || enviando) return;
    setEnviando(true);
    try {
      const r = await authFetch(`/whatsapp/conversaciones/${phone}/responder`, {
        method: "POST",
        body: JSON.stringify({ text: cuerpo }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        setTexto("");
        await cargar();
        onCambio();
      } else {
        toast(data.error ?? data.message ?? "No se pudo enviar el mensaje", "x");
      }
    } finally {
      setEnviando(false);
    }
  };

  if (!conv) {
    return <div className="rounded-xl border border-border-subtle bg-surface p-4 text-[13px] text-text-tertiary">Cargando conversación…</div>;
  }

  const mio = conv.assignedToId === miId;
  const ventanaAbierta = conv.ventana?.abierta;
  const horas = Math.floor((conv.ventana?.minutos ?? 0) / 60);

  return (
    <div className="flex min-h-[60vh] flex-col rounded-xl border border-border-subtle bg-surface lg:h-[calc(100vh-14rem)]">
      {/* Cabecera */}
      <div className="border-b border-border-subtle p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <button type="button" onClick={onCerrar} className="mt-0.5 text-text-tertiary lg:hidden">
              <Icon name="arrow-left" size={16} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-text-primary">{nombreDe(conv)}</p>
              <p className="truncate text-[12px] text-text-tertiary">
                +{conv.phone}
                {conv.abonado != null && (
                  <>
                    {" · "}
                    <Link href={`/clientes/${conv.subscriberId}`} className="text-brand hover:underline">
                      Abonado {conv.abonado}
                    </Link>
                  </>
                )}
                {conv.subscriberStatus && ` · ${conv.subscriberStatus}`}
              </p>
            </div>
          </div>
          <Badge label={ETIQUETA[conv.status]} tone={TONO[conv.status]} />
        </div>

        {conv.esperandoConfirmacion && (
          // Aviso para quien atiende: el próximo mensaje del cliente lo va a interpretar
          // el sistema como "sí quedó" / "no quedó" (ver TicketConfirmacionService).
          <p className="mt-2 rounded-lg bg-info-soft px-3 py-2 text-[12px] text-info-text">
            <Icon name="clock" size={12} className="mr-1 inline" />
            Se le preguntó si su servicio quedó funcionando. Su próxima respuesta cierra el caso o abre una re-visita.
          </p>
        )}
        {conv.handoffReason && (
          <p className="mt-2 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
            <Icon name="hourglass" size={12} className="mr-1 inline" />
            {conv.handoffReason}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {!mio && (
            <Button size="sm" onClick={() => accion("asignar", undefined, "Conversación tomada. El bot ya no responde aquí.")}>
              <Icon name="user-check" size={13} /> Tomar
            </Button>
          )}
          {conv.status !== "RESUELTA" && (
            <Button size="sm" variant="secondary" onClick={() => accion("resolver", undefined, "Resuelta. El bot vuelve a atender este chat.")}>
              <Icon name="check" size={13} /> Resolver
            </Button>
          )}
          {conv.status !== "BOT" && (
            <Button size="sm" variant="ghost" onClick={() => accion("devolver-bot", undefined, "Devuelta al bot.")}>
              <Icon name="sparkles" size={13} /> Devolver al bot
            </Button>
          )}
          <select
            value=""
            onChange={(e) => e.target.value && accion("asignar", { userId: e.target.value }, "Conversación asignada.")}
            className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[12px] text-text-secondary"
          >
            <option value="">Pasar a…</option>
            {agentes.filter((a) => a.id !== conv.assignedToId).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {conv.assignedToName && (
            <span className="text-[11px] text-text-tertiary">Atiende: {conv.assignedToName}</span>
          )}
        </div>
      </div>

      {/* Mensajes */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {mensajes.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">Sin mensajes registrados.</p>
        ) : (
          mensajes.map((m) => (
            <div key={m.id} className={`flex ${m.direction === "IN" ? "justify-start" : "justify-end"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] ${
                  m.direction === "IN" ? "bg-surface-2 text-text-primary" : "bg-brand-soft text-text-primary"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                {m.audioUrl && <NotaDeVoz url={m.audioUrl} />}
                <p className="mt-1 text-[10px] text-text-tertiary">
                  {new Date(m.createdAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}
                  {/* Saliente sin autor = lo mandó el sistema: el bot o una campaña. */}
                  {m.direction === "OUT" && ` · ${m.autor ?? "bot"}`}
                  {/* Con audio, el texto de arriba es la transcripción: decirlo evita que
                      se lea como si el cliente lo hubiera escrito así. */}
                  {m.hasAudio && (m.audioUrl ? " · nota de voz transcrita" : " · nota de voz (sin audio guardado)")}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={finRef} />
      </div>

      {/* Respuesta */}
      <div className="border-t border-border-subtle p-3">
        {!ventanaAbierta && (
          // Regla de Meta, no del sistema: pasadas 24 h del último mensaje del cliente
          // no se puede mandar texto libre. El envío sigue funcionando porque sale como
          // plantilla aprobada, pero el texto se aplana y la conversación se factura.
          <p className="mb-2 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
            Pasaron más de 24 h desde el último mensaje del cliente. Tu respuesta saldrá dentro de una
            plantilla aprobada (Meta no permite texto libre fuera de esa ventana).
          </p>
        )}
        {ventanaAbierta && horas < 3 && (
          <p className="mb-2 text-[11px] text-text-tertiary">
            Quedan ~{conv.ventana.minutos} min de la ventana de respuesta libre.
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void enviar();
              }
            }}
            rows={2}
            placeholder="Escribe tu respuesta… (Enter envía, Shift+Enter salta línea)"
            className="min-h-[42px] flex-1 resize-y rounded-lg border border-border-default bg-surface px-3 py-2 text-[13px]"
          />
          <Button onClick={enviar} disabled={enviando || !texto.trim()}>
            <Icon name="send" size={14} /> {enviando ? "Enviando…" : "Enviar"}
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-text-tertiary">
          Al responder, el bot deja de contestar en este chat hasta que lo marques como resuelto.
        </p>
      </div>
    </div>
  );
}
