# 6. Definir límites y reposición (Reorden) 📊

**¿Para qué?** Decirle al sistema **cuántas unidades como mínimo** deben quedar de cada producto. Cuando baja de ahí, **te avisa** (campana 🔔) y **sugiere** cuánto pedir.
**¿Quién?** Jefe de bodega.
**Dónde:** Inventario → **Límites y reorden**. Tiene dos pestañas: **Límites** y **Sugerencias**.

## Pestaña "Límites" — configurar
1. Clic en **Nuevo límite** (o **Editar** uno existente).
2. **Producto** y **Bodega** (el límite es por producto en cada bodega).
3. Define los tres números:
   - **Mínimo**: lo más bajo aceptable (stock de seguridad).
   - **Punto de reorden**: cuando llega aquí, **salta la alerta**. (Debe ser ≥ mínimo.)
   - **Máximo**: hasta cuánto reponer.
4. Guardar.

> Ejemplo: Mínimo 5, Punto de reorden 15, Máximo 40 → al llegar a 15 avisa; sugerirá pedir hasta 40.

## Pestaña "Sugerencias" — reponer
- Lista los productos que **ya están en o por debajo** de su punto de reorden, con la **cantidad sugerida** a pedir y el **costo estimado**.
- Botón **Crear OC**: genera una **orden de compra** en borrador con ese producto. Eliges el **proveedor**, ajustas cantidad/costo y listo.

## Consejo
Configura primero los límites de tus productos **más críticos** (los que no pueden faltar). Así la campana trabaja por ti.
