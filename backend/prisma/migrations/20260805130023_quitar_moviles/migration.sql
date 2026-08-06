/*
  Warnings:

  - You are about to drop the `Movil` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `MovilMember` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "MovilMember" DROP CONSTRAINT "MovilMember_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "MovilMember" DROP CONSTRAINT "MovilMember_movilId_fkey";

-- DropTable
DROP TABLE "Movil";

-- DropTable
DROP TABLE "MovilMember";
