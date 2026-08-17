import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Context, FiberState, ValidationError } from '../../src/ctx/index.js';

/**
 * Plugin config validation is standard-schema, not a cordis-specific schema
 * library. `zod@4` implements Standard Schema v1 and is already a dependency of
 * this package, so a plugin gets the same validation gate `Workflow.inputSchema`
 * gives a run — for zero new dependencies.
 */
describe('plugin Config validation', () => {
  // NOTE: `ctx.plugin(p, config)` types `config` as the schema's OUTPUT (it is
  // inferred from `apply`'s second parameter), so a schema whose input and
  // output differ — `.default()`, `.transform()` — needs a cast at the call
  // site. Kept simple here.
  const Config = z.object({ level: z.string(), retries: z.number().optional() });
  type PluginConfig = z.output<typeof Config>;

  it('parses config before the plugin starts and hands the parsed value to apply()', async () => {
    const ctx = new Context();
    let seen: unknown;

    const fiber = await ctx.plugin(
      {
        name: 'configured',
        Config,
        apply(_pluginCtx: Context, config: PluginConfig) {
          seen = config;
        },
      },
      { level: 'info' },
    );

    expect(fiber.state).toBe(FiberState.ACTIVE);
    expect(seen).toEqual({ level: 'info' });
  });

  it('rejects bad config with a ValidationError naming the offending path', async () => {
    const ctx = new Context();
    let applied = false;

    const fiber = ctx.plugin(
      {
        name: 'misconfigured',
        Config,
        apply(_pluginCtx: Context, _config: PluginConfig) {
          applied = true;
        },
      },
      // Deliberately ill-typed: the point is that config arriving from outside
      // the type system (a .mars/workflows/*.js file, an operator's JSON) is
      // rejected at runtime before the plugin body ever runs.
      { level: 5 } as unknown as PluginConfig,
    );

    await expect(fiber.await()).rejects.toBeInstanceOf(ValidationError);
    await expect(fiber.await()).rejects.toThrow(/at level/);
    expect(applied).toBe(false);
    expect(fiber.state).toBe(FiberState.FAILED);
  });
});
