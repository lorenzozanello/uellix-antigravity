// tests/golden/j1-customer.contract.journey.ts
//
// J1 contract suite. Intentionally thin.
//
// Every assertion this file makes lives in tests/golden/contract-suite.ts, and
// every step it covers is derived from the frozen authority rather than listed
// here. If this file grew a hand-written step list it would become possible
// for J1 to disagree with the authority while still passing, which is the
// exact condition the generator exists to prevent.

import { registerJourneyContractSuite } from './contract-suite'

registerJourneyContractSuite('J1')
