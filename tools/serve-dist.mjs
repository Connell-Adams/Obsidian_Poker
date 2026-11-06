// Minimal static server for the production build, with no dependencies.
// Usage: node tools/serve-dist.mjs [port]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve('dist');
const port = Number(process.argv[2] ?? 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

if (!existsSync(join(root, 'index.html'))) {
  console.error('No production build found. Run: npm run build');
  process.exit(1);
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const target = normalize(join(root, decodeURIComponent(url.pathname)));
  // Refuse anything that would escape the build folder.
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  const file = existsSync(target) && statSync(target).isFile() ? target : join(root, 'index.html');
  response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`Serving dist on http://localhost:${port}`));
