import {execFileSync} from 'node:child_process';

// Demo writes require an explicitly labelled disposable stack, including API↔DB routing.
export function assertDemoTarget(env, apiUrl, inspect = name => JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0]) {
  if (env.DEMO_ISOLATED !== '1') throw new Error('Demo writes require DEMO_ISOLATED=1');
  const pg=env.DEMO_PG_CONTAINER, api=env.DEMO_API_CONTAINER;
  if (![pg,api].every(n=>/^leadprocure-demo-[a-z0-9][a-z0-9-]*$/.test(n ?? ''))) throw new Error('Explicit disposable DEMO_PG_CONTAINER and DEMO_API_CONTAINER are required');
  const dbName='leadprocure_demo';
  const database=inspect(pg),server=inspect(api);
  for (const c of [database,server]) if(c.Config?.Labels?.['leadprocure.disposable']!=='true') throw new Error('Refusing a container without the disposable label');
  const values=c=>Object.fromEntries((c.Config?.Env ?? []).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));
  if(values(database).POSTGRES_DB!==dbName) throw new Error('Refusing a non-demo database');
  const dbUrl=new URL(values(server).DATABASE_URL);
  if(dbUrl.pathname!=='/'+dbName || dbUrl.username!=='app_user') throw new Error('API does not use the disposable runtime database');
  const dbNetworks=database.NetworkSettings?.Networks ?? {},apiNetworks=server.NetworkSettings?.Networks ?? {};
  if(!Object.keys(dbNetworks).some(n=>apiNetworks[n] && [pg,...(dbNetworks[n].Aliases ?? [])].includes(dbUrl.hostname))) throw new Error('API and demo database routing do not match');
  const url=new URL(apiUrl);
  const mapped=server.NetworkSettings?.Ports?.['3000/tcp'] ?? [];
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.pathname!=='/' || url.search || url.username || url.password || !mapped.some(p=>p.HostIp==='127.0.0.1' && p.HostPort===(url.port || '80'))) throw new Error('DEMO_API must use the disposable API published 127.0.0.1 port');
  return {pg,dbName};
}
