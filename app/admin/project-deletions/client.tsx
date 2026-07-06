'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Trash2, AlertTriangle } from 'lucide-react';
import { approveProjectDeletionAction } from '@/app/app/projects/projects.actions';
import { useToast } from '@/hooks/use-toast';

interface DeletionRequest {
  id: string;
  name: string;
  organizationId: string;
  deletionRequestedAt: Date | null;
  deletionRequestedBy: string;
  deletionReason: string | null;
}

export default function ProjectDeletionClient({ initialRequests }: { initialRequests: DeletionRequest[] }) {
  const { toast } = useToast();
  const [requests, setRequests] = useState<DeletionRequest[]>(initialRequests);
  const [selectedRequest, setSelectedRequest] = useState<DeletionRequest | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [isApproving, setIsApproving] = useState(false);

  const handleApprove = async () => {
    if (!selectedRequest) return;
    if (confirmText !== 'ELIMINAR') {
      toast({
        title: 'Error',
        description: 'Debes escribir "ELIMINAR" para confirmar.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setIsApproving(true);
      await approveProjectDeletionAction(
        selectedRequest.id,
        confirmText,
        `Aprobado por SuperAdmin. Motivo original: ${selectedRequest.deletionReason}`,
      );
      toast({
        title: 'Éxito',
        description: `El proyecto "${selectedRequest.name}" ha sido eliminado.`,
      });
      setApproveDialogOpen(false);
      setConfirmText('');
      setRequests((prev) => prev.filter((r) => r.id !== selectedRequest.id));
      setSelectedRequest(null);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'No se pudo aprobar la eliminación.',
        variant: 'destructive',
      });
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <>
      <div className="grid gap-4">
        {requests.map((request) => (
          <Card key={request.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-lg">{request.name}</CardTitle>
                  <CardDescription>
                    Solicitado:{' '}
                    {request.deletionRequestedAt
                      ? new Date(request.deletionRequestedAt).toLocaleString('es-MX')
                      : 'Desconocido'}
                  </CardDescription>
                </div>
                <Badge variant="danger" className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Pendiente
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {request.deletionReason && (
                <div>
                  <p className="text-sm font-medium mb-1">Motivo:</p>
                  <p className="text-sm text-muted-foreground bg-muted p-2 rounded">
                    {request.deletionReason}
                  </p>
                </div>
              )}
              <Button
                variant="destructive"
                onClick={() => {
                  setSelectedRequest(request);
                  setApproveDialogOpen(true);
                }}
                className="w-full"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Aprobar eliminación
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar eliminación permanente</DialogTitle>
            <DialogDescription>
              Esta acción es irreversible. El proyecto será marcado como eliminado en la auditoría.
            </DialogDescription>
          </DialogHeader>

          {selectedRequest && (
            <div className="space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="font-medium text-red-900">Proyecto a eliminar:</p>
                <p className="text-red-800 font-bold mt-1">{selectedRequest.name}</p>
              </div>

              <div>
                <label className="text-sm font-medium">
                  Escribe <code className="bg-muted px-1 py-0.5 rounded">ELIMINAR</code> para confirmar
                </label>
                <Input
                  placeholder="ELIMINAR"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
                  className="mt-1"
                  disabled={isApproving}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApproveDialogOpen(false);
                setConfirmText('');
              }}
              disabled={isApproving}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleApprove}
              disabled={isApproving || confirmText !== 'ELIMINAR'}
            >
              {isApproving ? 'Eliminando...' : 'Eliminar permanentemente'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
