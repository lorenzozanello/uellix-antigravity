import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(process.cwd())

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8')
}

describe('R3.5 stella_0004 rollback invocation contract', () => {
  const rollback = () => read('db/prepared/stella_0004_rollback.sql')
  const roleModel = () => read('docs/ops/DATABASE_ROLE_MODEL.md')

  it('consumes exactly the two transaction-local rollback GUC inputs', () => {
    const inputs = [...rollback().matchAll(/current_setting\('([^']+)'/g)].map((match) => match[1]).sort()

    expect(inputs).toEqual([
      'uellix.rollback_confirmation',
      'uellix.rollback_restore_unsafe_defaults',
    ])
  })

  it('requires a governed local administrative wrapper to set the actual GUC inputs in its transaction', () => {
    const sql = rollback()
    const docs = roleModel()

    for (const source of [sql, docs]) {
      expect(source).toMatch(/governed local administrative (?:recovery )?wrapper/i)
      expect(source).toMatch(/set_config\('uellix\.rollback_confirmation'/i)
      expect(source).toMatch(/set_config\('uellix\.rollback_restore_unsafe_defaults'/i)
      expect(source).toMatch(/true\)/)
    }
  })

  it('removes stale psql variables and never authorizes generic psql for the rollback', () => {
    const sql = rollback()
    const docs = roleModel()

    for (const source of [sql, docs]) {
      expect(source).not.toMatch(/-v\s+uellix_rollback_(?:confirmation|restore_unsafe_defaults)/i)
      expect(source).toMatch(/generic psql.*not authori[sz]ed|does not authori[sz]e generic psql/i)
    }
  })

  it('fails closed when an approved recovery wrapper has not been provided', () => {
    for (const source of [rollback(), roleModel()]) {
      expect(source).toMatch(
        /(?:does not provide[\s\S]{0,50}authori[sz]e|no proporciona[\s\S]{0,50}autoriza) (?:a |un )?rollback runner/i,
      )
    }
  })
})
