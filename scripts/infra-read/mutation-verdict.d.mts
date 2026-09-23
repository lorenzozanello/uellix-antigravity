export type MutantVerdict = 'KILLED' | 'SURVIVED' | 'ERROR'
export type Expectation = 'KILLED' | 'SURVIVED'
export type Classification = 'AS_EXPECTED' | 'UNEXPECTED'
export interface Row { readonly classification: Classification }
export function verdictOf(status: number | null | undefined, output: string): MutantVerdict
export function classify(expect: string, verdict: string): Classification
export function aggregate(rows: readonly Row[]): { total: number; asExpected: number; unexpected: number; pass: boolean }
