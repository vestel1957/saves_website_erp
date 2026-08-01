import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Teléfono al que van a llegar los códigos de firma. Se normaliza a E.164 en el servicio. */
export class SetSignaturePhoneDto {
  @IsString()
  @MinLength(7, { message: 'Escribe el celular completo.' })
  @MaxLength(25)
  phone!: string;
}

/** Los 6 dígitos que llegaron por WhatsApp. */
export class SignatureCodeDto {
  @IsString()
  @Matches(/^\s*\d(\s*\d){5}\s*$/, { message: 'El código son 6 dígitos.' })
  code!: string;
}
