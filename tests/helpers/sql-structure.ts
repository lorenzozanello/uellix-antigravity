// tests/helpers/sql-structure.ts
//
// A structural reader for the DDL the capability packages are made of.
//
// It exists because existence regexes cannot express the properties the design
// claims. "There are nine cap_invitation_* policies and three say RESTRICTIVE"
// is true of the correct package AND of a package whose RESTRICTIVE policy now
// names uellix_app, or whose USING clause now reads `true`. The gate has to
// compare TUPLES, so something has to produce them.
//
// The hard part is not the grammar, it is knowing where the grammar applies.
// These files are ~40 % prose: the comment above cap_lead_deny_runtime
// describes the policy it precedes, postcondition messages quote the GRANT
// statements they verify, and stella_0009 builds an ALTER TABLE inside a string
// literal. Every one of those is a false positive for a naive scan. So the
// first pass masks comments and string literals, and every subsequent search
// runs over the mask while every extraction reads the original text.

export interface ParsedPolicy {
  readonly name: string
  readonly table: string
  readonly permissive: 'PERMISSIVE' | 'RESTRICTIVE'
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  /** Lowercased. EMPTY when the statement has no TO clause — which is TO PUBLIC. */
  readonly roles: readonly string[]
  readonly using: string | null
  readonly withCheck: string | null
  readonly raw: string
}

export interface ParsedPrivilege {
  readonly privilege: string
  /** null = table-wide. A list = column-scoped. */
  readonly columns: readonly string[] | null
}

export interface ParsedGrant {
  readonly privileges: readonly ParsedPrivilege[]
  /**
   * `ROLE` is a GRANT with no ON clause — `GRANT uellix_owner TO r`, i.e. role
   * MEMBERSHIP. The first version of this parser skipped those statements
   * entirely (`if (onAt === -1) continue`), which made the inbound direction of
   * a membership grant invisible: the gate looked for `GRANT <caprole> TO …`
   * and never for `GRANT <owner> TO <caprole>` — the one that gives a
   * capability role the table owner's privileges, and with them the
   * ownership-based RLS exemption.
   */
  readonly objectType: 'TABLE' | 'FUNCTION' | 'SCHEMA' | 'SEQUENCE' | 'ROLE' | 'UNKNOWN'
  readonly object: string
  /** Lowercased; `public` for PUBLIC. */
  readonly grantees: readonly string[]
  /** WITH GRANT OPTION: the grantee may re-grant. Part of the signature. */
  readonly grantOption: boolean
  /** WITH INHERIT TRUE / SET TRUE / ADMIN TRUE on a role membership. */
  readonly withClause: string
  readonly raw: string
}

/**
 * `sql` with every comment removed and every string literal intact.
 *
 * The one definition of "what is code" in this repository. Anything that judges
 * SQL text must go through here, or it judges prose as well.
 */
export function stripComments(sql: string): string {
  return mask(sql, false)
}

/** Collapse whitespace so reformatting is not a difference but a token is. */
export function normalizeExpr(expr: string): string {
  return expr.replace(/\s+/g, ' ').trim()
}

/**
 * A copy of `sql` in which every character belonging to a comment or to a
 * string literal is replaced by a placeholder, indices preserved.
 *
 * Comments become spaces (they are not code). String literals become \x01 when
 * `maskStrings` is set — they ARE part of the statement's extent, so a `;` or
 * `(` inside one must not terminate or unbalance it, but the statement still
 * runs through them.
 *
 * Two variants are needed, and the distinction is not cosmetic. Structure
 * (statement extents, paren depth) must be read with strings masked. Predicate
 * TEXT must be read with strings INTACT but comments still removed — otherwise
 * disclosures_update_admin's WITH CHECK comes back with the three-line comment
 * that sits inside its parentheses, and comparing it against the contract
 * compares prose.
 */
