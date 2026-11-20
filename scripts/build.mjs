import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { build } from 'esbuild';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const files = await readdir('public', { recursive: true, withFileTypes: true });
const assets = {};
for (const file of files.filter(entry => entry.isFile())) {
  const path = join(file.parentPath, file.name);
  const extension = extname(file.name);
  const type = contentTypes[extension];
  if (!type) throw new Error(`Unknown content type for ${path}`);
  const binary = extension === '.woff2';
  const body = await readFile(path, binary ? 'base64' : 'utf8');
  assets['/' + path.slice('public/'.length).replaceAll('\\', '/')] = { type, body, binary };
}

await build({
  entryPoints: ['worker/index.mjs'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/server/index.js',
  plugins: [{
    name: 'site-assets',
    setup(builder) {
      builder.onResolve({ filter: /^open-play:assets$/ }, () => ({ path: 'assets', namespace: 'open-play' }));
      builder.onLoad({ filter: /^assets$/, namespace: 'open-play' }, () => ({ contents: `export default ${JSON.stringify(assets)};` }));
    },
  }],
});

await mkdir('dist/.openai', { recursive: true });
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
await cp('migrations', 'dist/.openai/drizzle', { recursive: true });
