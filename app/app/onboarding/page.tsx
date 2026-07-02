import { requireAuth } from '@/lib/auth/session'
import { getCurrentMembership } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import { createFirstOrganization } from './actions'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/states/ErrorState'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_name: 'El nombre de la organización debe tener al menos 2 caracteres.',
  invalid_slug: 'El identificador solo puede contener minúsculas, números y guiones.',
  slug_taken: 'Ese identificador ya está en uso. Prueba con otro.',
}

export default async function OnboardingPage(props: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireAuth()

  // Si el usuario ya tiene una organización, redirigir al dashboard
  const membership = await getCurrentMembership(user.id)
  if (membership) {
    redirect('/app/dashboard')
  }

  const searchParams = await props.searchParams
  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? 'Ocurrió un error. Intenta de nuevo.' : null

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Bienvenido a Uellix
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Crea tu organización para comenzar a medir impacto social.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Crear organización</CardTitle>
          </CardHeader>
          <CardContent>
            {errorMessage && (
              <ErrorState title="No se pudo crear la organización" message={errorMessage} className="mb-5" />
            )}

            <form action={createFirstOrganization} className="space-y-5">
              <div>
                <Label htmlFor="name">
                  Nombre de la organización <span className="text-danger">*</span>
                </Label>
                <Input
                  id="name"
                  name="name"
                  type="text"
                  required
                  maxLength={255}
                  placeholder="Ej: Fundación Impacto Positivo"
                  className="mt-1.5"
                />
              </div>

              <div>
                <Label htmlFor="slug">
                  Identificador único (slug) <span className="text-danger">*</span>
                </Label>
                <Input
                  id="slug"
                  name="slug"
                  type="text"
                  required
                  maxLength={255}
                  pattern="[a-z0-9-]+"
                  placeholder="Ej: fundacion-impacto"
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-muted-foreground">Solo minúsculas, números y guiones.</p>
              </div>

              <div>
                <Label htmlFor="legalName">Razón social (opcional)</Label>
                <Input
                  id="legalName"
                  name="legalName"
                  type="text"
                  maxLength={255}
                  placeholder="Ej: Fundación Impacto Positivo A.C."
                  className="mt-1.5"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="country">País (código ISO)</Label>
                  <Input
                    id="country"
                    name="country"
                    type="text"
                    maxLength={2}
                    placeholder="MX"
                    className="mt-1.5 uppercase"
                  />
                </div>

                <div>
                  <Label htmlFor="sector">Sector</Label>
                  <Select id="sector" name="sector" className="mt-1.5">
                    <option value="">Seleccionar</option>
                    <option value="educacion">Educación</option>
                    <option value="salud">Salud</option>
                    <option value="medio_ambiente">Medio Ambiente</option>
                    <option value="inclusion_social">Inclusión Social</option>
                    <option value="desarrollo_economico">Desarrollo Económico</option>
                    <option value="otro">Otro</option>
                  </Select>
                </div>
              </div>

              <Button type="submit" id="btn-create-organization" className="w-full">
                Crear organización
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
