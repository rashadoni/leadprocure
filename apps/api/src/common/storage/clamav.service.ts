import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'net';
import { AppConfig } from '../config/config.service';

export type ScanVerdict = 'CLEAN' | 'INFECTED';

// Minimal clamd client speaking the zINSTREAM protocol: null-terminated command,
// then <4-byte BE length><chunk>… and a zero-length terminator. clamd answers
// "stream: OK" or "stream: <sig> FOUND". Anything else (timeout, size limit,
// connection refused) throws — the caller leaves the file PENDING and retries.
@Injectable()
export class ClamavService {
  private readonly log = new Logger('ClamAV');

  constructor(private readonly cfg: AppConfig) {}

  scanBuffer(buf: Buffer, timeoutMs = 60_000): Promise<ScanVerdict> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      let reply = '';
      const fail = (err: Error) => { sock.destroy(); reject(err); };
      sock.setTimeout(timeoutMs, () => fail(new Error('clamd timeout')));
      sock.on('error', fail);
      sock.on('data', (d) => { reply += d.toString(); });
      sock.on('close', () => {
        if (/\bFOUND\b/.test(reply)) return resolve('INFECTED');
        if (/\bOK\b/.test(reply)) return resolve('CLEAN');
        reject(new Error(`clamd: ${reply.trim() || 'no reply'}`));
      });
      sock.connect(this.cfg.clamavPort, this.cfg.clamavHost, () => {
        sock.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let off = 0; off < buf.length; off += CHUNK) {
          const slice = buf.subarray(off, Math.min(off + CHUNK, buf.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(slice.length, 0);
          sock.write(len);
          sock.write(slice);
        }
        sock.write(Buffer.alloc(4)); // zero-length chunk = end of stream
      });
    });
  }

  async ping(timeoutMs = 5_000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new Socket();
      let reply = '';
      const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.on('error', () => done(false));
      sock.on('data', (d) => { reply += d.toString(); if (reply.includes('PONG')) done(true); });
      sock.connect(this.cfg.clamavPort, this.cfg.clamavHost, () => sock.write('zPING\0'));
    });
  }
}
