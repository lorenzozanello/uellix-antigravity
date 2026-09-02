// scripts/blocked-command.ts
//
// Aborting alias for package scripts whose destination used to be decided by
// the ambient environment rather than by the command's name.
//
// `pnpm db:seed:proxies` and `pnpm db:migrate` did not say where they wrote.
// They resolved `DATABASE_URL`, so the same keystrokes seeded a laptop one
// day and a managed database the next. Deleting them outright would leave
// operators with a bare "command not found"; this alias fails loudly and
// names the replacement instead.
//
// Usage (from package.json):
//   tsx scripts/blocked-command.ts <blocked-name> <replacement-name> [reason]

const [blocked, replacement, reason] = process.argv.slice(2)

console.error('\n================================================================')
console.error(`BLOCKED COMMAND: pnpm ${blocked ?? '(unnamed)'}`)
console.error('================================================================')
console.error('')
console.error(
  reason ??
    'This command resolved its database target from DATABASE_URL, so its\n' +
      'destination depended on the ambient environment instead of on what the\n' +
      'command says it does. It has been replaced by an explicitly scoped one.'
)
console.error('')
if (replacement) {
  console.error(`Use instead:  pnpm ${replacement}`)
}
console.error('')
console.error('Remote operations are not performed by pnpm scripts. They go through')
console.error('the reviewed SQL packages in db/prepared/ and the gate checklists in')
console.error('docs/ops/gates/. See docs/ops/DATABASE_TARGET_SAFETY.md.')
console.error('================================================================\n')

process.exit(1)
