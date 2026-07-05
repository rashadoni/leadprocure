import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterOrgDto {
  @IsString() @MinLength(2) legalName!: string;
  @IsOptional() @IsString() voen?: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @MinLength(2) fullName!: string;
}

export class LoginDto {
  @IsEmail() email!: string;
  @IsString() password!: string;
  @IsOptional() @IsString() orgId?: string;
}
