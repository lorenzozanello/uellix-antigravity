import type { Metadata } from 'next'
import Link from 'next/link'
import { requestPasswordReset } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Auth surface — noindex for the same reason as /login (see that file's note).
export const metadata: Metadata = {
  title: 'Recuperar contraseña',
  description: 'Restablecé el acceso a tu cuenta de Uellix.',
  robots: { index: false, follow: true },
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: 'Ingresa un correo electrónico válido.',
}

export default async function ForgotPasswordPage(props: {
  searchParams: Promise<{ error?: string; success?: string }>
}) {
  const searchParams = await props.searchParams
  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? 'Ocurrió un error.' : null
  const success = searchParams?.success === '1'

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-xl bg-card p-8 shadow-sm border border-border">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Recuperar contraseña</h2>
          <p className="text-sm text-muted-foreground">
            Ingresa tu correo y te enviaremos un enlace para restablecer tu contraseña.
          </p>
        </div>

        {success ? (
          <div className="space-y-4">
            <div className="text-sm text-center text-foreground">
              Si existe una cuenta con ese correo, recibirás un enlace para restablecer tu contraseña en unos
              minutos.
            </div>
            <Link
              href="/login"
              className="block text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Volver a iniciar sesión
            </Link>
          </div>
        ) : (
          <form action={requestPasswordReset} className="space-y-4">
            {errorMessage && <div className="text-sm text-danger text-center">{errorMessage}</div>}
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium leading-none text-foreground">
                Correo electrónico
              </Label>
              <Input id="email" name="email" type="email" required placeholder="nombre@empresa.com" />
            </div>
            <Button type="submit" className="w-full">
              Enviar enlace
            </Button>
            <Link
              href="/login"
              className="block text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Volver a iniciar sesión
            </Link>
          </form>
        )}
      </div>
    </div>
  )
}
