import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initializeRunManifest } from './artifacts'
import { checkpointState, readCheckpoint } from './checkpoint'
import { validateResumeManifest } from './resume'

describe('contextual real runner persistence', () => {
  it('initializes the run manifest once and never overwrites it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stella-runner-'))
    const manifest = { runId: 'run-1', status: 'INITIALIZED' }
    await initializeRunManifest(directory, manifest)
    await expect(initializeRunManifest(directory, { runId: 'run-2' })).rejects.toThrow()
    expect(JSON.parse(await readFile(join(directory, 'run-manifest.json'), 'utf8'))).toEqual(manifest)
    await rm(directory, { recursive: true, force: true })
  })

  it('writes checkpoint atomically and rejects a corrupt checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stella-runner-'))
    await checkpointState(directory, { status: 'RUNNING', providerCalls: 1, expectedCalls: 2 })
    expect(JSON.parse(await readFile(join(directory, 'run-state.json'), 'utf8'))).toMatchObject({ providerCalls: 1 })
    await writeFile(join(directory, 'run-state.json.tmp'), '{', 'utf8')
    await expect(readCheckpoint(join(directory, 'run-state.json.tmp'))).rejects.toThrow()
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ['head', { head: 'other' }], ['branch', { branch: 'other' }], ['model', { model: 'other' }], ['case ids', { caseIds: ['other'] }],
    ['scope', { scope: 'full' }], ['expected calls', { expectedCalls: 2 }], ['protocol', { schemaProtocol: 'other' }], ['completed', { status: 'COMPLETED_PENDING_HUMAN_REVIEW' }], ['calls exceeded', { providerCalls: 2, expectedCalls: 1 }],
  ])('rejects incompatible resume manifest: %s', (_name, patch) => {
    const manifest = { branch: 'branch', head: 'head', originMainSHA: 'base', providerMode: 'paid_gemini', model: 'gemini-2.5-flash', caseCatalogHash: 'hash', caseIds: ['case'], scope: 'canary', expectedCalls: 1, schemaProtocol: 'sourceRefIndexes', status: 'RUNNING', providerCalls: 0, ...patch }
    expect(() => validateResumeManifest(manifest, { branch: 'branch', head: 'head', originMainSHA: 'base', providerMode: 'paid_gemini', model: 'gemini-2.5-flash', caseCatalogHash: 'hash', caseIds: ['case'], scope: 'canary', expectedCalls: 1 })).toThrow()
  })
})
