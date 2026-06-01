import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  // Externalize runtime dependencies — don't bundle them
  external: ['zod'],
  platform: 'node',
  // Use a build-specific tsconfig: noEmit:false + ignoreDeprecations:"6.0"
  // (TypeScript 6 deprecated baseUrl; some tsup internals trigger it)
  tsconfig: 'tsconfig.build.json',
  // TODO: set publishConfig scope/registry when a second project consumer exists;
  // do NOT pick a registry now — that decision is deferred.
});
