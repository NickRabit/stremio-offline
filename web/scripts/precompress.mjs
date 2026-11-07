import { constants } from "node:zlib";
import { brotliCompress, gzip } from "node:zlib";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("dist");
const MIN_BYTES = 1024;
const EXTENSIONS = new Set([".js", ".css", ".svg", ".json", ".webmanifest"]);

const compress = (method, input, options) => new Promise((resolve, reject) => {
  method(input, options, (error, output) => error ? reject(error) : resolve(output));
});

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

await Promise.all((await filesUnder(ROOT)).map(async (file) => {
  if (!EXTENSIONS.has(path.extname(file))) return;
  if ((await stat(file)).size <= MIN_BYTES) return;
  const input = await readFile(file);
  const [brotliOutput, gzipOutput] = await Promise.all([
    compress(brotliCompress, input, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
    compress(gzip, input, { level: 9 }),
  ]);
  if (brotliOutput.length < input.length) await writeFile(`${file}.br`, brotliOutput);
  if (gzipOutput.length < input.length) await writeFile(`${file}.gz`, gzipOutput);
}));
