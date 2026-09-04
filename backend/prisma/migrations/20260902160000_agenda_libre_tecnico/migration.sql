-- Excepción nominal al turno obligatorio del técnico (2026-09-02, a pedido del usuario).
--
-- El turno (una visita a la vez, `src/support/turno.ts`) sigue rigiendo para todos;
-- quien tenga esta bandera ve y abre su agenda entera del día. Es un permiso POR
-- PERSONA y no un interruptor global a propósito: el día que se le quiera dar a otro
-- técnico se pone la bandera, sin volver a tocar código.
ALTER TABLE "Staff" ADD COLUMN "agendaLibre" BOOLEAN NOT NULL DEFAULT false;

-- El único con la excepción hoy: Oscar Rodríguez Fonseca (técnico).
-- Por correo y no por id, para que valga igual en cualquier entorno.
UPDATE "Staff" SET "agendaLibre" = true WHERE lower("email") = 'oscarroso74@gmail.com';
