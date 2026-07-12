"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthProvider";
import { firstAccessibleHref } from "@/lib/nav";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";

// Ya no hay un "Panel" global: la raíz solo redirige al Resumen de la primera
// sección que el usuario pueda ver (Inventario, Contabilidad, SST…).
export default function Home() {
  const router = useRouter();
  const { user, loading, can } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    const dest = firstAccessibleHref(can);
    router.replace(dest ?? "/login");
  }, [loading, user, can, router]);

  return <PageSkeleton />;
}
