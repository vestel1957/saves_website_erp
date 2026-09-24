-- Asistentes de un evento de la agenda: funcionarios invitados (User.id).
ALTER TABLE "CalendarEvent" ADD COLUMN "attendeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "CalendarEvent_attendeeIds_idx" ON "CalendarEvent" USING GIN ("attendeeIds");
