// Runs a TypeScript module through Vite's SSR transform without adding a runner dependency.
// Usage: node tools/run-ts.mjs tools/generate-preflop-table.ts [args...]
import { resolve } from 'node:path';
import { createServer } from 'vite';

const entry = process.argv[2];
if (!entry) {
  console.error('Usage: node tools/run-ts.mjs <module path from project root> [args...]');
  process.exit(1);
}
const server = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  await server.ssrLoadModule(resolve(entry));
} finally {
  await server.close();
}
