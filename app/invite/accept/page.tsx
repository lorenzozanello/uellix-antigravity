import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/session'
import { acceptInvitation } from '@/lib/invitations/service'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/states/ErrorState'

const LINK_BUTTON_CLASS =
  'inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors'

export default async function AcceptInvitationPage(props: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await props.searchParams

  if (!token) {
    return (
      <Shell>
        <ErrorState title="Invitación inválida" message="El enlace de invitación no incluye un token válido." />
      </Shell>
    )
  }

  const user = await getCurrentUser()

  if (!user) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Inicia sesión para continuar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Necesitas iniciar sesión con el correo al que se envió esta invitación antes de poder aceptarla.
              Después de iniciar sesión, regresa a este mismo enlace.
            </p>
            <Link
              href={`/login?redirect=${encodeURIComponent(`/invite/accept?token=${token}`)}`}
              className={LINK_BUTTON_CLASS}
            >
              Iniciar sesión
            </Link>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  try {
    await acceptInvitation(token)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudo aceptar la invitación.'
    return (
      <Shell>
        <ErrorState title="No se pudo aceptar la invitación" message={message} />
      </Shell>
    )
  }

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">¡Bienvenido a Uellix!</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Te has unido a la organización correctamente.
          </p>
          <Link href="/app/dashboard" className={LINK_BUTTON_CLASS}>
            Ir al dashboard
          </Link>
        </CardContent>
      </Card>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="w-full max-w-md space-y-6">{children}</div>
    </div>
  )
}
