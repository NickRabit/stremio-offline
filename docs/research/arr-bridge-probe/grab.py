import os
from api import api, ROOT
import json
for app in ['sonarr', 'radarr']:
    if app == 'sonarr':
        eps = api(app, 'episode?seriesId=1')
        ep = next((x for x in eps if x['seasonNumber'] == 1 and x['episodeNumber'] == 1))
        path = 'release?episodeId=' + str(ep['id'])
        (ROOT / 'episode-id').write_text(str(ep['id']))
    else:
        path = 'release?movieId=1'
    releases = api(app, path)
    (ROOT / f'{app}-releases.json').write_text(json.dumps(releases, indent=2))
    print(app, [(x['title'], x.get('rejections'), x.get('size')) for x in releases])
    if not releases:
        continue
    api(app, 'release', {'guid': releases[0]['guid'], 'indexerId': releases[0]['indexerId']})
    print(app, 'grab accepted')
