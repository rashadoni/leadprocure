import 'reflect-metadata';
import { createHash } from 'crypto';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DataSource, QueryRunner } from 'typeorm';
import { loadRootEnv } from './common/config/env';
import { AppConfig } from './common/config/config.service';
import { ClamavService, ScanVerdict } from './common/storage/clamav.service';

type PendingFile = {
  src: string;
  id: string;
  storage_key: string;
  owner_org: string;
  filename: string;
  size_bytes: string | number;
  sha256: string;
};

loadRootEnv();

const maxFiles = Math.max(1, Math.min(Number(process.env.AV_SCAN_MAX_FILES ?? 100), 500));
const maxBytes = Math.max(1, Number(process.env.AV_SCAN_MAX_BYTES ?? 24 * 1024 * 1024));

function storageClient(): { client: S3Client; bucket: string } {
  return {
    client: new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      },
    }),
    bucket: process.env.S3_BUCKET ?? 'leadprocure',
  };
}

async function waitForClamd(clam: ClamavService): Promise<void> {
  const deadline = Date.now() + Number(process.env.CLAMAV_READY_TIMEOUT_MS ?? 180_000);
  while (!(await clam.ping())) {
    if (Date.now() >= deadline) throw new Error('clamd did not become ready before timeout');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function setStatus(q: QueryRunner, file: PendingFile, status: ScanVerdict | 'SKIPPED' | 'ERROR') {
  return q.query(`SELECT document_set_av_status($1,$2,$3)`, [file.src, file.id, status]);
}

async function notifyInfected(q: QueryRunner, file: PendingFile): Promise<void> {
  await q.query(`SELECT app_notify($1, NULL, 'DOCUMENT_INFECTED', $2::jsonb)`, [
    file.owner_org,
    JSON.stringify({ filename: file.filename }),
  ]);
}

async function main(): Promise<void> {
  const cfg = new AppConfig();
  const clam = new ClamavService(cfg);
  const { client: s3, bucket } = storageClient();
  const ds = new DataSource({ type: 'postgres', url: cfg.databaseUrl, logging: ['error'] });
  await ds.initialize();
  const q = ds.createQueryRunner();
  await q.connect();

  let locked = false;
  let scanned = 0;
  let infected = 0;
  let blocked = 0;
  let failures = 0;
  try {
    const lock = await q.query(`SELECT pg_try_advisory_lock(hashtext('leadprocure-av-scan')) AS locked`);
    locked = lock[0]?.locked === true;
    if (!locked) {
      console.log('AV scan skipped: another execution owns the advisory lock');
      return;
    }

    await waitForClamd(clam);
    const files: PendingFile[] = await q.query(`SELECT * FROM documents_pending_scan($1)`, [maxFiles]);
    for (const file of files) {
      try {
        const metadata = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: file.storage_key }));
        const objectSize = metadata.ContentLength;
        const expectedSize = Number(file.size_bytes);
        if (objectSize === undefined || objectSize !== expectedSize) {
          await setStatus(q, file, 'ERROR');
          blocked += 1;
          console.warn(`AV size mismatch: ${file.src}/${file.id} ${file.filename}`);
          continue;
        }
        if (objectSize > maxBytes) {
          await setStatus(q, file, 'SKIPPED');
          blocked += 1;
          console.warn(`AV blocked oversized file: ${file.src}/${file.id} (${objectSize} bytes)`);
          continue;
        }

        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.storage_key }));
        const buffer = Buffer.from(await object.Body!.transformToByteArray());
        const actualSha256 = createHash('sha256').update(buffer).digest('hex');

        if (buffer.length !== expectedSize || actualSha256 !== file.sha256.toLowerCase()) {
          await setStatus(q, file, 'ERROR');
          blocked += 1;
          console.warn(`AV integrity error: ${file.src}/${file.id} ${file.filename}`);
          continue;
        }
        const verdict = await clam.scanBuffer(buffer);
        await setStatus(q, file, verdict);
        scanned += 1;
        if (verdict === 'INFECTED') {
          infected += 1;
          await notifyInfected(q, file);
          console.warn(`AV infected: ${file.src}/${file.id} ${file.filename}`);
        }
      } catch (error: any) {
        // Leave the row PENDING. Cloud Run retry or the catch-up schedule handles it.
        failures += 1;
        console.error(`AV transient failure: ${file.src}/${file.id}: ${error.message}`);
      }
    }
    console.log(JSON.stringify({ pending: files.length, scanned, infected, blocked, failures }));
    if (failures > 0) throw new Error(`${failures} file(s) remain PENDING after transient failures`);
  } finally {
    if (locked) await q.query(`SELECT pg_advisory_unlock(hashtext('leadprocure-av-scan'))`);
    await q.release();
    await ds.destroy();
    s3.destroy();
  }
}

void main().catch((error) => {
  console.error(`AV scan job failed: ${error.message}`);
  process.exitCode = 1;
});
