/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El build VALIDA TIPOS. Antes llevaba `typescript.ignoreBuildErrors: true` por
  // picos de memoria que mataban el build en esta máquina; medido el 2026-07-20, ya
  // no ocurre: 52 s y 1 GB de pico con el chequeo activado. Con `cpus: 1` y
  // `workerThreads: false` el consumo se mantiene acotado.
  // Máquina compartida de 16 núcleos: limitar los workers de generación de páginas
  // evita el pico de memoria que el OOM-killer usaba para matar el build.
  // optimizePackageImports: adelgaza el registro central de iconos (lucide-react).
  experimental: { cpus: 1, workerThreads: false, optimizePackageImports: ["lucide-react"] },
  // Mikrotik dejó de ser parte de /red y tiene módulo propio (2026-07-15). Estos
  // redirects sostienen los enlaces guardados/compartidos de la ruta anterior.
  async redirects() {
    return [
      { source: "/red/mikrotik", destination: "/mikrotik", permanent: true },
      { source: "/red/mikrotik/:id", destination: "/mikrotik/:id", permanent: true },
      { source: "/red/masivo", destination: "/mikrotik/masivo", permanent: true },
      { source: "/red/ips", destination: "/mikrotik/ips", permanent: true },
      // Empleados pasó a CONFIGURACIÓN y Documentos a PERSONAS / PROYECTOS
      // (2026-08-05). `:path*` cubre la ficha (/empleados/7) y Móviles.
      { source: "/empleados", destination: "/configuracion/empleados", permanent: true },
      // "Móviles / cuadrillas" se retiró del sistema (2026-08-05): su enlace guardado
      // cae en el listado de empleados, no en un 404. Va ANTES del `:path*`.
      { source: "/empleados/moviles", destination: "/configuracion/empleados", permanent: true },
      { source: "/configuracion/empleados/moviles", destination: "/configuracion/empleados", permanent: true },
      { source: "/empleados/:path*", destination: "/configuracion/empleados/:path*", permanent: true },
      { source: "/configuracion/documentos", destination: "/documentos", permanent: true },
    ];
  },
};

export default nextConfig;
