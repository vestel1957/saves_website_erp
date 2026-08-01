-- Espera de confirmación del cliente sobre una orden resuelta (ver TicketConfirmacionService).
ALTER TABLE "WhatsappConversation" ADD COLUMN     "awaitingTicketId" TEXT,
ADD COLUMN     "awaitingSince" TIMESTAMP(3);
