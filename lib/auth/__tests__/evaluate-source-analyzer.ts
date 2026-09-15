/**
 * lib/auth/__tests__/evaluate-source-analyzer.ts
 *
 * Structural analyzer backing N-22 (EVALUATE_COMMERCIAL_V1_TEST_MANIFEST
 * v1.0.0.json) and the M-12 / M-13 / M-14 mutation controls.
 *
 * WHY A SOURCE ANALYZER AND NOT A ROLE FIXTURE
 * --------------------------------------------
 * Seven Evaluate authority concepts collapse into only THREE distinct role
 * extensions today. Substituting canDecideEvaluation for canArchiveEvaluation,
 * canDraftEvaluationTemplate or canCreateEvaluation produces IDENTICAL results
 * for all six roles, so every role-varying fixture stays green. 14 of the 42
 * ordered prohibition pairs are behaviourally undetectable. Detection requires
 * a structural control over declaration sites.
 *
 * The analyzer takes SOURCE TEXT rather than reading the file itself, so the
 * mutation controls can feed it a mutated copy and assert it turns RED without
 * ever writing a broken permissions.ts to disk.
 *
 * The whole file is treated as ONE string. A line-oriented grep is blind to a
 * multi-line function body and can report the expected number while matching a
 * comment.
 */

/** The seven Evaluate authority concepts: predicate <-> its own closed constant. */
export const EVALUATE_CONCEPTS = [
  {
    concept: 'criterion response edit authority',
    predicate: 'canEditEvaluationCriterionResponse',
    constant: 'EVALUATE_CRITERION_EDIT_ROLES',
  },
  {
    concept: 'template draft authority',
    predicate: 'canDraftEvaluationTemplate',
    constant: 'EVALUATE_TEMPLATE_DRAFT_ROLES',
  },
  {
    concept: 'template publish authority',
    predicate: 'canPublishEvaluateTemplateVersion',
    constant: 'EVALUATE_TEMPLATE_PUBLISH_ROLES',
  },
  {
    concept: 'template retire authority',
    predicate: 'canRetireEvaluateTemplate',
    constant: 'EVALUATE_TEMPLATE_RETIRE_ROLES',
  },
  {
    concept: 'evaluation decision authority',
    predicate: 'canDecideEvaluation',
    constant: 'EVALUATE_DECISION_ROLES',
  },
  {
    concept: 'archive authority',
    predicate: 'canArchiveEvaluation',
    constant: 'EVALUATE_ARCHIVE_ROLES',
  },
  {
    concept: 'evaluation create authority',
    predicate: 'canCreateEvaluation',
    constant: 'EVALUATE_CREATE_ROLES',
  },
] as const

/**
 * Ratified extension of each closed set, used by the behaviour matrix.
 * NEVER used for identity: extensional equality is not authority identity.
 */
export const EVALUATE_EXTENSIONS: Record<string, readonly string[]> = {
  EVALUATE_CRITERION_EDIT_ROLES: ['analyst', 'impact_manager', 'organization_admin'],
  EVALUATE_TEMPLATE_DRAFT_ROLES: ['impact_manager', 'organization_admin'],
  EVALUATE_TEMPLATE_PUBLISH_ROLES: ['organization_admin'],
  EVALUATE_TEMPLATE_RETIRE_ROLES: ['organization_admin'],
  EVALUATE_DECISION_ROLES: ['organization_admin', 'impact_manager'],
  EVALUATE_ARCHIVE_ROLES: ['impact_manager', 'organization_admin'],
  EVALUATE_CREATE_ROLES: ['organization_admin', 'impact_manager'],
}

export interface ProhibitionPair {
  subject: string
  subjectConstant: string
  otherPredicate: string
  otherConstant: string
}

/**
 * Constructs all 42 ordered pairs of distinct concepts. GENERATED, never
 * hand-listed: R3 of the authority carried a hand-written subset of five
 * prohibitions, which is exactly how the archive and create sharing survived
 * its own rule (independent audit CA-B-01).
 */
export function orderedProhibitionPairs(): ProhibitionPair[] {
  const pairs: ProhibitionPair[] = []
  for (const x of EVALUATE_CONCEPTS) {
    for (const y of EVALUATE_CONCEPTS) {
      if (x.predicate === y.predicate) continue
      pairs.push({
        subject: x.predicate,
        subjectConstant: x.constant,
        otherPredicate: y.predicate,
        otherConstant: y.constant,
      })
    }
  }
  return pairs
}

/** Escapes a literal for embedding in a RegExp. */
function lit(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches an identifier on word boundaries, so a longer name never counts. */
function word(name: string): RegExp {
  return new RegExp('\\b' + lit(name) + '\\b')
}

export interface ExtractedFunction {
  signature: string
  body: string
}

/**
 * Extracts a top-level exported function body by brace matching. Returns null
 * when the function is not declared at all — which the caller MUST treat as a
 * failure, never as "nothing to check". A checker that silently passes on a
 * missing subject is vacuous.
 */
export function extractFunction(source: string, name: string): ExtractedFunction | null {
  const decl = new RegExp('export\\s+function\\s+' + lit(name) + '\\s*\\(')
  const m = decl.exec(source)
  if (!m) return null
  const openIdx = source.indexOf('{', m.index)
  if (openIdx === -1) return null
  const signature = source.slice(m.index, openIdx)
  let depth = 0
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { signature, body: source.slice(openIdx + 1, i) }
    }
  }
  return null
}

export interface ExtractedConstant {
  declaration: string
  initializer: string
}

