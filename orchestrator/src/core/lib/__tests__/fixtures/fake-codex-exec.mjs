#!/usr/bin/env node
// A `codex exec --json` stand-in. Emits the exact event shape codex-cli
// 0.145.0 produces, captured from a real run: agent_message and
// command_execution items carry NO usage, and the terminal `turn.completed`
// carries the whole turn's cumulative usage.
const events = [
  { type: 'thread.started', thread_id: 'fixture-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'working' } },
  {
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: '/bin/zsh -lc ls',
      aggregated_output: '',
      exit_code: 0,
      status: 'completed',
    },
  },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'done' } },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 31864,
      cached_input_tokens: 25088,
      cache_write_input_tokens: 0,
      output_tokens: 118,
      reasoning_output_tokens: 0,
    },
  },
]
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`)
