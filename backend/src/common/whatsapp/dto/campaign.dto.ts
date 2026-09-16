import {
  IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Una variable {{n}} de una plantilla y de dónde sale su valor. */
export class TemplateVariableDto {
  @IsInt()
  index!: number;

  @IsString()
  label!: string;

  /** name | firstName | abonado | phone | deuda | plan | custom */
  @IsString()
  source!: string;

  /** Valor fijo cuando source = custom. */
  @IsOptional() @IsString()
  value?: string;
}

/** Alta/edición de una plantilla de WhatsApp (referencia local a la aprobada en Meta). */
export class TemplateDto {
  @IsString() @MinLength(1)
  name!: string;

  @IsOptional() @IsString()
  language?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsString() @MinLength(1)
  bodyText!: string;

  @IsOptional() @IsString()
  headerText?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TemplateVariableDto)
  variables?: TemplateVariableDto[];

  @IsOptional() @IsBoolean()
  active?: boolean;

  /** true = además de guardarla local, crearla en Meta (queda PENDING de aprobación). */
  @IsOptional() @IsBoolean()
  submitToMeta?: boolean;
}

/** Filtro de destinatarios (cuando no se pasan ids explícitos). */
export class CampaignFilterDto {
  @IsOptional() @IsString()
  status?: string; // ACTIVO | CORTADO | CARTERA | ...

  @IsOptional() @IsString()
  branchId?: string;

  @IsOptional() @IsString()
  search?: string;

  /** Varios estados a la vez (se suman a `status`). */
  @IsOptional() @IsArray() @IsString({ each: true })
  statuses?: string[];

  /** Varias sedes a la vez (se suman a `branchId`). */
  @IsOptional() @IsArray() @IsString({ each: true })
  branchIds?: string[];

  /** Clientes que tienen alguno de estos planes del catálogo. */
  @IsOptional() @IsArray() @IsString({ each: true })
  planIds?: string[];

  /** `con` = con deuda exigible ≥ `deudaMin` · `sin` = al día. Vacío = no importa. */
  @IsOptional() @IsIn(['con', 'sin'])
  deuda?: 'con' | 'sin';

  @IsOptional() @IsNumber() @Min(0)
  deudaMin?: number;

  /** Solo celulares colombianos: a un fijo WhatsApp no llega y el envío sale FAILED. */
  @IsOptional() @IsBoolean()
  soloMoviles?: boolean;

  /** Saltar a quien tiene la conversación en manos de una persona en la bandeja. */
  @IsOptional() @IsBoolean()
  omitirEnAtencion?: boolean;
}

/** Crear y lanzar una campaña de envío masivo por plantilla. */
export class CreateCampaignDto {
  @IsString() @MinLength(1)
  name!: string;

  @IsString() @MinLength(1)
  templateName!: string;

  @IsOptional() @IsString()
  templateId?: string;

  @IsOptional() @IsString()
  language?: string;

  /** Destinatarios explícitos (ids de suscriptor). Tienen prioridad sobre el filtro. */
  @IsOptional() @IsArray() @IsString({ each: true })
  subscriberIds?: string[];

  @IsOptional() @IsObject() @ValidateNested() @Type(() => CampaignFilterDto)
  filter?: CampaignFilterDto;

  /** Override de las variables (si no se usan las guardadas en la plantilla). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TemplateVariableDto)
  variables?: TemplateVariableDto[];
}

/** Calcular a quién le llegaría una campaña, sin crearla. */
export class CampaignPreviewDto {
  /** Opcional: sin plantilla se cuenta el público pero no se arma el mensaje de ejemplo. */
  @IsOptional() @IsString()
  templateName?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  subscriberIds?: string[];

  @IsOptional() @IsObject() @ValidateNested() @Type(() => CampaignFilterDto)
  filter?: CampaignFilterDto;
}

/** Mandar UNA plantilla de prueba a un celular antes de lanzar la campaña. */
export class CampaignTestDto {
  @IsString() @MinLength(1)
  templateName!: string;

  @IsString() @MinLength(7)
  phone!: string;

  /** Cliente con cuyos datos se llenan las variables. Sin él, valores de ejemplo. */
  @IsOptional() @IsString()
  subscriberId?: string;
}
