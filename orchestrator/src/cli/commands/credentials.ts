/**
 * `credentials` command group — manage credential name→env-var mappings.
 *
 * Three subcommands:
 *   credentials set    — upsert a credential record
 *   credentials list   — print all credentials with their set? status
 *   credentials remove — delete a credential by name
 *
 * All three call the core credential-store functions directly (no daemon round-trip).
 */

import {
  listCredentials,
  removeCredential,
  setCredential,
} from '../../core/lib/credential-store'
import type { Command } from '../command'

const credentialsSet: Command = {
  path: 'credentials set',
  summary: 'register or update a credential name→env-var mapping',
  usage: 'usage: mars credentials set <name> <env-var> [--description <desc>]',
  run: async (args, deps) => {
    const name = args.positional[0]
    const envVar = args.positional[1]

    if (!name) {
      deps.err('usage: mars credentials set <name> <env-var> [--description <desc>]')
      return { code: 2 }
    }
    if (!envVar) {
      deps.err('usage: mars credentials set <name> <env-var> [--description <desc>]')
      return { code: 2 }
    }

    const description = args.flags['--description']

    await setCredential(name, envVar, description)
    deps.out(`credential '${name}' set (env var: ${envVar})`)
    return { code: 0 }
  },
}

const credentialsList: Command = {
  path: 'credentials list',
  summary: 'list all registered credentials',
  usage: 'usage: mars credentials list',
  run: async (_args, deps) => {
    const creds = await listCredentials()
    if (creds.length === 0) {
      deps.out('(no credentials configured)')
      return { code: 0 }
    }
    deps.out(
      [
        'name'.padEnd(20),
        'env_var'.padEnd(24),
        'description'.padEnd(30),
        'set?',
      ].join('  '),
    )
    deps.out(
      [
        '----'.padEnd(20),
        '-------'.padEnd(24),
        '-----------'.padEnd(30),
        '----',
      ].join('  '),
    )
    for (const c of creds) {
      const isSet = process.env[c.envVar] !== undefined ? 'yes' : 'no'
      deps.out(
        [
          c.name.slice(0, 20).padEnd(20),
          c.envVar.slice(0, 24).padEnd(24),
          (c.description ?? '').slice(0, 30).padEnd(30),
          isSet,
        ].join('  '),
      )
    }
    return { code: 0 }
  },
}

const credentialsRemove: Command = {
  path: 'credentials remove',
  summary: 'delete a credential by name',
  usage: 'usage: mars credentials remove <name>',
  run: async (args, deps) => {
    const name = args.positional[0]

    if (!name) {
      deps.err('usage: mars credentials remove <name>')
      return { code: 2 }
    }

    await removeCredential(name)
    return { code: 0 }
  },
}

const credentialsGroup: Command = {
  path: 'credentials',
  summary: 'manage credential name→env-var mappings',
  usage: 'usage: mars credentials <set|list|remove>',
  run: (_args, deps) => {
    deps.err('usage: mars credentials <set|list|remove>')
    return { code: 2 }
  },
}

export const credentialsCommands: readonly Command[] = [
  credentialsSet,
  credentialsList,
  credentialsRemove,
  credentialsGroup,
]
