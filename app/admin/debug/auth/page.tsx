import { createClient } from '@/lib/supabase/server'
import { db } from '@/db/client'
import { users, organizations, organizationMembers } from '@/db/schema'
import { eq } from 'drizzle-orm'

export default async function AuthDebugPage() {
  try {
    // Get Supabase auth user
    const supabase = await createClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()

    let dbUser = null
    let membership = null
    let org = null

    if (authUser) {
      // Check database user
      dbUser = await db.select().from(users)
        .where(eq(users.id, authUser.id))
        .limit(1)
        .then(rows => rows[0] ?? null)

      if (dbUser) {
        // Check membership
        const memberRow = await db.select().from(organizationMembers)
          .where(eq(organizationMembers.userId, authUser.id))
          .limit(1)
          .then(rows => rows[0] ?? null)

        if (memberRow) {
          membership = memberRow
          // Check organization
          org = await db.select().from(organizations)
            .where(eq(organizations.id, memberRow.organizationId))
            .limit(1)
            .then(rows => rows[0] ?? null)
        }
      }
    }

    return (
      <div className="max-w-2xl mx-auto p-8 space-y-6">
        <h1 className="text-2xl font-bold">Authentication Debug Info</h1>

        <div className="border rounded p-4">
          <h2 className="font-bold mb-2">Supabase Auth User</h2>
          {authUser ? (
            <pre className="bg-slate-100 p-2 text-sm overflow-auto">
              {JSON.stringify({ id: authUser.id, email: authUser.email }, null, 2)}
            </pre>
          ) : (
            <p className="text-red-600">❌ No authenticated user</p>
          )}
        </div>

        <div className="border rounded p-4">
          <h2 className="font-bold mb-2">Database User</h2>
          {dbUser ? (
            <pre className="bg-slate-100 p-2 text-sm overflow-auto">
              {JSON.stringify({ id: dbUser.id, email: dbUser.email, fullName: dbUser.fullName }, null, 2)}
            </pre>
          ) : (
            <p className="text-red-600">
              ❌ No matching user in database {authUser ? `(auth ID: ${authUser.id})` : ''}
            </p>
          )}
        </div>

        <div className="border rounded p-4">
          <h2 className="font-bold mb-2">Organization Membership</h2>
          {membership ? (
            <pre className="bg-slate-100 p-2 text-sm overflow-auto">
              {JSON.stringify({
                id: membership.id,
                organizationId: membership.organizationId,
                role: membership.role,
                status: membership.status
              }, null, 2)}
            </pre>
          ) : (
            <p className="text-red-600">
              ❌ No active membership found {dbUser ? `(user ID: ${dbUser.id})` : ''}
            </p>
          )}
        </div>

        <div className="border rounded p-4">
          <h2 className="font-bold mb-2">Organization</h2>
          {org ? (
            <pre className="bg-slate-100 p-2 text-sm overflow-auto">
              {JSON.stringify({ id: org.id, name: org.name, slug: org.slug }, null, 2)}
            </pre>
          ) : (
            <p className="text-red-600">
              ❌ No organization found {membership ? `(org ID: ${membership.organizationId})` : ''}
            </p>
          )}
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded p-4">
          <h3 className="font-bold mb-2">Troubleshooting Steps:</h3>
          <ol className="list-decimal list-inside space-y-1 text-sm">
            <li>If "No authenticated user" → User is not logged in</li>
            <li>If "No matching user in database" → syncUserProfile() didn't run or DB is empty</li>
            <li>If "No active membership" → User not added to organization_members</li>
            <li>If "No organization" → Organization record deleted or missing</li>
          </ol>
        </div>
      </div>
    )
  } catch (error) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-2xl font-bold text-red-600 mb-4">Error</h1>
        <pre className="bg-red-50 p-4 text-sm border border-red-200 rounded">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      </div>
    )
  }
}
