"""Run only against disposable containers created here; requires Docker Desktop/macOS."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
HERE = Path(__file__).resolve().parent
IMAGES = {'sonarr': 'lscr.io/linuxserver/sonarr@sha256:a5c1a5fecbef946927ab90ad68df319ac5fe644057e5fc18cd993f01ac07b2b2', 'radarr': 'lscr.io/linuxserver/radarr@sha256:adb6c09d6b729ea5e642c99cea35af72702ef476bf4763f153299ac5db9f0b4f'}
for port in [18880, 18989, 17878]:
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('127.0.0.1', port))
root = Path(tempfile.mkdtemp(prefix='arr220-probe-'))
os.environ['ARR_LAB_DIR'] = str(root)
from api import api
created = []
bridge = None
results = {'images': IMAGES, 'versions': {}, 'checks': []}
print('Evidence directory:', root, flush=True)

def terminate(signum, _frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, terminate)

def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def wait_for(fn, timeout=60):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            value = fn()
            if value:
                return value
        except Exception as exc:
            last = exc
        time.sleep(1)
    raise RuntimeError(f'Condition timed out: {last}')

def control(path, post=False):
    with urlopen(Request('http://127.0.0.1:18880/control/' + path, data=b'' if post else None), timeout=10) as response:
        return json.load(response)

def imported(app):
    resource = 'episodefile?seriesId=1' if app == 'sonarr' else 'moviefile?movieId=1'
    rows = api(app, resource)
    if len(rows) != 1:
        return False
    path = root / 'shared' / rows[0]['path'].removeprefix('/data/')
    assert hashlib.sha256(path.read_bytes()).digest() == fixture_hash
    return rows

def finish(label):
    wait_for(lambda : len(control('state')['jobs']) == 2)
    control('complete', True)
    wait_for(lambda : all((j['status'] == 'Completed' for j in control('state')['jobs'].values())))
    for app in IMAGES:
        api(app, 'command', {'name': 'RefreshMonitoredDownloads'})
        rows = wait_for(lambda : imported(app))
        history = api(app, 'history?pageSize=30')
        (root / f'{app}-{label}-history.json').write_text(json.dumps(history, indent=2))
        results['checks'].append({'app': app, 'check': label, 'importedSize': rows[0]['size'], 'sha256': fixture_hash.hex()})
    wait_for(lambda : not control('state')['jobs'])
try:
    for directory in ['shared/staging', 'shared/movies', 'shared/tv', 'sonarr', 'radarr']:
        (root / directory).mkdir(parents=True, exist_ok=True)
    command('ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1200', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-c:a', 'aac', '-b:a', '32k', '-shortest', str(root / 'shared/fixture.mkv'))
    fixture_hash = hashlib.sha256((root / 'shared/fixture.mkv').read_bytes()).digest()
    for (app, internal, exposed) in [('sonarr', 8989, 18989), ('radarr', 7878, 17878)]:
        (root / app / 'config.xml').write_text(f'<Config><BindAddress>*</BindAddress><Port>{internal}</Port><ApiKey>{secrets.token_hex(16)}</ApiKey><AuthenticationMethod>External</AuthenticationMethod><AuthenticationRequired>DisabledForLocalAddresses</AuthenticationRequired><LogLevel>debug</LogLevel><UpdateMechanism>Docker</UpdateMechanism></Config>')
        name = 'arr220-probe-' + app + '-' + secrets.token_hex(3)
        command('docker', 'run', '-d', '--name', name, '-p', f'127.0.0.1:{exposed}:{internal}', '-e', 'PUID=0', '-e', 'PGID=0', '-e', 'TZ=UTC', '-v', f'{root / app}:/config', '-v', f"{root / 'shared'}:/data", IMAGES[app])
        created.append(name)
        results['versions'][app] = wait_for(lambda : api(app, 'system/status'))['version']
    bridge_log = (root / 'bridge.log').open('w')
    bridge = subprocess.Popen([sys.executable, str(HERE / 'bridge.py')], stdout=bridge_log, stderr=subprocess.STDOUT)
    wait_for(lambda : control('state'))
    for app in IMAGES:
        for (kind, implementation) in [('downloadclient', 'Sabnzbd'), ('indexer', 'Newznab')]:
            row = next((x for x in api(app, kind + '/schema') if x['implementation'] == implementation))
            (root / f'{app}-{kind}-schema.json').write_text(json.dumps(row))
    subprocess.run([sys.executable, str(HERE / 'configure.py')], check=True)
    subprocess.run([sys.executable, str(HERE / 'grab.py')], check=True)
    finish('interactive')
    for app in IMAGES:
        (root / 'options.json').write_text('{"empty":true}')
        try:
            api(app, 'indexer/test', api(app, 'indexer')[0])
        except RuntimeError as error:
            assert 'no results' in str(error).lower(), error
        else:
            raise AssertionError('Expected empty-feed validation failure')
        (root / 'options.json').write_text('{}')
        api(app, 'indexer/test', api(app, 'indexer')[0])
        resource = 'episodefile' if app == 'sonarr' else 'moviefile'
        rows = api(app, resource + ('?seriesId=1' if app == 'sonarr' else '?movieId=1'))
        assert len(rows) == 1
        api(app, resource + '/' + str(rows[0]['id']), method='DELETE')
        path = 'release?episodeId=' + (root / 'episode-id').read_text() if app == 'sonarr' else 'release?movieId=1'
        (root / 'options.json').write_text('{"missing_size":true}')
        rows = api(app, path)
        assert rows and rows[0]['size'] == 0, rows
        (root / 'options.json').write_text('{}')
        rows = api(app, path)
        assert rows
        (root / 'options.json').write_text('{"invalid_nzb":true}')
        try:
            api(app, 'release', {'guid': rows[0]['guid'], 'indexerId': rows[0]['indexerId']})
        except RuntimeError as error:
            assert 'Invalid NZB: No files' in str(error), error
        else:
            raise AssertionError('Expected invalid-NZB rejection')
        assert not control('state')['jobs']
        (root / 'options.json').write_text('{}')
        api(app, 'indexer/test', api(app, 'indexer')[0])
        api(app, 'downloadclient/test', api(app, 'downloadclient')[0])
        results['checks'].append({'app': app, 'check': 'empty-feed, missing-size, invalid-NZB', 'passed': True})
    for app in IMAGES:
        payload = {'name': 'EpisodeSearch', 'episodeIds': [int((root / 'episode-id').read_text())]} if app == 'sonarr' else {'name': 'MoviesSearch', 'movieIds': [1]}
        api(app, 'command', payload)
    finish('automatic-command')
    results['passed'] = True
    print(json.dumps(results, indent=2))
finally:
    (root / 'results.json').write_text(json.dumps(results, indent=2))
    if bridge:
        bridge.terminate()
        bridge.wait(timeout=10)
        bridge_log.close()
    for name in created:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
