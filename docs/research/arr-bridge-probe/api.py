import os
import urllib.request, urllib.error, json, xml.etree.ElementTree as ET
from pathlib import Path
ROOT = Path(os.environ['ARR_LAB_DIR'])

def api(app, path, data=None, method=None):
    key = ET.parse(ROOT / app / 'config.xml').findtext('ApiKey')
    port = 18989 if app == 'sonarr' else 17878
    req = urllib.request.Request(f'http://127.0.0.1:{port}/api/v3/{path}', data=json.dumps(data).encode() if data is not None else None, headers={'X-Api-Key': key, 'Content-Type': 'application/json'}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
            return json.loads(b) if b else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(str(e.code) + ' ' + e.read().decode()) from None
if __name__ == '__main__':
    import sys
    (app, path) = sys.argv[1:3]
    print(json.dumps(api(app, path), indent=2))
