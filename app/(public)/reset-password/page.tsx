import type { Metadata } from 'next'
import { updatePassword } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Auth surface — noindex for the same reason as /login (see that file's note).
export const metadata: Metadata = {
  title: 'Nueva contraseña',
  description: 'Definí una nueva contraseña para tu cuenta de Uellix.',
  robots: { index: false, follow: true },
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_password: 'La contraseña debe tener al menos 6 caracteres.',
  password_mismatch: 'Las contraseñas no coinciden.',
  update_failed: 'No se pudo actualizar la contraseña. Solicita un nuevo enlace e intenta de nuevo.',
}

export default async function ResetPasswordPage(props: { searchParams: Promise<{ error?: string }> }) {
  const searchParams = await props.searchParams
  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? 'Ocurrió un error.' : null

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-xl bg-card p-8 shadow-sm border border-border">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Nueva contraseña</h2>
          <p className="text-sm text-muted-foreground">Ingresa tu nueva contraseña para tu cuenta.</p>
        </div>
        <form action={updatePassword} className="space-y-4">
          {errorMessage && <div className="text-sm text-danger text-center">{errorMessage}</div>}
          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm font-medium leading-none text-foreground">
              Nueva contraseña
            </Label>
            <Input id="password" name="password" type="password" required minLength={6} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword" className="text-sm font-medium leading-none text-foreground">
              Confirmar contraseña
            </Label>
            <Input id="confirmPassword" name="confirmPassword" type="password" required minLength={6} />
          </div>
          <Button type="submit" className="w-full">
            Guardar contraseña
          </Button>
        </form>
      </div>
    </div>
  )
}
