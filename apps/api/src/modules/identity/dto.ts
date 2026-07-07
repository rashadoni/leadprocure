import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class RegisterOrgDto {
  @IsString() @MinLength(2) legalName!: string;
  // Azerbaijan VÖEN (tax ID) is exactly 10 digits; optional but validated when present.
  @IsOptional() @Matches(/^\d{10}$/, { message: 'VÖEN must be 10 digits' }) voen?: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @MinLength(2) fullName!: string;
}

export class LoginDto {
  @IsEmail() email!: string;
  @IsString() password!: string;
  @IsOptional() @IsString() orgId?: string;
}
