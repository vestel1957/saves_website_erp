/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El type-check se valida aparte (tsc); saltarlo en build evita picos de
  // memoria que matan el build en este entorno. (Next 16 ya no corre ESLint en build.)
  typescript: { ignoreBuildErrors: true },
  // Máquina compartida de 16 núcleos: limitar los workers de generación de páginas
  // evita el pico de memoria que el OOM-killer usaba para matar el build.
  // optimizePackageImports: adelgaza el registro central de iconos (lucide-react).
  experimental: { cpus: 1, workerThreads: false, optimizePackageImports: ["lucide-react"] },
};

export default nextConfig;
