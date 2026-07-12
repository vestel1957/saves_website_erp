"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { API_URL } from "@/lib/auth";
import { setPortalToken } from "@/lib/portal";

export default function PortalLoginPage() {
  const router = useRouter();
  const [abonado, setAbonado] = useState("");
  const [document, setDocument] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!abonado.trim() || !document.trim()) { setErr("Ingresa tu número de abonado y documento."); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/portal/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ abonado: Number(abonado), document: document.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo iniciar sesión");
      setPortalToken(d.token);
      router.push("/portal");
    } catch (e) { setErr(e instanceof Error ? e.message : "Error"); } finally { setLoading(false); }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-vestel.png" alt="Vestel" className="mx-auto mb-6 h-11 w-auto" />
        <div className="rounded-2xl border border-border-subtle bg-surface p-7 shadow-sm">
          <h1 className="text-center text-[18px] font-bold text-text-primary">Portal de pagos</h1>
          <p className="mt-1 text-center text-[12.5px] text-text-tertiary">Consulta y paga tu factura en línea</p>

          <form onSubmit={submit} className="mt-6 flex flex-col gap-3.5">
            <Field label="Número de abonado" required>
              <Input inputMode="numeric" value={abonado} onChange={(e) => setAbonado(e.target.value)} placeholder="Ej: 55976" autoFocus />
            </Field>
            <Field label="Documento (cédula/NIT)" required>
              <Input value={document} onChange={(e) => setDocument(e.target.value)} placeholder="Sin puntos ni espacios" />
            </Field>
            {err && (
              <div className="flex items-start gap-2 rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">
                <Icon name="alert-circle" size={14} className="mt-0.5 shrink-0" /> <span>{err}</span>
              </div>
            )}
            <Button type="submit" className="mt-1 w-full" disabled={loading}>
              {loading ? "Ingresando…" : "Ingresar"}
            </Button>
          </form>
        </div>
        <p className="mt-4 text-center text-[11px] text-text-tertiary">
          ¿Problemas para ingresar? Comunícate con Vestel.
        </p>
      </div>
    </div>
  );
}