/** Extracts a `const NAME: readonly Role[] = [...]` initializer by bracket matching. */
export function extractConstant(source: string, name: string): ExtractedConstant | null {
  const decl = new RegExp('const\\s+' + lit(name) + '\\s*:\\s*readonly\\s+Role\\[\\]\\s*=')
  const m = decl.exec(source)
  if (!m) return null
  const openIdx = source.indexOf('[', source.indexOf('=', m.index))
  if (openIdx === -1) return null
  let depth = 0
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        return {
          declaration: source.slice(m.index, i + 1),
          initializer: source.slice(openIdx + 1, i),
        }
      }
    }
  }
  return null
}

/**
 * Strips comments, so a prohibited token discussed in PROSE is not counted as
 * a violation. The Evaluate block in permissions.ts deliberately NAMES hasRole
 * and isInReviewSet in its own commentary explaining why they are forbidden;
 * without this the analyzer would report those explanations as defects.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

export interface Finding {
  clause: string
  detail: string
}

/**
 * Runs N-22 clauses (1)-(5) over the given source text.
 *
 * Clause (6) — "each Evaluate server action calls the predicate matching its
 * own act" — is NOT evaluated here. No Evaluate server action exists yet
 * (W-EV-5). Asserting it now would be vacuously green over an empty set,
 * which is worse than not asserting it: it reports coverage that does not
 * exist. See evaluateServerActionSurface().
 */
export function analyzeEvaluateSource(source: string): Finding[] {
  const findings: Finding[] = []
  const code = stripComments(source)

  const bodies = new Map<string, string>()
  const signatures = new Map<string, string>()

  // Clause (1): each of the seven exists as its own named export.
  for (const c of EVALUATE_CONCEPTS) {
    const fn = extractFunction(code, c.predicate)
    if (!fn) {
      findings.push({
        clause: '1',
        detail: c.predicate + ' is not declared as a named export function',
      })
      continue
    }
    bodies.set(c.predicate, fn.body)
    signatures.set(c.predicate, fn.signature)
  }

  // Clause (2): each reads its OWN named closed constant.
  for (const c of EVALUATE_CONCEPTS) {
    const body = bodies.get(c.predicate)
    if (body === undefined) continue
    if (!word(c.constant).test(body)) {
      findings.push({
        clause: '2',
        detail: c.predicate + ' does not read its own constant ' + c.constant,
      })
    }
  }

  // Clause (3): 42 ordered pairs — no subject reads another concept's constant,
  // and no subject is an alias, re-export or delegation of another predicate.
  for (const p of orderedProhibitionPairs()) {
    const body = bodies.get(p.subject)
    if (body === undefined) continue
    if (word(p.otherConstant).test(body)) {
      findings.push({
        clause: '3',
        detail: p.subject + ' reads ' + p.otherConstant + ', the constant of ' + p.otherPredicate,
      })
    }
    if (word(p.otherPredicate).test(body)) {
      findings.push({
        clause: '3',
        detail: p.subject + ' delegates to ' + p.otherPredicate,
      })
    }
  }

  // Clause (4): no constant derived, spread or computed out of another.
  for (const c of EVALUATE_CONCEPTS) {
    const k = extractConstant(code, c.constant)
    if (!k) {
      findings.push({
        clause: '4',
        detail: c.constant + " is not declared as a literal 'readonly Role[]' array",
      })
      continue
    }
    if (k.initializer.includes('...')) {
      findings.push({ clause: '4', detail: c.constant + ' spreads another value' })
    }
    for (const other of EVALUATE_CONCEPTS) {
      if (other.constant === c.constant) continue
      if (word(other.constant).test(k.initializer)) {
        findings.push({
          clause: '4',
          detail: c.constant + ' is derived from ' + other.constant,
        })
      }
    }
    // Only role string literals and separators may appear in the initializer.
    const residue = k.initializer.replace(/'[a-z_]+'/g, '').replace(/[\s,]/g, '')
    if (residue.length > 0) {
      findings.push({
        clause: '4',
        detail: c.constant + ' initializer contains non-literal content: ' + residue,
      })
    }
  }

  // Clause (5): no hierarchy admission, no review/Stella-set derivation.
  const FORBIDDEN_TOKENS = [
    'hasRole',
    'ROLE_HIERARCHY',
    '>=',
    'isInReviewSet',
    'REVIEW_ROLES',
    'STELLA_ROLES',
  ]
  for (const c of EVALUATE_CONCEPTS) {
    const body = bodies.get(c.predicate)
    if (body === undefined) continue
    for (const token of FORBIDDEN_TOKENS) {
      if (body.includes(token)) {
        findings.push({
          clause: '5',
          detail: c.predicate + " uses forbidden '" + token + "'",
        })
      }
    }
    // A role-set parameter would reintroduce sharing through the call site.
    const sig = signatures.get(c.predicate) ?? ''
    if (/Role\s*\[\s*\]/.test(sig)) {
      findings.push({
        clause: '5',
        detail: c.predicate + ' accepts a role set as a parameter',
      })
    }
  }

  return findings
}

/**
 * Clause (6) surface. Returns whichever Evaluate server-action files exist.
 * While this is EMPTY, clause (6) is DEFERRED_TO_W_EV_5 — not PASS.
 */
export function evaluateServerActionSurface(trackedPaths: readonly string[]): readonly string[] {
  return trackedPaths.filter(
    (p) => /^app\/actions\/evaluate\//.test(p) || /^app\/.*\/evaluate\/.*\.actions?\.ts$/.test(p)
  )
}
