import os
from api import api, ROOT
import json
for app in ['sonarr', 'radarr']:
    cat = 'stremio-tv' if app == 'sonarr' else 'stremio-movies'
    client = json.loads((ROOT / f'{app}-downloadclient-schema.json').read_text())
    client.update(name='ARR220 HTTP bridge', enable=True, priority=1, removeCompletedDownloads=True, removeFailedDownloads=True)
    values = {'host': 'host.docker.internal', 'port': 18880, 'urlBase': '/sab', 'apiKey': 'arr220-disposable-test-key', 'tvCategory': cat, 'movieCategory': cat}
    for f in client['fields']:
        if f['name'] in values:
            f['value'] = values[f['name']]
    print(app, 'client test', api(app, 'downloadclient/test', client))
    client = api(app, 'downloadclient', client)
    print('client id', client['id'])
    idx = json.loads((ROOT / f'{app}-indexer-schema.json').read_text())
    idx.update(name='ARR220 HTTP addon', enableRss=False, enableAutomaticSearch=True, enableInteractiveSearch=True, priority=1, downloadClientId=client['id'])
    values = {'baseUrl': 'http://host.docker.internal:18880/indexer', 'apiPath': '/api', 'apiKey': 'arr220-disposable-test-key', 'categories': [5000 if app == 'sonarr' else 2000]}
    for f in idx['fields']:
        if f['name'] in values:
            f['value'] = values[f['name']]
    print(app, 'indexer test', api(app, 'indexer/test', idx))
    print('indexer id', api(app, 'indexer', idx)['id'])
    print('root', api(app, 'rootfolder', {'path': '/data/tv' if app == 'sonarr' else '/data/movies'}))
    for q in api(app, 'qualitydefinition'):
        q['minSize'] = 0
        api(app, 'qualitydefinition/' + str(q['id']), q, 'PUT')
    lookup = api(app, 'series/lookup?term=tvdb:81189' if app == 'sonarr' else 'movie/lookup?term=tmdb:10378')
    item = lookup[0]
    item.update(qualityProfileId=1, monitored=True, rootFolderPath='/data/tv' if app == 'sonarr' else '/data/movies')
    item['addOptions'] = {'searchForMissingEpisodes': False, 'searchForMovie': False}
    item['languageProfileId'] = 1
    saved = api(app, 'series' if app == 'sonarr' else 'movie', item)
    (ROOT / f'{app}-item.json').write_text(json.dumps(saved, indent=2))
    print(app, 'item', saved['id'], saved['title'])
