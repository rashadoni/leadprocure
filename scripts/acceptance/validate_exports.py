"""Validate synthetic API exports against official UBL 2.1 / OCDS 1.1.5 schemas.
Use PYTHONPATH with lxml available. No customer data or credentials required.
"""
import hashlib,json,pathlib,sys,urllib.parse,urllib.request
from lxml import etree
import jsonschema
CACHE=pathlib.Path('/tmp/leadprocure-official-schemas')
UBL='https://docs.oasis-open.org/ubl/os-UBL-2.1/xsd/maindoc/UBL-Invoice-2.1.xsd'
OCDS='https://standard.open-contracting.org/schema/1__1__5/release-package-schema.json'
allowed={'docs.oasis-open.org','standard.open-contracting.org','www.w3.org'}
def fetch(url):
    url=url.replace('http://','https://',1)
    parsed=urllib.parse.urlparse(url)
    if parsed.hostname not in allowed:raise ValueError('Unexpected schema host: '+url)
    path=CACHE/parsed.hostname/parsed.path.lstrip('/')
    path.parent.mkdir(parents=True,exist_ok=True)
    if not path.exists():
        with urllib.request.urlopen(url,timeout=20) as r:path.write_bytes(r.read())
    return path
seen=set()
def xsd(url):
    if url in seen:return fetch(url)
    seen.add(url);p=fetch(url)
    tree=etree.parse(str(p))
    for n in tree.xpath('//*[@schemaLocation]'):
        dep=urllib.parse.urljoin(url,n.attrib['schemaLocation']);xsd(dep)
    return p
def schema_json(url):return json.loads(fetch(url).read_text())
if __name__=='__main__':
    p=xsd(UBL)
    if len(sys.argv)>1 and sys.argv[1]=='fetch':
        schema_json(OCDS);print('Official schemas cached:',len(seen),'XSD files');sys.exit(0)
    directory=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/leadprocure-audit-exports')
    validator=etree.XMLSchema(etree.parse(str(p)))
    results=[]
    for name in ['inclusive.xml','zero.xml','mixed-inclusive.xml','mixed-exclusive.xml']:
        doc=directory/name;validator.assertValid(etree.parse(str(doc)))
        results.append({'file':name,'schema':UBL,'sha256':hashlib.sha256(doc.read_bytes()).hexdigest(),'result':'PASS'})
    schema=schema_json(OCDS)
    resolver=jsonschema.RefResolver(base_uri=OCDS,referrer=schema,handlers={'https':schema_json,'http':schema_json})
    errors=list(jsonschema.Draft4Validator(schema,resolver=resolver,format_checker=jsonschema.FormatChecker()).iter_errors(json.loads((directory/'ocds.json').read_text())))
    if errors:raise ValueError('\n'.join(str(e) for e in errors))
    results.append({'file':'ocds.json','schema':OCDS,'result':'PASS'})
    print(json.dumps(results,indent=2))
