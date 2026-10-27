import {createHmac} from 'crypto';
import {Test} from '@nestjs/testing';
import request from 'supertest';
import {DataSource} from 'typeorm';
import {WhatsappWebhookController} from '../src/modules/channels/channels.module';

describe('Meta callback authenticity (HTTP; no external provider)',()=>{
 let app:any;const query=jest.fn().mockResolvedValue([]);const secret='isolated-meta-app-secret';const before=process.env.WHATSAPP_APP_SECRET;
 const payload=JSON.stringify({entry:[{changes:[{value:{statuses:[{id:'audit-wamid',status:'delivered'}]}}]}]});
 const sign=(body:string)=>'sha256='+createHmac('sha256',secret).update(body).digest('hex');
 const post=(body=payload)=>request(app.getHttpServer()).post('/channels/whatsapp/webhook').set('Content-Type','application/json').send(body);
 beforeAll(async()=>{const m=await Test.createTestingModule({controllers:[WhatsappWebhookController],providers:[{provide:DataSource,useValue:{query}}]}).compile();app=m.createNestApplication({rawBody:true});await app.init();});
 beforeEach(()=>{process.env.WHATSAPP_APP_SECRET=secret;query.mockClear();});
 afterAll(async()=>{if(before===undefined)delete process.env.WHATSAPP_APP_SECRET;else process.env.WHATSAPP_APP_SECRET=before;await app.close();});
 it('rejects unsigned, malformed and tampered callbacks before accessing data',async()=>{
  await post().expect(401);await post().set('x-hub-signature-256','sha256=abc').expect(401);
  await post(payload.replace('delivered','read')).set('x-hub-signature-256',sign(payload)).expect(401);expect(query).not.toHaveBeenCalled();
 });
 it('fails closed when signing is unconfigured',async()=>{delete process.env.WHATSAPP_APP_SECRET;await post().set('x-hub-signature-256',sign(payload)).expect(503);expect(query).not.toHaveBeenCalled();});
 it('accepts authentic raw bytes and ignores arbitrary statuses',async()=>{
  await post().set('x-hub-signature-256',sign(payload)).expect(200);expect(query).toHaveBeenCalledWith('SELECT followup_msg_set_status($1, $2)',['audit-wamid','delivered']);
  query.mockClear();const arbitrary=payload.replace('delivered','APPROVED');await post(arbitrary).set('x-hub-signature-256',sign(arbitrary)).expect(200);expect(query).not.toHaveBeenCalled();
 });
});
