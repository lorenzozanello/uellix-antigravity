import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold mb-4">Welcome back</h2>
        <p className="text-zinc-600 mb-2">You are signed in as: <strong>{user.email}</strong></p>
        <p className="text-sm text-zinc-500">Your user ID is: {user.id}</p>
        <div className="mt-6 pt-6 border-t">
          <form action="/auth/signout" method="post">
            <button type="submit" className="text-sm font-medium text-red-600 hover:text-red-500">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
