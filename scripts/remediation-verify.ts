// scripts/remediation-verify.ts
// COMMIT 5.3 — the offline gate for the prechain remediation delivery path.
//
// Everything `pnpm certify:remediation` depends on that can be checked without
// Docker, checked in the order a failure is cheapest to act on. It computes and
// it writes nothing; it touches no database and reads no environment variable.
//
// The division of labour matters: `certify:remediation` needs a 1.7 GB image
// and several minutes, and a CI that does not have those must still be stopped
// from shipping a harness that would certify the wrong bytes, inject at a
// relocated anchor, or provision a staging shape that is already remediated.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import {
  PRECHAIN_REMEDIATION,
  PRECHAIN_GRANTS,
  sha256OfPreparedSql,
} from '../db/hosted/prechain-remediation'
import {
  OLD_BOOTSTRAP_ID,
  OLD_BOOTSTRAP_SECOND_PASS,
  SELECTABLE_REMEDIATION_PACKAGES,
  verifyRemediationPin,
} from '../db/hosted/remediation-attempt'
import {
  REMEDIATION_FAILURE_INJECTIONS,
  REMEDIATION_ROLLBACK_BOUNDARIES,
} from '../db/hosted/authority/certification/remediation-failure-injection'
import { injectFailure } from '../db/hosted/authority/certification/failure-injection'
import {
  assertStagingShapeIsUnremediated,
  resolveStagingShapeBootstrap,
} from '../db/hosted/authority/certification/staging-shape'
import {
  bodyDigest,
  extractDollarQuotedBody,
} from '../db/hosted/authority/certification/remediation-probes'
import { WITNESSED_PACKAGES } from '../db/hosted/package-witnesses'
import { CHAIN_PACKAGE_FILES } from '../db/hosted/authority/window-plan'

const ROOT = path.resolve(import.meta.dirname, '..')

const checks: { name: string; detail: string }[] = []
const failures: { name: string; detail: string }[] = []

function check(name: string, run: () => string): void {
  try {
    checks.push({ name, detail: run() })
  } catch (error) {
    failures.push({ name, detail: error instanceof Error ? error.message : String(error) })
  }
}

const SQL = readFileSync(path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile), 'utf8')

check('package pin', () => {
  const digest = verifyRemediationPin(SQL)
  return `${PRECHAIN_REMEDIATION.sourceFile} = ${digest}`
})

check('forward-only: no rollback script exists', () => {
  const rollback = path.join(ROOT, 'db/prepared/stella_hosted_0002_rollback.sql')
  if (existsSync(rollback)) {
    throw new Error(
      `${rollback} exists. This package is FORWARD-ONLY by decision — undoing a committed ` +
        `authority reconciliation is correct only under assumptions about what happened since — ` +
        `and a rollback script here would be a script whose correctness nobody measured.`,
    )
  }
  return 'absent, as the registry declares'
})

check('the remediation is not a chain package', () => {
  if (WITNESSED_PACKAGES.includes(PRECHAIN_REMEDIATION.id)) {
    throw new Error(`${PRECHAIN_REMEDIATION.id} is in WITNESSED_PACKAGES; it would appear in nextChainPackage.`)
  }
  if (CHAIN_PACKAGE_FILES.some((e) => e.sourceFile === `${PRECHAIN_REMEDIATION.id}.sql`)) {
    throw new Error(`${PRECHAIN_REMEDIATION.id} is in CHAIN_PACKAGE_FILES.`)
  }
  return `absent from the ${WITNESSED_PACKAGES.length} witnessed packages and the ${CHAIN_PACKAGE_FILES.length} chain files`
})

check('the old bootstrap is not selectable', () => {
  if (SELECTABLE_REMEDIATION_PACKAGES.includes(OLD_BOOTSTRAP_ID)) {
    throw new Error(`${OLD_BOOTSTRAP_ID} is selectable. Its second pass is ${OLD_BOOTSTRAP_SECOND_PASS}.`)
  }
  return `selectable set = [${SELECTABLE_REMEDIATION_PACKAGES.join(', ')}]; 0001 second pass ${OLD_BOOTSTRAP_SECOND_PASS}`
})

