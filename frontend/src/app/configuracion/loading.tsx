import { PageSkeleton } from "@/components/skeletons/PageSkeleton";

// El layout de la sección ya aporta Sidebar + TopNav; aquí solo va el contenido.
export default function Loading() {
  return <PageSkeleton />;
}
