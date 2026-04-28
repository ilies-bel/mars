#!/usr/bin/env node
import { Command } from 'commander';
import { BeadsStore } from '../store/beads-store.ts';
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
