"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { AuthNotice } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";

type ApiKeyRow = {
  id: string; name: string; keyPrefix: string; scopes: string[];
  active: boolean; revoked: boolean; rateLimit: number; ignoreLimits: boolean;
  ipAllowlist: string[]; lastUsedAt: string | null; lastUsedIp: string | null;
  usageCount: number; createdByName: string | null; createdAt: string; legacy: boolean;
};
type Scope = { key: string; label: string };

export default function ApiPage() {
  const { user, can, authFetch } = useAuth();
  const allowed = can(PERM.AREA_SISTEMAS) || can(PERM.SYSTEM_ADMIN);

  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(["clients:read"]));
  const [rateLimit, setRateLimit] = useState("500");
  const [ips, setIps] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<{ name: string; key: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [k, s] = await Promise.all([authFetch("/admin/api-keys"), authFetch("/admin/api-keys/scopes")]);
      if (k.ok) setKeys(await k.json());
      if (s.ok) setScopes((await s.json()).scopes ?? []);
    } catch { /* best-effort */ }
  }, [authFetch]);

  useEffect(() => { if (user && allowed) void refresh(); }, [user, allowed, refresh]);

  function toggleScope(key: string) {
    setPicked((p) => {
      const n = new Set(p);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return toast("Ponle un nombre a la clave", "x");
    if (picked.size === 0) return toast("Elige al menos un permiso", "x");
    setCreating(true);
    const res = await authFetch("/admin/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        scopes: [...picked],
        rateLimit: Number(rateLimit) || 0,
        ipAllowlist: ips.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      }),
    });
    setCreating(false);
    if (!res.ok) { toast("No se pudo crear la clave", "x"); return; }
    const data = await res.json();
    setFreshKey({ name: data.name, key: data.key });
    setName(""); setIps(""); setPicked(new Set(["clients:read"]));
    void refresh();
  }

  async function revoke(id: string) {
    const res = await authFetch(`/admin/api-keys/${id}/revoke`, { method: "POST" });
    if (res.ok) { toast("Clave revocada"); void refresh(); }
    else toast("No se pudo revocar", "x");
  }

  async function toggleActive(row: ApiKeyRow) {
    const res = await authFetch(`/admin/api-keys/${row.id}`, {
      method: "PATCH", body: JSON.stringify({ active: !row.active }),
    });
    if (res.ok) { void refresh(); } else toast("No se pudo actualizar", "x");
  }

  if (!user) return <AuthNotice />;
  if (!allowed)
    return (
      <>
        <PageHeading icon="key-round" title="API pública" />
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center text-[13px] text-text-tertiary">
          Solo Sistemas puede administrar las claves de API.
        </div>
      </>
    );

  return (
    <>
      <PageHeading icon="key-round" title="API pública"
        subtitle="Claves para integraciones de terceros. Solo lectura, con permisos y límite por hora." />

      {/* Clave recién creada — se muestra una sola vez */}
      {freshKey && (
        <div className="mt-4 rounded-xl border border-success-text/40 bg-success-soft p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-success-text">
            <Icon name="shield-check" className="h-4 w-4" />
            Clave creada: {freshKey.name}
          </div>
          <p className="mt-1 text-[12px] text-text-secondary">
            Cópiala ahora — por seguridad no se vuelve a mostrar.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text-primary">
              {freshKey.key}
            </code>
            <Button size="sm" variant="secondary"
              onClick={() => { navigator.clipboard?.writeText(freshKey.key); toast("Copiada"); }}>
              <Icon name="copy" className="h-3.5 w-3.5" /> Copiar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFreshKey(null)}>Cerrar</Button>
          </div>
        </div>
      )}

      {/* Alta de clave */}
      <form onSubmit={createKey} className="mt-4 rounded-xl border border-border-subtle bg-surface p-5">
        <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-text-primary">
          <Icon name="plus" className="h-4 w-4 text-brand" /> Nueva clave
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Nombre del tercero / integración" required>
            <Input value={name} placeholder="Ej: Portal de pagos" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Límite por hora" hint="0 = sin límite">
            <Input inputMode="numeric" value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />
          </Field>
          <Field label="IPs permitidas" hint="separadas por coma; vacío = cualquiera">
            <Input value={ips} placeholder="190.1.2.3, 190.1.2.4" onChange={(e) => setIps(e.target.value)} />
          </Field>
          <Field label="Permisos (scopes)">
            <div className="flex flex-wrap gap-1.5 pt-1">
              {scopes.map((s) => (
                <button key={s.key} type="button" onClick={() => toggleScope(s.key)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    picked.has(s.key)
                      ? "border-brand bg-brand-soft text-brand"
                      : "border-border-default text-text-tertiary hover:bg-surface-2"
                  }`}>
                  {s.label}
                </button>
              ))}
            </div>
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <Button type="submit" disabled={creating}>{creating ? "Creando…" : "Crear clave"}</Button>
        </div>
      </form>

      {/* Listado */}
      <div className="mt-4 rounded-xl border border-border-subtle bg-surface p-5">
        <h2 className="mb-3 text-[14px] font-semibold text-text-primary">Claves ({keys.length})</h2>
        {keys.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">Aún no hay claves. Crea una arriba.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th className="py-2 pr-3 font-semibold">Clave</th>
                  <th className="py-2 pr-3 font-semibold">Permisos</th>
                  <th className="py-2 pr-3 font-semibold">Uso</th>
                  <th className="py-2 pr-3 font-semibold">Estado</th>
                  <th className="py-2 pr-0 text-right font-semibold">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b border-border-subtle/60">
                    <td className="py-2.5 pr-3">
                      <div className="font-semibold text-text-primary">{k.name}</div>
                      <code className="text-[11px] text-text-tertiary">{k.keyPrefix}</code>
                      {k.legacy && <span className="ml-1 text-[10px] text-text-tertiary">· legacy</span>}
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {k.scopes.map((s) => <Badge key={s} label={s} tone="info" />)}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-text-secondary">
                      {k.usageCount > 0 ? (
                        <>
                          {k.usageCount} llamadas
                          {k.lastUsedAt && <div className="text-[11px] text-text-tertiary">
                            últ: {new Date(k.lastUsedAt).toLocaleDateString("es-CO")}{k.lastUsedIp ? ` · ${k.lastUsedIp}` : ""}
                          </div>}
                        </>
                      ) : <span className="text-text-tertiary">sin uso</span>}
                    </td>
                    <td className="py-2.5 pr-3">
                      {k.revoked ? <Badge label="Revocada" tone="error" />
                        : k.active ? <Badge label="Activa" tone="success" />
                        : <Badge label="Inactiva" tone="warning" />}
                    </td>
                    <td className="py-2.5 pr-0 text-right">
                      {!k.revoked && (
                        <div className="inline-flex gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => toggleActive(k)}>
                            {k.active ? "Desactivar" : "Activar"}
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => revoke(k.id)}>Revocar</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Documentación */}
      <div className="mt-4 rounded-xl border border-border-subtle bg-surface p-5">
        <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-text-primary">
          <Icon name="book-open" className="h-4 w-4 text-brand" /> Cómo se usa
        </h2>
        <p className="text-[12.5px] text-text-secondary">
          Autenticación por cabecera <code className="rounded bg-surface-2 px-1">X-API-Key</code>. Base:{" "}
          <code className="rounded bg-surface-2 px-1">/api/public/v1</code>. Endpoints disponibles:
        </p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border-subtle bg-surface-2 p-3 text-[12px] leading-relaxed text-text-secondary">
          <pre className="whitespace-pre">{`GET  /api/public/v1/ping
GET  /api/public/v1/clients?search=&page=1&pageSize=50   (scope clients:read)
GET  /api/public/v1/clients/:id                          (scope clients:read)
GET  /api/public/v1/clients/:id/invoices                 (scope invoices:read)

# Ejemplo
curl -H "X-API-Key: sv_live_xxx" \\
     "https://app.saves.com.co/api/public/v1/clients?pageSize=5"`}</pre>
        </div>
      </div>
    </>
  );
}
