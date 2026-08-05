import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectVerifyGates } from '../detect-verify-gates'

const repos: string[] = []

const makeRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-detect-verify-gates-'))
  repos.push(repo)
  return repo
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})

describe('detectVerifyGates', () => {
  it('proposes normalized gates for supported Node scripts using the lockfile package manager', () => {
    const repo = makeRepo()
    writeFileSync(
      resolve(repo, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          'test:integration': 'vitest run --config integration',
        },
      }),
    )
    writeFileSync(resolve(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9')

    expect(detectVerifyGates(repo)).toEqual([
      {
        scope: '.',
        name: 'lint',
        cmd: 'pnpm',
        args: ['run', 'lint'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'package.json script "lint"',
      },
      {
        scope: '.',
        name: 'test',
        cmd: 'pnpm',
        args: ['run', 'test'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'package.json script "test"',
      },
      {
        scope: '.',
        name: 'test:integration',
        cmd: 'pnpm',
        args: ['run', 'test:integration'],
        required: true,
        tier: 'integration',
        source: 'detected',
        evidence: 'package.json script "test:integration"',
      },
      {
        scope: '.',
        name: 'typecheck',
        cmd: 'pnpm',
        args: ['run', 'typecheck'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'package.json script "typecheck"',
      },
    ])
  })

  it('inspects only package scopes declared by npm workspaces', () => {
    const repo = makeRepo()
    writeFileSync(
      resolve(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    )
    mkdirSync(resolve(repo, 'packages', 'api'), { recursive: true })
    writeFileSync(
      resolve(repo, 'packages', 'api', 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
    )
    mkdirSync(resolve(repo, 'unrelated'), { recursive: true })
    writeFileSync(
      resolve(repo, 'unrelated', 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' } }),
    )

    expect(detectVerifyGates(repo)).toEqual([
      {
        scope: 'packages/api',
        name: 'test',
        cmd: 'npm',
        args: ['run', 'test'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'package.json script "test"',
      },
    ])
  })

  it('collapses overlapping workspace declarations into one deterministically sorted proposal', () => {
    const repo = makeRepo()
    writeFileSync(
      resolve(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*', 'packages/api'] }),
    )
    mkdirSync(resolve(repo, 'packages', 'api'), { recursive: true })
    writeFileSync(
      resolve(repo, 'packages', 'api', 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' } }),
    )

    expect(detectVerifyGates(repo)).toEqual([
      {
        scope: 'packages/api',
        name: 'lint',
        cmd: 'npm',
        args: ['run', 'lint'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'package.json script "lint"',
      },
    ])
  })

  it('proposes a Python test gate when pyproject declares pytest configuration', () => {
    const repo = makeRepo()
    writeFileSync(
      resolve(repo, 'pyproject.toml'),
      ['[project]', 'name = "sample"', '', '[tool.pytest.ini_options]', 'testpaths = ["tests"]'].join('\n'),
    )

    expect(detectVerifyGates(repo)).toEqual([
      {
        scope: '.',
        name: 'test',
        cmd: 'python',
        args: ['-m', 'pytest'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'pyproject.toml pytest configuration',
      },
    ])
  })

  it('proposes a Cargo test gate when Cargo.toml declares a test target', () => {
    const repo = makeRepo()
    writeFileSync(
      resolve(repo, 'Cargo.toml'),
      ['[package]', 'name = "sample"', 'version = "0.1.0"', '', '[[test]]', 'name = "api"'].join('\n'),
    )

    expect(detectVerifyGates(repo)).toEqual([
      {
        scope: '.',
        name: 'test',
        cmd: 'cargo',
        args: ['test'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'Cargo.toml test target',
      },
    ])
  })

  it('proposes a Cargo test gate when cargo is runnable even without a declared test target', () => {
    const repo = makeRepo()
    const bin = resolve(repo, 'bin')
    mkdirSync(bin)
    writeFileSync(resolve(repo, 'Cargo.toml'), '[package]\nname = "sample"\nversion = "0.1.0"\n')
    writeFileSync(resolve(bin, 'cargo'), '#!/bin/sh\n')
    chmodSync(resolve(bin, 'cargo'), 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`

    try {
      expect(detectVerifyGates(repo)).toEqual([
        {
          scope: '.',
          name: 'test',
          cmd: 'cargo',
          args: ['test'],
          required: true,
          tier: 'task',
          source: 'detected',
          evidence: 'cargo executable',
        },
      ])
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('proposes a Go test gate when a module contains Go test files', () => {
    const repo = makeRepo()
    writeFileSync(resolve(repo, 'go.mod'), 'module example.com/sample\n\ngo 1.24\n')
    writeFileSync(resolve(repo, 'sample_test.go'), 'package sample\n')

    expect(detectVerifyGates(repo)).toEqual([
      {
        scope: '.',
        name: 'test',
        cmd: 'go',
        args: ['test', './...'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'go.mod with Go test files',
      },
    ])
  })

  it('proposes a Gradle test gate when the repository includes a runnable wrapper', () => {
    const repo = makeRepo()
    writeFileSync(resolve(repo, 'build.gradle'), 'plugins { id "java" }\n')
    writeFileSync(resolve(repo, 'gradlew'), '#!/bin/sh\n')
    chmodSync(resolve(repo, 'gradlew'), 0o755)

    expect(detectVerifyGates(repo)).toEqual([
      {
        scope: '.',
        name: 'test',
        cmd: './gradlew',
        args: ['test'],
        required: true,
        tier: 'task',
        source: 'detected',
        evidence: 'Gradle wrapper',
      },
    ])
  })

  it('proposes a Gradle test gate when the build declares a test task', () => {
    const repo = makeRepo()
    writeFileSync(resolve(repo, 'build.gradle.kts'), 'tasks.test { useJUnitPlatform() }\n')
    const originalPath = process.env.PATH
    process.env.PATH = ''

    try {
      expect(detectVerifyGates(repo)).toEqual([
        {
          scope: '.',
          name: 'test',
          cmd: 'gradle',
          args: ['test'],
          required: true,
          tier: 'task',
          source: 'detected',
          evidence: 'Gradle test task',
        },
      ])
    } finally {
      process.env.PATH = originalPath
    }
  })
})
