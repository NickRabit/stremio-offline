"""Disposable protocol probe, deliberately not a production adapter."""
import os
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen
from email.parser import BytesParser
from email.policy import default
from xml.sax.saxutils import escape
import json, threading, uuid, xml.etree.ElementTree as ET
ROOT = Path(os.environ['ARR_LAB_DIR'])
PORT = 18880
BASE = f'http://host.docker.internal:{PORT}'
KEY = 'arr220-disposable-test-key'
MOVIE = 'Big.Buck.Bunny.2008.720p.WEB-DL.AAC.H264-ARRLAB'
TV = 'Breaking.Bad.S01E01.720p.WEB-DL.AAC.H264-ARRLAB'
RELEASES = {'movie': (MOVIE, 'stremio-movies', 2000), 'episode': (TV, 'stremio-tv', 5000)}
JOBS = {}
EVENTS = []
LOCK = threading.RLock()

def record(event, **data):
    row = {'event': event, **data}
    EVENTS.append(row)
    with (ROOT / 'transcript.jsonl').open('a') as f:
        f.write(json.dumps(row) + '\n')

def envelope(rid):
    return f'<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><head><meta type="stremio-offline-v1">{rid}</meta></head><file poster="fixture" date="1780000000" subject="fixture"><groups><group>local.fixture</group></groups><segments><segment bytes="1" number="1">fixture@invalid</segment></segments></file></nzb>'.encode()

