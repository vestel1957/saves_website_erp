-- Comprobante de un movimiento subido EN EL LEGACY. Allá no hay columna de adjunto en
-- `transactions`: el fichero se anota en `meta_data` (type 77 → col1) y vive en su
-- `userfiles/attach/`. Sin esta columna, los 26.153 comprobantes de egresos del legacy
-- eran invisibles aquí: la pantalla de cierres ofrecía "Adjuntar" sobre gastos que ya
-- tenían su soporte cargado desde 2022.
ALTER TABLE "Transaction" ADD COLUMN "legacyAttach" TEXT;
