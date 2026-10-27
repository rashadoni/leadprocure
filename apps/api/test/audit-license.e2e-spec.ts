import { generateKeyPairSync } from 'crypto';
import { EntitlementService } from '../src/common/license/entitlement.service';
import { FeatureGuard } from '../src/common/license/feature.guard';
import { NEW_WORK_KEY } from '../src/common/auth/decorators';
import { signLicenseToken } from '../src/common/license/paseto-license';
import { FEATURE_KEYS, LicenseClaims } from '@leadprocure/shared';

describe('audit licensing: signed claims, time and graceful continuation',()=>{
  const pair=generateKeyPairSync('ed25519');
  const cfg:any={nodeEnv:'production',deploymentMode:'on_prem_isolated',licenseDevEdition:'enterprise',licensePublicKeyB64:Buffer.from(pair.publicKey.export({type:'spki',format:'pem'}) as string).toString('base64')};
  const now=Date.now();
  const claims:LicenseClaims={license_id:'audit-license',customer_id:'audit',deployment_type:'on_prem_isolated',license_type:'server',edition:'enterprise',features:[...FEATURE_KEYS],limits:{max_buyer_orgs:null,seats:null,events_month:10},valid_from:new Date(now-1000).toISOString(),expires_at:new Date(now+20*86400000).toISOString(),grace_until:new Date(now+25*86400000).toISOString(),key_id:'audit',schema_version:1};
  afterEach(()=>jest.restoreAllMocks());
  it('production without a signed license restricts new work and exposes missing source',async()=>{
    const service=new EntitlementService({query:async()=>[]} as any,cfg);
    await service.reload();expect(service.snapshot().source).toBe('missing');expect(service.status()).toBe('expired_restricted');
    expect(()=>service.assertCanCreateNew()).toThrow();
    const reflector:any={getAllAndOverride:(key:string)=>key===NEW_WORK_KEY ? false:undefined};
    const ctx:any={getHandler:()=>({}),getClass:()=>({})};
    expect(new FeatureGuard(reflector,service).canActivate(ctx)).toBe(true);
    reflector.getAllAndOverride=(key:string)=>key===NEW_WORK_KEY ? true:undefined;
    expect(()=>new FeatureGuard(reflector,service).canActivate(ctx)).toThrow();
  });
  it('real PASETO signature advances valid→grace→restricted without reload and supports renewal',async()=>{
    let row:any;
    const db:any={query:async(sql:string,p:any[])=>{
      if(sql.startsWith('INSERT')){row={raw_token:p[11],status:p[10]};return [];}
      return row?[row]:[];
    }};
    const service=new EntitlementService(db,cfg);
    await service.installFromToken(await signLicenseToken(claims,pair.privateKey));
    expect(service.status()).toBe('valid');expect(service.snapshot().source).toBe('installed');
    const clock=jest.spyOn(Date,'now');clock.mockReturnValue(Date.parse(claims.expires_at)+1);
    expect(service.status()).toBe('grace');expect(service.canCreateNew()).toBe(true);
    clock.mockReturnValue(Date.parse(claims.grace_until)+1);
    expect(service.status()).toBe('expired_restricted');expect(service.canCreateNew()).toBe(false);
    clock.mockRestore();
    await service.installFromToken(await signLicenseToken({...claims,license_id:'renewed',expires_at:new Date(now+60*86400000).toISOString(),grace_until:new Date(now+70*86400000).toISOString()},pair.privateKey));
    expect(service.status()).toBe('valid');
  });
  it('future and revoked signed licenses do not permit new operations',async()=>{
    const token=await signLicenseToken({...claims,valid_from:new Date(now+86400000).toISOString()},pair.privateKey);
    const service=new EntitlementService({query:async()=>[{raw_token:token,status:'valid'}]} as any,cfg);
    await service.reload();expect(service.canCreateNew()).toBe(false);
    const valid=await signLicenseToken(claims,pair.privateKey);
    const revoked=new EntitlementService({query:async()=>[{raw_token:valid,status:'revoked'}]} as any,cfg);
    await revoked.reload();expect(revoked.status()).toBe('revoked');
  });
});
