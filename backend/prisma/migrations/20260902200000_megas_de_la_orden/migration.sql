-- Cuántas megas sube (o baja) la orden (2026-09-02).
--
-- 'Subir megas' y 'Bajar megas' se abrían sin decir a CUÁNTO se pasa el cliente:
-- el formulario no tenía dónde escribirlo, la cascada de cierre dejaba la nota
-- "aplica el nuevo plan desde su ficha" y el dato vivía en la cabeza de quien
-- atendió al cliente. El técnico salía sin saber a qué velocidad dejarlo y el
-- cambio de precio se hacía a mano.
--
-- El plan destino ES la velocidad: de él salen las megas, la tarifa de la próxima
-- factura, el perfil PPP del Mikrotik y el traffic-table de la OLT.
--
-- Todo nullable: las 314.000 órdenes que ya existen —y las que siguen naciendo en
-- el legacy o por el chatbot— no lo traen, y no se puede reconstruir (el legacy lo
-- aparca en su tabla `temporales`, que todavía no se trae para el plan).
ALTER TABLE "Ticket" ADD COLUMN "planToId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "planToName" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "planToMegas" INTEGER;
ALTER TABLE "Ticket" ADD COLUMN "planFromName" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "planFromMegas" INTEGER;
ALTER TABLE "Ticket" ADD COLUMN "planAppliedAt" TIMESTAMP(3);
