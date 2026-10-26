"""Bounded checks only. Full acceptance belongs on hosted CI / dedicated worker."""
import pathlib, subprocess, shlex, sys
root=pathlib.Path(__file__).resolve().parents[2]
network='lp-audit-20261026'; db=network+'-db'; storage=network+'-storage'
def docker(args, timeout=50, capture=False):
    return subprocess.run(['ssh','-o','BatchMode=yes','contabo-admin',shlex.join(['docker']+args)],text=True,check=True,timeout=timeout,capture_output=capture)
mode=sys.argv[1]
if mode=='setup-upgrade':
    docker(['run','-d','--name',network+'-upgrade','--label','leadprocure.audit=20261026','--network',network,'--network-alias','postgres-upgrade','--memory','384m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,size=256m','-e','POSTGRES_USER=leadprocure_owner','-e','POSTGRES_PASSWORD=isolated_owner','-e','POSTGRES_DB=leadprocure_audit_test','postgres:16'])
elif mode=='setup':
    docker(['network','create','--internal','--label','leadprocure.audit=20261026',network])
    docker(['run','-d','--name',db,'--label','leadprocure.audit=20261026','--network',network,'--network-alias','postgres','--memory','384m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,size=256m','-e','POSTGRES_USER=leadprocure_owner','-e','POSTGRES_PASSWORD=isolated_owner','-e','POSTGRES_DB=leadprocure_audit_test','postgres:16'])
    docker(['run','-d','--name',storage,'--label','leadprocure.audit=20261026','--network',network,'--network-alias','minio','--memory','256m','--cpus','1','-e','MINIO_ROOT_USER=isolatedaccess','-e','MINIO_ROOT_PASSWORD=isolatedsecret','minio/minio:latest','server','/data'])
elif mode in ['roles','roles-upgrade']:
    if mode=='roles-upgrade': db=network+'-upgrade'
    sql="CREATE ROLE app_user LOGIN PASSWORD 'isolated_app' NOSUPERUSER NOBYPASSRLS; GRANT CONNECT ON DATABASE leadprocure_audit_test TO app_user; GRANT USAGE ON SCHEMA public TO app_user; ALTER DEFAULT PRIVILEGES FOR ROLE leadprocure_owner IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user; ALTER DEFAULT PRIVILEGES FOR ROLE leadprocure_owner IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO app_user;"
    docker(['exec',db,'psql','-U','leadprocure_owner','-d','leadprocure_audit_test','-v','ON_ERROR_STOP=1','-c',sql])
elif mode in ['migrate','test','bucket','webtype','typecheck','upgrade']:
    args=['run','--rm','--network',network,'--memory','1g','--cpus','1','--tmpfs','/tmp:rw,size=128m','-w','/repo/apps/api']
    for src,dst in [('apps/api/src','/repo/apps/api/src'),('apps/api/test','/repo/apps/api/test'),('packages/shared/src','/repo/packages/shared/src'),('apps/web/src','/repo/apps/web/src'),('apps/web/tsconfig.json','/repo/apps/web/tsconfig.json'),('scripts','/repo/scripts')]:args+=['-v',str(root/src)+':'+dst+':ro']
    exports=pathlib.Path('/tmp/leadprocure-audit-exports')
    exports.mkdir(exist_ok=True)
    args+=['-v',str(exports)+':/audit-exports']
    env={'AUDIT_EXPORT_DIR':'/audit-exports','NODE_ENV':'test','LEADPROCURE_TEST_ISOLATED':'1','DATABASE_URL':'postgres://app_user:isolated_app@postgres:5432/leadprocure_audit_test','DATABASE_OWNER_URL':'postgres://leadprocure_owner:isolated_owner@postgres:5432/leadprocure_audit_test','JWT_ACCESS_SECRET':'isolated-key','JWT_REFRESH_SECRET':'isolated-refresh','BID_MASTER_KEY_B64':'dGVzdC1vbmx5LW5vdC1hLXByb2R1Y3Rpb24ta2V5ISE=','CLAMAV_ENABLED':'false','S3_ENDPOINT':'http://minio:9000','S3_ACCESS_KEY':'isolatedaccess','S3_SECRET_KEY':'isolatedsecret','S3_BUCKET':'leadprocure-audit-test','TS_NODE_TRANSPILE_ONLY':'true'}
    if mode=='upgrade':
        env['DATABASE_URL']=env['DATABASE_URL'].replace('@postgres:', '@postgres-upgrade:')
        env['DATABASE_OWNER_URL']=env['DATABASE_OWNER_URL'].replace('@postgres:', '@postgres-upgrade:')
    for k,v in env.items():args+=['-e',k+'='+v]
    args+=['--entrypoint','node','leadprocure-prod-api']
    if mode=='upgrade':args+=['-r','ts-node/register','../../scripts/acceptance/upgrade-check.cjs']
    elif mode=='migrate':args+=['-r','ts-node/register','node_modules/typeorm/cli.js','migration:run','-d','src/common/db/data-source.ts']
    elif mode=='bucket':args+=['-e',"const {S3Client,CreateBucketCommand}=require('@aws-sdk/client-s3');new S3Client({endpoint:process.env.S3_ENDPOINT,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS_KEY,secretAccessKey:process.env.S3_SECRET_KEY}}).send(new CreateBucketCommand({Bucket:process.env.S3_BUCKET})).then(()=>console.log('Test bucket ready'))"]
    elif mode=='typecheck':args+=['-e',"const ts=require('typescript'),p=ts.readConfigFile('tsconfig.json',ts.sys.readFile);const c=ts.parseJsonConfigFileContent(p.config,ts.sys,process.cwd());Object.assign(c.options,{noEmit:true,incremental:false,paths:{'@leadprocure/shared':['../../packages/shared/src/index.ts']}});const d=ts.getPreEmitDiagnostics(ts.createProgram(c.fileNames,c.options));if(d.length){console.error(ts.formatDiagnosticsWithColorAndContext(d,{getCanonicalFileName:f=>f,getCurrentDirectory:ts.sys.getCurrentDirectory,getNewLine:()=>String.fromCharCode(10)}));process.exit(1)}console.log('PASS: API TypeScript with current shared source');"]
    elif mode=='webtype':args+=['node_modules/typescript/bin/tsc','-p','/repo/apps/web/tsconfig.json','--noEmit']
    else:
        assert 1<=len(sys.argv[2:])<=2,'Only one or two named targeted suites per run on Contabo'
        for name in sys.argv[2:]:assert name.endswith('.e2e-spec.ts') and '/' not in name
        args+=['node_modules/jest/bin/jest.js','--config','test/jest-e2e.json','--runInBand','--forceExit','--runTestsByPath']+['test/'+name for name in sys.argv[2:]]
    docker(args,timeout=55)
else:raise SystemExit('Unknown mode')