class H(BaseHTTPRequestHandler):

    def log_message(self, *args):
        pass

    def send(self, data, kind='application/json', code=200):
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
        elif isinstance(data, str):
            data = data.encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        with LOCK:
            opts = json.loads((ROOT / 'options.json').read_text()) if (ROOT / 'options.json').exists() else {}
            u = urlparse(self.path)
            q = {k: v[0] for (k, v) in parse_qs(u.query).items()}
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            record('request', method=self.command, path=u.path, query={k: v for (k, v) in q.items() if k not in ('apikey', 'ticket')})
            if u.path == '/fixture.mkv':
                return self.send((ROOT / 'shared/fixture.mkv').read_bytes(), 'video/x-matroska')
            if u.path == '/addon/manifest.json':
                return self.send({'id': 'org.arr220.fixture', 'version': '1.0.0', 'name': 'ARR fixture', 'resources': ['stream'], 'types': ['movie', 'series']})
            if u.path.startswith('/addon/stream/'):
                rid = 'movie' if '/movie/' in u.path else 'episode'
                return self.send({'streams': [{'url': BASE + '/fixture.mkv', 'behaviorHints': {'filename': RELEASES[rid][0] + '.mkv', 'videoSize': (ROOT / 'shared/fixture.mkv').stat().st_size}}]})
            if u.path == '/control/state':
                return self.send({'jobs': JOBS, 'events': EVENTS})
            if u.path == '/control/complete':
                threading.Thread(target=complete, daemon=True).start()
                return self.send({'status': True})
            if u.path == '/get' and q.get('ticket') == 'disposable-release-ticket':
                payload = envelope(q['id'])
                if opts.get('invalid_nzb'):
                    payload = b'<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><head/></nzb>'
                return self.send(payload, 'application/x-nzb')
            if q.get('apikey') != KEY:
                return self.send({'status': False, 'error': 'API Key Incorrect'}, code=401)
            if u.path == '/indexer/api':
                t = q.get('t')
                if t == 'caps':
                    return self.send('<?xml version="1.0"?><caps><server title="ARR lab"/><limits max="100" default="100"/><searching><search available="yes" supportedParams="q"/><tv-search available="yes" supportedParams="q,imdbid,season,ep"/><movie-search available="yes" supportedParams="q,imdbid,tmdbid"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>', 'application/xml')
                if t == 'get':
                    return self.send(envelope(q['id']), 'application/x-nzb')
                cats = q.get('cat', '')
                rid = 'episode' if t == 'tvsearch' or '50' in cats else 'movie'
                (title, cat, category) = RELEASES[rid]
                size = (ROOT / 'shared/fixture.mkv').stat().st_size
                link = escape(BASE + '/get?id=' + rid + '&ticket=disposable-release-ticket')
                item = f'<item><title>{title}</title><guid isPermaLink="false">{rid}</guid><link>{link}</link><pubDate>Thu, 24 Sep 2026 12:00:00 +0000</pubDate><category>{category}</category><enclosure url="{link}" length="{size}" type="application/x-nzb"/><newznab:attr name="category" value="{category}"/><newznab:attr name="size" value="{size}"/></item>'
                if opts.get('missing_size'):
                    item = item.replace(f' length="{size}"', '').replace(f'<newznab:attr name="size" value="{size}"/>', '')
                if opts.get('empty'):
                    item = ''
                return self.send(f'<?xml version="1.0"?><rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><title>ARR lab</title><description>fixture</description><link>{BASE}</link><newznab:response offset="0" total="{(1 if item else 0)}"/>{item}</channel></rss>', 'application/xml')
            mode = q.get('mode')
            if mode == 'version':
                return self.send({'version': '4.5.5'})
            if mode == 'get_config':
                return self.send({'config': {'misc': {'complete_dir': '/data/staging', 'history_retention': '0', 'history_retention_option': 'all', 'history_retention_number': 0, 'enable_tv_sorting': False, 'enable_movie_sorting': False, 'enable_date_sorting': False}, 'categories': [{'name': x[1], 'dir': '', 'pp': '0'} for x in RELEASES.values()], 'servers': [], 'sorters': []}})
            if mode == 'fullstatus':
                return self.send({'status': {'complete_dir': '/data/staging'}})
            if mode == 'addfile':
                msg = BytesParser(policy=default).parsebytes(b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\nMIME-Version: 1.0\r\n\r\n' + body)
                try:
                    part = next((x for x in msg.iter_parts() if x.get_param('name', header='content-disposition') == 'name'))
                    root = ET.fromstring(part.get_payload(decode=True))
                    rid = root.find('{*}head/{*}meta').text
                    assert rid in RELEASES and q['cat'] == RELEASES[rid][1]
                except Exception:
                    return self.send({'status': False, 'error': 'Foreign or invalid fixture envelope'})
                jid = next((key for (key, value) in JOBS.items() if value['rid'] == rid), 'ARR220-' + rid + '-' + uuid.uuid4().hex[:8])
                JOBS.setdefault(jid, {'rid': rid, 'status': 'Downloading', 'title': RELEASES[rid][0], 'category': q['cat'], 'bytes': (ROOT / 'shared/fixture.mkv').stat().st_size})
                record('upload', reference=rid, jobId=jid, filename=part.get_filename())
                return self.send({'status': True, 'nzo_ids': [jid]})
            if mode in ['queue', 'history']:
                if q.get('name') == 'delete':
                    record('delete', jobId=q.get('value'), del_files=q.get('del_files'), archive=q.get('archive'))
                    JOBS.pop(q.get('value'), None)
                    return self.send({'status': True})
                slots = []
                for (jid, j) in JOBS.items():
                    if q.get('category') and q['category'] != j['category']:
                        continue
                    if mode == 'queue' and j['status'] == 'Downloading':
                        slots.append({'nzo_id': jid, 'filename': j['title'], 'cat': j['category'], 'status': 'Downloading', 'mb': j['bytes'] / 1048576, 'mbleft': j['bytes'] / 1048576, 'timeleft': '0:00:30', 'percentage': 0, 'priority': 'Normal'})
                    if mode == 'history' and j['status'] == 'Completed':
                        slots.append({'nzo_id': jid, 'name': j['title'], 'nzb_name': j['title'] + '.nzb', 'category': j['category'], 'status': 'Completed', 'bytes': j['bytes'], 'storage': '/data/staging/' + jid + '/' + j['title'], 'download_time': 1, 'fail_message': ''})
                return self.send({mode: {'paused': False, 'slots': slots, 'noofslots': len(slots)}})
            return self.send({'status': False, 'error': 'Not implemented'}, code=400)

def complete():
    for (jid, j) in list(JOBS.items()):
        if j['status'] != 'Downloading':
            continue
        video = 'tt1254207' if j['rid'] == 'movie' else 'tt0903747:1:1'
        kind = 'movie' if j['rid'] == 'movie' else 'series'
        stream = json.load(urlopen(f'http://127.0.0.1:{PORT}/addon/stream/{kind}/{video}.json'))['streams'][0]
        data = urlopen(stream['url'].replace('host.docker.internal', '127.0.0.1')).read()
        target = ROOT / 'shared/staging' / jid / j['title']
        target.mkdir(parents=True, exist_ok=True)
        (target / (j['title'] + '.mkv')).write_bytes(data)
        j['status'] = 'Completed'
        record('download-completed', jobId=jid, bytes=len(data))
if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