function mask(sql: string, maskStrings = true): string {
  const out = sql.split('')
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    // Dollar quoting, including a tagged form.
    //
    // ONLY in structure mode. When masking strings, a function body must be
    // opaque: its semicolons and parentheses belong to PL/pgSQL, not to the
    // enclosing statement, and one apostrophe inside a $body$ … $body$ block
    // would otherwise desynchronise the mask to end of file — after which every
    // statement is either invisible or mis-terminated, and the gates go QUIET
    // rather than red.
    //
    // In extraction mode the body must survive intact, because that is exactly
    // what the business-guard gates read. Comments inside it are still removed
    // by the ordinary rules below, which is the point: prose describing a rule
    // must never be mistaken for the rule.
    const dollar = maskStrings && c === '$' ? /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i)) : null
    if (dollar) {
      const tag = dollar[0]
      const close = sql.indexOf(tag, i + tag.length)
      const end = close === -1 ? n : close + tag.length
      // The delimiters stay visible so a function body is still locatable.
      for (let k = i + tag.length; k < Math.min(end - tag.length, n); k++) {
        if (sql[k] !== '\n') out[k] = '\x01'
      }
      i = end
      continue
    }
    if (c === 'E' && sql[i + 1] === "'") {
      // E'' strings honour backslash escapes, so \' does not close them.
      out[i] = maskStrings ? '\x01' : out[i]
      i++
      out[i] = maskStrings ? '\x01' : out[i]
      i++
      while (i < n) {
        if (sql[i] === '\\') {
          if (maskStrings) { out[i] = '\x01'; out[i + 1] = '\x01' }
          i += 2
          continue
        }
        const done = sql[i] === "'"
        if (maskStrings) out[i] = '\x01'
        i++
        if (done) break
      }
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') out[i++] = ' '
    } else if (c === '/' && sql[i + 1] === '*') {
      out[i++] = ' '
      out[i++] = ' '
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) out[i++] = ' '
      if (i < n) {
        out[i++] = ' '
        out[i++] = ' '
      }
    } else if (c === "'") {
      const put = (at: number) => {
        if (maskStrings) out[at] = '\x01'
      }
      put(i++)
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          put(i++)
          put(i++)
          continue
        }
        if (sql[i] === "'") {
          put(i++)
          break
        }
        put(i++)
      }
    } else {
      i++
    }
  }
  return out.join('')
}

/** Depth of every index within `text`, counting only unmasked parentheses. */
function depths(text: string): number[] {
  const d: number[] = new Array(text.length)
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(') {
      d[i] = depth
      depth++
    } else if (c === ')') {
      depth--
      d[i] = depth
    } else {
      d[i] = depth
    }
  }
  return d
}

/** The extent of the statement starting at `from`, up to its terminating `;`. */
function statementEnd(masked: string, from: number): number {
  let depth = 0
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ';' && depth === 0) return i
  }
  return masked.length
}

/** Every unmasked occurrence of `re` in `masked`, as [start, end] pairs. */
function occurrences(masked: string, re: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let m: RegExpExecArray | null
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  while ((m = rx.exec(masked)) !== null) out.push([m.index, m.index + m[0].length])
  return out
}

/** Balanced-paren body of the `(` at or after `open`, read from `raw`. */
function balanced(raw: string, masked: string, open: number): { body: string; end: number } {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++
    else if (masked[i] === ')') {
      depth--
      if (depth === 0) return { body: raw.slice(open + 1, i), end: i + 1 }
    }
  }
  return { body: raw.slice(open + 1), end: masked.length }
}

export function parsePolicies(sql: string): ParsedPolicy[] {
  const masked = mask(sql)
  const codeText = mask(sql, false)
  const out: ParsedPolicy[] = []

  for (const [start] of occurrences(masked, /\bCREATE\s+POLICY\b/gi)) {
    const end = statementEnd(masked, start)
    const raw = codeText.slice(start, end)
    const mRaw = masked.slice(start, end)
    const d = depths(mRaw)

    const nameM = /\bCREATE\s+POLICY\s+([A-Za-z_][\w$]*)/i.exec(mRaw)
    if (!nameM) continue
    const name = raw.slice(nameM.index, nameM.index + nameM[0].length).replace(/^\s*CREATE\s+POLICY\s+/i, '')

    const onM = /\bON\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/i.exec(mRaw.slice(nameM[0].length))
    const table = onM ? onM[1] : ''

    const asM = /\bAS\s+(PERMISSIVE|RESTRICTIVE)\b/i.exec(mRaw)
    const permissive = asM && /RESTRICTIVE/i.test(asM[1]) ? 'RESTRICTIVE' : 'PERMISSIVE'

    const forM = /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(mRaw)
    const command = (forM ? forM[1].toUpperCase() : 'ALL') as ParsedPolicy['command']

    // USING / WITH CHECK, at depth 0 only: `WITH CHECK (a AND (b))` must not be
    // found again inside a predicate that happens to contain the words.
    const clauseAt = (re: RegExp): { body: string; at: number } | null => {
      for (const [s, e] of occurrences(mRaw, re)) {
        if (d[s] !== 0) continue
        const open = mRaw.indexOf('(', e - 1)
        if (open === -1) continue
        return { body: normalizeExpr(balanced(raw, mRaw, open).body), at: s }
      }
      return null
    }
    const usingC = clauseAt(/\bUSING\s*\(/gi)
    const checkC = clauseAt(/\bWITH\s+CHECK\s*\(/gi)

    // TO, at depth 0, before the first predicate clause. A role list ends where
    // USING / WITH CHECK begins, or at the statement end.
    let roles: string[] = []
    const limit = Math.min(
      usingC ? usingC.at : mRaw.length,
      checkC ? checkC.at : mRaw.length,
    )
    for (const [s, e] of occurrences(mRaw, /\bTO\b/gi)) {
      if (d[s] !== 0 || s > limit) continue
      roles = raw
        .slice(e, limit)
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .filter((r) => r.length > 0 && /^[a-z_][\w$]*$/.test(r))
      break
    }

    out.push({
      name,
      table,
      permissive,
      command,
      roles,
      using: usingC ? usingC.body : null,
      withCheck: checkC ? checkC.body : null,
      raw: sql.slice(start, end),
    })
  }
  return out
}

function parsePrivilegeList(list: string): ParsedPrivilege[] {
  // Split on commas at DEPTH 0. This is the whole point: in
  // `INSERT (email, company_name), SELECT` the first two commas belong to the
  // column list and the third separates two privileges. A naive split on ','
  // reads it as four, and a `split(' ')[0]` reads it as one.
  const pieces: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      pieces.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  pieces.push(buf)
  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece) => {
      const m = /^([A-Za-z ]+?)\s*\(([\s\S]*)\)$/.exec(piece)
      if (m) {
        return {
          privilege: m[1].trim().toUpperCase(),
          columns: m[2].split(',').map((c) => c.trim()).filter((c) => c.length > 0),
        }
      }
      return { privilege: piece.toUpperCase(), columns: null }
    })
}

