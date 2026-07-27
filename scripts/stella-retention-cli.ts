// scripts/stella-retention-cli.ts
// Etapa A2.4 (DR-004 aprobado) — local-only operator CLI for the Stella
// retention purge engine. Two pnpm entry points share this file:
//
//   pnpm stella:retention:preview --org <organizationId> --user <userId>
//   pnpm stella:retention:purge   --org <organizationId> --user <userId> [--apply] [--batch-size N]
//
// `preview` ALWAYS runs a dry-run (there is no --apply for it — see
// package.json). `purge` defaults to dry-run too; it only mutates data when
// --apply is passed explicitly. Both abort immediately if DATABASE_URL does
// not resolve to a loopback host (db/guard.ts) — this script must never run
// against a remote database, in this session or any other.
//
// Never prints: connection strings, secrets, or response_json content (the
// purge engine itself never reads that column's value — see
// lib/stella/retention/purge-service.ts's header — so there is nothing to
// print even if this script wanted to).

import * as dotenv from 'dotenv'
import path from 'path'
import { assertLocalDatabase } from '../db/guard'

// Same convention as scripts/seed-local.ts: load .env.local explicitly,
// never rely on a bare `import 'dotenv/config'` (which loads .env — the
// file db/guard.ts's header warns points at the remote project).
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

assertLocalDatabase({ context: 'scripts/stella-retention-cli.ts' })

async function main() {
  const { previewStellaRetentionPurge, executeStellaRetentionPurge } = await import('../lib/stella/retention/purge-service')

  const args = process.argv.slice(2)
  const mode = args[0] === 'purge' ? 'purge' : 'preview'

  function flag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`)
    return idx !== -1 ? args[idx + 1] : undefined
  }
  function hasFlag(name: string): boolean {
    return args.includes(`--${name}`)
  }

  const organizationId = flag('org')
  const userId = flag('user')
  const batchSizeRaw = flag('batch-size')
  const batchSize = batchSizeRaw ? Number(batchSizeRaw) : undefined
  const apply = mode === 'purge' && hasFlag('apply')

  if (!organizationId || !userId) {
    console.error('Uso:')
    console.error('  pnpm stella:retention:preview --org <organizationId> --user <userId>')
    console.error('  pnpm stella:retention:purge   --org <organizationId> --user <userId> [--apply] [--batch-size N]')
    process.exit(1)
  }

  // Operator context, not a real authenticated session: this CLI acts as if
  // the caller already holds organization_admin — the ONLY role the service
  // layer accepts for preview/apply (lib/stella/retention/purge-service.ts's
  // PURGE_ROLES). No session, no client-supplied role — deliberate, since a
  // local script has no HTTP request to resolve a session from.
  const actorRole = 'organization_admin'

  if (mode === 'preview' || !apply) {
    console.log(`[stella-retention] Ejecutando DRY-RUN para organización ${organizationId}${apply ? '' : ' (purge sin --apply se comporta igual que preview)'}...`)
    const result = await previewStellaRetentionPurge(organizationId, userId, actorRole, { batchSize })
    if (!result.ok) {
      console.error(`[stella-retention] Error: ${result.error}`)
      process.exit(1)
    }
    printSummary(result.run)
    if (mode === 'preview') {
      console.log('\nPara aplicar: pnpm stella:retention:purge --org <organizationId> --user <userId> --apply')
    }
    return
  }

  console.log(`[stella-retention] Ejecutando APPLY para organización ${organizationId} — esto redacta response_json de las interacciones elegibles.`)
  const idempotencyKey = `cli:${organizationId}:${Date.now()}`
  const previewResult = await previewStellaRetentionPurge(organizationId, userId, actorRole, { batchSize })
  if (!previewResult.ok) {
    console.error(`[stella-retention] Error en el dry-run previo: ${previewResult.error}`)
    process.exit(1)
  }
  const applyResult = await executeStellaRetentionPurge(organizationId, userId, actorRole, {
    previewRunId: previewResult.run.id,
    idempotencyKey,
    batchSize,
  })
  if (!applyResult.ok) {
    console.error(`[stella-retention] Error: ${applyResult.error}`)
    process.exit(1)
  }
  printSummary(applyResult.run)
}

function printSummary(run: { id: string; mode: string; status: string; policyVersion: string; cutoffAt: Date; recordsScanned: number; recordsEligible: number; recordsPurged: number; recordsSkippedHold: number; recordsFailed: number }) {
  console.log('')
  console.log(`  Run ID              : ${run.id}`)
  console.log(`  Modo                : ${run.mode}`)
  console.log(`  Estado              : ${run.status}`)
  console.log(`  Versión de política : ${run.policyVersion}`)
  console.log(`  Corte (cutoff)      : ${run.cutoffAt.toISOString()}`)
  console.log(`  Escaneadas          : ${run.recordsScanned}`)
  console.log(`  Elegibles           : ${run.recordsEligible}`)
  console.log(`  Purgadas            : ${run.recordsPurged}`)
  console.log(`  Bloqueadas por hold : ${run.recordsSkippedHold}`)
  console.log(`  Fallidas            : ${run.recordsFailed}`)
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[stella-retention] Error inesperado:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
