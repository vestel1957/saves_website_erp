-- La VLAN del catálogo apunta a una OLT registrada en vez de a un texto libre.
ALTER TABLE "Vlan" ADD COLUMN "oltId" TEXT;
CREATE INDEX "Vlan_oltId_idx" ON "Vlan"("oltId");
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
