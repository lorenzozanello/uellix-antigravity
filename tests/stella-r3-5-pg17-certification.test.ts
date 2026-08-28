import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertR3_5Pg17CertificationImageId,
  assertR3_5Pg17CertificationSourceHashes,
  collectR3_5Pg17CertificationSourceHashes,
  R3_5_PG17_CERTIFICATION_CONTAINER,
  R3_5_PG17_CERTIFICATION_IMAGE,
  R3_5_PG17_CERTIFICATION_IMAGE_ID,
  R3_5_PG17_CERTIFICATION_PACKAGE_HASHES,
  R3_5_PG17_CERTIFICATION_PHASE_AUTHORITY,
  R3_5_PG17_CERTIFICATION_PHASES,
} from '@/db/r3-5-pg17-certification-inputs'
import { R3_4_LOCAL_PHASES } from '@/db/r3-4-governed-runner'
import * as executor from '@/scripts/stella-r3-5-pg17-certify'

const ROOT = path.resolve(process.cwd())

const EXPECTED_HASHES = {
  'stella_0002_interactions_hardening.sql': 'bdf5f8dc925b3ed5643262f83efc52ea2d11233f5fae05f1e948b8cf424858cd',
  'stella_0002b_append_only_truncate_hardening.sql': '781e8b58fe2f512c4214016421199c853f9ed840fde0f27f701ddf247aace550',
  'stella_0001_role_topology_bootstrap.sql': '967a5dc8d5a35bf28a602346f6d69d63829210da5956ca4a993b00ccb4dbb32f',
  'stella_0003_suggestion_decisions.sql': 'b9857837a9b7b39e32e23ec4bcf9e1153eff397b6a1c031ba51e7a10476a8c0f',
  'stella_0004_role_separation.sql': 'e00987bf4620939af28d75e0aed0ee584430f602f7aaffdd33752c990da02aa1',
  'stella_0001_role_topology_bootstrap_rollback.sql': 'f2c3b59e2e37515ad85ee7f93f8ada8e34666a363c40746b2624a11f5ede7e9e',
  'stella_0004_rollback.sql': '22afa4cfddfe407abc6171b452659bf56d2a833663a818bfd55c6fab002f7cb6',
} as const

