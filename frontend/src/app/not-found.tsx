import Link from "next/link";
import { Icon } from "@/components/Icon";

/**
 * 404 propio. Sin este fichero, Next sirve su página por defecto —en inglés y sin
 * el chrome de la aplicación—, que a un usuario del ERP le parece que el sistema
 * se cayó en vez de que se equivocó de dirección.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <Icon name="search" size={40} className="text-text-tertiary" />
      <div>
        <h2 className="text-[16px] font-bold text-text-primary">Esta página no existe</h2>
        <p className="mt-1 max-w-md text-[13px] text-text-secondary">
          Puede que el enlace esté desactualizado o que el registro se haya eliminado.
        </p>
      </div>
      <Link
        href="/"
        className="rounded-lg bg-brand px-4 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
      >
        Ir al inicio
      </Link>
    </div>
  );
}
