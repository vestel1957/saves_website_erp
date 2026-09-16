# Facturación electrónica (DIAN vía Siigo)

Estado de la e-factura del stack nuevo y cómo opera. **Última revisión: 2026-09-07.**

## Estado actual

**ACTIVA.** `EINVOICE_LIVE=true` en `backend/.env` (y por tanto en el bloque `env` de
`ecosystem.config.js`, que lo lee de ahí). El arranque lo confirma en el log:
`Interruptores EN VIVO: … EINVOICE_LIVE …`. Comprobación por API: `GET /api/einvoice/mode`
→ `{ live: true }`.

La cuenta emisora ya tiene cargado el mapeo DIAN **real** con el que Vestel factura
(`scripts/configurar-siigo-vestel.ts`, que se puede volver a correr en cualquier momento).

## Cómo emite el legacy (lo que se replicó)

Verificado en `application/controllers/FacturasElectronicas.php::guardar` y
`application/models/Facturas_electronicas_model.php`, y **cotejado contra documentos ya
timbrados** leídos de la API de Siigo (p. ej. `FV-3-192657`, `FV-3-192659`).

| Qué | Valor | De dónde |
|---|---|---|
| Empresa que emite | VesgaTelecomunicaciones SAS (`config_facturacion_electronica` id=2) | Aunque hay dos cuentas (Tv / Internet), **el documento siempre sale con la de Internet**: la TV viaja como un ítem más dentro de ella. El bloque de la cuenta de TV está comentado en el legacy. |
| `document.id` | `27274` | Factura electrónica de venta (FV, código 3) |
| Nota crédito | `10920` | Nota Crédito electrónica (NC, código 1) |
| `seller` | `945` | Vendedor de la factura |
| `cost_center` | Yopal `69` · Villanueva `167` · Monterrey `165` | Un centro de costo por sede; lo que no está mapeado cae a Yopal |
| `payments[0].id` | `2512` (Efectivo) | El legacy vivo nunca factura a crédito |
| IVA | `5869` (IVA 19%) | Solo en los ítems que gravan; los de 0% van **sin** nodo `taxes` |
| `date` | El día en que se timbra | No la fecha de la factura interna |
| Vencimiento | +20 días | |
| `observations` | `Estrato : X` | Va aunque el cliente no tenga estrato |
| `items[].code` | `T02` para todo lo de TV; para lo demás el `product_code` del catálogo | En el stack nuevo ese catálogo es `Material.code`, resuelto **por nombre** igual que el legacy |
| `items[].description` | `Servicio de Internet <plan>` · `Television <paquete>` · `Puntos de tv adicionales N` | |

Lo que **no** se copió, por ser defectos del legacy y no reglas: mandaba siempre
`check_digit: "4"` y `commercial_name: "Siigo"`, heredados de la plantilla de ejemplo; y
creaba el tercero con el vendedor `282`, hoy **inactivo** en Siigo (aquí se usa el 945, en
el campo configurable `SiigoAccount.customerSellerId`).

## Diferencias deliberadas con el legacy

1. **Los ítems salen de la factura, no de los servicios del cliente.** El legacy rebusca el
   plan actual del abonado y reconstruye la factura; aquí se timbra lo que la factura dice.
   Es el mismo resultado en el caso normal y evita timbrar un valor distinto al cobrado.
2. **Conceptos que no viajan a la DIAN**: los renglones de precio negativo (descuento de
   promoción, que entra como *"Nota Credito · Promoción 5% pronto pago"* — Siigo no admite
   ítems en negativo) y el arrastre de cartera (*"Saldo anterior"*, *"saldo inicial"*). El
   legacy tampoco los manda.
3. **El lote va acotado a un mes** (igual que el legacy, que filtra
   `DATE_FORMAT(invoicedate,'%Y-%m')`). Sin ese corte el lote se comería el atraso histórico
   de ~166 mil facturas marcadas desde 2019. El mes se elige en la pantalla.
4. **Freno al doble timbre.** El legacy sigue emitiendo en paralelo y sus emisiones **no
   quedan atadas a la factura** (`facturacion_electronica_siigo.invoice_id` viene `NULL` en
   las 222 mil filas), así que la idempotencia por factura no las ve. Lo que sí llega por el
   sync cada 15 min es la fila con el abonado y la fecha: si el abonado ya tiene una
   e-factura de ese mes, no se vuelve a emitir. Un segundo documento legítimo del mes se
   emite con `POST /api/einvoice/emit/:invoiceId?forzar=1`.
5. Se **persisten CUFE, número DIAN y PDF** de la respuesta (el legacy los descartaba).
6. **Se manda a la DIAN al crear** (`stamp: {send: true}`, apagable en
   `SiigoAccount.autoStamp`). Esto **el legacy no lo hace**: sin ese campo Siigo crea el
   documento y lo deja en **borrador**, sin CUFE y sin llegar a la DIAN — allá el envío lo
   aprueba contabilidad a mano en Siigo. Aquí el botón dice "emitir ante la DIAN", así que
   se timbra de una. El correo al cliente **no** se dispara desde aquí (`mail.send: false`).
7. Un `2xx` de Siigo **no** significa timbrada: si `stamp.status` viene `Rejected` el
   registro queda como ERROR con el motivo de la DIAN, no como FACTURADA.

## Operación

- `/facturacion/electronica` → pestaña **Por sede**: se elige el **mes a timbrar** y se
  emite el lote de la sede (`POST /api/einvoice/emit-branch/:branchId?mes=YYYY-MM`, de a 100;
  `hasMore` avisa que quedan). En LIVE el diálogo exige teclear el nombre de la sede.
- **Ver clientes** (`/facturacion/electronica/emitir/[id]`) marca a quién se le factura
  (`eInvoiceTv` / `eInvoiceInternet`). Sin marca, se timbra la factura completa.
- Emisión suelta desde la ficha de la factura y desde la lista de facturación.
- Rechazos: quedan como `ElectronicInvoice` tipo ERROR con el mensaje de Siigo, en la
  pestaña **Errores**, con botón Reintentar.
- Config: `/facturacion/electronica/cuentas` (la página existe; no está enlazada en el
  header por pedido del usuario).

## Comprobaciones

```bash
cd backend
npx tsx scripts/smoke-efactura-payload.ts 3        # arma payloads reales sin enviarlos
npx tsx scripts/smoke-efactura-cobertura.ts 2026-09 2026-11   # ¿algún concepto sin código?
npx tsx scripts/smoke-efactura-duplicado.ts        # el freno al doble timbre
npx tsx scripts/configurar-siigo-vestel.ts         # recarga el mapeo DIAN
```

## Prueba de punta a punta (2026-09-07)

Emitida una factura real: abonado 3350 (tid 500238, Yopal, combo TV+Internet, 77.000,11).
Salió como **FV-3-192664**, aceptada por la DIAN con CUFE
`dc93850005b7…80e8d1`. El documento en Siigo es idéntico en forma a los que timbra el
legacy (mismo `cost_center` 69, `seller` 945, códigos `T02` + `968033`, IVA 5869, pago 2512).

> Las credenciales de Siigo que viven en la BD son las de **producción de Vestel**.
