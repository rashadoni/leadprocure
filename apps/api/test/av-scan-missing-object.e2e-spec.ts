import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID, createHash } from 'crypto';
import { Client } from 'pg';
import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { AppModule } from '../src/app.module';
import { AvScanWorker } from '../src/common/storage/documents.module';

// Документ, объекта которого в хранилище больше нет, получает терминальное состояние и
// уходит из очереди сканирования.
//
// До этой правки сканер на любой неудаче писал «will retry» и оставлял строку PENDING, а
// `documents_pending_scan` отдаёт PENDING снова и снова. Замерено на проде 9 ноября 2026:
// `eicar-live.txt`, созданный 7 июля, четыре месяца крутился каждые 30 секунд с
// `The specified key does not exist. — will retry`.
//
// Шум — меньшая часть: очередь это `ORDER BY created_at LIMIT 5`, то есть навсегда падающая
// СТАРЕЙШАЯ строка занимает слот в каждой партии, и пять таких строк останавливают проверку
// новых загрузок молча. Поэтому второй проход здесь — не украшение, а и есть сам дефект:
// именно он показывает, что строка из очереди ВЫШЛА.
//
// clamd этому набору не нужен: объект удаляется до скана, и до clamd дело не доходит.
describe('antivirus: объекта нет — повтор прекращается (e2e)', () => {
  let app: INestApplication;
  let db: Client;
  let s3: S3Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  const bucket = process.env.S3_BUCKET ?? 'leadprocure';
  let buyer: string;
  let docId: string, storageKey: string;

  const avStatus = async (id: string) =>
    (await db.query('SELECT av_status FROM documents WHERE id = $1', [id])).rows[0]?.av_status;

  beforeAll(async () => {
    // Антивирус включён ТОЛЬКО для этого приложения: иначе загрузка записалась бы SKIPPED и
    // в очередь вообще не попала. clamd при этом не поднимается и не нужен.
    process.env.CLAMAV_ENABLED = 'true';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      },
    });

    buyer = (await http().post('/auth/register/buyer').send({
      legalName: `AvGone ${tag}`, email: `avgone-${tag}@t.test`, password: 'password123', fullName: 'AvGone',
    }).expect(201)).body.accessToken;

    const content = `потерянный файл ${tag}`;
    const pre = await http().post('/documents/presign').set(...bearer(buyer))
      .send({ filename: 'gone.txt', mime: 'text/plain' }).expect(201);
    const put = await fetch(pre.body.uploadUrl, {
      method: 'PUT', body: content, headers: { 'Content-Type': 'text/plain' },
    });
    expect(put.ok).toBe(true);
    const conf = await http().post('/documents/confirm').set(...bearer(buyer)).send({
      storageKey: pre.body.storageKey, filename: 'gone.txt', mime: 'text/plain',
      sizeBytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
      entityType: 'request',
    }).expect(201);
    docId = conf.body.id;
    // Ключ, под которым документ лежит на самом деле: `confirm` переснимает байты на свой
    // неизменяемый ключ, и он НЕ равен ключу разрешения на загрузку.
    storageKey = (await db.query('SELECT storage_key FROM documents WHERE id = $1', [docId])).rows[0].storage_key;
    expect(conf.body.avStatus).toBe('PENDING');
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM organizations WHERE legal_name LIKE $1', [`AvGone %${tag}`]);
      await db.end();
    }
    if (app) await app.close();
    delete process.env.CLAMAV_ENABLED;
  });

  it('пока объект на месте, документ остаётся в очереди', async () => {
    const queued = await db.query(`SELECT id FROM documents_pending_scan(50) WHERE id = $1`, [docId]);
    expect(queued.rowCount).toBe(1);
    expect(await avStatus(docId)).toBe('PENDING');
  });

  it('объект исчез — один проход помечает документ MISSING, а не «попробуем ещё»', async () => {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    const worker = app.get(AvScanWorker);
    await worker.scanOnce(50);
    expect(await avStatus(docId)).toBe('MISSING');
  });

  // Тот самый дефект: до правки документ оставался PENDING и возвращался в очередь вечно,
  // занимая слот в партии из пяти.
  it('и из очереди он выходит — второй проход его не видит', async () => {
    const queued = await db.query(`SELECT id FROM documents_pending_scan(50) WHERE id = $1`, [docId]);
    expect(queued.rowCount).toBe(0);
    const worker = app.get(AvScanWorker);
    await worker.scanOnce(50);
    expect(await avStatus(docId)).toBe('MISSING'); // состояние терминальное, второй проход его не двигает
  });

  it('скачивание отказывает своим текстом, а не «ждём вердикта»', async () => {
    const res = await http().get(`/documents/${docId}/download`).set(...bearer(buyer)).expect(400);
    expect(JSON.stringify(res.body)).toContain('no longer in storage');
  });

  // Страховка от ложного терминала. Неудача, которая МОЖЕТ пройти в другой раз, обязана
  // оставить строку в очереди: иначе лежащий полчаса clamd или опечатка в имени корзины
  // помечали бы здоровые файлы потерянными — необратимо, и это хуже исходного дефекта.
  //
  // Два случая, и ВТОРОЙ здесь главный. Сетевой отказ — лёгкая семья: у него нет ни имени
  // ошибки S3, ни статуса, так что его не опознал бы никакой разбор. Опасна семья «ошибка S3
  // со статусом 404, но НЕ „ключа нет“»: замерено, что `NoSuchBucket` приходит ровно с 404,
  // то есть неотличимо по статусу от пропавшего ключа. Первая редакция правки считала
  // терминальным любой 404 и на этом случае помечала MISSING всю очередь.
  const failingUpload = async (filename: string) => {
    const content = `${filename} ${tag}`;
    const pre = await http().post('/documents/presign').set(...bearer(buyer))
      .send({ filename, mime: 'text/plain' }).expect(201);
    await fetch(pre.body.uploadUrl, { method: 'PUT', body: content, headers: { 'Content-Type': 'text/plain' } });
    return (await http().post('/documents/confirm').set(...bearer(buyer)).send({
      storageKey: pre.body.storageKey, filename, mime: 'text/plain',
      sizeBytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
      entityType: 'request',
    }).expect(201)).body.id as string;
  };

  // Подменяем только добычу байтов, остальной путь воркера настоящий.
  const scanWith = async (fail: () => Promise<never>) => {
    const worker = app.get(AvScanWorker) as any;
    const docs = worker.docs;
    const real = docs.getObjectBuffer.bind(docs);
    docs.getObjectBuffer = fail;
    try { await worker.scanOnce(50); } finally { docs.getObjectBuffer = real; }
  };

  const stillQueued = async (id: string) => {
    expect(await avStatus(id)).toBe('PENDING');
    const queued = await db.query(`SELECT id FROM documents_pending_scan(50) WHERE id = $1`, [id]);
    expect(queued.rowCount).toBe(1);
  };

  it('хранилище недоступно — документ остаётся в очереди', async () => {
    const id = await failingUpload('netfail.txt');
    await scanWith(async () => { throw new Error('ECONNREFUSED 127.0.0.1:9'); });
    await stillQueued(id);
  });

  // Ошибка не придумана: её бросает тот же SDK, настоящим запросом к несуществующей корзине.
  // Сочинённый объект проверял бы мою догадку о форме ошибки, а не форму саму.
  it('корзины нет — это НЕ «объекта нет», документ остаётся в очереди', async () => {
    const id = await failingUpload('nobucket.txt');
    const absent = `no-such-bucket-${Date.now()}`;
    let measured: any;
    await scanWith(async () => {
      try {
        await s3.send(new GetObjectCommand({ Bucket: absent, Key: 'k' }));
      } catch (e) { measured = e; throw e; }
      throw new Error('корзины быть не должно');
    });
    // Сама предпосылка проверки: ошибка обязана быть именно 404 с чужим именем, иначе
    // проверка стережёт не тот случай и проходила бы по случайности.
    expect(measured?.name).toBe('NoSuchBucket');
    expect(measured?.$metadata?.httpStatusCode).toBe(404);
    await stillQueued(id);
  });
});
