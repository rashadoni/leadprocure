import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID, createHash } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { AvScanWorker } from '../src/common/storage/documents.module';
import { ClamavService } from '../src/common/storage/clamav.service';

// Real antivirus pipeline against a live clamd (infra/docker-compose.yml `clamav`):
// presigned upload → PENDING → worker streams to clamd → CLEAN / INFECTED verdict →
// infected downloads are refused. Uses the EICAR test signature (harmless by design;
// assembled from parts so the source file itself never contains the signature).
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-', 'FILE!$H+H*'].join('');

describe('antivirus scanning (clamd e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string;
  let cleanId: string, eicarId: string;

  const upload = async (token: string, filename: string, content: string) => {
    const pre = await http().post('/documents/presign').set(...bearer(token))
      .send({ filename, mime: 'text/plain' }).expect(201);
    const put = await fetch(pre.body.uploadUrl, { method: 'PUT', body: content, headers: { 'Content-Type': 'text/plain' } });
    expect(put.ok).toBe(true);
    const sha = createHash('sha256').update(content).digest('hex');
    const conf = await http().post('/documents/confirm').set(...bearer(token))
      .send({ storageKey: pre.body.storageKey, filename, mime: 'text/plain', sizeBytes: content.length, sha256: sha, entityType: 'request' })
      .expect(201);
    return conf.body as { id: string; avStatus: string };
  };

  beforeAll(async () => {
    // AV on for THIS app instance only; clamd from the dev compose stack.
    process.env.CLAMAV_ENABLED = 'true';
    process.env.CLAMAV_HOST = process.env.CLAMAV_HOST ?? 'localhost';
    process.env.CLAMAV_PORT = process.env.CLAMAV_PORT ?? '3310';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();

    const r = await http().post('/auth/register/buyer')
      .send({ legalName: `Av Buyer ${tag}`, email: `av-${tag}@t.test`, password: 'password123', fullName: 'AV' }).expect(201);
    buyer = r.body.accessToken;

    // clamd's first boot loads the signature DB — wait until it answers PING.
    const clam = app.get(ClamavService);
    const deadline = Date.now() + 180_000;
    while (!(await clam.ping())) {
      if (Date.now() > deadline) throw new Error('clamd did not become ready — is infra clamav running?');
      await new Promise((res) => setTimeout(res, 3000));
    }
  }, 240_000);

  afterAll(async () => {
    delete process.env.CLAMAV_ENABLED;
    await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Av %${tag}%`]);
    await db.end();
    await app.close();
  });

  it('uploads land as PENDING while AV is enabled', async () => {
    ({ id: cleanId } = await upload(buyer, `clean-${tag}.txt`, 'perfectly ordinary tender attachment'));
    ({ id: eicarId } = await upload(buyer, `eicar-${tag}.txt`, EICAR));
    const list = await http().get('/documents').set(...bearer(buyer)).expect(200);
    for (const id of [cleanId, eicarId]) {
      expect(list.body.find((d: any) => d.id === id).av_status).toBe('PENDING');
    }
    await http().get(`/documents/${cleanId}/download`).set(...bearer(buyer)).expect(400);
  });

  it('the worker turns PENDING into CLEAN / INFECTED verdicts', async () => {
    const worker = app.get(AvScanWorker);
    await worker.scanOnce(20);
    const list = await http().get('/documents').set(...bearer(buyer)).expect(200);
    expect(list.body.find((d: any) => d.id === cleanId).av_status).toBe('CLEAN');
    expect(list.body.find((d: any) => d.id === eicarId).av_status).toBe('INFECTED');
  }, 120_000);

  it('an INFECTED file cannot be downloaded; a CLEAN one can', async () => {
    await http().get(`/documents/${eicarId}/download`).set(...bearer(buyer)).expect(400);
    const ok = await http().get(`/documents/${cleanId}/download`).set(...bearer(buyer)).expect(200);
    expect(ok.body.url).toContain(process.env.S3_BUCKET ?? 'leadprocure');
  });

  it('the owner org is notified about the blocked file', async () => {
    const notes = await http().get('/notifications').set(...bearer(buyer)).expect(200);
    const hit = notes.body.find((n: any) => n.type === 'DOCUMENT_INFECTED');
    expect(hit).toBeDefined();
    expect(hit.payload.filename).toBe(`eicar-${tag}.txt`);
  });
});
