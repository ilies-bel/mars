#!/usr/bin/env node
import { Command } from 'commander';
import { planNew } from './plan-new.ts';

const program = new Command();

program.name('mars').description('Mars Framework — declarative AI coding agents').version('0.0.0');

const plan = program.command('plan').description('Plan management');

plan
  .command('new')
  .description('Register a new idea as a draft plan (no planner run yet)')
  .argument('<goal...>', 'short statement of what you want')
  .action(async (goalParts: string[]) => {
    const goal = goalParts.join(' ');
    const { plan: created, path } = await planNew(goal);
    console.log(created.id);
    console.log(`  status: ${created.status}`);
    console.log(`  origin: ${created.origin}`);
    console.log(`  saved:  ${path}`);
    console.log(`  next:   mars plan refine ${created.id}`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
