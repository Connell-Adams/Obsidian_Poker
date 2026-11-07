import { defineConfig } from 'vite';

/**
 * Bundles the trusted game server (engine included) into one file the Supabase
 * Edge Function imports. Run `npm run build:edge` after changing server or engine code.
 */
export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: 'src/online/server/core.ts',
      formats: ['es'],
      fileName: () => 'core.bundle.js',
    },
    outDir: 'supabase/functions/poker',
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
  },
});
