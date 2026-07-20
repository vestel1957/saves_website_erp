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
    ];
  },
};

export default nextConfig;
