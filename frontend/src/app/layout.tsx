import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { Toaster } from "@/components/ui/Toast";
import { AppFrame } from "@/components/AppFrame";
import { AuthProvider } from "@/context/AuthProvider";
import { SidebarProvider } from "@/context/SidebarProvider";
import { NotificationsProvider } from "@/context/NotificationsProvider";
import { fetchMe, TOKEN_COOKIE, type AuthUser } from "@/lib/auth";

/**
 * Hidrata el usuario en el servidor a partir de la cookie de sesión. Así el
 * AuthProvider nace con el usuario ya resuelto y el cliente NO tiene que hacer
 * un /auth/me antes de pedir los datos de la página — se elimina un round-trip
 * completo de la ruta crítica en cada carga dura.
 */
async function getInitialUser(): Promise<AuthUser | null> {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) return null;
  try {
    return await fetchMe(token);
  } catch {
    return null; // token inválido/expirado → el cliente cae a login como antes
  }
}

/**
 * El tipo de letra de TODA la interfaz. Se expone como variable CSS y `globals.css`
 * la ata a `--font-sans`, que es de donde tira el `font-sans` de Tailwind: cambiar
 * la fuente del sistema entero es cambiar estas dos líneas y nada más.
 *
 * La variable se llama `--font-ui` y no por el nombre de la familia a propósito:
 * el día que se vuelva a cambiar, el nombre no queda mintiendo por el CSS.
 */
const fuenteUi = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vestel · Panel Ejecutivo",
  description: "Pulso en tiempo real de ingresos, pipeline, operaciones y salud del cliente",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Permite hacer zoom (accesibilidad) pero evita el zoom automático en inputs de iOS.
  maximumScale: 5,
  // Sin `cover`, `env(safe-area-inset-*)` vale 0 en iOS y el pie del menú lateral
  // (donde está «Cerrar sesión») queda debajo de la barra de gestos.
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialUser = await getInitialUser();
  return (
    <html lang="es" className={fuenteUi.variable} suppressHydrationWarning>
      <head>
        {/*
          Anti-FOUC: aplica tema oscuro, color primario y tinte de fondo guardados
          ANTES de pintar.

          Del tinte sólo COPIA el mapa de variables que `@/lib/appearance` dejó ya
          calculado al guardarlo (validando nombre y color, porque localStorage lo
          puede tocar cualquiera): repetir aquí la conversión HSL y las mezclas en
          un script en línea sería un duplicado imposible de mantener en sincronía.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var r=document.documentElement;var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)r.classList.add('dark');var b=localStorage.getItem('brandColor');if(b&&/^#[0-9a-fA-F]{6}$/.test(b)){r.style.setProperty('--color-brand',b);var f=function(c){c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);};var L=function(h){return 0.2126*f(parseInt(h.slice(1,3),16))+0.7152*f(parseInt(h.slice(3,5),16))+0.0722*f(parseInt(h.slice(5,7),16));};var lb=L(b);var cw=(Math.max(lb,1)+0.05)/(Math.min(lb,1)+0.05);var ld=L('#0d1526');var cd=(Math.max(lb,ld)+0.05)/(Math.min(lb,ld)+0.05);r.style.setProperty('--color-on-brand',cw>=cd?'#ffffff':'#0d1526');}var s=localStorage.getItem('uiSurfaces');if(s){var o=JSON.parse(s);for(var k in o){if(/^--ui-[a-z0-9-]+$/.test(k)&&/^#[0-9a-fA-F]{6}$/.test(o[k]))r.style.setProperty(k,o[k]);}}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <AuthProvider initialUser={initialUser}>
          <SidebarProvider>
            {/* Dentro del AuthProvider (necesita la sesión) y FUERA del AppFrame:
                el sondeo de avisos no debe reiniciarse al navegar. */}
            <NotificationsProvider>
              <AppFrame>{children}</AppFrame>
            </NotificationsProvider>
          </SidebarProvider>
        </AuthProvider>
        <Toaster />
      </body>
    </html>
  );
}
