import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { parseMediaName, partSignature } from '../server/src/library-parse.ts';
import { numberedEpisode } from '../server/src/library.ts';
import { diskEpisodes } from '../server/src/library-episodes.ts';

if (!process.argv[2]) throw new Error('Usage: node --import tsx scripts/probe-release-parser-transfer.mts <addon-root>');
const { parseNameWithLibrary } = createRequire(import.meta.url)(join(resolve(process.argv[2]), 'src/indexer/parse.js'));
const names = [
  'Film 16x9', 'Film 4x3', 'Film 16x09', 'Show 1x03', 'Show 31x02',
  'Film 16x9 Show S02E03', 'Film DDP5.1 x265', 'Show 1x265',
  'Show.S02E03.Episode.Title', 'S02E03.Episode.Title', 'Film 2.díl',
  'Film část 2', 'Film CD2', 'Film cesky dabing', 'Český sen',
  'Film slovenský dabing', 'It dabing 2017', 'Film CZ-titulky',
  'Film CZ dabing Návrat', 'Cam 2018', 'Film 2020 CAM',
  'Show.S01E01-E06', 'Show.S01E01E02', 'Show.S01E03.Pilot.TVRip',
  'Show.S01.COMPLETE', 'Film S3 1080p', 'Show.Season.3', 'V S01E03',
];
for (const name of names) {
  console.log(JSON.stringify({
    name,
    offline: parseMediaName(name),
    numbered: numberedEpisode(`${name}.mkv`),
    disk: diskEpisodes([`${name}.mkv`]),
    part: partSignature(name),
    addon: await parseNameWithLibrary(name),
  }));
}
