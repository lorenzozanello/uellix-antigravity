import { login, signup } from './actions'
import { isSafeRedirectPath } from '@/lib/auth/safe-redirect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Ingresa un correo y una contraseña válidos (mínimo 6 caracteres).',
  auth_failed: 'No se pudo iniciar sesión. Verifica tu correo y contraseña.',
}

export default async function LoginPage(props: { searchParams: Promise<{ error?: string; redirect?: string }> }) {
  const searchParams = await props.searchParams
  const errorMessage = searchParams?.error
    ? ERROR_MESSAGES[searchParams.error] ?? 'Ocurrió un error. Intenta de nuevo.'
    : null
  const redirectTo = isSafeRedirectPath(searchParams?.redirect) ? searchParams.redirect : null

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-xl bg-card p-8 shadow-sm border border-border">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Uellix</h2>
          <p className="text-sm text-muted-foreground">Inicia sesión en tu cuenta</p>
        </div>
        <form className="space-y-4">
          {errorMessage && (
            <div className="text-sm text-danger text-center">
              {errorMessage}
            </div>
          )}
          {redirectTo && <input type="hidden" name="redirect" value={redirectTo} />}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium leading-none text-foreground">Correo electrónico</Label>
              <Input id="email" name="email" type="email" required placeholder="nombre@empresa.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium leading-none text-foreground">Contraseña</Label>
              <Input id="password" name="password" type="password" required />
            </div>
          </div>

          <div className="flex flex-col gap-3 pt-2">
            <Button type="submit" formAction={login} className="w-full">
              Iniciar sesión
            </Button>
            <Button type="submit" formAction={signup} variant="outline" className="w-full">
              Crear cuenta
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
