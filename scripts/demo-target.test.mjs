import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertDemoTarget} from './demo-target.mjs';
const env={DEMO_ISOLATED:'1',DEMO_PG_CONTAINER:'leadprocure-demo-db',DEMO_API_CONTAINER:'leadprocure-demo-api'};
const db={Config:{Labels:{'leadprocure.disposable':'true'},Env:['POSTGRES_DB=leadprocure_demo']},NetworkSettings:{Networks:{demo:{Aliases:['postgres']}}}};
const api={Config:{Labels:{'leadprocure.disposable':'true'},Env:['DATABASE_URL=postgres://app_user:synthetic@postgres:5432/leadprocure_demo']},NetworkSettings:{Networks:{demo:{}},Ports:{'3000/tcp':[{HostIp:'127.0.0.1',HostPort:'3005'}]}}};
const inspect=n=>n===env.DEMO_PG_CONTAINER?db:api;
test('requires explicit isolation before inspecting or mutating any target',()=>{assert.throws(()=>assertDemoTarget({},'http://localhost:3000',()=>{throw Error('inspection must not run');}),/DEMO_ISOLATED/);assert.throws(()=>assertDemoTarget({...env,DEMO_PG_CONTAINER:'leadprocure-prod-postgres-1'},'http://127.0.0.1:3005',inspect),/Explicit disposable/);});
test('rejects production URL, wrong published port, missing labels and mismatched database',()=>{
 for(const url of ['https://production.example','http://localhost:3000'])assert.throws(()=>assertDemoTarget(env,url,inspect),/published 127/);
 assert.throws(()=>assertDemoTarget(env,'http://127.0.0.1:3005',n=>n===env.DEMO_PG_CONTAINER?{...db,Config:{...db.Config,Labels:{}}}:api),/disposable label/);
 assert.throws(()=>assertDemoTarget(env,'http://127.0.0.1:3005',n=>n===env.DEMO_PG_CONTAINER?db:{...api,Config:{...api.Config,Env:['DATABASE_URL=postgres://app_user:synthetic@postgres:5432/leadprocure']}}),/runtime database/);
});
test('rejects the same port bound on a different host address or ambiguous localhost',()=>{
 const remote={...api,NetworkSettings:{...api.NetworkSettings,Ports:{'3000/tcp':[{HostIp:'10.0.0.2',HostPort:'3005'}]}}};
 assert.throws(()=>assertDemoTarget(env,'http://127.0.0.1:3005',n=>n===env.DEMO_PG_CONTAINER?db:remote),/published 127/);
 assert.throws(()=>assertDemoTarget(env,'http://localhost:3005',inspect),/published 127/);
});
test('accepts a labelled disposable API and its matching disposable database',()=>{assert.deepEqual(assertDemoTarget(env,'http://127.0.0.1:3005',inspect),{pg:'leadprocure-demo-db',dbName:'leadprocure_demo'});});
