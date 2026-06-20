import { login, signup } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default async function LoginPage(props: { searchParams: Promise<{ error?: string }> }) {
  const searchParams = await props.searchParams
  return (
    <div className="flex h-screen w-full items-center justify-center bg-zinc-50">
      <div className="w-full max-w-sm space-y-6 rounded-xl bg-white p-8 shadow-sm border border-zinc-200">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900">Uellix</h2>
          <p className="text-sm text-zinc-500">Sign in to your account</p>
        </div>
        <form className="space-y-4">
          {searchParams?.error && (
            <div className="text-sm text-red-500 text-center">
              Authentication failed. Please check your credentials.
            </div>
          )}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium leading-none text-zinc-700">Email address</Label>
              <Input id="email" name="email" type="email" required placeholder="name@company.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium leading-none text-zinc-700">Password</Label>
              <Input id="password" name="password" type="password" required />
            </div>
          </div>

          <div className="flex flex-col gap-3 pt-2">
            <Button formAction={login} className="w-full">
              Sign in
            </Button>
            <Button formAction={signup} variant="outline" className="w-full">
              Create account
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
