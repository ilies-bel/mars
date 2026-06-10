import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Emit declarations as part of the same tsup run so dist/index.d.ts and
  // dist/index.d.cts are produced atomically. The previous build chain
  // (`tsup && tsc --emitDeclarationOnly && cp index.d.ts index.d.cts`) had a
  // failure mode where the `cp` step would error with "dist/index.d.ts: No
  // such file or directory" — the standalone tsc invocation occasionally
  // emitted no declaration when the prepare hook ran under pnpm install,
  // breaking the workspace-dep install on fresh worktrees. tsup's bundled
  // dts pass writes both .d.ts and .d.cts in a single atomic step.
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
