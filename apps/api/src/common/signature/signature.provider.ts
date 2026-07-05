import { createHmac, timingSafeEqual } from 'crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import { AppConfig } from '../config/config.service';

// Boundary for qualified e-signatures (ASAN İmza in production). High-assurance
// actions — bid submit, opening ceremony, award — must be signed; the signature is
// stored in the audit payload. The real ASAN provider plugs in behind this interface
// once operator credentials exist (external onboarding); DevSignatureProvider keeps
// the flow honest until then.
export abstract class SignatureProvider {
  abstract sign(payload: string): Promise<string>;
  abstract verify(payload: string, signature: string): Promise<boolean>;
  abstract readonly kind: string;
}

@Injectable()
export class DevSignatureProvider extends SignatureProvider {
  readonly kind = 'dev-hmac';
  constructor(private readonly cfg: AppConfig) {
    super();
  }
  async sign(payload: string): Promise<string> {
    return createHmac('sha256', this.cfg.jwtAccessSecret).update(payload).digest('hex');
  }
  async verify(payload: string, signature: string): Promise<boolean> {
    const expected = await this.sign(payload);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

@Global()
@Module({
  providers: [{ provide: SignatureProvider, useClass: DevSignatureProvider }],
  exports: [SignatureProvider],
})
export class SignatureModule {}
