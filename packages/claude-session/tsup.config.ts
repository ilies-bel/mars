import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  // node-pty is a native addon — mark it external so tsup does not try to
  // bundle it.  At runtime the consumer's node_modules/node-pty is loaded
  // via the normal Node resolution chain.
  external: ['node-pty'],
});
