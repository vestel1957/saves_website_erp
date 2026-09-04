-- "El portal cobra ya con el descuento puesto".
--
-- El portal de pagos (PHP del legacy, que no se puede editar desde aquí) arma lo que
-- cobra con SUM(total)-SUM(pamnt) sobre `invoices`: no tiene descuento de sólo mostrar.
-- Lo único que baja lo que cobra es que la factura del legacy valga menos, y para eso
-- el descuento hay que concederlo ANTES de que pague.
--
-- Va aparte de `portalPublish` porque son cosas distintas: publicar deja una fila en
-- `promos` para que el portal ofrezca el descuento con su propia mecánica (sólo la
-- última factura, sólo después del día 20); esto rebaja la cartera de una vez. Y son
-- excluyentes: con las dos, el cliente se lo llevaría dos veces.
ALTER TABLE "Promotion"
  ADD COLUMN "portalPreapply" BOOLEAN NOT NULL DEFAULT false;
