-- DropIndex
DROP INDEX "Ticket_editedAt_idx";

-- AlterTable
ALTER TABLE "Olt" ADD COLUMN     "transport" TEXT NOT NULL DEFAULT 'ssh';
