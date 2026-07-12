import {
  IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, MinLength, ValidateNested,
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
}

/** Filtro simple de destinatarios (cuando no se pasan ids explícitos). */
export class CampaignFilterDto {
  @IsOptional() @IsString()
  status?: string; // ACTIVO | CORTADO | CARTERA | ...

  @IsOptional() @IsString()
  branchId?: string;

  @IsOptional() @IsString()
  search?: string;
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
