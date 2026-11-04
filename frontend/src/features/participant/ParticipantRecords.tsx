import { Card } from '@/components/ui/card';
import { ErrorState, Skeleton } from '@/components/common/States';
import { CapturePanel } from '@/features/capture/CapturePanel';
import { useMyPatient } from './hooks';

/** The participant's own measurements, reminders and ECG metadata, plus the form to report a symptom. Scoped server-side to the signed-in patient. */
export default function ParticipantRecords() {
  const patient = useMyPatient();
  if (patient.isLoading) return <Skeleton className="h-64 w-full" />;
  if (patient.error || !patient.data) return <Card><ErrorState error={patient.error} onRetry={() => patient.refetch()} /></Card>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Your records</h1>
      <CapturePanel patientId={patient.data.id} mode="participant" />
    </div>
  );
}
