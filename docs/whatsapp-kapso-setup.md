# Activar WhatsApp con KAPSO (Cloud API oficial de Meta)

> El ERP usa **[Kapso](https://kapso.com)** como transporte único de WhatsApp: un
> proxy sobre la **Cloud API oficial de Meta** (sin librerías no oficiales, sin QR,
> sin riesgo de baneo). El código ya está listo (webhook con verificación + firma,
> envío de texto, documentos/PDF y notas de voz). Activarlo es **solo configuración**:
> conectar un número en Kapso y llenar las variables de entorno.

## 1. Aprovisionar en Kapso (lo hace BHDC con su cuenta)

En [kapso.com](https://kapso.com) / la app de Kapso:

1. Crear el proyecto y, en **Integrations → API keys**, generar un **API key** del
   proyecto → `KAPSO_API_KEY`.
2. **Conectar un número de WhatsApp** (número gestionado por Kapso, número propio
   de la empresa, o sandbox para pruebas). Copiar su **Phone Number ID** →
   `KAPSO_PHONE_NUMBER_ID`.
3. **App Secret de Meta** (opcional pero recomendado): si Kapso reenvía los webhooks
   firmados con el App Secret de Meta, ponlo en `WHATSAPP_WEBHOOK_APP_SECRET` para
   verificar la firma `X-Hub-Signature-256`. Si no lo configuras, el webhook se acepta
   sin verificar firma (solo recomendable en pruebas).

## 2. Variables de entorno (`backend/.env`)

```env
# --- WhatsApp vía KAPSO (Cloud API oficial) — transporte único ---
KAPSO_API_KEY=kapso_xxxxxxxxxxxxxxxxxxxxxxxx
KAPSO_PHONE_NUMBER_ID=123456789012345
# Opcionales (valores por defecto razonables):
# KAPSO_BASE_URL=https://api.kapso.ai/meta/whatsapp
# KAPSO_GRAPH_VERSION=v24.0
# Webhook entrante:
WHATSAPP_WEBHOOK_VERIFY_TOKEN=bhdc_wa_754ffefa4d6b465b0cbbc6e3e4e9f9a3
WHATSAPP_WEBHOOK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> El **Verify Token** lo eliges tú (cualquier cadena); debe ser **idéntico** en el
> `.env` y en la configuración del webhook (handshake GET).
>
> El canal se enciende automáticamente cuando `KAPSO_API_KEY` y
> `KAPSO_PHONE_NUMBER_ID` están definidos (`WhatsappService.enabled`).

## 3. Exponer el webhook (HTTPS público)

La ruta del sistema para recibir mensajes es:

```
https://<dominio-del-servidor>/api/whatsapp/webhook
```

- **Producción:** publicar el backend (puerto 3051) detrás del dominio con HTTPS
  (Nginx/Caddy).
- **Pruebas rápidas:** un túnel temporal, ej. `ngrok http 3051`, y usar esa URL.

## 4. Configurar el reenvío del webhook en Kapso

En el panel de Kapso, editar el número conectado y apuntar el **destino del
webhook** a `https://<dominio>/api/whatsapp/webhook` con el mismo Verify Token.
Kapso reenvía el evento de Meta en formato Graph (`entry/changes/value/messages`),
que es lo que procesa el sistema. Asegúrate de que lleguen los **mensajes entrantes**
(texto y audio).

## 5. Reiniciar y vincular usuarios

1. Reiniciar el backend: `pm2 restart nexus-backend`.
2. En **Administración → WhatsApp** (`/configuracion/whatsapp`) verificar que el
   badge **Kapso** quede en verde (estado vía `/admin/whatsapp/status`).
3. Enviar un **mensaje de prueba** desde la misma pantalla.
4. **Vincular el teléfono de cada funcionario** a su usuario del ERP (tabla de la
   misma pantalla) — el bot hereda sus permisos RBAC.
5. Escribirle al número de la empresa: *"¿cuánto stock hay de pulidora?"* o
   *"crea una orden de trabajo…"* 🚀

## Notas importantes

- **Ventana de 24 horas:** la Cloud API permite responder libremente solo dentro de
  las 24 h del último mensaje del usuario. Como el bot **responde** a quien le
  escribe, siempre está dentro de la ventana ✅.
- **Alertas proactivas (stock bajo, mantenimiento):** los avisos que el sistema envía
  *sin que el usuario escriba primero* requieren **plantillas aprobadas** por Meta.
  Hoy el canal envía texto plano; para alertas proactivas fuera de la ventana de 24 h
  hay que crear una plantilla en Kapso/Meta y enrutarlas por ella (pendiente).
- **Número de prueba vs. producción:** el número sandbox de Kapso solo escribe a
  destinatarios precargados; para uso real, conectar el número de la empresa.
- **Media entrante (notas de voz):** se descarga por Kapso en dos pasos
  (`GET /v24.0/{mediaId}` → `download_url` firmado → bytes). El `download_url`
  expira ~4 minutos, por eso se descarga al instante al recibir el webhook.
