import { PageSkeleton } from "@/components/skeletons/PageSkeleton";

// El shell (Sidebar + TopNav) ahora lo aporta el root layout (AppFrame) y
// persiste entre navegaciones; aquí solo va el skeleton del contenido.
export default function Loading() {
  return <PageSkeleton />;
}
