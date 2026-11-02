import { useQueryClient } from '@tanstack/react-query';
import { patientsApi } from '@/api/patients';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useToast } from '@/components/ui/toast';
import type { Patient } from '@/types/api';

/** Soft delete (admin). The backend returns 409 when the patient has enrollments; the message is shown in the dialog. */
export function DeletePatientDialog({ patient, onOpenChange, onDeleted }: { patient: Patient | null; onOpenChange: (o: boolean) => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <ConfirmDialog open={!!patient} onOpenChange={onOpenChange} title={`Delete ${patient ? `${patient.firstName} ${patient.lastName}` : 'patient'}?`}
      description="The patient is removed from lists and search. Clinical records are retained. Patients with enrollments cannot be deleted; set them to withdrawn instead."
      confirmLabel="Delete patient"
      onConfirm={async () => {
        await patientsApi.remove(patient!.id);
        toast.success('Patient deleted');
        for (const k of ['patients', 'directory', 'patient']) qc.invalidateQueries({ queryKey: [k] });
        onDeleted?.();
      }} />
  );
}