function parseAcl(sql: string, keyword: 'GRANT' | 'REVOKE'): ParsedGrant[] {
  const masked = mask(sql)
  const codeText = mask(sql, false)
  const out: ParsedGrant[] = []
  const tail = keyword === 'GRANT' ? /\bTO\b/gi : /\bFROM\b/gi

  for (const [start, kwEnd] of occurrences(masked, new RegExp(`\\b${keyword}\\b`, 'gi'))) {
    const end = statementEnd(masked, start)
    const raw = codeText.slice(start, end)
    const mRaw = masked.slice(start, end)
    const d = depths(mRaw)
    const offset = kwEnd - start

    // `ON` at depth 0 separates privileges from the object.
    let onAt = -1
    for (const [s] of occurrences(mRaw, /\bON\b/gi)) {
      if (d[s] === 0 && s > offset) {
        onAt = s
        break
      }
    }

    let tailAt = -1
    for (const [s] of occurrences(mRaw, tail)) {
      if (d[s] === 0 && s > Math.max(onAt, offset)) {
        tailAt = s
        break
      }
    }
    if (tailAt === -1) continue

    const grantOption = /\bWITH\s+GRANT\s+OPTION\b/i.test(raw)
    const withM = /\bWITH\b([\s\S]*)$/i.exec(raw.slice(tailAt))
    const withClause = withM ? normalizeExpr(withM[1]) : ''
    // Everything from WITH onward belongs to the option list, not the grantees.
    const granteeSlice = raw
      .slice(tailAt + (keyword === 'GRANT' ? 2 : 4))
      .replace(/\bWITH\b[\s\S]*$/i, '')

    // A GRANT with no ON is role MEMBERSHIP: `GRANT uellix_owner TO r`.
    if (onAt === -1) {
      const member = normalizeExpr(raw.slice(offset, tailAt))
      if (!/^[A-Za-z_][\w$]*$/.test(member)) continue
      out.push({
        privileges: [{ privilege: 'MEMBERSHIP', columns: null }],
        objectType: 'ROLE',
        object: member.toLowerCase(),
        grantees: granteeSlice
          .split(',')
          .map((g) => g.trim().toLowerCase())
          .filter((g) => /^[a-z_][\w$]*$/.test(g)),
        grantOption,
        withClause,
        raw: sql.slice(start, end),
      })
      continue
    }

    const privileges = parsePrivilegeList(raw.slice(offset, onAt))
    let objectPart = raw.slice(onAt + 2, tailAt).trim()

    let objectType: ParsedGrant['objectType'] = 'TABLE'
    const typeM = /^(TABLE|FUNCTION|ROUTINE|PROCEDURE|SCHEMA|SEQUENCE)\s+/i.exec(objectPart)
    if (typeM) {
      const kw = typeM[1].toUpperCase()
      objectType =
        kw === 'ROUTINE' || kw === 'PROCEDURE' ? 'FUNCTION' : (kw as ParsedGrant['objectType'])
      objectPart = objectPart.slice(typeM[0].length).trim()
    } else if (/^(ALL|DATABASE|LARGE)\b/i.test(objectPart)) {
      objectType = 'UNKNOWN'
    }
    // A function's argument list is part of its identity for the ACL but not
    // part of its name; keeping it out makes `object` comparable.
    const object = objectPart.replace(/\([\s\S]*$/, '').trim().replace(/\s+/g, ' ')

    const grantees = granteeSlice
      .replace(/\bCASCADE\b|\bRESTRICT\b/i, '')
      .split(',')
      .map((g) => g.trim().toLowerCase())
      .filter((g) => /^[a-z_][\w$]*$/.test(g))

    out.push({
      privileges,
      objectType,
      object,
      grantees,
      grantOption,
      withClause,
      raw: sql.slice(start, end),
    })
  }
  return out
}

export function parseGrants(sql: string): ParsedGrant[] {
  return parseAcl(sql, 'GRANT')
}

export function parseRevokes(sql: string): ParsedGrant[] {
  return parseAcl(sql, 'REVOKE')
}

/**
 * The CONTENTS of every `EXECUTE '<literal>'`, with '' unescaped.
 *
 * These packages all contain DO blocks that build DDL as a string — stella_0009
 * adds a CHECK constraint that way. A parser that masks string literals cannot
 * see any of it, so `EXECUTE 'GRANT SELECT ON public.marketing_leads TO
 * uellix_cap_lead'` is, to every structural gate, a statement that does not
 * exist. Returning the literals lets the gates re-scan them as SQL, which is
 * the only way the executed text is judged by the same rules as the written
 * text.
 */
export function executedLiterals(sql: string): string[] {
  const out: string[] = []
  const re = /\bEXECUTE\s+'/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    let i = m.index + m[0].length
    let buf = ''
    while (i < sql.length) {
      if (sql[i] === "'" && sql[i + 1] === "'") {
        buf += "'"
        i += 2
        continue
      }
      if (sql[i] === "'") break
      buf += sql[i++]
    }
    out.push(buf)
  }
  return out
}

