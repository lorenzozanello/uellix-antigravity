import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * Admin endpoint to manage test users
 *
 * POST /api/admin/create-test-user
 * Body: { email: string, password: string }
 *
 * Creates a new user or resets password if user exists.
 * No email confirmation required.
 *
 * ⚠️ Requires SUPABASE_SERVICE_ROLE_KEY in env
 */
export async function POST(request: Request) {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Missing email or password' },
        { status: 400 }
      )
    }

    // Use service role key (admin)
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // First try to find existing user
    const { data: { users } } = await adminClient.auth.admin.listUsers()
    const existingUser = users?.find(u => u.email === email)

    if (existingUser) {
      // Reset password for existing user
      const { data, error } = await adminClient.auth.admin.updateUserById(
        existingUser.id,
        { password }
      )

      if (error) {
        return NextResponse.json(
          { error: error.message },
          { status: 400 }
        )
      }

      return NextResponse.json({
        success: true,
        action: 'password_reset',
        user: {
          id: data.user?.id,
          email: data.user?.email,
          message: `Password reset for existing user. Can login immediately.`,
        },
      })
    } else {
      // Create new user without email confirmation
      const { data, error } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // Skip email confirmation
      })

      if (error) {
        return NextResponse.json(
          { error: error.message },
          { status: 400 }
        )
      }

      return NextResponse.json({
        success: true,
        action: 'user_created',
        user: {
          id: data.user?.id,
          email: data.user?.email,
          message: `User created. Email confirmation skipped. Can login immediately.`,
        },
      })
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
