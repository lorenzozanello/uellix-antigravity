import { requireOrganizationAccess } from '@/lib/auth/session'
import { canInviteUsers, canManageUsers } from '@/lib/auth/permissions'
import { ROLES, ROLE_LABELS } from '@/lib/auth/roles'
import { listMembersForCurrentOrganization } from '@/lib/organizations/members'
import { listInvitationsForCurrentOrganization } from '@/lib/invitations/service'
import { inviteMemberAction, revokeInvitationAction, removeMemberAction } from './actions'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { ErrorState } from '@/components/states/ErrorState'
import { EmptyState } from '@/components/states/EmptyState'
import { Users } from 'lucide-react'

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: 'Completa todos los campos requeridos.',
  no_permission: 'No tienes permisos para realizar esta acción.',
  invalid_role: 'No se puede invitar a alguien como super administrador.',
  duplicate_pending: 'Ya existe una invitación pendiente para ese correo.',
  cannot_remove_self: 'No puedes eliminarte a ti mismo de la organización.',
  unknown_error: 'Ocurrió un error. Intenta de nuevo.',
}

const SUCCESS_MESSAGES: Record<string, string> = {
  invited: 'Invitación enviada correctamente.',
  revoked: 'Invitación revocada.',
  removed: 'Miembro eliminado de la organización.',
}

const INVITABLE_ROLES = [
  ROLES.ORGANIZATION_ADMIN,
  ROLES.IMPACT_MANAGER,
  ROLES.ANALYST,
  ROLES.REVIEWER,
  ROLES.VIEWER,
]

export default async function MembersPage(props: {
  searchParams: Promise<{ error?: string; success?: string }>
}) {
  const ctx = await requireOrganizationAccess()
  const searchParams = await props.searchParams

  const [members, invitations] = await Promise.all([
    listMembersForCurrentOrganization(),
    listInvitationsForCurrentOrganization(),
  ])

  const pendingInvitations = invitations.filter((inv) => inv.status === 'pending')
  const canInvite = canInviteUsers(ctx.membership.role)
  const canManage = canManageUsers(ctx.membership.role)

  const errorMessage = searchParams?.error ? ERROR_MESSAGES[searchParams.error] ?? ERROR_MESSAGES.unknown_error : null
  const successMessage = searchParams?.success ? SUCCESS_MESSAGES[searchParams.success] : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Miembros</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {members.length} miembro{members.length !== 1 ? 's' : ''} en {ctx.organization.name}
        </p>
      </div>

      {errorMessage && <ErrorState title="No se pudo completar la acción" message={errorMessage} />}
      {successMessage && (
        <div role="status" aria-live="polite" className="rounded-lg border border-success/20 bg-success-light p-4 text-sm text-success">
          {successMessage}
        </div>
      )}

      {canInvite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Invitar miembro</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={inviteMemberAction} className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px_auto] sm:items-end">
              <div>
                <Label htmlFor="email">Correo electrónico</Label>
                <Input id="email" name="email" type="email" required placeholder="persona@organizacion.org" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="role">Rol</Label>
                <Select id="role" name="role" required defaultValue={ROLES.VIEWER} className="mt-1.5">
                  {INVITABLE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" id="btn-invite-member">
                Enviar invitación
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Miembros activos</CardTitle>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <EmptyState icon={<Users className="h-6 w-6 text-neutral-500" />} title="Sin miembros" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Correo</TableHead>
                  <TableHead>Rol</TableHead>
                  {canManage && <TableHead className="text-right">Acciones</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>{member.fullName ?? '—'}</TableCell>
                    <TableCell>{member.email}</TableCell>
                    <TableCell>
                      <Badge variant="neutral">{ROLE_LABELS[member.role as keyof typeof ROLE_LABELS] ?? member.role}</Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        {member.userId !== ctx.user.id && (
                          <form action={removeMemberAction}>
                            <input type="hidden" name="membershipId" value={member.id} />
                            <button type="submit" className="text-sm text-danger hover:underline">
                              Eliminar
                            </button>
                          </form>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canInvite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Invitaciones pendientes</CardTitle>
          </CardHeader>
          <CardContent>
            {pendingInvitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay invitaciones pendientes.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Correo</TableHead>
                    <TableHead>Rol</TableHead>
                    <TableHead>Expira</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingInvitations.map((invitation) => (
                    <TableRow key={invitation.id}>
                      <TableCell>{invitation.email}</TableCell>
                      <TableCell>
                        <Badge variant="neutral">
                          {ROLE_LABELS[invitation.role as keyof typeof ROLE_LABELS] ?? invitation.role}
                        </Badge>
                      </TableCell>
                      <TableCell>{new Date(invitation.expiresAt).toLocaleDateString('es-MX')}</TableCell>
                      <TableCell className="text-right">
                        <form action={revokeInvitationAction}>
                          <input type="hidden" name="invitationId" value={invitation.id} />
                          <button type="submit" className="text-sm text-danger hover:underline">
                            Revocar
                          </button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
