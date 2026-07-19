-- Extensiones requeridas por el schema.
-- pg_trgm: lo exigen los indices GIN gin_trgm_ops de Subscriber (busqueda por
-- nombre/documento/telefono). Prisma no lo emite porque la extension no esta
-- declarada en el datasource, y sin el este baseline falla en una base nueva.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST', 'EXPENSE');

-- CreateEnum
CREATE TYPE "NormalSide" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('MANUAL', 'AUTOMATIC', 'RECURRING', 'CLOSING');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED', 'LOCKED');

-- CreateEnum
CREATE TYPE "DepreciationMethod" AS ENUM ('STRAIGHT_LINE', 'DECLINING_BALANCE', 'UNITS_OF_PRODUCTION');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('ISSUED', 'PARTIAL', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('IN', 'OUT', 'TRANSFER');

-- CreateEnum
CREATE TYPE "KardexReason" AS ENUM ('OPENING', 'PURCHASE', 'SALE', 'TRANSFER', 'ADJUSTMENT', 'RETURN', 'INTERNAL_CONSUMPTION', 'PRODUCTION', 'LOSS', 'THEFT', 'DAMAGE');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PHYSICAL', 'RAW_MATERIAL', 'FINISHED_GOOD', 'CONSUMABLE', 'SPARE_PART', 'TOOL', 'ASSET');

-- CreateEnum
CREATE TYPE "CostingMethod" AS ENUM ('AVERAGE', 'STANDARD', 'LAST');

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('MAIN', 'SECONDARY', 'PRODUCTION', 'WORKSHOP', 'VEHICLE', 'CONSIGNMENT', 'TRANSIT');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('ZONE', 'AISLE', 'RACK', 'BIN');

-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'ASSIGNED', 'SOLD', 'IN_REPAIR', 'RETIRED', 'LOST');

-- CreateEnum
CREATE TYPE "FlowStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'PARTIAL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReceiptCondition" AS ENUM ('OK', 'DAMAGED', 'MISSING');

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('DAMAGE', 'THEFT', 'LOSS', 'OPERATIONAL_ERROR', 'ADMIN_CORRECTION', 'COUNT_DIFFERENCE');

-- CreateEnum
CREATE TYPE "AssetAssignmentStatus" AS ENUM ('ASSIGNED', 'RETURNED', 'LOST');

-- CreateEnum
CREATE TYPE "TaxKind" AS ENUM ('SALES', 'PURCHASE', 'WITHHOLDING');

-- CreateEnum
CREATE TYPE "WithholdingBase" AS ENUM ('SUBTOTAL', 'TAX');

-- CreateEnum
CREATE TYPE "PartyKind" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH');

-- CreateEnum
CREATE TYPE "InventoryAlertType" AS ENUM ('LOW_STOCK', 'OUT_OF_STOCK', 'MAINTENANCE_DUE');

-- CreateEnum
CREATE TYPE "MaterialAssignmentStatus" AS ENUM ('ASSIGNED', 'RETURNED', 'CONSUMED', 'LOST');

-- CreateEnum
CREATE TYPE "MaterialAssignmentKind" AS ENUM ('CONSUMABLE', 'TOOL');

-- CreateEnum
CREATE TYPE "MaintenanceKind" AS ENUM ('PREVENTIVE', 'CORRECTIVE');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MaintenanceFrequency" AS ENUM ('BY_DAYS', 'BY_METER');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkOrderPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "WorkOrderType" AS ENUM ('CORRECTIVE', 'PREVENTIVE', 'INSTALLATION', 'CLEANING', 'INSPECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkOrderEventType" AS ENUM ('CREATED', 'UPDATED', 'STARTED', 'COMPLETED', 'CANCELLED', 'REOPENED', 'STATUS_FORCED', 'PART_ADDED', 'PHOTO_ADDED', 'PHOTO_DELETED', 'TASK_DONE', 'TASK_UNDONE');

-- CreateEnum
CREATE TYPE "EmployeeDocType" AS ENUM ('CC', 'CE', 'TI', 'PASAPORTE', 'NIT', 'OTRO');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'INACTIVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "EmployeeDocumentKind" AS ENUM ('CV', 'IDENTITY', 'CONTRACT', 'CERTIFICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "RiskType" AS ENUM ('FISICO', 'QUIMICO', 'BIOLOGICO', 'MECANICO', 'ELECTRICO', 'ERGONOMICO', 'PSICOSOCIAL', 'LOCATIVO');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('BAJO', 'MEDIO', 'ALTO', 'CRITICO');

-- CreateEnum
CREATE TYPE "EppDeliveryStatus" AS ENUM ('ENTREGADO', 'DEVUELTO', 'VENCIDO', 'REPUESTO', 'PERDIDO');

-- CreateEnum
CREATE TYPE "MedicalExamType" AS ENUM ('INGRESO', 'PERIODICO', 'REINTEGRO', 'RETIRO');

-- CreateEnum
CREATE TYPE "MedicalConcept" AS ENUM ('APTO', 'APTO_CON_RESTRICCIONES', 'NO_APTO', 'APLAZADO');

-- CreateEnum
CREATE TYPE "TrainingAttendeeStatus" AS ENUM ('INSCRITO', 'ASISTIO', 'APROBADO', 'REPROBADO');

-- CreateEnum
CREATE TYPE "IncidentClass" AS ENUM ('INCIDENTE', 'CASI_ACCIDENTE', 'ACCIDENTE_LEVE', 'ACCIDENTE_GRAVE');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('REPORTADO', 'EN_INVESTIGACION', 'CON_ACCIONES', 'CERRADO');

-- CreateEnum
CREATE TYPE "InspectionItemResult" AS ENUM ('CONFORME', 'NO_CONFORME', 'OBSERVACION');

-- CreateEnum
CREATE TYPE "FindingPriority" AS ENUM ('BAJA', 'MEDIA', 'ALTA', 'CRITICA');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('ABIERTO', 'EN_PROGRESO', 'CERRADO', 'VENCIDO');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PENDIENTE', 'EN_PROGRESO', 'COMPLETADA', 'VERIFICADA', 'VENCIDA');

-- CreateEnum
CREATE TYPE "SstDocType" AS ENUM ('POLITICA', 'PROCEDIMIENTO', 'MANUAL', 'INSTRUCTIVO', 'FORMATO', 'PROTOCOLO');

-- CreateEnum
CREATE TYPE "SstDocStatus" AS ENUM ('BORRADOR', 'EN_REVISION', 'VIGENTE', 'OBSOLETO');

-- CreateEnum
CREATE TYPE "EmergencyEquipmentType" AS ENUM ('EXTINTOR', 'BOTIQUIN', 'ALARMA', 'CAMILLA', 'EQUIPO_RESCATE', 'OTRO');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('OPERATIVO', 'EN_MANTENIMIENTO', 'VENCIDO', 'FUERA_SERVICIO');

-- CreateEnum
CREATE TYPE "BrigadeRole" AS ENUM ('JEFE', 'BRIGADISTA', 'PRIMEROS_AUXILIOS', 'CONTRA_INCENDIOS', 'EVACUACION');

-- CreateEnum
CREATE TYPE "DrillType" AS ENUM ('EVACUACION', 'INCENDIO', 'SISMO', 'DERRAME', 'MEDICO', 'OTRO');

