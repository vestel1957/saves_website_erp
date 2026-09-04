-- Apps (OTT) que el cliente puede elegir con un combo.
-- Códigos del catálogo de PlayHub; vacío = el combo no ofrece apps.
ALTER TABLE "PlanBundle" ADD COLUMN "allowedApps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
