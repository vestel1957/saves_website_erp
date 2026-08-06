"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthProvider";
import { type AudienceResult, type PromotionAudience, audienceHasCriteria } from "@/lib/promotions";

/**
 * Conteo en vivo de a cuántos clientes reales alcanza un público.
 *
 * Estaba metido dentro del selector de público, que era el único que lo mostraba —y
 * lo mostraba al fondo de su columna, donde en móvil había que bajar hasta el final
 * para verlo. Sacarlo a un hook deja que el panel de resumen lo enseñe arriba y
 * siempre a la vista, que es lo que evita descontarle a quien no correspondía.
 */
export function useAlcance(audience: PromotionAudience) {
  const { authFetch } = useAuth();
  const [alcance, setAlcance] = useState<AudienceResult | null>(null);
  const [contando, setContando] = useState(false);

  useEffect(() => {
    if (!audienceHasCriteria(audience)) {
      setAlcance({ count: 0, sample: [], sinCriterios: true });
      setContando(false);
      return;
    }
    let vivo = true;
    setContando(true);
    // Freno de 400 ms: sin esto se consulta en cada tecla del buscador de clientes.
    const t = setTimeout(async () => {
      try {
        const r = await authFetch(`/promotions/audience`, { method: "POST", body: JSON.stringify(audience) });
        const d = await r.json();
        if (vivo) setAlcance(d);
      } catch {
        if (vivo) setAlcance(null);
      } finally {
        if (vivo) setContando(false);
      }
    }, 400);
    return () => { vivo = false; clearTimeout(t); };
  }, [audience, authFetch]);

  return { alcance, contando };
}