-- CreateEnum
CREATE TYPE "SstAlertType" AS ENUM ('EXAMEN_MEDICO', 'CAPACITACION', 'CERTIFICACION', 'EPP', 'DOCUMENTO', 'ACCION_CORRECTIVA', 'INSPECCION', 'EQUIPO_EMERGENCIA', 'CONTRATISTA');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('IN_APP', 'EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('PENDIENTE', 'ENVIADA', 'LEIDA', 'DESCARTADA');

-- CreateEnum
CREATE TYPE "PayrollConceptType" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "PayrollSalaryNature" AS ENUM ('SALARIAL', 'NON_SALARIAL');

-- CreateEnum
CREATE TYPE "PayrollConceptCategory" AS ENUM ('BASIC_SALARY', 'OVERTIME', 'BONUS', 'ALLOWANCE', 'COMMISSION', 'VACATION', 'SICK_LEAVE', 'PENSION', 'HEALTH', 'TAX', 'OTHER');

-- CreateEnum
CREATE TYPE "PayrollCalcMethod" AS ENUM ('FIXED', 'PERCENTAGE', 'PER_QUANTITY', 'PROPORTIONAL');

-- CreateEnum
CREATE TYPE "PayrollCalcBase" AS ENUM ('NONE', 'BASIC_SALARY', 'DAILY_SALARY', 'GROSS_SALARIAL', 'IBC');

-- CreateEnum
CREATE TYPE "PayrollPayClass" AS ENUM ('QUINCENAL', 'QUINCENAL_ROLL');

-- CreateEnum
CREATE TYPE "PayrollContractType" AS ENUM ('INDEFINITE', 'FIXED_TERM', 'WORK_LABOR', 'SERVICES', 'APPRENTICESHIP');

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('OPEN', 'PROCESSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "PayrollEventType" AS ENUM ('VACATION', 'SICK_LEAVE', 'LICENSE', 'PERMISSION', 'ABSENCE', 'BONUS', 'COMMISSION', 'ALLOWANCE', 'DEDUCTION', 'OTHER');

-- CreateEnum
CREATE TYPE "PayrollEventStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayslipStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('ACCOUNTING_ENTRY', 'ELECTRONIC_PAYROLL', 'EMPLOYEE_SYNC', 'CONCEPT_SYNC');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('OK', 'FAILED', 'DRY_RUN');

-- CreateEnum
CREATE TYPE "SubscriberStatus" AS ENUM ('ACTIVO', 'CARTERA', 'COMPROMISO', 'CORTADO', 'DEPURADO', 'EVENTO', 'EXONERADO', 'INSTALAR', 'POR_RETIRAR', 'REPORTADO', 'RETIRADO', 'SUSPENDIDO', 'INACTIVO');

-- CreateEnum
CREATE TYPE "InvoiceRon" AS ENUM ('ACTIVO', 'INSTALAR', 'CORTADO', 'SUSPENDIDO', 'EXONERADO', 'CARTERA', 'COMPROMISO', 'DEPURADO', 'RETIRADO', 'ANULADO', 'REPORTADO', 'EVENTO', 'DADO_DE_BAJA', 'POR_RETIRAR');

-- CreateEnum
CREATE TYPE "ServiceKind" AS ENUM ('INTERNET', 'TV', 'PUNTOS', 'STREAMING');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('ACTIVO', 'CORTADO', 'SUSPENDIDO');

-- CreateEnum
CREATE TYPE "SubInvoiceStatus" AS ENUM ('DUE', 'PARTIAL', 'PAID', 'CANCELED');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('RECURRENTE', 'FIJA', 'NOTA_CREDITO', 'NOTA_DEBITO');

-- CreateEnum
CREATE TYPE "InstallTech" AS ENUM ('GPON', 'EPON', 'EOC', 'RADIO', 'FIBRA');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('INCOME', 'EXPENSE', 'TRANSFER');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('VIGENTE', 'ANULADA');

-- CreateEnum
CREATE TYPE "RetentionType" AS ENUM ('RETEFUENTE_SERVICIOS', 'COMPRAS', 'PERSONAS_NO_DECLARANTES', 'RETEIVA');

-- CreateEnum
CREATE TYPE "EInvoiceType" AS ENUM ('FACTURADA', 'ERROR', 'ACTUALIZADA', 'NOTA_CREDITO');

-- CreateEnum
CREATE TYPE "EInvoicePayMethod" AS ENUM ('CREDITO', 'EFECTIVO');

-- CreateEnum
CREATE TYPE "WhatsappSendStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "PromotionAssignAction" AS ENUM ('ASSIGNED', 'UNASSIGNED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('REALIZANDO', 'RESUELTO', 'ANULADA', 'PENDIENTE');

-- CreateEnum
CREATE TYPE "TodoStatus" AS ENUM ('DUE', 'DONE', 'PROGRESS');

-- CreateEnum
CREATE TYPE "TodoPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "Kpi" (
    "id" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "delta" TEXT NOT NULL,
    "deltaLabel" TEXT NOT NULL,
    "trend" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "Kpi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueMonth" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "revenue" INTEGER NOT NULL,
    "target" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "RevenueMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "avatarColor" TEXT NOT NULL,
    "probability" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "timeAgo" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardEntry" (
    "id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "avatarColor" TEXT NOT NULL,
    "deals" INTEGER NOT NULL,
    "quotaPct" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "LeaderboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "pct" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "normalSide" "NormalSide" NOT NULL,
    "parentId" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCenter" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalPeriod" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PeriodType" NOT NULL DEFAULT 'MONTH',
    "year" INTEGER NOT NULL,
    "month" INTEGER,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "periodId" TEXT,
    "type" "EntryType" NOT NULL DEFAULT 'MANUAL',
    "status" "EntryStatus" NOT NULL DEFAULT 'POSTED',
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdBy" TEXT,
    "reversedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "lineOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "nextRunDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lines" JSONB NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TaxKind" NOT NULL DEFAULT 'SALES',
    "rate" DECIMAL(9,6) NOT NULL,
    "base" "WithholdingBase" NOT NULL DEFAULT 'SUBTOTAL',
    "accountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountMapping" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedAssetCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "method" "DepreciationMethod" NOT NULL DEFAULT 'STRAIGHT_LINE',
    "usefulLifeMonths" INTEGER NOT NULL DEFAULT 60,
    "assetAccountId" TEXT NOT NULL,
    "depreciationExpenseAccountId" TEXT NOT NULL,
    "accumulatedDepreciationAccountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedAssetCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "acquisitionDate" TIMESTAMP(3) NOT NULL,
    "inServiceDate" TIMESTAMP(3) NOT NULL,
    "acquisitionCost" DECIMAL(18,2) NOT NULL,
    "residualValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "method" "DepreciationMethod" NOT NULL DEFAULT 'STRAIGHT_LINE',
    "status" "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "accumulatedDepreciation" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "acquisitionEntryId" TEXT,
    "disposalDate" TIMESTAMP(3),
    "disposalProceeds" DECIMAL(18,2),
    "disposalEntryId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepreciationEntry" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "accumulatedAfter" DECIMAL(18,2) NOT NULL,
    "bookValueAfter" DECIMAL(18,2) NOT NULL,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepreciationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Party" (
    "id" TEXT NOT NULL,
    "kind" "PartyKind" NOT NULL DEFAULT 'CUSTOMER',
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "taxTotal" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "status" "DocStatus" NOT NULL DEFAULT 'ISSUED',
    "taxCodeId" TEXT,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseBill" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "taxTotal" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "status" "DocStatus" NOT NULL DEFAULT 'ISSUED',
    "taxCodeId" TEXT,
    "journalEntryId" TEXT,
    "goodsReceiptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountNumber" TEXT,
    "glAccountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankMovement" (
    "id" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paymentId" TEXT,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "statementLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "partyId" TEXT,
    "bankAccountId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "billId" TEXT,
    "journalEntryId" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "reference" TEXT,
    "type" "MovementType" NOT NULL,
    "reason" "KardexReason" NOT NULL DEFAULT 'ADJUSTMENT',
    "productName" TEXT NOT NULL,
    "productId" TEXT,
    "warehouseFromId" TEXT,
    "warehouseToId" TEXT,
    "serialId" TEXT,
    "partyId" TEXT,
    "counterpartyEmployeeId" TEXT,
    "costCenterId" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "totalCost" DECIMAL(18,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "userId" TEXT,
    "notes" TEXT,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "whatsappPhone" TEXT,
    "cajaLegacyId" INTEGER,
    "sedesAccede" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "area" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermission" (
    "userId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'ALLOW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("userId","permissionId")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitOfMeasure" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitOfMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "internalCode" TEXT,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ProductType" NOT NULL DEFAULT 'PHYSICAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "categoryId" TEXT,
    "brandId" TEXT,
    "uomId" TEXT,
    "costingMethod" "CostingMethod" NOT NULL DEFAULT 'AVERAGE',
    "lastCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "averageCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "standardCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "trackSerials" BOOLEAN NOT NULL DEFAULT false,
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WarehouseType" NOT NULL DEFAULT 'MAIN',
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "responsibleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "kind" "LocationKind" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT,
    "onHand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KardexEntry" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "reason" "KardexReason" NOT NULL,
    "direction" "MovementType" NOT NULL,
    "movementId" TEXT NOT NULL,
    "quantityIn" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantityOut" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "balanceQty" DECIMAL(18,4) NOT NULL,
    "balanceValue" DECIMAL(18,2) NOT NULL,
    "avgCost" DECIMAL(18,4) NOT NULL,
    "reference" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KardexEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerialNumber" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "warehouseId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SerialNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "status" "FlowStatus" NOT NULL DEFAULT 'DRAFT',
    "orderDate" TIMESTAMP(3) NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "notes" TEXT,
    "requestedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "receivedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" TEXT,
    "warehouseId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "receivedById" TEXT,
    "notes" TEXT,
    "evidenceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GRLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "poLineId" TEXT,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "condition" "ReceiptCondition" NOT NULL DEFAULT 'OK',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GRLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAdjustment" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "reason" "AdjustmentReason" NOT NULL,
    "status" "FlowStatus" NOT NULL DEFAULT 'DRAFT',
    "responsibleId" TEXT,
    "approvedById" TEXT,
    "evidenceUrl" TEXT,
    "notes" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReorderRule" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "minQty" DECIMAL(18,4) NOT NULL,
    "maxQty" DECIMAL(18,4) NOT NULL,
    "reorderPoint" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReorderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryNotification" (
    "id" TEXT NOT NULL,
    "type" "InventoryAlertType" NOT NULL,
    "channel" "AlertChannel" NOT NULL DEFAULT 'IN_APP',
    "status" "AlertStatus" NOT NULL DEFAULT 'PENDIENTE',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "productId" TEXT,
    "warehouseId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "InventoryNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "returnedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "kind" "MaterialAssignmentKind" NOT NULL DEFAULT 'CONSUMABLE',
    "assignedAt" TIMESTAMP(3) NOT NULL,
    "returnedAt" TIMESTAMP(3),
    "status" "MaterialAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "outMovementId" TEXT,
    "inMovementId" TEXT,
    "notes" TEXT,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAssignment" (
    "id" TEXT NOT NULL,
    "serialId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL,
    "returnedAt" TIMESTAMP(3),
    "status" "AssetAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "MaintenanceKind" NOT NULL,
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'COMPLETED',
    "date" TIMESTAMP(3) NOT NULL,
    "serialId" TEXT,
    "productId" TEXT,
    "areaId" TEXT,
    "technician" TEXT,
    "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "meterReading" DECIMAL(18,2),
    "description" TEXT NOT NULL,
    "notes" TEXT,
    "warehouseId" TEXT,
    "planId" TEXT,
    "workOrderId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePart" (
    "id" TEXT NOT NULL,
    "maintenanceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "movementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenancePart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceAttachment" (
    "id" TEXT NOT NULL,
    "maintenanceId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "description" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlan" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "serialId" TEXT,
    "productId" TEXT,
    "areaId" TEXT,
    "kind" "MaintenanceKind" NOT NULL DEFAULT 'PREVENTIVE',
    "frequency" "MaintenanceFrequency" NOT NULL DEFAULT 'BY_DAYS',
    "intervalDays" INTEGER,
    "intervalMeter" DECIMAL(18,2),
    "leadDays" INTEGER NOT NULL DEFAULT 7,
    "lastServiceDate" TIMESTAMP(3),
    "lastServiceMeter" DECIMAL(18,2),
    "nextDueDate" TIMESTAMP(3),
    "nextDueMeter" DECIMAL(18,2),
    "assigneeId" TEXT,
    "assignedEmployeeId" TEXT,
    "warehouseId" TEXT,
    "priority" "WorkOrderPriority" NOT NULL DEFAULT 'MEDIUM',
    "autoCreateWorkOrder" BOOLEAN NOT NULL DEFAULT true,
    "taskTemplate" TEXT[],
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "WorkOrderType" NOT NULL DEFAULT 'CORRECTIVE',
    "priority" "WorkOrderPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'PENDING',
    "areaId" TEXT,
    "warehouseId" TEXT,
    "assigneeId" TEXT,
    "assignedEmployeeId" TEXT,
    "createdById" TEXT,
    "dueDate" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "planId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderTask" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderPhoto" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "description" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderPart" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "movementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderEvent" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "type" "WorkOrderEventType" NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "SalesInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseBillLine" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "productId" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,
    "taxCodeId" TEXT,
    "isInventory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PurchaseBillLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "docType" "EmployeeDocType" NOT NULL DEFAULT 'CC',
    "docNumber" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "position" TEXT,
    "area" TEXT,
    "hireDate" TIMESTAMP(3),
    "birthDate" TIMESTAMP(3),
    "phone" TEXT,
    "email" TEXT,
    "bloodType" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "address" TEXT,
    "city" TEXT,
    "contractType" TEXT,
    "salary" DECIMAL(18,2),
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "eps" TEXT,
    "arl" TEXT,
    "pensionFund" TEXT,
    "compensationFund" TEXT,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "laborRestrictions" TEXT,
    "sstObservations" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "EmployeeDocumentKind" NOT NULL DEFAULT 'OTHER',
    "fileName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "description" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstRiskMatrix" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SstRiskMatrix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstRiskEntry" (
    "id" TEXT NOT NULL,
    "matrixId" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "position" TEXT,
    "activity" TEXT NOT NULL,
    "riskType" "RiskType" NOT NULL,
    "hazard" TEXT NOT NULL,
    "probability" INTEGER NOT NULL DEFAULT 1,
    "impact" INTEGER NOT NULL DEFAULT 1,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'BAJO',
    "existingControls" TEXT,
    "preventiveMeasures" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstRiskEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstEmployeeRisk" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "riskEntryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstEmployeeRisk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstEppDelivery" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "deliveryDate" TIMESTAMP(3) NOT NULL,
    "returnDate" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" "EppDeliveryStatus" NOT NULL DEFAULT 'ENTREGADO',
    "movementId" TEXT,
    "signatureUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstEppDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstMedicalExam" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "MedicalExamType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "provider" TEXT,
    "concept" "MedicalConcept" NOT NULL DEFAULT 'APTO',
    "restrictions" TEXT,
    "nextDueDate" TIMESTAMP(3),
    "fileUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstMedicalExam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstTraining" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "instructor" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "durationHours" DECIMAL(8,2),
    "validityMonths" INTEGER,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstTraining_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstTrainingAttendee" (
    "id" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "TrainingAttendeeStatus" NOT NULL DEFAULT 'INSCRITO',
    "score" DECIMAL(5,2),
    "certificateUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstTrainingAttendee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstIncident" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "time" TEXT,
    "place" TEXT NOT NULL,
    "area" TEXT,
    "reportedById" TEXT,
    "classification" "IncidentClass" NOT NULL,
    "description" TEXT NOT NULL,
    "immediateCause" TEXT,
    "rootCause" TEXT,
    "status" "IncidentStatus" NOT NULL DEFAULT 'REPORTADO',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SstIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstIncidentPerson" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "employeeId" TEXT,
    "externalName" TEXT,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstIncidentPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstInspectionTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "items" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstInspectionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstInspection" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "templateId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "inspectorId" TEXT,
    "targetType" TEXT,
    "targetRef" TEXT,
    "area" TEXT,
    "globalResult" "InspectionItemResult" NOT NULL DEFAULT 'CONFORME',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstInspectionItem" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "result" "InspectionItemResult" NOT NULL DEFAULT 'CONFORME',
    "note" TEXT,
    "evidenceUrl" TEXT,

    CONSTRAINT "SstInspectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstFinding" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "FindingPriority" NOT NULL DEFAULT 'MEDIA',
    "status" "FindingStatus" NOT NULL DEFAULT 'ABIERTO',
    "area" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SstFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstCorrectiveAction" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "responsibleId" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" "ActionStatus" NOT NULL DEFAULT 'PENDIENTE',
    "completedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "evidenceUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SstCorrectiveAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstDocument" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "SstDocType" NOT NULL,
    "title" TEXT NOT NULL,
    "currentVersion" TEXT NOT NULL DEFAULT '1.0',
    "status" "SstDocStatus" NOT NULL DEFAULT 'BORRADOR',
    "ownerId" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "fileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SstDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstDocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fileUrl" TEXT,
    "changeNote" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstEmergencyEquipment" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "EmergencyEquipmentType" NOT NULL,
    "location" TEXT NOT NULL,
    "area" TEXT,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'OPERATIVO',
    "lastInspectionAt" TIMESTAMP(3),
    "nextInspectionAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SstEmergencyEquipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstBrigade" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstBrigade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstBrigadeMember" (
    "id" TEXT NOT NULL,
    "brigadeId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "role" "BrigadeRole" NOT NULL DEFAULT 'BRIGADISTA',
    "certifications" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SstBrigadeMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstDrill" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" "DrillType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "scenario" TEXT NOT NULL,
    "location" TEXT,
    "participantsCount" INTEGER,
    "result" TEXT,
    "findingsSummary" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstDrill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstDrillParticipant" (
    "id" TEXT NOT NULL,
    "drillId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "SstDrillParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstContractor" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "partyId" TEXT,
    "responsibleName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SstContractor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstContractorDocument" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileUrl" TEXT,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstContractorDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstComplianceAudit" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "auditor" TEXT NOT NULL,
    "scope" TEXT,
    "summary" TEXT,
    "score" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstComplianceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstEvidence" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PHOTO',
    "url" TEXT NOT NULL,
    "description" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SstEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SstNotification" (
    "id" TEXT NOT NULL,
    "type" "SstAlertType" NOT NULL,
    "channel" "AlertChannel" NOT NULL DEFAULT 'IN_APP',
    "status" "AlertStatus" NOT NULL DEFAULT 'PENDIENTE',
    "employeeId" TEXT,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "dueDate" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "SstNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollConcept" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "PayrollConceptType" NOT NULL,
    "salaryNature" "PayrollSalaryNature" NOT NULL DEFAULT 'SALARIAL',
    "category" "PayrollConceptCategory" NOT NULL DEFAULT 'OTHER',
    "calcMethod" "PayrollCalcMethod" NOT NULL DEFAULT 'FIXED',
    "rate" DECIMAL(18,6),
    "base" "PayrollCalcBase" NOT NULL DEFAULT 'NONE',
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "cycleDays" INTEGER,
    "affectsHealth" BOOLEAN NOT NULL DEFAULT false,
    "affectsPension" BOOLEAN NOT NULL DEFAULT false,
    "affectsParafiscals" BOOLEAN NOT NULL DEFAULT false,
    "affectsSeverance" BOOLEAN NOT NULL DEFAULT false,
    "affectsVacation" BOOLEAN NOT NULL DEFAULT false,
    "affectsBonus" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollConcept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollContract" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "contractType" "PayrollContractType" NOT NULL DEFAULT 'INDEFINITE',
    "payClass" "PayrollPayClass" NOT NULL DEFAULT 'QUINCENAL',
    "baseSalary" DECIMAL(18,2) NOT NULL,
    "monthlyHours" DECIMAL(10,2) NOT NULL DEFAULT 240,
    "transportAllowance" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "payday" TIMESTAMP(3),
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollEvent" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "conceptId" TEXT,
    "periodId" TEXT,
    "type" "PayrollEventType" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "quantity" DECIMAL(12,2),
    "amount" DECIMAL(18,2),
    "notes" TEXT,
    "status" "PayrollEventStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "contractId" TEXT,
    "baseSalary" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grossSalary" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalEarnings" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netSalary" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "PayslipStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayslipLine" (
    "id" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "conceptId" TEXT,
    "type" "PayrollConceptType" NOT NULL,
    "salaryNature" "PayrollSalaryNature" NOT NULL DEFAULT 'SALARIAL',
    "category" "PayrollConceptCategory" NOT NULL DEFAULT 'OTHER',
    "label" TEXT NOT NULL,
    "origin" TEXT,
    "formula" TEXT,
    "quantity" DECIMAL(12,2),
    "unitValue" DECIMAL(18,2),
    "amount" DECIMAL(18,2) NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayslipLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingIntegrationLog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "status" "IntegrationStatus" NOT NULL,
    "periodId" TEXT,
    "payslipId" TEXT,
    "reference" TEXT,
    "message" TEXT,
    "request" JSONB,
    "response" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingIntegrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "dir" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscriber" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "abonado" INTEGER NOT NULL,
    "suscripcion" TEXT,
    "firstName" TEXT,
    "secondName" TEXT,
    "lastName1" TEXT,
    "lastName2" TEXT,
    "companyName" TEXT,
    "fullName" TEXT,
    "customerType" TEXT,
    "docType" TEXT,
    "docNumber" TEXT,
    "birthDate" DATE,
    "phone1" TEXT,
    "phone2" TEXT,
    "email" TEXT,
    "contractDate" DATE,
    "entryDate" DATE,
    "estrato" TEXT,
    "clausula" INTEGER,
    "departmentRef" TEXT,
    "cityRef" TEXT,
    "localityRef" TEXT,
    "neighborhood" TEXT,
    "addressLine" TEXT,
    "nomenclature" JSONB,
    "gpsLat" TEXT,
    "gpsLng" TEXT,
    "branchId" TEXT,
    "pppUsername" TEXT,
    "pppPassword" TEXT,
    "pppService" TEXT,
    "pppProfile" TEXT,
    "ipLocal" TEXT,
    "ipRemote" TEXT,
    "netComment" TEXT,
    "macEquipo" TEXT,
    "macOnt" TEXT,
    "installTech" "InstallTech",
    "status" "SubscriberStatus",
    "previousStatus" "SubscriberStatus",
    "statusChangedAt" TIMESTAMP(3),
    "statusGenDate" DATE,
    "promiseExpiry" DATE,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "debitCache" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditCache" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "eInvoice" BOOLEAN NOT NULL DEFAULT false,
    "eInvoiceTv" BOOLEAN NOT NULL DEFAULT false,
    "eInvoiceInternet" BOOLEAN NOT NULL DEFAULT false,
    "eInvoicePuntos" BOOLEAN NOT NULL DEFAULT false,
    "digitalSignature" BOOLEAN NOT NULL DEFAULT false,
    "eInvoicePayMethod" "EInvoicePayMethod",
    "picture" TEXT,
    "partyId" TEXT,
    "lastEmailReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MikrotikActionLog" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT,
    "mikrotikId" TEXT,
    "mikrotikName" TEXT,
    "action" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "detail" TEXT,
    "pppUsername" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MikrotikActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OltActionLog" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT,
    "oltId" TEXT,
    "oltName" TEXT,
    "action" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "detail" TEXT,
    "sn" TEXT,
    "fsp" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OltActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenieacsActionLog" (
    "id" TEXT NOT NULL,
    "serverId" TEXT,
    "serverName" TEXT,
    "action" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "detail" TEXT,
    "deviceId" TEXT,
    "subscriberId" TEXT,
    "count" INTEGER,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenieacsActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayhubSubscription" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "subscriberId" TEXT,
    "nameS" TEXT,
    "externalName" TEXT,
    "productId" TEXT,
    "productName" TEXT,
    "voucher" TEXT,
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "PlayhubSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappMessage" (
    "id" TEXT NOT NULL,
    "waMessageId" TEXT,
    "direction" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "hasAudio" BOOLEAN NOT NULL DEFAULT false,
    "subscriberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'es',
    "category" TEXT,
    "bodyText" TEXT NOT NULL,
    "headerText" TEXT,
    "variables" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" TEXT,
    "templateName" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'es',
    "filterJson" JSONB,
    "total" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "read" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WhatsappCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappSend" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "subscriberId" TEXT,
    "phone" TEXT NOT NULL,
    "templateName" TEXT,
    "waMessageId" TEXT,
    "status" "WhatsappSendStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "body" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Movil" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Activa',
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Movil_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MovilMember" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "movilId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "role" TEXT,

    CONSTRAINT "MovilMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalMessage" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "campaignName" TEXT,
    "refId" INTEGER,
    "recipientUserId" INTEGER,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocFolder" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "folderId" TEXT,
    "title" TEXT NOT NULL,
    "fileName" TEXT,
    "storedName" TEXT,
    "docDate" DATE,
    "permission" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CronRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "detail" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "userName" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberService" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "kind" "ServiceKind" NOT NULL,
    "planName" TEXT,
    "price" DECIMAL(18,2),
    "taxRate" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "status" "ServiceStatus" NOT NULL DEFAULT 'ACTIVO',
    "megas" INTEGER,
    "planId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriberService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ServiceKind" NOT NULL DEFAULT 'INTERNET',
    "pppProfile" TEXT,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "megas" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberStatusHistory" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "status" "SubscriberStatus" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "originTicketId" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "subscriberId" TEXT NOT NULL,
    "callType" TEXT,
    "responseType" TEXT,
    "responseDetail" TEXT,
    "responsible" TEXT,
    "date" DATE NOT NULL,
    "time" TEXT,
    "dueDate" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubInvoice" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "tid" INTEGER NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "issuerUserId" INTEGER,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "shipping" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "SubInvoiceStatus" NOT NULL DEFAULT 'DUE',
    "ron" "InvoiceRon",
    "paymentMethod" TEXT,
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "taxEnabled" BOOLEAN NOT NULL DEFAULT true,
    "discEnabled" BOOLEAN NOT NULL DEFAULT false,
    "discountFormat" TEXT,
    "branchRef" TEXT,
    "serviceTv" TEXT,
    "serviceCombo" TEXT,
    "puntos" INTEGER,
    "estadoTv" "ServiceStatus",
    "estadoCombo" "ServiceStatus",
    "streamingStandard" INTEGER NOT NULL DEFAULT 0,
    "streamingPremium" INTEGER NOT NULL DEFAULT 0,
    "streamingPremiumPlus" INTEGER NOT NULL DEFAULT 0,
    "streamingDiamante" INTEGER NOT NULL DEFAULT 0,
    "term" INTEGER,
    "rec" TEXT,
    "reconnectFlag" BOOLEAN NOT NULL DEFAULT false,
    "currencyRef" INTEGER,
    "kind" "InvoiceKind" NOT NULL DEFAULT 'RECURRENTE',
    "promo" INTEGER,
    "promo2" INTEGER,
    "promoModifiedDate" DATE,
    "promo2ModifiedDate" DATE,
    "retentionType" "RetentionType",
    "eInvoiceFlag" TEXT,
    "eInvoiceGenDate" DATE,
    "eInvoiceServices" TEXT,
    "eInvoicePayMethod" "EInvoicePayMethod",
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubInvoiceItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "invoiceId" TEXT NOT NULL,
    "productId" INTEGER,
    "productName" TEXT,
    "description" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxRemoved" INTEGER,
    "retentionType" "RetentionType",
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdditionalService" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "invoiceId" TEXT,
    "ticketId" INTEGER,
    "productId" INTEGER NOT NULL,
    "valor" TEXT NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdditionalService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionCategory" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "TransactionCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "cashAccountId" INTEGER,
    "accountName" TEXT,
    "type" "TxType" NOT NULL,
    "category" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "payerName" TEXT,
    "subscriberId" TEXT,
    "method" TEXT,
    "date" DATE NOT NULL,
    "invoiceId" TEXT,
    "issuerUserId" INTEGER,
    "note" TEXT,
    "ext" BOOLEAN NOT NULL DEFAULT false,
    "bankName" TEXT,
    "bankId" INTEGER,
    "status" "TxStatus" NOT NULL DEFAULT 'VIGENTE',
    "noShow" BOOLEAN NOT NULL DEFAULT false,
    "payuOrderId" TEXT,
    "attach" TEXT,
    "attachName" TEXT,
    "supplyOrderId" TEXT,
    "stockReturnId" TEXT,
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReceipt" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "date" TIMESTAMP(3) NOT NULL,
    "fileName" TEXT NOT NULL,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptTransaction" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,

    CONSTRAINT "ReceiptTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voiding" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "dateTime" TIMESTAMP(3) NOT NULL,
    "detail" TEXT,
    "transactionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "voidedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voiding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashClose" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "cashAccountId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "base" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sales" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "expenses" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "transfersIn" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "transfersOut" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deposited" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "surplus" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringInvoice" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "tid" INTEGER NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "invoiceDate" DATE,
    "dueDate" DATE,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "shipping" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT,
    "ron" TEXT,
    "term" INTEGER,
    "rec" TEXT,
    "notes" TEXT,
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "branchRef" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringInvoiceItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "invoiceId" TEXT NOT NULL,
    "productId" INTEGER,
    "productName" TEXT,
    "description" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashOpen" (
    "id" TEXT NOT NULL,
    "cashAccountId" INTEGER NOT NULL,
    "accountName" TEXT,
    "date" DATE NOT NULL,
    "base" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "openedBy" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashOpen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashAccount" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "accountNumber" TEXT,
    "holder" TEXT NOT NULL,
    "branchLegacy" INTEGER,
    "balance" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "fixedFund" DECIMAL(14,2) NOT NULL DEFAULT 200000,
    "code" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "departmentRef" TEXT,

    CONSTRAINT "CashAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "departmentLegacy" INTEGER,
    "name" TEXT NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Locality" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "departmentLegacy" INTEGER,
    "cityLegacy" INTEGER,
    "name" TEXT NOT NULL,

    CONSTRAINT "Locality_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Neighborhood" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "departmentLegacy" INTEGER,
    "cityLegacy" INTEGER,
    "localityLegacy" INTEGER,
    "name" TEXT NOT NULL,

    CONSTRAINT "Neighborhood_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyInfo" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "taxId" TEXT,
    "currency" TEXT,
    "prefix" TEXT,
    "logo" TEXT,

    CONSTRAINT "CompanyInfo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "orderNo" INTEGER,
    "taskId" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "color" TEXT,
    "start" TIMESTAMP(3),
    "end" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "rel" INTEGER,
    "rid" INTEGER,
    "assignedBy" TEXT,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "tid" INTEGER NOT NULL,
    "subscriberId" TEXT,
    "subscriberLegacy" INTEGER,
    "invoiceDate" DATE,
    "dueDate" DATE,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "proposal" TEXT,
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "quoteId" TEXT NOT NULL,
    "materialLegacy" INTEGER,
    "product" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffArea" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "StaffArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "docNumber" TEXT,
    "username" TEXT,
    "email" TEXT,
    "role" INTEGER,
    "entryDate" DATE,
    "rh" TEXT,
    "eps" TEXT,
    "pension" TEXT,
    "address" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "areaId" TEXT,
    "areaLegacy" INTEGER,
    "phone" TEXT,
    "phoneAlt" TEXT,
    "picture" TEXT,
    "sign" TEXT,
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "lastLogin" TIMESTAMP(3),
    "sedeAccede" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "percentage" INTEGER NOT NULL DEFAULT 0,
    "discountFormat" TEXT NOT NULL DEFAULT '%',
    "flatAmount" DECIMAL(18,2),
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "global" BOOLEAN NOT NULL DEFAULT false,
    "subscriberStatus" "SubscriberStatus",
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionAssignmentLog" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "promotionName" TEXT NOT NULL,
    "staffId" TEXT,
    "staffName" TEXT NOT NULL,
    "action" "PromotionAssignAction" NOT NULL,
    "assignedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionAssignmentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionApplication" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "staffId" TEXT,
    "appliedByName" TEXT,
    "percentage" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "priority" TEXT NOT NULL DEFAULT 'Medium',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "subscriberId" TEXT,
    "subscriberLegacy" INTEGER,
    "startDate" DATE,
    "endDate" DATE,
    "tag" TEXT,
    "phase" TEXT,
    "note" TEXT,
    "worth" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "detail" TEXT,
    "color" TEXT,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "category" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "nit" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "region" TEXT,
    "payMethod" TEXT,
    "account" TEXT,
    "accountType" TEXT,
    "bank" TEXT,
    "company" TEXT,
    "branchRef" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialCategory" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "title" TEXT NOT NULL,
    "extra" TEXT,

    CONSTRAINT "MaterialCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialWarehouse" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "title" TEXT NOT NULL,
    "extra" TEXT,
    "technicianRef" TEXT,

    CONSTRAINT "MaterialWarehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "categoryId" TEXT,
    "categoryLegacy" INTEGER,
    "warehouseId" TEXT,
    "warehouseLegacy" INTEGER,
    "branchRef" INTEGER,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "discRate" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "alert" INTEGER,
    "serviceType" TEXT,
    "tvOrNet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialActa" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "date" TIMESTAMP(3) NOT NULL,
    "fromWarehouseLegacy" INTEGER,
    "toWarehouseLegacy" INTEGER,
    "fromWarehouseId" TEXT,
    "toWarehouseId" TEXT,
    "fromWarehouseName" TEXT,
    "toWarehouseName" TEXT,
    "observations" TEXT,
    "userId" INTEGER,
    "createdByName" TEXT,
    "assignedToId" TEXT,
    "assignedToName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Emitida',
    "receivedBy" INTEGER,
    "receivedByName" TEXT,
    "receivedAt" TIMESTAMP(3),
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialActa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialActaItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "actaId" TEXT NOT NULL,
    "materialId" TEXT,
    "materialLegacy" INTEGER,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "received" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "MaterialActaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplyOrder" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "tid" INTEGER NOT NULL,
    "supplierId" TEXT,
    "supplierLegacy" INTEGER,
    "orderDate" DATE,
    "dueDate" DATE,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "shipping" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pendiente',
    "categoryRef" TEXT,
    "warehouseRef" INTEGER,
    "branchRef" TEXT,
    "notes" TEXT,
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "receivedBy" INTEGER,
    "receivedAt" TIMESTAMP(3),
    "retentionType" TEXT,
    "retention" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'compra',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplyOrderItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "orderId" TEXT NOT NULL,
    "materialId" TEXT,
    "materialLegacy" INTEGER,
    "product" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(9,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SupplyOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReturn" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "tid" INTEGER NOT NULL,
    "supplierId" TEXT,
    "supplierLegacy" INTEGER,
    "date" DATE,
    "dueDate" DATE,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReturnItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "returnId" TEXT NOT NULL,
    "materialId" TEXT,
    "materialLegacy" INTEGER,
    "product" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "StockReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentGateway" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "key1" TEXT NOT NULL,
    "key2" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "devMode" BOOLEAN NOT NULL DEFAULT false,
    "ord" INTEGER NOT NULL DEFAULT 0,
    "surcharge" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "PaymentGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOrder" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'wompi',
    "method" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "gatewayTxId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "transactionId" TEXT,
    "rawInit" JSONB,
    "rawWebhook" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT,
    "uploadedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Cargado',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "appliedRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "notFoundRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "appliedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "documento" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'EFECTY',
    "reference" TEXT,
    "date" DATE,
    "status" TEXT NOT NULL DEFAULT 'Inicial',
    "subscriberId" TEXT,
    "message" TEXT,
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiigoAccount" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "role" TEXT NOT NULL,
    "companyName" TEXT,
    "username" TEXT NOT NULL,
    "accessKey" TEXT NOT NULL,
    "token" TEXT,
    "tokenExpires" TIMESTAMP(3),
    "subscriptionKey" TEXT,
    "apiBaseUrl" TEXT NOT NULL DEFAULT 'https://api.siigo.com/v1',
    "authUrl" TEXT NOT NULL DEFAULT 'https://api.siigo.com/auth',
    "documentId" INTEGER,
    "creditNoteDocumentId" INTEGER,
    "sellerId" INTEGER,
    "ivaTaxId" INTEGER,
    "paymentCredIt" INTEGER,
    "paymentCash" INTEGER,
    "contactEmail" TEXT,
    "costCenterByBranch" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiigoAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ElectronicInvoice" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "siigoAccountId" TEXT,
    "subscriberId" TEXT,
    "invoiceId" TEXT,
    "date" DATE NOT NULL,
    "executedAt" TIMESTAMP(3),
    "servicesBilled" TEXT,
    "createdWithMultiple" BOOLEAN NOT NULL DEFAULT false,
    "type" "EInvoiceType" NOT NULL DEFAULT 'FACTURADA',
    "payMethod" "EInvoicePayMethod",
    "legacyConsecutive" INTEGER DEFAULT 0,
    "payloadJson" TEXT,
    "siigoInvoiceId" TEXT,
    "dianNumber" TEXT,
    "cufe" TEXT,
    "pdfUrl" TEXT,
    "xmlUrl" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ElectronicInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mikrotik" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "port" TEXT NOT NULL,
    "tech" TEXT NOT NULL,
    "branchId" TEXT,
    "sedeLegacy" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mikrotik_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Olt" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "port" TEXT NOT NULL DEFAULT '22',
    "tech" TEXT NOT NULL DEFAULT 'GPON',
    "branchId" TEXT,
    "sedeLegacy" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "defaultLineProfile" INTEGER,
    "defaultSrvProfile" INTEGER,
    "defaultVlan" INTEGER,
    "defaultGemport" INTEGER,
    "defaultUserVlan" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Olt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenieacsServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nbiUrl" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "password" TEXT NOT NULL DEFAULT '',
    "sedeLegacy" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenieacsServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OltOnu" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "oltId" TEXT NOT NULL,
    "frame" INTEGER NOT NULL DEFAULT 0,
    "slot" INTEGER,
    "port" INTEGER,
    "ontId" INTEGER,
    "sn" TEXT,
    "description" TEXT,
    "runState" TEXT,
    "configState" TEXT,
    "matchState" TEXT,
    "rxPower" TEXT,
    "syncState" TEXT NOT NULL DEFAULT 'presente',
    "subscriberId" TEXT,
    "clientName" TEXT,
    "firstSeen" TIMESTAMP(3),
    "lastSync" TIMESTAMP(3),

    CONSTRAINT "OltOnu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vlan" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "branchId" TEXT,
    "sedeLegacy" INTEGER NOT NULL,
    "vlan" INTEGER NOT NULL,
    "olt" TEXT,
    "tray" INTEGER,
    "oltPort" INTEGER,
    "detail" TEXT NOT NULL,

    CONSTRAINT "Vlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nap" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "branchId" TEXT,
    "sedeLegacy" INTEGER NOT NULL,
    "vlanId" TEXT,
    "vlanLegacy" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "portCount" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "gpsLat" TEXT,
    "gpsLng" TEXT,

    CONSTRAINT "Nap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Port" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "sedeLegacy" INTEGER NOT NULL,
    "vlanLegacy" INTEGER NOT NULL,
    "napId" TEXT,
    "napLegacy" INTEGER NOT NULL,
    "port" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "subscriberId" TEXT,
    "assignedLegacy" INTEGER NOT NULL,
    "detail" TEXT NOT NULL,

    CONSTRAINT "Port_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpUserMk" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ipLocal" TEXT NOT NULL,
    "ipRemote" TEXT NOT NULL,
    "tech" TEXT NOT NULL,
    "sedeLegacy" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "profiles" TEXT NOT NULL,

    CONSTRAINT "IpUserMk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenieacsConnection" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ipRemote" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "branchId" TEXT,
    "sedeLegacy" INTEGER NOT NULL,
    "comments" TEXT,
    "updatedByUserId" INTEGER,

    CONSTRAINT "GenieacsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentWarehouse" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "EquipmentWarehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "code" INTEGER NOT NULL,
    "supplierLegacy" INTEGER NOT NULL DEFAULT 0,
    "warehouseId" TEXT,
    "warehouseLegacy" INTEGER NOT NULL,
    "mac" TEXT,
    "serial" TEXT,
    "arrival" DATE,
    "endDate" DATE,
    "brand" TEXT,
    "installType" TEXT,
    "port" INTEGER,
    "vlan" INTEGER,
    "nat" INTEGER,
    "subscriberId" TEXT,
    "assignedRaw" TEXT,
    "status" TEXT,
    "observation" TEXT,
    "master" TEXT,
    "image" TEXT,
    "meters" INTEGER,
    "accessories" TEXT,
    "genieacsId" TEXT,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentTransfer" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "date" TIMESTAMP(3) NOT NULL,
    "fromWarehouse" TEXT NOT NULL,
    "toWarehouse" TEXT NOT NULL,
    "fromWarehouseName" TEXT,
    "toWarehouseName" TEXT,
    "observations" TEXT,
    "userId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Emitida',
    "fromWarehouseId" TEXT,
    "toWarehouseId" TEXT,
    "requestedById" TEXT,
    "requestedByName" TEXT,
    "requestedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedByName" TEXT,
    "receivedAt" TIMESTAMP(3),
    "rejectReason" TEXT,

    CONSTRAINT "EquipmentTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentTransferItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "transferId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "equipmentLegacy" INTEGER NOT NULL,

    CONSTRAINT "EquipmentTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "code" INTEGER,
    "subject" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "created" DATE NOT NULL,
    "subscriberId" TEXT,
    "col" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'PENDIENTE',
    "priority" TEXT NOT NULL DEFAULT 'Media',
    "problem" TEXT,
    "section" TEXT,
    "finalDate" DATE,
    "invoiceLegacy" INTEGER,
    "invoiceBillLegacy" INTEGER,
    "assigned" TEXT,
    "par" INTEGER,
    "signatureName" TEXT,
    "signatureCc" TEXT,
    "signatureRel" TEXT,
    "signatureImage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMaterial" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "materialId" TEXT,
    "materialName" TEXT NOT NULL,
    "warehouseId" TEXT,
    "warehouseName" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employeeName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketThread" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "ticketCode" INTEGER NOT NULL,
    "message" TEXT,
    "subscriberId" TEXT,
    "employeeId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "attach" TEXT,
    "attachName" TEXT,
    "geoLat" TEXT,
    "geoLng" TEXT,

    CONSTRAINT "TicketThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferActa" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "fromWarehouse" INTEGER NOT NULL,
    "toWarehouse" INTEGER NOT NULL,
    "observations" TEXT,
    "userTransfers" INTEGER NOT NULL,
    "status" TEXT,
    "userReceives" INTEGER,
    "receptionDate" TIMESTAMP(3),

    CONSTRAINT "TransferActa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferActaItem" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "productTransferLegacy" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "actaId" TEXT NOT NULL,

    CONSTRAINT "TransferActaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TodoTask" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "tdate" DATE NOT NULL,
    "name" TEXT,
    "status" "TodoStatus" NOT NULL DEFAULT 'DUE',
    "start" DATE,
    "dueDate" DATE,
    "description" TEXT,
    "orderId" INTEGER NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "assigneeId" INTEGER NOT NULL,
    "related" INTEGER,
    "priority" "TodoPriority" NOT NULL DEFAULT 'MEDIUM',
    "rid" INTEGER,
    "score" INTEGER,

    CONSTRAINT "TodoTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberFile" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberNote" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessGoal" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "income" BIGINT NOT NULL DEFAULT 0,
    "expense" BIGINT NOT NULL DEFAULT 0,
    "sales" BIGINT NOT NULL DEFAULT 0,
    "netincome" BIGINT NOT NULL DEFAULT 0,
    "users" BIGINT NOT NULL DEFAULT 0,
    "vesagro" BIGINT NOT NULL DEFAULT 0,
    "servicios" BIGINT NOT NULL DEFAULT 0,
    "compras" BIGINT NOT NULL DEFAULT 0,
    "creditos" BIGINT NOT NULL DEFAULT 0,
    "nomina" BIGINT NOT NULL DEFAULT 0,
    "socios" BIGINT NOT NULL DEFAULT 0,
    "oficial" BIGINT NOT NULL DEFAULT 0,
    "internet" BIGINT NOT NULL DEFAULT 0,
    "programadora" BIGINT NOT NULL DEFAULT 0,
    "impuestos" BIGINT NOT NULL DEFAULT 0,
    "publicos" BIGINT NOT NULL DEFAULT 0,
    "comisiones" BIGINT NOT NULL DEFAULT 0,
    "celulares" BIGINT NOT NULL DEFAULT 0,
    "purchase" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "BusinessGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatbotSession" (
    "id" TEXT NOT NULL,
    "convKey" TEXT NOT NULL,
    "history" JSONB NOT NULL DEFAULT '[]',
    "pending" JSONB,
    "pendingAt" TIMESTAMP(3),
    "handoffAt" TIMESTAMP(3),
    "handoffReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatbotSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatbotUsage" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatbotUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatbotSeenMessage" (
    "messageId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatbotSeenMessage_pkey" PRIMARY KEY ("messageId")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "group" TEXT NOT NULL DEFAULT 'general',
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['clients:read']::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "ignoreLimits" BOOLEAN NOT NULL DEFAULT false,
    "rateLimit" INTEGER NOT NULL DEFAULT 500,
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PromotionAssignees" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionAssignees_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Kpi_key_key" ON "Kpi"("key");

-- CreateIndex
CREATE INDEX "Kpi_group_idx" ON "Kpi"("group");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueMonth_sortOrder_key" ON "RevenueMonth"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_sortOrder_key" ON "Deal"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_sortOrder_key" ON "Activity"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardEntry_rank_key" ON "LeaderboardEntry"("rank");

-- CreateIndex
CREATE UNIQUE INDEX "Region_sortOrder_key" ON "Region"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Account_code_key" ON "Account"("code");

-- CreateIndex
CREATE INDEX "Account_type_idx" ON "Account"("type");

-- CreateIndex
CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "CostCenter_code_key" ON "CostCenter"("code");

-- CreateIndex
CREATE INDEX "FiscalPeriod_status_idx" ON "FiscalPeriod"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_year_month_key" ON "FiscalPeriod"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_number_key" ON "JournalEntry"("number");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversedById_key" ON "JournalEntry"("reversedById");

-- CreateIndex
CREATE INDEX "JournalEntry_date_idx" ON "JournalEntry"("date");

-- CreateIndex
CREATE INDEX "JournalEntry_status_idx" ON "JournalEntry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_sourceType_sourceId_key" ON "JournalEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxCode_code_key" ON "TaxCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AccountMapping_key_key" ON "AccountMapping"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FixedAssetCategory_code_key" ON "FixedAssetCategory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "FixedAsset_code_key" ON "FixedAsset"("code");

-- CreateIndex
CREATE INDEX "FixedAsset_categoryId_idx" ON "FixedAsset"("categoryId");

-- CreateIndex
CREATE INDEX "FixedAsset_status_idx" ON "FixedAsset"("status");

-- CreateIndex
CREATE INDEX "DepreciationEntry_assetId_idx" ON "DepreciationEntry"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationEntry_assetId_year_month_key" ON "DepreciationEntry"("assetId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "SalesInvoice_number_key" ON "SalesInvoice"("number");

-- CreateIndex
CREATE INDEX "SalesInvoice_partyId_idx" ON "SalesInvoice"("partyId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBill_number_key" ON "PurchaseBill"("number");

-- CreateIndex
CREATE INDEX "PurchaseBill_partyId_idx" ON "PurchaseBill"("partyId");

-- CreateIndex
CREATE UNIQUE INDEX "BankMovement_statementLineId_key" ON "BankMovement"("statementLineId");

-- CreateIndex
CREATE INDEX "BankMovement_bankAccountId_idx" ON "BankMovement"("bankAccountId");

-- CreateIndex
CREATE INDEX "BankStatementLine_bankAccountId_idx" ON "BankStatementLine"("bankAccountId");

-- CreateIndex
CREATE INDEX "InventoryMovement_productId_idx" ON "InventoryMovement"("productId");

-- CreateIndex
CREATE INDEX "InventoryMovement_warehouseFromId_idx" ON "InventoryMovement"("warehouseFromId");

-- CreateIndex
CREATE INDEX "InventoryMovement_warehouseToId_idx" ON "InventoryMovement"("warehouseToId");

-- CreateIndex
CREATE INDEX "InventoryMovement_partyId_idx" ON "InventoryMovement"("partyId");

-- CreateIndex
CREATE INDEX "InventoryMovement_counterpartyEmployeeId_idx" ON "InventoryMovement"("counterpartyEmployeeId");

-- CreateIndex
CREATE INDEX "InventoryMovement_costCenterId_idx" ON "InventoryMovement"("costCenterId");

-- CreateIndex
CREATE INDEX "InventoryMovement_date_idx" ON "InventoryMovement"("date");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_whatsappPhone_key" ON "User"("whatsappPhone");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Category_code_key" ON "Category"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_name_key" ON "Brand"("name");

-- CreateIndex
CREATE UNIQUE INDEX "UnitOfMeasure_code_key" ON "UnitOfMeasure"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_internalCode_key" ON "Product"("internalCode");

-- CreateIndex
CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_brandId_idx" ON "Product"("brandId");

-- CreateIndex
CREATE INDEX "Product_entryDate_idx" ON "Product"("entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_code_key" ON "Warehouse"("code");

-- CreateIndex
CREATE INDEX "Location_warehouseId_idx" ON "Location"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_warehouseId_code_key" ON "Location"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "StockLevel_productId_idx" ON "StockLevel"("productId");

-- CreateIndex
CREATE INDEX "StockLevel_warehouseId_idx" ON "StockLevel"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_productId_warehouseId_locationId_key" ON "StockLevel"("productId", "warehouseId", "locationId");

-- CreateIndex
CREATE INDEX "KardexEntry_productId_warehouseId_date_idx" ON "KardexEntry"("productId", "warehouseId", "date");

-- CreateIndex
CREATE INDEX "KardexEntry_movementId_idx" ON "KardexEntry"("movementId");

-- CreateIndex
CREATE UNIQUE INDEX "SerialNumber_serial_key" ON "SerialNumber"("serial");

-- CreateIndex
CREATE INDEX "SerialNumber_productId_idx" ON "SerialNumber"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_number_key" ON "PurchaseOrder"("number");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");

-- CreateIndex
CREATE INDEX "POLine_orderId_idx" ON "POLine"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_number_key" ON "GoodsReceipt"("number");

-- CreateIndex
CREATE INDEX "GoodsReceipt_orderId_idx" ON "GoodsReceipt"("orderId");

-- CreateIndex
CREATE INDEX "GRLine_receiptId_idx" ON "GRLine"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryAdjustment_number_key" ON "InventoryAdjustment"("number");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderRule_productId_warehouseId_key" ON "ReorderRule"("productId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryNotification_dedupeKey_key" ON "InventoryNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "InventoryNotification_status_idx" ON "InventoryNotification"("status");

-- CreateIndex
CREATE INDEX "InventoryNotification_type_idx" ON "InventoryNotification"("type");

-- CreateIndex
CREATE INDEX "MaterialAssignment_employeeId_idx" ON "MaterialAssignment"("employeeId");

-- CreateIndex
CREATE INDEX "MaterialAssignment_productId_idx" ON "MaterialAssignment"("productId");

-- CreateIndex
CREATE INDEX "MaterialAssignment_status_idx" ON "MaterialAssignment"("status");

-- CreateIndex
CREATE INDEX "AssetAssignment_serialId_idx" ON "AssetAssignment"("serialId");

-- CreateIndex
CREATE INDEX "AssetAssignment_employeeId_idx" ON "AssetAssignment"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Area_code_key" ON "Area"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceOrder_number_key" ON "MaintenanceOrder"("number");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceOrder_workOrderId_key" ON "MaintenanceOrder"("workOrderId");

-- CreateIndex
CREATE INDEX "MaintenanceOrder_serialId_idx" ON "MaintenanceOrder"("serialId");

-- CreateIndex
CREATE INDEX "MaintenanceOrder_productId_idx" ON "MaintenanceOrder"("productId");

-- CreateIndex
CREATE INDEX "MaintenanceOrder_areaId_idx" ON "MaintenanceOrder"("areaId");

-- CreateIndex
CREATE INDEX "MaintenanceOrder_kind_idx" ON "MaintenanceOrder"("kind");

-- CreateIndex
CREATE INDEX "MaintenanceOrder_date_idx" ON "MaintenanceOrder"("date");

-- CreateIndex
CREATE INDEX "MaintenancePart_maintenanceId_idx" ON "MaintenancePart"("maintenanceId");

-- CreateIndex
CREATE INDEX "MaintenancePart_productId_idx" ON "MaintenancePart"("productId");

-- CreateIndex
CREATE INDEX "MaintenanceAttachment_maintenanceId_idx" ON "MaintenanceAttachment"("maintenanceId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePlan_number_key" ON "MaintenancePlan"("number");

-- CreateIndex
CREATE INDEX "MaintenancePlan_active_idx" ON "MaintenancePlan"("active");

-- CreateIndex
CREATE INDEX "MaintenancePlan_nextDueDate_idx" ON "MaintenancePlan"("nextDueDate");

-- CreateIndex
CREATE INDEX "MaintenancePlan_serialId_idx" ON "MaintenancePlan"("serialId");

-- CreateIndex
CREATE INDEX "MaintenancePlan_productId_idx" ON "MaintenancePlan"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_number_key" ON "WorkOrder"("number");

-- CreateIndex
CREATE INDEX "WorkOrder_assigneeId_idx" ON "WorkOrder"("assigneeId");

-- CreateIndex
CREATE INDEX "WorkOrder_assignedEmployeeId_idx" ON "WorkOrder"("assignedEmployeeId");

-- CreateIndex
CREATE INDEX "WorkOrder_status_idx" ON "WorkOrder"("status");

-- CreateIndex
CREATE INDEX "WorkOrder_areaId_idx" ON "WorkOrder"("areaId");

-- CreateIndex
CREATE INDEX "WorkOrder_priority_idx" ON "WorkOrder"("priority");

-- CreateIndex
CREATE INDEX "WorkOrder_type_idx" ON "WorkOrder"("type");

-- CreateIndex
CREATE INDEX "WorkOrderTask_workOrderId_idx" ON "WorkOrderTask"("workOrderId");

-- CreateIndex
CREATE INDEX "WorkOrderPhoto_workOrderId_idx" ON "WorkOrderPhoto"("workOrderId");

-- CreateIndex
CREATE INDEX "WorkOrderPart_workOrderId_idx" ON "WorkOrderPart"("workOrderId");

-- CreateIndex
CREATE INDEX "WorkOrderPart_productId_idx" ON "WorkOrderPart"("productId");

-- CreateIndex
CREATE INDEX "WorkOrderEvent_workOrderId_idx" ON "WorkOrderEvent"("workOrderId");

-- CreateIndex
CREATE INDEX "WorkOrderEvent_createdAt_idx" ON "WorkOrderEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SalesInvoiceLine_invoiceId_idx" ON "SalesInvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "PurchaseBillLine_billId_idx" ON "PurchaseBillLine"("billId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_docNumber_key" ON "Employee"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_area_idx" ON "Employee"("area");

-- CreateIndex
CREATE INDEX "Employee_status_idx" ON "Employee"("status");

-- CreateIndex
CREATE INDEX "EmployeeDocument_employeeId_idx" ON "EmployeeDocument"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_kind_idx" ON "EmployeeDocument"("kind");

-- CreateIndex
CREATE INDEX "SstRiskEntry_matrixId_idx" ON "SstRiskEntry"("matrixId");

-- CreateIndex
CREATE INDEX "SstRiskEntry_riskType_idx" ON "SstRiskEntry"("riskType");

-- CreateIndex
CREATE INDEX "SstRiskEntry_riskLevel_idx" ON "SstRiskEntry"("riskLevel");

-- CreateIndex
CREATE INDEX "SstEmployeeRisk_employeeId_idx" ON "SstEmployeeRisk"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SstEmployeeRisk_employeeId_riskEntryId_key" ON "SstEmployeeRisk"("employeeId", "riskEntryId");

-- CreateIndex
CREATE INDEX "SstEppDelivery_employeeId_idx" ON "SstEppDelivery"("employeeId");

-- CreateIndex
CREATE INDEX "SstEppDelivery_productId_idx" ON "SstEppDelivery"("productId");

-- CreateIndex
CREATE INDEX "SstEppDelivery_status_idx" ON "SstEppDelivery"("status");

-- CreateIndex
CREATE INDEX "SstEppDelivery_expiresAt_idx" ON "SstEppDelivery"("expiresAt");

-- CreateIndex
CREATE INDEX "SstMedicalExam_employeeId_idx" ON "SstMedicalExam"("employeeId");

-- CreateIndex
CREATE INDEX "SstMedicalExam_nextDueDate_idx" ON "SstMedicalExam"("nextDueDate");

-- CreateIndex
CREATE INDEX "SstTraining_category_idx" ON "SstTraining"("category");

-- CreateIndex
CREATE INDEX "SstTraining_date_idx" ON "SstTraining"("date");

-- CreateIndex
CREATE INDEX "SstTrainingAttendee_employeeId_idx" ON "SstTrainingAttendee"("employeeId");

-- CreateIndex
CREATE INDEX "SstTrainingAttendee_expiresAt_idx" ON "SstTrainingAttendee"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SstTrainingAttendee_trainingId_employeeId_key" ON "SstTrainingAttendee"("trainingId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SstIncident_number_key" ON "SstIncident"("number");

-- CreateIndex
CREATE INDEX "SstIncident_classification_idx" ON "SstIncident"("classification");

-- CreateIndex
CREATE INDEX "SstIncident_status_idx" ON "SstIncident"("status");

-- CreateIndex
CREATE INDEX "SstIncident_date_idx" ON "SstIncident"("date");

-- CreateIndex
CREATE INDEX "SstIncidentPerson_incidentId_idx" ON "SstIncidentPerson"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "SstInspection_number_key" ON "SstInspection"("number");

-- CreateIndex
CREATE INDEX "SstInspection_date_idx" ON "SstInspection"("date");

-- CreateIndex
CREATE INDEX "SstInspection_globalResult_idx" ON "SstInspection"("globalResult");

-- CreateIndex
CREATE INDEX "SstInspectionItem_inspectionId_idx" ON "SstInspectionItem"("inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SstFinding_number_key" ON "SstFinding"("number");

-- CreateIndex
CREATE INDEX "SstFinding_sourceType_sourceId_idx" ON "SstFinding"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "SstFinding_status_idx" ON "SstFinding"("status");

-- CreateIndex
CREATE INDEX "SstFinding_priority_idx" ON "SstFinding"("priority");

-- CreateIndex
CREATE INDEX "SstCorrectiveAction_findingId_idx" ON "SstCorrectiveAction"("findingId");

-- CreateIndex
CREATE INDEX "SstCorrectiveAction_status_idx" ON "SstCorrectiveAction"("status");

-- CreateIndex
CREATE INDEX "SstCorrectiveAction_dueAt_idx" ON "SstCorrectiveAction"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "SstDocument_code_key" ON "SstDocument"("code");

-- CreateIndex
CREATE INDEX "SstDocument_type_idx" ON "SstDocument"("type");

-- CreateIndex
CREATE INDEX "SstDocument_status_idx" ON "SstDocument"("status");

-- CreateIndex
CREATE INDEX "SstDocument_expiresAt_idx" ON "SstDocument"("expiresAt");

-- CreateIndex
CREATE INDEX "SstDocumentVersion_documentId_idx" ON "SstDocumentVersion"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "SstEmergencyEquipment_code_key" ON "SstEmergencyEquipment"("code");

-- CreateIndex
CREATE INDEX "SstEmergencyEquipment_type_idx" ON "SstEmergencyEquipment"("type");

-- CreateIndex
CREATE INDEX "SstEmergencyEquipment_status_idx" ON "SstEmergencyEquipment"("status");

-- CreateIndex
CREATE INDEX "SstEmergencyEquipment_nextInspectionAt_idx" ON "SstEmergencyEquipment"("nextInspectionAt");

-- CreateIndex
CREATE INDEX "SstEmergencyEquipment_expiresAt_idx" ON "SstEmergencyEquipment"("expiresAt");

-- CreateIndex
CREATE INDEX "SstBrigadeMember_employeeId_idx" ON "SstBrigadeMember"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SstBrigadeMember_brigadeId_employeeId_key" ON "SstBrigadeMember"("brigadeId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SstDrill_number_key" ON "SstDrill"("number");

-- CreateIndex
CREATE INDEX "SstDrill_date_idx" ON "SstDrill"("date");

-- CreateIndex
CREATE INDEX "SstDrill_type_idx" ON "SstDrill"("type");

-- CreateIndex
CREATE INDEX "SstDrillParticipant_drillId_idx" ON "SstDrillParticipant"("drillId");

-- CreateIndex
CREATE UNIQUE INDEX "SstDrillParticipant_drillId_employeeId_key" ON "SstDrillParticipant"("drillId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "SstContractor_partyId_key" ON "SstContractor"("partyId");

-- CreateIndex
CREATE INDEX "SstContractorDocument_contractorId_idx" ON "SstContractorDocument"("contractorId");

-- CreateIndex
CREATE INDEX "SstContractorDocument_expiresAt_idx" ON "SstContractorDocument"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SstComplianceAudit_number_key" ON "SstComplianceAudit"("number");

-- CreateIndex
CREATE INDEX "SstComplianceAudit_date_idx" ON "SstComplianceAudit"("date");

-- CreateIndex
CREATE INDEX "SstEvidence_entityType_entityId_idx" ON "SstEvidence"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "SstNotification_dedupeKey_key" ON "SstNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "SstNotification_status_idx" ON "SstNotification"("status");

-- CreateIndex
CREATE INDEX "SstNotification_type_idx" ON "SstNotification"("type");

-- CreateIndex
CREATE INDEX "SstNotification_dueDate_idx" ON "SstNotification"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollConcept_code_key" ON "PayrollConcept"("code");

-- CreateIndex
CREATE INDEX "PayrollConcept_type_idx" ON "PayrollConcept"("type");

-- CreateIndex
CREATE INDEX "PayrollConcept_category_idx" ON "PayrollConcept"("category");

-- CreateIndex
CREATE INDEX "PayrollContract_employeeId_idx" ON "PayrollContract"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollContract_active_idx" ON "PayrollContract"("active");

-- CreateIndex
CREATE INDEX "PayrollPeriod_status_idx" ON "PayrollPeriod"("status");

-- CreateIndex
CREATE INDEX "PayrollEvent_employeeId_idx" ON "PayrollEvent"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollEvent_periodId_idx" ON "PayrollEvent"("periodId");

-- CreateIndex
CREATE INDEX "PayrollEvent_status_idx" ON "PayrollEvent"("status");

-- CreateIndex
CREATE INDEX "Payslip_employeeId_idx" ON "Payslip"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_periodId_employeeId_key" ON "Payslip"("periodId", "employeeId");

-- CreateIndex
CREATE INDEX "PayslipLine_payslipId_idx" ON "PayslipLine"("payslipId");

-- CreateIndex
CREATE INDEX "AccountingIntegrationLog_kind_idx" ON "AccountingIntegrationLog"("kind");

-- CreateIndex
CREATE INDEX "AccountingIntegrationLog_status_idx" ON "AccountingIntegrationLog"("status");

-- CreateIndex
CREATE INDEX "AccountingIntegrationLog_periodId_idx" ON "AccountingIntegrationLog"("periodId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_legacyId_key" ON "Branch"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_legacyId_key" ON "Subscriber"("legacyId");

-- CreateIndex
CREATE INDEX "Subscriber_abonado_idx" ON "Subscriber"("abonado");

-- CreateIndex
CREATE INDEX "Subscriber_docNumber_idx" ON "Subscriber"("docNumber");

-- CreateIndex
CREATE INDEX "Subscriber_phone1_idx" ON "Subscriber"("phone1");

-- CreateIndex
CREATE INDEX "Subscriber_status_idx" ON "Subscriber"("status");

-- CreateIndex
CREATE INDEX "Subscriber_branchId_idx" ON "Subscriber"("branchId");

-- CreateIndex
CREATE INDEX "Subscriber_firstName_idx" ON "Subscriber" USING GIN ("firstName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Subscriber_secondName_idx" ON "Subscriber" USING GIN ("secondName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Subscriber_lastName1_idx" ON "Subscriber" USING GIN ("lastName1" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Subscriber_lastName2_idx" ON "Subscriber" USING GIN ("lastName2" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Subscriber_companyName_idx" ON "Subscriber" USING GIN ("companyName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Subscriber_docNumber_trgm_idx" ON "Subscriber" USING GIN ("docNumber" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Subscriber_phone1_trgm_idx" ON "Subscriber" USING GIN ("phone1" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "MikrotikActionLog_subscriberId_idx" ON "MikrotikActionLog"("subscriberId");

-- CreateIndex
CREATE INDEX "MikrotikActionLog_action_idx" ON "MikrotikActionLog"("action");

-- CreateIndex
CREATE INDEX "MikrotikActionLog_createdAt_idx" ON "MikrotikActionLog"("createdAt");

-- CreateIndex
CREATE INDEX "OltActionLog_subscriberId_idx" ON "OltActionLog"("subscriberId");

-- CreateIndex
CREATE INDEX "OltActionLog_oltId_idx" ON "OltActionLog"("oltId");

-- CreateIndex
CREATE INDEX "OltActionLog_action_idx" ON "OltActionLog"("action");

-- CreateIndex
CREATE INDEX "OltActionLog_createdAt_idx" ON "OltActionLog"("createdAt");

-- CreateIndex
CREATE INDEX "GenieacsActionLog_serverId_idx" ON "GenieacsActionLog"("serverId");

-- CreateIndex
CREATE INDEX "GenieacsActionLog_action_idx" ON "GenieacsActionLog"("action");

-- CreateIndex
CREATE INDEX "GenieacsActionLog_createdAt_idx" ON "GenieacsActionLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlayhubSubscription_legacyId_key" ON "PlayhubSubscription"("legacyId");

-- CreateIndex
CREATE INDEX "PlayhubSubscription_subscriberId_idx" ON "PlayhubSubscription"("subscriberId");

-- CreateIndex
CREATE INDEX "WhatsappMessage_phone_idx" ON "WhatsappMessage"("phone");

-- CreateIndex
CREATE INDEX "WhatsappMessage_subscriberId_idx" ON "WhatsappMessage"("subscriberId");

-- CreateIndex
CREATE INDEX "WhatsappMessage_createdAt_idx" ON "WhatsappMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_kind_key" ON "EmailTemplate"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappTemplate_name_key" ON "WhatsappTemplate"("name");

-- CreateIndex
CREATE INDEX "WhatsappTemplate_active_idx" ON "WhatsappTemplate"("active");

-- CreateIndex
CREATE INDEX "WhatsappCampaign_createdAt_idx" ON "WhatsappCampaign"("createdAt");

-- CreateIndex
CREATE INDEX "WhatsappCampaign_templateId_idx" ON "WhatsappCampaign"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappSend_waMessageId_key" ON "WhatsappSend"("waMessageId");

-- CreateIndex
CREATE INDEX "WhatsappSend_campaignId_idx" ON "WhatsappSend"("campaignId");

-- CreateIndex
CREATE INDEX "WhatsappSend_status_idx" ON "WhatsappSend"("status");

-- CreateIndex
CREATE INDEX "WhatsappSend_subscriberId_idx" ON "WhatsappSend"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "Movil_legacyId_key" ON "Movil"("legacyId");

-- CreateIndex
CREATE INDEX "Movil_status_idx" ON "Movil"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MovilMember_legacyId_key" ON "MovilMember"("legacyId");

-- CreateIndex
CREATE INDEX "MovilMember_employeeId_idx" ON "MovilMember"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "MovilMember_movilId_employeeId_key" ON "MovilMember"("movilId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "InternalMessage_legacyId_key" ON "InternalMessage"("legacyId");

-- CreateIndex
CREATE INDEX "InternalMessage_recipientUserId_idx" ON "InternalMessage"("recipientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "DocFolder_legacyId_key" ON "DocFolder"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_legacyId_key" ON "Document"("legacyId");

-- CreateIndex
CREATE INDEX "Document_folderId_idx" ON "Document"("folderId");

-- CreateIndex
CREATE INDEX "CronRun_job_startedAt_idx" ON "CronRun"("job", "startedAt");

-- CreateIndex
CREATE INDEX "SubscriberService_subscriberId_idx" ON "SubscriberService"("subscriberId");

-- CreateIndex
CREATE INDEX "SubscriberService_kind_idx" ON "SubscriberService"("kind");

-- CreateIndex
CREATE INDEX "SubscriberService_planId_idx" ON "SubscriberService"("planId");

-- CreateIndex
CREATE INDEX "Plan_kind_idx" ON "Plan"("kind");

-- CreateIndex
CREATE INDEX "Plan_active_idx" ON "Plan"("active");

-- CreateIndex
CREATE INDEX "SubscriberStatusHistory_subscriberId_idx" ON "SubscriberStatusHistory"("subscriberId");

-- CreateIndex
CREATE INDEX "SubscriberStatusHistory_date_idx" ON "SubscriberStatusHistory"("date");

-- CreateIndex
CREATE INDEX "SubscriberStatusHistory_status_date_idx" ON "SubscriberStatusHistory"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CallLog_legacyId_key" ON "CallLog"("legacyId");

-- CreateIndex
CREATE INDEX "CallLog_subscriberId_idx" ON "CallLog"("subscriberId");

-- CreateIndex
CREATE INDEX "CallLog_responseDetail_idx" ON "CallLog"("responseDetail");

-- CreateIndex
CREATE INDEX "CallLog_dueDate_idx" ON "CallLog"("dueDate");

-- CreateIndex
CREATE INDEX "CallLog_responsible_idx" ON "CallLog"("responsible");

-- CreateIndex
CREATE INDEX "CallLog_date_idx" ON "CallLog"("date");

-- CreateIndex
CREATE UNIQUE INDEX "SubInvoice_legacyId_key" ON "SubInvoice"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "SubInvoice_tid_key" ON "SubInvoice"("tid");

-- CreateIndex
CREATE INDEX "SubInvoice_subscriberId_idx" ON "SubInvoice"("subscriberId");

-- CreateIndex
CREATE INDEX "SubInvoice_status_idx" ON "SubInvoice"("status");

-- CreateIndex
CREATE INDEX "SubInvoice_ron_idx" ON "SubInvoice"("ron");

-- CreateIndex
CREATE INDEX "SubInvoice_invoiceDate_idx" ON "SubInvoice"("invoiceDate");

-- CreateIndex
CREATE INDEX "SubInvoice_dueDate_idx" ON "SubInvoice"("dueDate");

-- CreateIndex
CREATE INDEX "SubInvoice_kind_idx" ON "SubInvoice"("kind");

-- CreateIndex
CREATE INDEX "SubInvoice_subscriberId_status_idx" ON "SubInvoice"("subscriberId", "status");

-- CreateIndex
CREATE INDEX "SubInvoice_status_subscriberId_idx" ON "SubInvoice"("status", "subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "SubInvoiceItem_legacyId_key" ON "SubInvoiceItem"("legacyId");

-- CreateIndex
CREATE INDEX "SubInvoiceItem_invoiceId_idx" ON "SubInvoiceItem"("invoiceId");

-- CreateIndex
CREATE INDEX "SubInvoiceItem_productId_idx" ON "SubInvoiceItem"("productId");

-- CreateIndex
CREATE INDEX "SubInvoiceItem_productName_createdAt_idx" ON "SubInvoiceItem"("productName", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdditionalService_legacyId_key" ON "AdditionalService"("legacyId");

-- CreateIndex
CREATE INDEX "AdditionalService_invoiceId_idx" ON "AdditionalService"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionCategory_legacyId_key" ON "TransactionCategory"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_legacyId_key" ON "Transaction"("legacyId");

-- CreateIndex
CREATE INDEX "Transaction_subscriberId_status_ext_idx" ON "Transaction"("subscriberId", "status", "ext");

-- CreateIndex
CREATE INDEX "Transaction_invoiceId_idx" ON "Transaction"("invoiceId");

-- CreateIndex
CREATE INDEX "Transaction_category_idx" ON "Transaction"("category");

-- CreateIndex
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");

-- CreateIndex
CREATE INDEX "Transaction_type_date_idx" ON "Transaction"("type", "date");

-- CreateIndex
CREATE INDEX "Transaction_supplierId_idx" ON "Transaction"("supplierId");

-- CreateIndex
CREATE INDEX "Transaction_supplyOrderId_idx" ON "Transaction"("supplyOrderId");

-- CreateIndex
CREATE INDEX "Transaction_stockReturnId_idx" ON "Transaction"("stockReturnId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReceipt_legacyId_key" ON "PaymentReceipt"("legacyId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_invoiceId_idx" ON "PaymentReceipt"("invoiceId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_date_idx" ON "PaymentReceipt"("date");

-- CreateIndex
CREATE INDEX "ReceiptTransaction_transactionId_idx" ON "ReceiptTransaction"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptTransaction_receiptId_transactionId_key" ON "ReceiptTransaction"("receiptId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Voiding_legacyId_key" ON "Voiding"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Voiding_transactionId_key" ON "Voiding"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "CashClose_legacyId_key" ON "CashClose"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "CashClose_cashAccountId_date_key" ON "CashClose"("cashAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringInvoice_legacyId_key" ON "RecurringInvoice"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringInvoice_tid_key" ON "RecurringInvoice"("tid");

-- CreateIndex
CREATE INDEX "RecurringInvoice_subscriberId_idx" ON "RecurringInvoice"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringInvoiceItem_legacyId_key" ON "RecurringInvoiceItem"("legacyId");

-- CreateIndex
CREATE INDEX "RecurringInvoiceItem_invoiceId_idx" ON "RecurringInvoiceItem"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CashOpen_cashAccountId_date_key" ON "CashOpen"("cashAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CashAccount_legacyId_key" ON "CashAccount"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_legacyId_key" ON "Department"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "City_legacyId_key" ON "City"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Locality_legacyId_key" ON "Locality"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Neighborhood_legacyId_key" ON "Neighborhood"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyInfo_legacyId_key" ON "CompanyInfo"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_legacyId_key" ON "CalendarEvent"("legacyId");

-- CreateIndex
CREATE INDEX "CalendarEvent_start_idx" ON "CalendarEvent"("start");

-- CreateIndex
CREATE INDEX "CalendarEvent_orderNo_idx" ON "CalendarEvent"("orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_legacyId_key" ON "Quote"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_tid_key" ON "Quote"("tid");

-- CreateIndex
CREATE INDEX "Quote_subscriberId_idx" ON "Quote"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteItem_legacyId_key" ON "QuoteItem"("legacyId");

-- CreateIndex
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffArea_legacyId_key" ON "StaffArea"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_legacyId_key" ON "Staff"("legacyId");

-- CreateIndex
CREATE INDEX "Staff_role_idx" ON "Staff"("role");

-- CreateIndex
CREATE INDEX "Staff_areaId_idx" ON "Staff"("areaId");

-- CreateIndex
CREATE INDEX "Promotion_active_idx" ON "Promotion"("active");

-- CreateIndex
CREATE INDEX "Promotion_startDate_endDate_idx" ON "Promotion"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "Promotion_subscriberStatus_idx" ON "Promotion"("subscriberStatus");

-- CreateIndex
CREATE INDEX "PromotionAssignmentLog_promotionId_idx" ON "PromotionAssignmentLog"("promotionId");

-- CreateIndex
CREATE INDEX "PromotionAssignmentLog_staffId_idx" ON "PromotionAssignmentLog"("staffId");

-- CreateIndex
CREATE INDEX "PromotionAssignmentLog_createdAt_idx" ON "PromotionAssignmentLog"("createdAt");

-- CreateIndex
CREATE INDEX "PromotionApplication_invoiceId_idx" ON "PromotionApplication"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionApplication_promotionId_invoiceId_key" ON "PromotionApplication"("promotionId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_legacyId_key" ON "Project"("legacyId");

-- CreateIndex
CREATE INDEX "Project_subscriberId_idx" ON "Project"("subscriberId");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_legacyId_key" ON "Milestone"("legacyId");

-- CreateIndex
CREATE INDEX "Milestone_projectId_idx" ON "Milestone"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_legacyId_key" ON "Supplier"("legacyId");

-- CreateIndex
CREATE INDEX "Supplier_category_idx" ON "Supplier"("category");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseCategory_name_key" ON "PurchaseCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialCategory_legacyId_key" ON "MaterialCategory"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialWarehouse_legacyId_key" ON "MaterialWarehouse"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Material_legacyId_key" ON "Material"("legacyId");

-- CreateIndex
CREATE INDEX "Material_categoryId_idx" ON "Material"("categoryId");

-- CreateIndex
CREATE INDEX "Material_warehouseId_idx" ON "Material"("warehouseId");

-- CreateIndex
CREATE INDEX "Material_name_idx" ON "Material"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialActa_legacyId_key" ON "MaterialActa"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialActaItem_legacyId_key" ON "MaterialActaItem"("legacyId");

-- CreateIndex
CREATE INDEX "MaterialActaItem_actaId_idx" ON "MaterialActaItem"("actaId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplyOrder_legacyId_key" ON "SupplyOrder"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplyOrder_tid_key" ON "SupplyOrder"("tid");

-- CreateIndex
CREATE INDEX "SupplyOrder_supplierId_idx" ON "SupplyOrder"("supplierId");

-- CreateIndex
CREATE INDEX "SupplyOrder_status_idx" ON "SupplyOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplyOrderItem_legacyId_key" ON "SupplyOrderItem"("legacyId");

-- CreateIndex
CREATE INDEX "SupplyOrderItem_orderId_idx" ON "SupplyOrderItem"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReturn_legacyId_key" ON "StockReturn"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReturn_tid_key" ON "StockReturn"("tid");

-- CreateIndex
CREATE INDEX "StockReturn_supplierId_idx" ON "StockReturn"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReturnItem_legacyId_key" ON "StockReturnItem"("legacyId");

-- CreateIndex
CREATE INDEX "StockReturnItem_returnId_idx" ON "StockReturnItem"("returnId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentGateway_legacyId_key" ON "PaymentGateway"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_reference_key" ON "PaymentOrder"("reference");

-- CreateIndex
CREATE INDEX "PaymentOrder_subscriberId_idx" ON "PaymentOrder"("subscriberId");

-- CreateIndex
CREATE INDEX "PaymentOrder_status_idx" ON "PaymentOrder"("status");

-- CreateIndex
CREATE INDEX "PaymentImportBatch_status_idx" ON "PaymentImportBatch"("status");

-- CreateIndex
CREATE INDEX "PaymentImportRow_batchId_idx" ON "PaymentImportRow"("batchId");

-- CreateIndex
CREATE INDEX "PaymentImportRow_reference_idx" ON "PaymentImportRow"("reference");

-- CreateIndex
CREATE INDEX "PaymentImportRow_status_idx" ON "PaymentImportRow"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SiigoAccount_legacyId_key" ON "SiigoAccount"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "ElectronicInvoice_legacyId_key" ON "ElectronicInvoice"("legacyId");

-- CreateIndex
CREATE INDEX "ElectronicInvoice_subscriberId_idx" ON "ElectronicInvoice"("subscriberId");

-- CreateIndex
CREATE INDEX "ElectronicInvoice_invoiceId_idx" ON "ElectronicInvoice"("invoiceId");

-- CreateIndex
CREATE INDEX "ElectronicInvoice_type_idx" ON "ElectronicInvoice"("type");

-- CreateIndex
CREATE INDEX "ElectronicInvoice_date_idx" ON "ElectronicInvoice"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Mikrotik_legacyId_key" ON "Mikrotik"("legacyId");

-- CreateIndex
CREATE INDEX "Mikrotik_branchId_idx" ON "Mikrotik"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Olt_legacyId_key" ON "Olt"("legacyId");

-- CreateIndex
CREATE INDEX "Olt_branchId_idx" ON "Olt"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "OltOnu_legacyId_key" ON "OltOnu"("legacyId");

-- CreateIndex
CREATE INDEX "OltOnu_oltId_idx" ON "OltOnu"("oltId");

-- CreateIndex
CREATE INDEX "OltOnu_subscriberId_idx" ON "OltOnu"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "Vlan_legacyId_key" ON "Vlan"("legacyId");

-- CreateIndex
CREATE INDEX "Vlan_branchId_idx" ON "Vlan"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Nap_legacyId_key" ON "Nap"("legacyId");

-- CreateIndex
CREATE INDEX "Nap_branchId_idx" ON "Nap"("branchId");

-- CreateIndex
CREATE INDEX "Nap_vlanId_idx" ON "Nap"("vlanId");

-- CreateIndex
CREATE UNIQUE INDEX "Port_legacyId_key" ON "Port"("legacyId");

-- CreateIndex
CREATE INDEX "Port_napId_idx" ON "Port"("napId");

-- CreateIndex
CREATE INDEX "Port_subscriberId_idx" ON "Port"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "IpUserMk_legacyId_key" ON "IpUserMk"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "GenieacsConnection_legacyId_key" ON "GenieacsConnection"("legacyId");

-- CreateIndex
CREATE INDEX "GenieacsConnection_branchId_idx" ON "GenieacsConnection"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentWarehouse_legacyId_key" ON "EquipmentWarehouse"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_legacyId_key" ON "Equipment"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_code_key" ON "Equipment"("code");

-- CreateIndex
CREATE INDEX "Equipment_warehouseId_idx" ON "Equipment"("warehouseId");

-- CreateIndex
CREATE INDEX "Equipment_subscriberId_idx" ON "Equipment"("subscriberId");

-- CreateIndex
CREATE INDEX "Equipment_status_idx" ON "Equipment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentTransfer_legacyId_key" ON "EquipmentTransfer"("legacyId");

-- CreateIndex
CREATE INDEX "EquipmentTransfer_status_idx" ON "EquipmentTransfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentTransferItem_legacyId_key" ON "EquipmentTransferItem"("legacyId");

-- CreateIndex
CREATE INDEX "EquipmentTransferItem_transferId_idx" ON "EquipmentTransferItem"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_legacyId_key" ON "Ticket"("legacyId");

-- CreateIndex
CREATE INDEX "Ticket_subscriberId_idx" ON "Ticket"("subscriberId");

-- CreateIndex
CREATE INDEX "Ticket_code_idx" ON "Ticket"("code");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");

-- CreateIndex
CREATE INDEX "Ticket_type_idx" ON "Ticket"("type");

-- CreateIndex
CREATE INDEX "Ticket_created_idx" ON "Ticket"("created");

-- CreateIndex
CREATE INDEX "Ticket_assigned_created_idx" ON "Ticket"("assigned", "created");

-- CreateIndex
CREATE INDEX "Ticket_priority_created_idx" ON "Ticket"("priority", "created");

-- CreateIndex
CREATE INDEX "TicketMaterial_ticketId_idx" ON "TicketMaterial"("ticketId");

-- CreateIndex
CREATE INDEX "TicketMaterial_materialId_idx" ON "TicketMaterial"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketThread_legacyId_key" ON "TicketThread"("legacyId");

-- CreateIndex
CREATE INDEX "TicketThread_ticketCode_idx" ON "TicketThread"("ticketCode");

-- CreateIndex
CREATE INDEX "TicketThread_subscriberId_idx" ON "TicketThread"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferActa_legacyId_key" ON "TransferActa"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferActaItem_legacyId_key" ON "TransferActaItem"("legacyId");

-- CreateIndex
CREATE INDEX "TransferActaItem_actaId_idx" ON "TransferActaItem"("actaId");

-- CreateIndex
CREATE UNIQUE INDEX "TodoTask_legacyId_key" ON "TodoTask"("legacyId");

-- CreateIndex
CREATE INDEX "TodoTask_status_idx" ON "TodoTask"("status");

-- CreateIndex
CREATE INDEX "TodoTask_orderId_idx" ON "TodoTask"("orderId");

-- CreateIndex
CREATE INDEX "TodoTask_rid_tdate_idx" ON "TodoTask"("rid", "tdate");

-- CreateIndex
CREATE INDEX "SubscriberFile_subscriberId_idx" ON "SubscriberFile"("subscriberId");

-- CreateIndex
CREATE INDEX "SubscriberNote_subscriberId_idx" ON "SubscriberNote"("subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessGoal_legacyId_key" ON "BusinessGoal"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatbotSession_convKey_key" ON "ChatbotSession"("convKey");

-- CreateIndex
CREATE INDEX "ChatbotSession_updatedAt_idx" ON "ChatbotSession"("updatedAt");

-- CreateIndex
CREATE INDEX "ChatbotSession_handoffAt_idx" ON "ChatbotSession"("handoffAt");

-- CreateIndex
CREATE INDEX "ChatbotUsage_day_idx" ON "ChatbotUsage"("day");

-- CreateIndex
CREATE UNIQUE INDEX "ChatbotUsage_day_model_key" ON "ChatbotUsage"("day", "model");

-- CreateIndex
CREATE INDEX "ChatbotSeenMessage_seenAt_idx" ON "ChatbotSeenMessage"("seenAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_key_key" ON "AppSetting"("key");

-- CreateIndex
CREATE INDEX "AppSetting_group_idx" ON "AppSetting"("group");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_legacyId_key" ON "ApiKey"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_active_idx" ON "ApiKey"("active");

-- CreateIndex
CREATE INDEX "_PromotionAssignees_B_index" ON "_PromotionAssignees"("B");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "FiscalPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxCode" ADD CONSTRAINT "TaxCode_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FixedAssetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationEntry" ADD CONSTRAINT "DepreciationEntry_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoice" ADD CONSTRAINT "SalesInvoice_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBill" ADD CONSTRAINT "PurchaseBill_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMovement" ADD CONSTRAINT "BankMovement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMovement" ADD CONSTRAINT "BankMovement_statementLineId_fkey" FOREIGN KEY ("statementLineId") REFERENCES "BankStatementLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_warehouseFromId_fkey" FOREIGN KEY ("warehouseFromId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_warehouseToId_fkey" FOREIGN KEY ("warehouseToId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_serialId_fkey" FOREIGN KEY ("serialId") REFERENCES "SerialNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_counterpartyEmployeeId_fkey" FOREIGN KEY ("counterpartyEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "UnitOfMeasure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_responsibleId_fkey" FOREIGN KEY ("responsibleId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KardexEntry" ADD CONSTRAINT "KardexEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KardexEntry" ADD CONSTRAINT "KardexEntry_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KardexEntry" ADD CONSTRAINT "KardexEntry_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POLine" ADD CONSTRAINT "POLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POLine" ADD CONSTRAINT "POLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GRLine" ADD CONSTRAINT "GRLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GRLine" ADD CONSTRAINT "GRLine_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "POLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GRLine" ADD CONSTRAINT "GRLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderRule" ADD CONSTRAINT "ReorderRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialAssignment" ADD CONSTRAINT "MaterialAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialAssignment" ADD CONSTRAINT "MaterialAssignment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_serialId_fkey" FOREIGN KEY ("serialId") REFERENCES "SerialNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceOrder" ADD CONSTRAINT "MaintenanceOrder_serialId_fkey" FOREIGN KEY ("serialId") REFERENCES "SerialNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceOrder" ADD CONSTRAINT "MaintenanceOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceOrder" ADD CONSTRAINT "MaintenanceOrder_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceOrder" ADD CONSTRAINT "MaintenanceOrder_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePart" ADD CONSTRAINT "MaintenancePart_maintenanceId_fkey" FOREIGN KEY ("maintenanceId") REFERENCES "MaintenanceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePart" ADD CONSTRAINT "MaintenancePart_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceAttachment" ADD CONSTRAINT "MaintenanceAttachment_maintenanceId_fkey" FOREIGN KEY ("maintenanceId") REFERENCES "MaintenanceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderTask" ADD CONSTRAINT "WorkOrderTask_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPhoto" ADD CONSTRAINT "WorkOrderPhoto_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPart" ADD CONSTRAINT "WorkOrderPart_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderPart" ADD CONSTRAINT "WorkOrderPart_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderEvent" ADD CONSTRAINT "WorkOrderEvent_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBillLine" ADD CONSTRAINT "PurchaseBillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBillLine" ADD CONSTRAINT "PurchaseBillLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstRiskEntry" ADD CONSTRAINT "SstRiskEntry_matrixId_fkey" FOREIGN KEY ("matrixId") REFERENCES "SstRiskMatrix"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstEmployeeRisk" ADD CONSTRAINT "SstEmployeeRisk_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstEmployeeRisk" ADD CONSTRAINT "SstEmployeeRisk_riskEntryId_fkey" FOREIGN KEY ("riskEntryId") REFERENCES "SstRiskEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstEppDelivery" ADD CONSTRAINT "SstEppDelivery_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstEppDelivery" ADD CONSTRAINT "SstEppDelivery_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstMedicalExam" ADD CONSTRAINT "SstMedicalExam_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstTrainingAttendee" ADD CONSTRAINT "SstTrainingAttendee_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "SstTraining"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstTrainingAttendee" ADD CONSTRAINT "SstTrainingAttendee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstIncidentPerson" ADD CONSTRAINT "SstIncidentPerson_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "SstIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstIncidentPerson" ADD CONSTRAINT "SstIncidentPerson_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstInspection" ADD CONSTRAINT "SstInspection_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SstInspectionTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstInspectionItem" ADD CONSTRAINT "SstInspectionItem_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "SstInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstCorrectiveAction" ADD CONSTRAINT "SstCorrectiveAction_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "SstFinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstDocumentVersion" ADD CONSTRAINT "SstDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SstDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstBrigadeMember" ADD CONSTRAINT "SstBrigadeMember_brigadeId_fkey" FOREIGN KEY ("brigadeId") REFERENCES "SstBrigade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstBrigadeMember" ADD CONSTRAINT "SstBrigadeMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstDrillParticipant" ADD CONSTRAINT "SstDrillParticipant_drillId_fkey" FOREIGN KEY ("drillId") REFERENCES "SstDrill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstDrillParticipant" ADD CONSTRAINT "SstDrillParticipant_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstContractor" ADD CONSTRAINT "SstContractor_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstContractorDocument" ADD CONSTRAINT "SstContractorDocument_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "SstContractor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SstNotification" ADD CONSTRAINT "SstNotification_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollContract" ADD CONSTRAINT "PayrollContract_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEvent" ADD CONSTRAINT "PayrollEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEvent" ADD CONSTRAINT "PayrollEvent_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "PayrollConcept"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEvent" ADD CONSTRAINT "PayrollEvent_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PayrollContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "Payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "PayrollConcept"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscriber" ADD CONSTRAINT "Subscriber_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscriber" ADD CONSTRAINT "Subscriber_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MikrotikActionLog" ADD CONSTRAINT "MikrotikActionLog_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltActionLog" ADD CONSTRAINT "OltActionLog_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayhubSubscription" ADD CONSTRAINT "PlayhubSubscription_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappMessage" ADD CONSTRAINT "WhatsappMessage_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappCampaign" ADD CONSTRAINT "WhatsappCampaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WhatsappTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSend" ADD CONSTRAINT "WhatsappSend_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsappCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSend" ADD CONSTRAINT "WhatsappSend_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovilMember" ADD CONSTRAINT "MovilMember_movilId_fkey" FOREIGN KEY ("movilId") REFERENCES "Movil"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovilMember" ADD CONSTRAINT "MovilMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "DocFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriberService" ADD CONSTRAINT "SubscriberService_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriberService" ADD CONSTRAINT "SubscriberService_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriberStatusHistory" ADD CONSTRAINT "SubscriberStatusHistory_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubInvoice" ADD CONSTRAINT "SubInvoice_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubInvoiceItem" ADD CONSTRAINT "SubInvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdditionalService" ADD CONSTRAINT "AdditionalService_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptTransaction" ADD CONSTRAINT "ReceiptTransaction_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "PaymentReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptTransaction" ADD CONSTRAINT "ReceiptTransaction_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voiding" ADD CONSTRAINT "Voiding_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringInvoice" ADD CONSTRAINT "RecurringInvoice_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringInvoiceItem" ADD CONSTRAINT "RecurringInvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "RecurringInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "StaffArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionAssignmentLog" ADD CONSTRAINT "PromotionAssignmentLog_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionAssignmentLog" ADD CONSTRAINT "PromotionAssignmentLog_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionApplication" ADD CONSTRAINT "PromotionApplication_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionApplication" ADD CONSTRAINT "PromotionApplication_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MaterialCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "MaterialWarehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialActaItem" ADD CONSTRAINT "MaterialActaItem_actaId_fkey" FOREIGN KEY ("actaId") REFERENCES "MaterialActa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialActaItem" ADD CONSTRAINT "MaterialActaItem_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyOrder" ADD CONSTRAINT "SupplyOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyOrderItem" ADD CONSTRAINT "SupplyOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SupplyOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyOrderItem" ADD CONSTRAINT "SupplyOrderItem_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReturn" ADD CONSTRAINT "StockReturn_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReturnItem" ADD CONSTRAINT "StockReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "StockReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReturnItem" ADD CONSTRAINT "StockReturnItem_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentImportRow" ADD CONSTRAINT "PaymentImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PaymentImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectronicInvoice" ADD CONSTRAINT "ElectronicInvoice_siigoAccountId_fkey" FOREIGN KEY ("siigoAccountId") REFERENCES "SiigoAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectronicInvoice" ADD CONSTRAINT "ElectronicInvoice_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectronicInvoice" ADD CONSTRAINT "ElectronicInvoice_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mikrotik" ADD CONSTRAINT "Mikrotik_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Olt" ADD CONSTRAINT "Olt_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltOnu" ADD CONSTRAINT "OltOnu_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltOnu" ADD CONSTRAINT "OltOnu_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vlan" ADD CONSTRAINT "Vlan_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nap" ADD CONSTRAINT "Nap_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nap" ADD CONSTRAINT "Nap_vlanId_fkey" FOREIGN KEY ("vlanId") REFERENCES "Vlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Port" ADD CONSTRAINT "Port_napId_fkey" FOREIGN KEY ("napId") REFERENCES "Nap"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Port" ADD CONSTRAINT "Port_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenieacsConnection" ADD CONSTRAINT "GenieacsConnection_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "EquipmentWarehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentTransferItem" ADD CONSTRAINT "EquipmentTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "EquipmentTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentTransferItem" ADD CONSTRAINT "EquipmentTransferItem_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMaterial" ADD CONSTRAINT "TicketMaterial_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMaterial" ADD CONSTRAINT "TicketMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketThread" ADD CONSTRAINT "TicketThread_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferActaItem" ADD CONSTRAINT "TransferActaItem_actaId_fkey" FOREIGN KEY ("actaId") REFERENCES "TransferActa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriberFile" ADD CONSTRAINT "SubscriberFile_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriberNote" ADD CONSTRAINT "SubscriberNote_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionAssignees" ADD CONSTRAINT "_PromotionAssignees_A_fkey" FOREIGN KEY ("A") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionAssignees" ADD CONSTRAINT "_PromotionAssignees_B_fkey" FOREIGN KEY ("B") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

