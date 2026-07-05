import { createPublicKey, KeyObject } from 'crypto';
import { V4 } from 'paseto';
import type { LicenseClaims } from '@leadprocure/shared';

// Licenses are PASETO v4.public tokens (Ed25519). The app embeds only the PUBLIC key and
// verifies offline — works air-gapped on-prem. Signing happens on our license server.
export async function verifyLicenseToken(token: string, publicKeyPem: string): Promise<LicenseClaims> {
  const key = createPublicKey(publicKeyPem);
  const payload = await V4.verify(token, key);
  return payload as unknown as LicenseClaims;
}

export async function signLicenseToken(claims: LicenseClaims, privateKey: KeyObject): Promise<string> {
  return V4.sign(claims as unknown as Record<string, unknown>, privateKey);
}

export function publicKeyFromB64Pem(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}
