# 2. Recibir mercancía (Recepciones) 📥

**¿Para qué?** Registrar la entrada física de productos a la bodega. Esto **suma stock** automáticamente.
**¿Quién?** Auxiliar o jefe de bodega.
**Dónde:** Inventario → **Recepciones**.

## Paso a paso
1. Clic en **Nueva recepción**.
2. **Orden de compra** (opcional):
   - Si la mercancía viene de una orden de compra, selecciónala → se cargan solos los productos pendientes.
   - Si es una entrada directa, déjalo en blanco.
3. **Bodega destino**: a dónde entra la mercancía.
4. **Fecha de recepción**: normalmente hoy.
5. Por cada producto que llega, agrega una línea:
   - **Producto**, **Cant.** (cantidad recibida), **Costo unit.** (lo que costó cada uno).
   - **Condición**: `OK` (entra a stock), `Dañado` o `Faltante` (**NO** entran a stock, pero quedan registrados).
6. (Opcional) **Notas** y **Registrar recepción**.

## Importante ✅
- Cuenta físicamente **antes** de registrar. Lo que escribas es lo que el sistema creerá que hay.
- Si llegan **menos** de los pedidos, registra solo lo que llegó: la orden queda **parcial** y puedes recibir el resto después.
- Lo **Dañado/Faltante** se anota para reclamar al proveedor, pero no suma stock.

## Errores comunes
- *"Falta bodega"* → selecciona la bodega destino.
- Registrar más de lo que llegó → genera diferencias. Si te equivocaste, avisa al jefe (se corrige con un Ajuste).
