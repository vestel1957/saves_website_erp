import {
  IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString,
  MinLength, ValidateNested, Min, Max,
} from 'class-validator';
import { Type } from 'class-transformer';

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST', 'EXPENSE'] as const;

export class CreateAccountDto {
  @IsString() @MinLength(1) code!: string;
  @IsString() @MinLength(1) name!: string;
  @IsIn(ACCOUNT_TYPES) type!: (typeof ACCOUNT_TYPES)[number];
  @IsOptional() @IsIn(['DEBIT', 'CREDIT']) normalSide?: 'DEBIT' | 'CREDIT';
  @IsOptional() @IsString() parentId?: string | null;
  @IsOptional() @IsBoolean() isPostable?: boolean;
  @IsOptional() @IsString() currency?: string;
}

export class UpdateAccountDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsBoolean() isPostable?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class JournalLineDto {
  @IsString() @MinLength(1) accountId!: string;
  @IsOptional() @IsString() costCenterId?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) debit!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) credit!: number;
  @IsOptional() @IsString() description?: string | null;
}

export class CreateJournalEntryDto {
  @IsISO8601() date!: string;
  @IsString() @MinLength(1) description!: string;
  @IsOptional() @IsString() reference?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

export class CreatePeriodDto {
  @IsInt() @Min(2000) @Max(2100) year!: number;
  @IsOptional() @IsInt() @Min(1) @Max(12) month?: number; // omitir = periodo anual
}

export class UpsertMappingDto {
  @IsString() @MinLength(1) key!: string;
  @IsString() @MinLength(1) accountId!: string;
  @IsOptional() @IsString() description?: string | null;
}
