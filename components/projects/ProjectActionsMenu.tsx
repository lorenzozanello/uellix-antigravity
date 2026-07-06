'use client';

import { useState } from 'react';
import { MoreVertical, Pause, Play, Archive, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  pauseProjectAction,
  resumeProjectAction,
  archiveProjectAction,
  requestProjectDeletionAction,
  validateDeletionEligibilityAction,
} from '@/app/app/projects/projects.actions';
import { useToast } from '@/hooks/use-toast';

interface ProjectActionsMenuProps {
  projectId: string;
  projectName: string;
  status: string;
  userRole?: string;
}

export function ProjectActionsMenu({
  projectId,
  projectName,
  status,
  userRole = 'viewer',
}: ProjectActionsMenuProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [deletionBlocked, setDeletionBlocked] = useState<{
    blocked: boolean;
    reason?: string;
    details?: string[];
  } | null>(null);

  const canModify = ['super_admin', 'organization_admin', 'impact_manager'].includes(
    userRole,
  );
  const canRequestDelete = ['super_admin', 'organization_admin'].includes(userRole);

  const handlePause = async () => {
    try {
      setIsLoading(true);
      await pauseProjectAction(projectId);
      toast({
        title: 'Éxito',
        description: `"${projectName}" ha sido pausado.`,
      });
      setOpen(false);
      window.location.reload();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'No se pudo pausar el proyecto.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResume = async () => {
    try {
      setIsLoading(true);
      await resumeProjectAction(projectId);
      toast({
        title: 'Éxito',
        description: `"${projectName}" ha sido reactivado.`,
      });
      setOpen(false);
      window.location.reload();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'No se pudo reactivar el proyecto.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleArchive = async () => {
    try {
      setIsLoading(true);
      await archiveProjectAction(projectId);
      toast({
        title: 'Éxito',
        description: `"${projectName}" ha sido archivado.`,
      });
      setOpen(false);
      window.location.reload();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'No se pudo archivar el proyecto.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRequestDeletion = async () => {
    if (!deleteReason.trim()) {
      toast({
        title: 'Error',
        description: 'El motivo de eliminación es obligatorio.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setIsLoading(true);
      await requestProjectDeletionAction(projectId, deleteReason);
      toast({
        title: 'Solicitud enviada',
        description: `Se ha solicitado la eliminación de "${projectName}". Un SuperAdmin debe aprobarla.`,
      });
      setDeleteDialogOpen(false);
      setDeleteReason('');
      setOpen(false);
      window.location.reload();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'No se pudo solicitar la eliminación.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const checkDeletionEligibility = async () => {
    try {
      const result = await validateDeletionEligibilityAction(projectId);
      setDeletionBlocked(result);
      if (result.blocked) {
        toast({
          title: 'No se puede solicitar eliminación',
          description: `${result.details?.join(' ') || result.reason}`,
          variant: 'destructive',
        });
        return false;
      }
      return true;
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Error al validar elegibilidad.',
        variant: 'destructive',
      });
      return false;
    }
  };

  const onDeleteClick = async () => {
    const eligible = await checkDeletionEligibility();
    if (eligible) {
      setDeleteDialogOpen(true);
    }
  };

  if (!canModify) {
    return null;
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            aria-label={`Acciones del proyecto ${projectName}`}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {status === 'active' && (
            <DropdownMenuItem onClick={handlePause} disabled={isLoading}>
              <Pause className="mr-2 h-4 w-4" />
              Pausar proyecto
            </DropdownMenuItem>
          )}
          {status === 'paused' && (
            <DropdownMenuItem onClick={handleResume} disabled={isLoading}>
              <Play className="mr-2 h-4 w-4" />
              Reactivar proyecto
            </DropdownMenuItem>
          )}

          {status !== 'archived' && (
            <DropdownMenuItem onClick={handleArchive} disabled={isLoading}>
              <Archive className="mr-2 h-4 w-4" />
              Archivar proyecto
            </DropdownMenuItem>
          )}

          {canRequestDelete && status !== 'archived' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onDeleteClick}
                disabled={isLoading}
                className="text-red-600"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Solicitar eliminación
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Solicitar eliminación de proyecto</DialogTitle>
            <DialogDescription>
              Esta acción requiere aprobación de un SuperAdmin y no se puede deshacer.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-2">Proyecto: {projectName}</p>
              {deletionBlocked?.blocked && (
                <div className="bg-red-50 border border-red-200 rounded p-3 mb-4">
                  <p className="text-sm text-red-800 font-medium mb-1">
                    No se puede eliminar este proyecto:
                  </p>
                  <ul className="text-sm text-red-700 list-disc list-inside">
                    {deletionBlocked.details?.map((detail, i) => (
                      <li key={i}>{detail}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium">Motivo de eliminación *</label>
              <Textarea
                placeholder="Ej: Proyecto duplicado, creado por error, prueba interna..."
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                className="mt-1"
                disabled={isLoading}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={isLoading}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleRequestDeletion}
              disabled={isLoading || !deleteReason.trim() || deletionBlocked?.blocked}
            >
              {isLoading ? 'Enviando...' : 'Solicitar eliminación'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
