import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { parseMediaPath } from '../server/src/library-parse.ts';

const addonRoot = process.argv[2];
if (!addonRoot) throw new Error('Usage: node --import tsx scripts/compare-release-parsers.mts <addon-root>');
const root = resolve(addonRoot);
const require = createRequire(import.meta.url);
const { parseNameWithLibrary } = require(join(root, 'src/indexer/parse.js'));
const files = ['indexer-parse.test.js', 'release.test.js', 'filename.test.js', 'indexer-episode-name.test.js'];
const video = /\.(mkv|mp4|avi|mov|m4v|wmv|webm|ts|m2ts|mpg|mpeg|flv|vob)\b/i;
const names: string[] = [];
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(join(root, 'test', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && video.test(node.text)) names.push(node.text.normalize('NFC'));
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const disagreements = { title: 0, year: 0, season: 0, episode: 0, any: 0, structure: 0 };
const emptyTitles = { offline: 0, addon: 0 };
for (const name of new Set(names)) {
  const offline = parseMediaPath(name);
  const addon = await parseNameWithLibrary(name);
  let changed = false;
  let structureChanged = false;
  for (const key of ['title', 'year', 'season', 'episode'] as const) {
    const a = key === 'title' ? normalize(offline.title) : offline[key] ?? null;
    const b = key === 'title' ? normalize(addon.title) : addon[key] ?? null;
    if (a !== b) {
      disagreements[key]++;
      changed = true;
      if (key === 'season' || key === 'episode') structureChanged = true;
    }
  }
  if (changed) disagreements.any++;
  if (structureChanged) disagreements.structure++;
  if (!normalize(offline.title)) emptyTitles.offline++;
  if (!normalize(addon.title)) emptyTitles.addon++;
}
const revision = (cwd: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const dirty = (cwd: string) => Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8' }).trim());
console.log(JSON.stringify({
  revisions: { offline: revision(process.cwd()), addon: revision(root) },
  dirty: { offline: dirty(process.cwd()), addon: dirty(root) },
  pttVersion: JSON.parse(readFileSync(join(root, 'node_modules/@viren070/parse-torrent-title/package.json'), 'utf8')).version,
  method: 'All video-shaped string literals in four test files, NFC-deduplicated; may include expected values and synthetic cases. Disagreement, not accuracy. No private names emitted.',
  files,
  occurrences: names.length,
  uniqueNames: new Set(names).size,
  duplicates: names.length - new Set(names).size,
  disagreements,
  emptyTitles,
}, null, 2));
