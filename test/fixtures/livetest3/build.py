# Build test/fixtures/livetest3/ from livetest-3's REAL export, pruned to what the P1 tests need.
# Nothing is hand-written: every value, key, name and prop below is copied from the export.
import json, os, sys
L = '/Users/mohamedomarwork/design-twin-livetest-3/design/export'
OUT = sys.argv[1]
KEEP_COLLS = {'Spacing', 'Border Radius'}
SCREENS = ['pages/__Organization_management_/positions___7314_87192',
           'pages/__Organization_management_/System_Configurations__1359_21337',
           'pages/In_progress/Create_Activity_Type__18411_84111']
SLICES = SCREENS + ['pages/__Organization_management_/Job_Role_Details__20174_143363',
                    'pages/In_progress/Create_Activity_Type__18411_84502']

def load(p): return json.load(open(os.path.join(L, p)))
def dump(p, d):
    f = os.path.join(OUT, p); os.makedirs(os.path.dirname(f), exist_ok=True)
    json.dump(d, open(f, 'w'), indent=None if p.endswith(('_87192.json','_21337.json','_84111.json')) else 1, ensure_ascii=False, separators=(',', ':') if p.endswith(('_87192.json','_21337.json','_84111.json')) else None); open(f, 'a').write('\n')

def prune_vars(d, hygiene_n=2):
    vs = [v for v in d['variables'] if v.get('collection') in KEEP_COLLS]
    names = {v['collection'] for v in vs}
    out = dict(d)
    out['variables'] = vs
    out['collections'] = [c for c in d['collections'] if c['name'] in names]
    out['hygiene'] = d.get('hygiene', [])[:hygiene_n]
    return out

dump('variables.json', prune_vars(load('variables.json')))
for s in SLICES: dump(s + '.vars.json', prune_vars(load(s + '.vars.json'), 0))
dump('design-system/tokens.json', prune_vars(load('design-system/tokens.json')))

KEEP_FIELDS = ('id', 'name', 'type', 'hidden', 'visible', 'mainComponent', 'props', 'component', 'tokens', 'children')
def has_instance(n): return n.get('type') == 'INSTANCE' or any(has_instance(c) for c in n.get('children') or [])
def prune_node(n):
    o = {k: n[k] for k in KEEP_FIELDS if k in n and k != 'children'}
    if 'tokens' in o: o['tokens'] = {k: v for k, v in o['tokens'].items() if isinstance(v, str) and 'Space' in v}
    if not o.get('tokens'): o.pop('tokens', None)
    kids = [prune_node(c) for c in n.get('children') or [] if has_instance(c) or any(isinstance(v, str) and 'Space' in v for v in (c.get('tokens') or {}).values())]
    if kids: o['children'] = kids
    return o
inst_names = set()
def collect(n):
    if n.get('type') == 'INSTANCE' and n.get('mainComponent'):
        mc = n['mainComponent']; inst_names.add(mc.get('setName') or mc.get('name') or n.get('name'))
    for c in n.get('children') or []: collect(c)
for s in SCREENS:
    d = load(s + '.json')
    out = {k: d[k] for k in ('screen', 'page', 'pageId', 'nodeId') if k in d}
    out['nodes'] = [prune_node(r) for r in d['nodes']]
    for r in d['nodes']: collect(r)
    dump(s + '.json', out)

cat = load('design-system/components.local.json')
cat['components'] = [c for c in cat['components'] if c['name'] in inst_names]
dump('design-system/components.local.json', cat)
lib = load('design-system/components.library.json')
lib['components'] = [c for c in lib['components'] if c['name'] in inst_names]
dump('design-system/components.library.json', lib)

# the reference answer the matcher must reproduce, name for name (trimmed to what the test compares)
ref = json.load(open('/Users/mohamedomarwork/design-twin-livetest-3/scripts-test/out/components/mapping.json'))
slim = {}
for k, sc in ref.items():
    rows = {}
    for i in sc['instances']:
        rows.setdefault(i['name'], {'match': i['match'] and i['match']['id'], 'firstReason': i['reasons'][0], 'confidence': i['confidence']})
    slim[k] = {'file': sc['file'].replace('design/export/', ''), 'node': sc['node'], 'instances': len(sc['instances']), 'names': rows}
dump('mapping.reference.json', slim)
print('catalog', len(cat['components']), 'library', len(lib['components']))
