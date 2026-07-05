import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import { AppConfig } from '../config/config.service';

// Envelope encryption for sealed bids: a random per-bid DEK encrypts the financial
// payload (AES-256-GCM); the DEK is wrapped with the master key (env/KMS). Amounts
// therefore never exist in cleartext in the DB until the opening ceremony decrypts them.
export interface SealedBlob {
  ciphertext: Buffer; // iv-less: ct || authTag(16)
  iv: Buffer;
  wrappedKey: Buffer; // wiv(12) || wrappedDek || authTag(16)
}

@Injectable()
export class SealedCryptoService {
  private readonly master: Buffer;

  constructor(cfg: AppConfig) {
    // Normalize whatever the env holds into exactly 32 bytes.
    this.master = createHash('sha256').update(Buffer.from(cfg.bidMasterKeyB64, 'base64')).digest();
  }

  seal(payload: unknown): SealedBlob {
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final(), c.getAuthTag()]);

    const wiv = randomBytes(12);
    const w = createCipheriv('aes-256-gcm', this.master, wiv);
    const wrapped = Buffer.concat([wiv, w.update(dek), w.final(), w.getAuthTag()]);

    return { ciphertext: ct, iv, wrappedKey: wrapped };
  }

  open<T>(blob: SealedBlob): T {
    const wiv = blob.wrappedKey.subarray(0, 12);
    const wTag = blob.wrappedKey.subarray(blob.wrappedKey.length - 16);
    const wCt = blob.wrappedKey.subarray(12, blob.wrappedKey.length - 16);
    const uw = createDecipheriv('aes-256-gcm', this.master, wiv);
    uw.setAuthTag(wTag);
    const dek = Buffer.concat([uw.update(wCt), uw.final()]);

    const tag = blob.ciphertext.subarray(blob.ciphertext.length - 16);
    const ct = blob.ciphertext.subarray(0, blob.ciphertext.length - 16);
    const d = createDecipheriv('aes-256-gcm', dek, blob.iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')) as T;
  }

  sha256(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex');
  }
}

@Global()
@Module({ providers: [SealedCryptoService], exports: [SealedCryptoService] })
export class SealedCryptoModule {}