check('the certified bodies are byte-equal to the bootstrap', () => {
  const bootstrap = readFileSync(
    path.join(ROOT, 'db/prepared/stella_hosted_0001_managed_role_bootstrap.sql'),
    'utf8',
  )
  const headers = [
    'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(p_package text)',
    'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_capability_membership_topology(',
  ]
  for (const header of headers) {
    const a = bodyDigest(extractDollarQuotedBody(SQL, header))
    const b = bodyDigest(extractDollarQuotedBody(bootstrap, header))
    if (a !== b) {
      throw new Error(
        `${header} differs between stella_hosted_0002 and stella_hosted_0001 (${a} vs ${b}). A ` +
          `fresh provision and a remediated project would then run different contracts.`,
      )
    }
  }
  return `${headers.length} bodies identical`
})

check('the witness measures a body the package actually writes', () => {
  const digest = bodyDigest(
    extractDollarQuotedBody(
      SQL,
      'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(p_package text)',
    ),
  )
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`derived a malformed digest: ${digest}`)
  return `certified body sha256 = ${digest}`
})

check('R1..R9 anchors resolve, at nine distinct positions', () => {
  if (REMEDIATION_FAILURE_INJECTIONS.length !== 9) {
    throw new Error(`${REMEDIATION_FAILURE_INJECTIONS.length} rollback points; the contract is nine.`)
  }
  const positions = new Set<number>()
  for (const injection of REMEDIATION_FAILURE_INJECTIONS) {
    const mutated = injectFailure(SQL, injection) // refuses if the anchor moved
    const at = mutated.split('\n').findIndex((l) => l.includes(`UELLIX_CERT_INJECTED_FAILURE ${injection.id}`))
    if (at === -1) throw new Error(`${injection.id}: the injected raise is not in the output.`)
    if (positions.has(at)) {
      throw new Error(
        `${injection.id} lands at the same line as an earlier point. Nine ids at eight positions ` +
          `is eight measurements reported as nine.`,
      )
    }
    positions.add(at)
  }
  return `${REMEDIATION_ROLLBACK_BOUNDARIES.join(', ')} at ${positions.size} distinct lines`
})

check('the grant inventory and the SQL agree', () => {
  for (const grant of PRECHAIN_GRANTS) {
    const bare = grant.object.replace(/\(\)$/, '')
    if (!SQL.includes(bare)) {
      throw new Error(`${grant.object} is in PRECHAIN_GRANTS and does not occur in the package.`)
    }
  }
  return `${PRECHAIN_GRANTS.length} grants, every object present in the SQL`
})

check('the staging shape resolves and is UNREMEDIATED', () => {
  const historical = resolveStagingShapeBootstrap(ROOT)
  assertStagingShapeIsUnremediated(historical.sql)
  return `blob ${historical.blob} (${historical.path} @ ${historical.sourceCommit}) sha256 ${historical.sha256}`
})

check('the LF normalization the pin assumes is idempotent', () => {
  if (sha256OfPreparedSql('a;\r\nb;\r\n') !== sha256OfPreparedSql('a;\nb;\n')) {
    throw new Error('the digest is line-ending sensitive; a CRLF checkout would fail the pin.')
  }
  return 'CRLF and LF hash identically'
})

for (const c of checks) console.log(`  PASS  ${c.name} — ${c.detail}`)
for (const f of failures) console.log(`  FAIL  ${f.name}\n        ${f.detail}`)
console.log('')
console.log(
  failures.length === 0
    ? `REMEDIATION_VERIFY = PASS (${checks.length} checks)`
    : `REMEDIATION_VERIFY = FAIL (${failures.length} of ${checks.length + failures.length} checks)`,
)
process.exit(failures.length === 0 ? 0 : 1)
