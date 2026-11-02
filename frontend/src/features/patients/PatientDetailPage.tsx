import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Mail, Pencil, Phone, Trash2 } from 'lucide-react';
import { patientsApi } from '@/api/patients';
import { enrollmentsApi } from '@/api/trials';
import { visitsApi } from '@/api/visits';
import { reimbursementsApi } from '@/api/reimbursements';
import { PageHeader } from '@/components/common/PageHeader';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorState, Skeleton } from '@/components/common/States';
import { DataTable } from '@/components/tables/DataTable';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate, formatDateTime, formatMoney } from '@/utils/format';
import { DeletePatientDialog } from './DeletePatientDialog';
import { PatientFormDialog } from './PatientFormDialog';

export default function PatientDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { hasRole } = useAuth();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const patient = useQuery({ queryKey: ['patient', id], queryFn: () => patientsApi.get(id) });
  const enrollments = useQuery({ queryKey: ['enrollments', { patientId: id }], queryFn: () => enrollmentsApi.list({ patientId: id, pageSize: 50 }) });
  const visits = useQuery({ queryKey: ['visits', { patientId: id }], queryFn: () => visitsApi.list({ patientId: id, pageSize: 50, order: 'desc' }) });
  const reimbursements = useQuery({ queryKey: ['reimbursements', { patientId: id }], queryFn: () => reimbursementsApi.list({ patientId: id, pageSize: 50 }) });

  if (patient.isLoading) return <Skeleton className="h-64 w-full" />;
  if (patient.error || !patient.data) return <Card><ErrorState error={patient.error} onRetry={() => patient.refetch()} /></Card>;
  const p = patient.data;

  return (
    <>
      <Link to="/app/patients" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" />Patients</Link>
      <PageHeader title={`${p.firstName} ${p.lastName}`} description={`Subject ${p.subjectCode}`}
        actions={<>{<StatusBadge value={p.status} />}{hasRole('admin', 'coordinator') && <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" />Edit</Button>}{hasRole('admin') && <Button variant="danger-outline" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4" />Delete</Button>}</>} />
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-1"><CardHeader><CardTitle>Profile</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row k="Date of birth" v={formatDate(p.dateOfBirth)} /><Row k="Sex" v={<span className="capitalize">{p.sex}</span>} />
            <Row k="Email" v={p.email ? <span className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5 text-slate-400" />{p.email}</span> : '—'} />
            <Row k="Phone" v={p.phone ? <span className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 text-slate-400" />{p.phone}</span> : '—'} />
            <Row k="Portal account" v={p.userId ? (p.portalAccountName ?? 'Linked') : 'Not linked'} /><Row k="Registered" v={formatDate(p.createdAt)} />
          </CardContent></Card>
        <div className="space-y-4 md:col-span-2">
          <p className="text-sm font-semibold">Enrollments</p>
          <DataTable rows={enrollments.data?.items} rowKey={(e) => e.id} loading={enrollments.isLoading} error={enrollments.error} emptyTitle="Not enrolled in any trial"
            columns={[
              { header: 'Trial', cell: (e) => <Link className="font-medium text-brand-700 hover:underline" to={`/app/trials/${e.trialId}`}>{e.trialCode ?? '—'}</Link> },
              { header: 'Site', cell: (e) => e.siteName ?? '—', hideOnMobile: true },
              { header: 'Arm', cell: (e) => e.arm ?? '—', hideOnMobile: true },
              { header: 'Status', cell: (e) => <StatusBadge value={e.status} /> },
            ]} />
        </div>
      </div>
      <p className="mb-2 text-sm font-semibold">Visits</p>
      <DataTable rows={visits.data?.items} rowKey={(v) => v.id} loading={visits.isLoading} error={visits.error} emptyTitle="No visits scheduled" onRowClick={(v) => nav(`/app/visits/${v.id}`)}
        columns={[
          { header: 'Visit', cell: (v) => <span className="font-medium">{v.visitType}</span> },
          { header: 'Scheduled', cell: (v) => formatDateTime(v.scheduledAt) },
          { header: 'Verified', cell: (v) => formatDateTime(v.verifiedAt), hideOnMobile: true },
          { header: 'Status', cell: (v) => <StatusBadge value={v.status} /> },
        ]} />
      <p className="mb-2 mt-6 text-sm font-semibold">Reimbursements</p>
      <DataTable rows={reimbursements.data?.items} rowKey={(r) => r.id} loading={reimbursements.isLoading} error={reimbursements.error} emptyTitle="No reimbursement requests"
        columns={[
          { header: 'Category', cell: (r) => <span className="capitalize">{r.category}</span> },
          { header: 'Amount', cell: (r) => <span className="font-medium">{formatMoney(r.amountCents, r.currency)}</span> },
          { header: 'Submitted', cell: (r) => formatDate(r.createdAt), hideOnMobile: true },
          { header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
          { header: 'Payment', cell: (r) => <StatusBadge value={r.paymentStatus} />, hideOnMobile: true },
        ]} />
      <PatientFormDialog open={editing} onOpenChange={setEditing} patient={p} />
      <DeletePatientDialog patient={deleting ? p : null} onOpenChange={setDeleting} onDeleted={() => nav('/app/patients')} />
    </>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex items-center justify-between gap-4"><span className="text-muted">{k}</span><span className="text-right font-medium text-ink">{v}</span></div>;
