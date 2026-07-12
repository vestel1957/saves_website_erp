import { IsArray, IsString } from 'class-validator';

/** Conjunto de pantallas (llaves `screen.*`) que el empleado debe ver. */
export class SetScreensDto {
  @IsArray()
  @IsString({ each: true })
  screens!: string[];
}
