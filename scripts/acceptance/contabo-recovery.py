"""Small recovery probe, only on this task's labelled disposable upgrade database."""
import hashlib,json,subprocess,shlex,uuid
name='lp-audit-20261026-upgrade'
def remote(args, data=None):
    return subprocess.run(['ssh','-o','BatchMode=yes','contabo-admin',shlex.join(['docker']+args)],input=data,capture_output=True,check=True).stdout
label=remote(['inspect','--format','{{index .Config.Labels "leadprocure.audit"}}',name]).decode().strip()
assert label=='20261026','Refusing unowned database container'
def sql(database,statement):
    return remote(['exec',name,'psql','-U','leadprocure_owner','-d',database,'-v','ON_ERROR_STOP=1','-Atc',statement]).decode().strip()
backup=remote(['exec',name,'pg_dump','-U','leadprocure_owner','-d','leadprocure_audit_test','-Fc'])
restored='audit_restore_'+uuid.uuid4().hex[:8]
sql('leadprocure_audit_test',f'CREATE DATABASE {restored}')
try:
    remote(['exec','-i',name,'pg_restore','-U','leadprocure_owner','-d',restored,'--exit-on-error'],backup)
    query="SELECT (SELECT count(*) FROM invoices)::text||','||(SELECT count(*) FROM migrations)::text||','||(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity)::text"
    original=sql('leadprocure_audit_test',query);result=sql(restored,query)
    assert original==result,(original,result)
    assert int(result.split(',')[2])>20
    isolated=sql(restored,"SET ROLE app_user; SELECT count(*) FROM invoices")
    assert isolated.splitlines()[-1]=='0','Restored runtime role must remain isolated without context'
    print(json.dumps({'result':'PASS','database':'disposable upgrade fixture','invoice_migration_rls_counts':result,'no_context_runtime_invoice_count':0,'backup_sha256':hashlib.sha256(backup).hexdigest(),'backup_bytes':len(backup)},indent=2))
finally:sql('leadprocure_audit_test',f'DROP DATABASE {restored}')
