#!/usr/bin/env node
import { Command } from 'commander';
import { BeadsStore } from '../store/beads-store.ts';
import {
  ContextError,
  formatSearchText,
  formatTreeText,
  runSearch,
  runTree,
} from './context.ts';
import { featurePlan } from './feature-plan.ts';

const program = new Command();

program.name('mars').description('Mars Framework — declarative AI coding agents').version('0.0.0');

const feature = program.command('feature').description('Feature management');

feature
  .command('plan')
  .description('Register a new idea as a draft feature (no planner run yet)')
  .argument('<goal...>', 'short statement of what you want')
  .action(async (goalParts: string[]) => {
    const goal = goalParts.join(' ');
    const store = new BeadsStore();
    let created;
    let path: string;
    try {
      ({ feature: created, path } = await featurePlan(goal, process.cwd(), { store }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `Error: feature was NOT registered in beads.\n  ${message}\n\nMake sure the beads CLI ("bd") is installed and "bd init" has been run in this directory.`,
      );
      process.exit(1);
    }
    console.log(created.id);
    console.log(`  status:  ${created.status}`);
    console.log(`  origin:  ${created.origin}`);
    console.log(`  storeId: ${created.storeId ?? '(none)'}`);
    console.log(`  saved:   ${path}`);
    console.log(`  next:    mars feature refine ${created.id}`);
  });

const context = program
  .command('context')
  .description('Deterministic codebase-context tools (replaces ad-hoc grep/ls/find)');

context
  .command('search')
  .description('Search the codebase via ripgrep, return structured hits')
  .argument('<query...>', 'pattern to search for (passed to ripgrep)')
  .option('--path <dir>', 'restrict search to this path')
  .option('--type <ext>', 'rg --type filter (e.g. ts, md)')
  .option('--format <fmt>', 'output format: json | text', 'json')
  .action(
    async (
      queryParts: string[],
      opts: { path?: string; type?: string; format: string },
    ) => {
      const query = queryParts.join(' ');
      try {
        const hits = await runSearch(query, {
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          ...(opts.type !== undefined ? { type: opts.type } : {}),
        });
        if (opts.format === 'text') {
          if (hits.length > 0) console.log(formatSearchText(hits));
        } else {
          console.log(JSON.stringify(hits));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ContextError) {
          console.error(`Error: ${message}`);
        } else {
          console.error(`Error: search failed.\n  ${message}`);
        }
        process.exit(1);
      }
    },
  );

context
  .command('tree')
  .description('List files and directories at a path (gitignore-aware), structured')
  .argument('[path]', 'path to list (default: current directory)', '.')
  .option('--depth <n>', 'recursion depth (default: 1)', '1')
  .option('--format <fmt>', 'output format: json | text', 'json')
  .action(async (path: string, opts: { depth: string; format: string }) => {
    const depth = Number.parseInt(opts.depth, 10);
    if (Number.isNaN(depth) || depth < 1) {
      console.error(`Error: --depth must be a positive integer (got "${opts.depth}")`);
      process.exit(1);
    }
    try {
      const entries = await runTree(path, { depth });
      if (opts.format === 'text') {
        if (entries.length > 0) console.log(formatTreeText(entries));
      } else {
        console.log(JSON.stringify(entries));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ContextError) {
        console.error(`Error: ${message}`);
      } else {
        console.error(`Error: tree failed.\n  ${message}`);
      }
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
