# Activación de la facturación electrónica (DIAN vía Siigo)

Estado y pasos para pasar la e-factura de **dry-run** a **emisión real** ante la DIAN.
Última revisión: 2026-07-20.

## Estado actual (2026-07-20)

- **`EINVOICE_LIVE` no está definido** → el sistema está en **dry-run**: arma el payload
  y lo registra, pero **no timbra**. Correcto para pruebas.
- Las **2 cuentas Siigo** tienen credenciales de API (`username` + `accessKey`) y
  `apiBaseUrl = https://api.siigo.com/v1`, **pero todo el mapeo DIAN está vacío**
  (`documentId`, `creditNoteDocumentId`, `sellerId`, `ivaTaxId`, `paymentCash`,
  `paymentCredIt`, `costCenterByBranch` → todos `null`).
- 222.759 registros `ElectronicInvoice` históricos migrados **sin CUFE** (no se timbraron
  aquí). 166.781 `SubInvoice` marcadas para timbrar.

> **Nota sobre el mecanismo (corrige un diagnóstico previo):** NO hay ningún "bug de pm2"
> que impida leer `EINVOICE_LIVE`. `ConfigModule.forRoot()` carga `backend/.env` a
> `process.env` (verificado empíricamente). El gate además se centralizó en
> `ecosystem.config.js` junto a `MIKROTIK_LIVE`/`OLT_LIVE` para que no despiste. Lo único
> que faltaba era **definir la variable** y, sobre todo, **llenar el mapeo DIAN**.

## Precondiciones para emitir (las exige el código)

`einvoice-emit.service.ts:216` rechaza la emisión si a la `SiigoAccount` le falta
`documentId`, `sellerId` o `paymentCash`. Para el flujo completo (facturas + notas
crédito + IVA + centros de costo) hacen falta, por cuenta:

| Campo (SiigoAccount) | Qué es | De dónde sale en Siigo |
|---|---|---|
| `documentId` | Tipo de comprobante DIAN de **factura de venta** (aquí vive la resolución y el consecutivo) | Siigo → Configuración → Tipos de comprobante → Factura electrónica |
| `creditNoteDocumentId` | Tipo de comprobante de **nota crédito** | Siigo → Tipos de comprobante → Nota crédito electrónica |
| `sellerId` | Vendedor por defecto (related_users) | Siigo → Usuarios / Vendedores |
| `ivaTaxId` | Impuesto IVA a aplicar en los ítems | Siigo → Configuración → Impuestos |
| `paymentCash` | Medio de pago **contado** | Siigo → Configuración → Medios de pago |
| `paymentCredIt` | Medio de pago **crédito** (para facturas a crédito) | Siigo → Medios de pago |
| `costCenterByBranch` | Mapa `{ legacyId de sede → id de centro de costo }` | Siigo → Centros de costo (uno por sede) |

Todos son **IDs numéricos de Siigo**. Se obtienen consultando la API de Siigo
(`GET /v1/document-types`, `/v1/users`, `/v1/taxes`, `/v1/payment-types`,
`/v1/cost-centers`) con las credenciales ya cargadas, o desde la interfaz de Siigo.

## Procedimiento de activación

1. **Obtener los IDs de Siigo** para cada una de las 2 cuentas (TV / Internet). Esto lo
   hace quien administre Siigo (contador) — no son inventables.
2. **Cargarlos** por cada cuenta: `PATCH /api/einvoice/accounts/:id` con los campos de la
   tabla (o desde la pantalla `/facturacion/electronica/cuentas`).
3. **Verificar credenciales**: `POST /api/einvoice/accounts/:id/test` (autentica contra
   Siigo). Y `GET /api/einvoice/:id` reporta qué campos siguen faltando.
4. **Probar en DRY-RUN** (con `EINVOICE_LIVE` aún sin activar): emitir unas facturas reales
   con `POST /api/einvoice/emit/:invoiceId`. Devuelve el payload construido sin enviarlo.
   Revisar que el payload (NIT, ítems, IVA, medio de pago, centro de costo) sea correcto.
5. **Activar LIVE**: poner `EINVOICE_LIVE=true` en `backend/.env` **y** en el bloque `env`
   de `ecosystem.config.js` (o dejar que lo tome del .env), y
   `pm2 restart saves-backend --update-env`. Confirmar con `GET /api/einvoice/mode` →
   `{ live: true }`.
6. **Timbrar unas pocas de verdad primero.** Emitir 2-3 facturas reales, verificar que
   la DIAN devuelve CUFE y número, y solo entonces procesar el lote grande
   (`POST /api/einvoice/emit-branch/:branchId`).

## Manejo de rechazos (ya implementado)

- Siigo rechaza → se registra `ElectronicInvoice` en estado ERROR con el mensaje; se
  reintenta con `POST /api/einvoice/:id/retry`.
- Idempotencia: no re-timbra una factura ya emitida (`einvoice-emit.service.ts:202`).
- La numeración/consecutivo DIAN la lleva Siigo, no este ERP.

## Pendiente / decisiones

- Definir el `costCenterByBranch` por las 7 sedes (hoy vacío → sin centro de costo).
- Cerrar antes la brecha de facturación −7,8% (conceptos "puntos", servicios adicionales,
  290 COMPROMISO sin plan) para no timbrar montos incompletos. Ver `compare-billing-*.json`.