describe('MSC-07B R3.6 closed PG17 certification profile', () => {
  it('derives its fixed R8 prefix from the sole R3.4 package-order authority', () => {
    expect(R3_5_PG17_CERTIFICATION_PHASE_AUTHORITY).toBe(R3_4_LOCAL_PHASES)
    expect(R3_5_PG17_CERTIFICATION_PHASES).toEqual(
      R3_4_LOCAL_PHASES.slice(0, R3_4_LOCAL_PHASES.findIndex((phase) => phase.file === 'stella_0004_role_separation.sql') + 1),
    )
    expect(R3_5_PG17_CERTIFICATION_PHASES.map((phase) => [phase.file, phase.identity])).toEqual([
      ['stella_0002_interactions_hardening.sql', 'admin'],
      ['stella_0002b_append_only_truncate_hardening.sql', 'admin'],
      ['stella_0001_role_topology_bootstrap.sql', 'admin'],
      ['stella_0003_suggestion_decisions.sql', 'migrator'],
      ['stella_0004_role_separation.sql', 'admin'],
    ])
    expect(Object.isFrozen(R3_5_PG17_CERTIFICATION_PHASES)).toBe(true)
  })

  it('pins the image and every R8 package or rollback byte before Docker can be used', () => {
    expect(R3_5_PG17_CERTIFICATION_IMAGE).toBe('public.ecr.aws/supabase/postgres:17.6.1.143')
    expect(R3_5_PG17_CERTIFICATION_IMAGE_ID).toBe(
      'sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453',
    )
    expect(R3_5_PG17_CERTIFICATION_PACKAGE_HASHES).toEqual(EXPECTED_HASHES)

    const observed = collectR3_5Pg17CertificationSourceHashes()
    expect(observed).toEqual(EXPECTED_HASHES)
    expect(() => assertR3_5Pg17CertificationSourceHashes(observed)).not.toThrow()
    expect(() => assertR3_5Pg17CertificationSourceHashes({
      ...observed,
      'stella_0004_role_separation.sql': '0'.repeat(64),
    })).toThrow(/sha-?256 mismatch/i)
    expect(() => assertR3_5Pg17CertificationImageId('sha256:wrong')).toThrow(/image id mismatch/i)

    for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
      const actual = createHash('sha256')
        .update(readFileSync(path.join(ROOT, 'db', 'prepared', file)))
        .digest('hex')
      expect(actual, file).toBe(expected)
    }
  })

  it('rejects every caller attempt to select SQL, packages, Docker, or a database target', () => {
    expect(executor.parseR3_5Pg17CertificationArguments([])).toBeUndefined()

    const attacks = [
      ['--sql=SELECT 1'],
      ['--file=stella_0003_suggestion_decisions.sql'],
      ['--package=stella_0004_role_separation.sql'],
      ['--phase=decision-migrator'],
      ['--container=other-container'],
      ['--image=postgres:latest'],
      ['--database-url=postgresql://example.invalid/db'],
      ['--host=127.0.0.1'],
      ['--port=5432'],
      ['--network=bridge'],
      ['--publish=5432:5432'],
      ['--mount=type=bind,source=.,target=/repo'],
      ['--volume=/var/run/docker.sock:/var/run/docker.sock'],
      ['../db/prepared/stella_0003_suggestion_decisions.sql'],
    ]

    for (const args of attacks) {
      expect(() => executor.parseR3_5Pg17CertificationArguments(args), args.join(' ')).toThrow(/does not accept arguments/i)
    }
  })

  it('registers exactly one fixed, argument-free package command', () => {
    const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(packageJson.scripts['certify:stella:r3-5:pg17']).toBe('tsx scripts/stella-r3-5-pg17-certify.ts')
  })

  it('builds one fixed, network-isolated container plan with private container-local psql transport', () => {
    const plan = executor.describeR3_5Pg17CertificationPlan()
    const flattenedDocker = plan.docker.commands.flatMap((command) => command.args)

    expect(plan.container.name).toBe(R3_5_PG17_CERTIFICATION_CONTAINER)
    expect(plan.container.image).toBe(R3_5_PG17_CERTIFICATION_IMAGE)
    expect(plan.docker.commands.filter((command) => command.kind === 'create')).toHaveLength(1)
    expect(plan.docker.commands.find((command) => command.kind === 'create')?.args).toEqual(expect.arrayContaining([
      'run', '-d', '--name', R3_5_PG17_CERTIFICATION_CONTAINER, '--network', 'none', '--pull', 'never',
      R3_5_PG17_CERTIFICATION_IMAGE,
    ]))
    expect(plan.docker.commands.find((command) => command.kind === 'image-inspect')?.args).toEqual([
      'image', 'inspect', '--format', '{{.Id}}', R3_5_PG17_CERTIFICATION_IMAGE,
    ])
    expect(flattenedDocker).not.toContain('-p')
    expect(flattenedDocker).not.toContain('--publish')
    expect(flattenedDocker).not.toContain('--mount')
    expect(flattenedDocker).not.toContain('--volume')
    expect(flattenedDocker).not.toContain('-v')
    expect(flattenedDocker.join(' ')).not.toMatch(/docker\.sock|host\.docker\.internal|localhost|postgresql:\/\//i)
    expect(flattenedDocker).not.toContain('prune')
    expect(flattenedDocker).not.toContain('rmi')
    expect(plan.docker.commands.some((command) =>
      command.args[0] === 'image' && (command.args.includes('rm') || command.args.includes('prune')),
    )).toBe(false)
    expect(plan.docker.commands.filter((command) => command.kind === 'cleanup-remove')).toEqual([
      expect.objectContaining({ args: ['container', 'rm', '-f', R3_5_PG17_CERTIFICATION_CONTAINER] }),
    ])
    expect(plan.docker.commands.find((command) => command.kind === 'cleanup-owner-check')?.args).toEqual(expect.arrayContaining([
      'container', 'inspect', R3_5_PG17_CERTIFICATION_CONTAINER,
    ]))
    expect(plan.transport).toEqual({
      kind: 'private-container-local-psql',
      adminSession: 'postgres',
      migratorSession: 'uellix_migrator',
      migratorCurrentUser: 'uellix_owner',
      migratorRoleStatement: 'SET LOCAL ROLE uellix_owner;',
      transactionPerPhase: true,
      hostTcpFallback: false,
    })
    expect(plan.phaseTransactions).toEqual([
      ['stella_0002_interactions_hardening.sql', 'postgres', 'postgres', null],
      ['stella_0002b_append_only_truncate_hardening.sql', 'postgres', 'postgres', null],
      ['stella_0001_role_topology_bootstrap.sql', 'postgres', 'postgres', null],
      ['stella_0003_suggestion_decisions.sql', 'uellix_migrator', 'uellix_owner', 'SET LOCAL ROLE uellix_owner;'],
      ['stella_0004_role_separation.sql', 'postgres', 'postgres', null],
    ])
  })

  it('contains the whole fixed R8 matrix and exposes no generic Docker, psql, or file executor', () => {
    expect(executor.R3_5_PG17_CERTIFICATION_MATRIX_STEPS).toEqual([
      'pg17-supabase-surface',
      'storage-shim',
      'baseline-50',
      'stella-0001-topology',
      'stella-0003-migrator-owner',
      'stella-0004-separation',
      'exact-memberships-and-grantor',
      'set-and-admin-negative-attacks',
      'rls',
      'append-only',
      'idempotence',
      'atomicity',
      'stella-0004-rollback',
      'stella-0001-rollback',
      'cleanup',
    ])
    expect(Object.keys(executor).sort()).toEqual([
      'R3_5_PG17_CERTIFICATION_MATRIX_STEPS',
      'describeR3_5Pg17CertificationPlan',
      'parseR3_5Pg17CertificationArguments',
    ])
  })
})
