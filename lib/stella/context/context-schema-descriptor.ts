// lib/stella/context/context-schema-descriptor.ts
// Etapa A1.5 (STL-A15-009) — deterministic control for context-schema
// version integrity. Before this file, CONTEXT_SCHEMA_VERSION (schema-version.ts)
// was a bare integer a developer had to remember to bump whenever
// StellaProjectContext's shape changed — nothing verified that the recorded
// version still matched the type's actual shape.
//
// CONTEXT_SCHEMA_DESCRIPTOR is a canonical, hand-written map of every
// top-level field to a short structural type label (never a value, never an
// ID, never narrative text — see the "no debe incluir" list in the task that
// created this file). It uses `satisfies Record<keyof StellaProjectContext, string>`
// so `pnpm typecheck` — not just developer memory — fails the moment a field
// is added, removed, or renamed on StellaProjectContext without this
// descriptor being updated to match. That is a stronger guarantee than the
// prompt-hash control (STL-A15-008) gets, because there is exactly one
// context shape to track (not six independent, more frequently-edited
// prompts), so the type system can enforce the coupling directly.
//
// computeContextSchemaHash() hashes the descriptor; CONTEXT_SCHEMA_HASH_BY_VERSION
// records the expected hash for the currently-registered CONTEXT_SCHEMA_VERSION.
// context-schema-descriptor.test.ts fails if the live hash no longer matches.

import { createHash } from 'crypto'
import { CONTEXT_SCHEMA_VERSION } from './schema-version'
import type { StellaProjectContext } from './types'

export const CONTEXT_SCHEMA_DESCRIPTOR = {
  projectId: 'string',
  organizationId: 'string',
  narrativeSummary: 'string',
  outcomesSnapshot: 'array<{id:string,name:string,description:string,stakeholderGroups?:string[]}>',
  indicatorsSnapshot: 'array<{id:string,outcomeId:string,name:string,unit:string,baseline?:string}>',
  stakeholderCount: 'number',
  evidenceMetadata:
    'array<{id:string,title:string,type:enum,status:enum,contentHashTruncated?:string,createdAt:string,outcomeId?:string,indicatorId?:string}>',
  evidenceTotal: 'number',
  proxySummary: 'array<{id:string,name:string,source:string,value:string,currency:string,confidenceLevel?:enum,methodologicalRisk?:enum}>',
  filterSetsSummary:
    'array<{assignmentId:string,deadweightPct?:number,attributionPct?:number,displacementPct?:number,dropoffPct?:number,durationYears?:number}>',
  calculationSnapshot:
    'nullable<{totalInvestment:number,grossSocialValue:number,netSocialValue:number,sroiRatio:number,currency:string,lineItemCount:number,version:number,fundersBreakdown?:array<{funderId:string,funderName:string,funderType:string,investmentUsd:number,attributedNsvUsd:number,sroiRatio:number}>,unattributedNsvUsd?:number}>',
  reportSections: 'array<{id:string,sectionType:string,title:string,contentLength:number,status:enum}>',
  readinessScore: 'optional<number>',
  projectCreatedAt: 'string',
  lastUpdatedAt: 'string',
} as const satisfies Record<keyof StellaProjectContext, string>

/** Live SHA-256 (hex) of the current structural descriptor. Contains no runtime values. */
export function computeContextSchemaHash(): string {
  return createHash('sha256').update(JSON.stringify(CONTEXT_SCHEMA_DESCRIPTOR)).digest('hex')
}

/**
 * One entry per CONTEXT_SCHEMA_VERSION ever registered — never overwritten,
 * only appended to, so a historical version's expected hash stays
 * reconstructable even after the descriptor changes for a newer version.
 * When you bump CONTEXT_SCHEMA_VERSION, add a new entry here; do not edit
 * an existing one.
 */
export const CONTEXT_SCHEMA_HASH_BY_VERSION: Readonly<Record<number, string>> = {
  1: 'e2fd3bef49e3f4f78e1e44457c6e62b9118965961e3fa9a3b52c0be95820959c',
}

/** Convenience accessor for the currently-registered schema version's expected hash. */
export function getExpectedContextSchemaHash(): string {
  const hash = CONTEXT_SCHEMA_HASH_BY_VERSION[CONTEXT_SCHEMA_VERSION]
  if (!hash) {
    throw new Error(
      `No expected hash registered for CONTEXT_SCHEMA_VERSION=${CONTEXT_SCHEMA_VERSION}. Add an entry to CONTEXT_SCHEMA_HASH_BY_VERSION.`,
    )
  }
  return hash
}
