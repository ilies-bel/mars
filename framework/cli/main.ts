#!/usr/bin/env node
import { Command } from 'commander';
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
    const { feature: created, path } = await featurePlan(goal);
    console.log(created.id);
    console.log(`  status: ${created.status}`);
    console.log(`  origin: ${created.origin}`);
    console.log(`  saved:  ${path}`);
    console.log(`  next:   mars feature refine ${created.id}`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