/** `sql` with every executed literal appended as if it had been written out. */
export function withExecutedLiterals(sql: string): string {
  const extra = executedLiterals(sql)
  return extra.length === 0 ? sql : `${sql}\n${extra.map((s) => `${s};`).join('\n')}`
}

export interface ParsedOwnership {
  readonly objectType: string
  readonly object: string
  readonly owner: string
}

/** Every `ALTER <kind> <name> … OWNER TO <role>`. */
export function parseOwnerships(sql: string): ParsedOwnership[] {
  const masked = mask(sql)
  const codeText = mask(sql, false)
  const out: ParsedOwnership[] = []
  for (const [start] of occurrences(masked, /\bALTER\s+(TABLE|FUNCTION|SCHEMA|SEQUENCE|VIEW|TYPE|ROUTINE|PROCEDURE)\b/gi)) {
    const end = statementEnd(masked, start)
    const stmt = codeText.slice(start, end)
    const m = /\bALTER\s+(\w+)\s+(?:IF\s+EXISTS\s+)?([\w."]+)[\s\S]*?\bOWNER\s+TO\s+([\w"]+)/i.exec(stmt)
    if (m) out.push({ objectType: m[1].toUpperCase(), object: m[2], owner: m[3].toLowerCase() })
  }
  return out
}

export interface RlsToggle {
  readonly table: string
  readonly action: 'ENABLE' | 'DISABLE' | 'FORCE' | 'NO FORCE'
}

/** Every `ALTER TABLE <t> {ENABLE|DISABLE|FORCE|NO FORCE} ROW LEVEL SECURITY`. */
export function parseRlsToggles(sql: string): RlsToggle[] {
  const codeText = mask(sql, false)
  return [
    ...codeText.matchAll(
      /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w.]+)\s+(ENABLE|DISABLE|NO\s+FORCE|FORCE)\s+ROW\s+LEVEL\s+SECURITY/gi,
    ),
  ].map((m) => ({
    table: m[1],
    action: m[2].toUpperCase().replace(/\s+/, ' ') as RlsToggle['action'],
  }))
}

export interface ParsedIndex {
  readonly name: string
  readonly table: string
  readonly unique: boolean
}

/** Every `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table>`. */
export function parseIndexes(sql: string): ParsedIndex[] {
  const codeText = mask(sql, false)
  return [
    ...codeText.matchAll(
      /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)\s+ON\s+([\w.]+)/gi,
    ),
  ].map((m) => ({ name: m[2], table: m[3], unique: Boolean(m[1]) }))
}

/** Every privilege a grantee receives on an object, flattened. */
export function privilegesFor(
  grants: readonly ParsedGrant[],
  object: string,
  grantee: string,
): ParsedPrivilege[] {
  return grants
    .filter((g) => g.object === object && g.grantees.includes(grantee.toLowerCase()))
    .flatMap((g) => g.privileges as ParsedPrivilege[])
}
