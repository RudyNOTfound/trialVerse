import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { trialsApi } from '@/api/trials';
import { InlineError } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useStaffDirectory } from '@/hooks/useStaffDirectory';
import type { TrialSite } from '@/types/api';

const schema = z.object({
  siteCode: z.string().trim().regex(/^[A-Za-z0-9-]{2,20}$/, '2–20 letters, digits or dashes'),
  name: z.string().trim().min(1, 'Required').max(160),
  city: z.string().max(80),
  country: z.string().trim().min(2, 'Required').max(80),
  status: z.enum(['active', 'inactive', 'closed']),
  principalInvestigatorId: z.string(),
});
type Values = z.infer<typeof schema>;
const EMPTY: Values = { siteCode: '', name: '', city: '', country: '', status: 'active', principalInvestigatorId: '' };

/** Create or edit a trial site. The principal-investigator picker needs the admin-only user list, so coordinators do not see it. */
export function SiteFormDialog({ trialId, open, onOpenChange, site }: { trialId: string; open: boolean; onOpenChange: (o: boolean) => void; site?: TrialSite }) {
  const qc = useQueryClient();
  const toast = useToast();
  const investigators = useStaffDirectory({ role: 'investigator', enabled: open });
  const [error, setError] = useState<unknown>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY });
  useEffect(() => {
    if (open) { setError(null); reset(site ? { siteCode: site.siteCode, name: site.name, city: site.city ?? '', country: site.country, status: site.status, principalInvestigatorId: site.principalInvestigatorId ?? '' } : EMPTY); }
  }, [open, site, reset]);

  const m = useMutation({
    mutationFn: (v: Values) => site
      ? trialsApi.updateSite(trialId, site.id, { name: v.name, city: v.city || undefined, country: v.country, status: v.status, principalInvestigatorId: v.principalInvestigatorId || null })
      : trialsApi.addSite(trialId, { siteCode: v.siteCode, name: v.name, city: v.city || undefined, country: v.country, ...(v.principalInvestigatorId ? { principalInvestigatorId: v.principalInvestigatorId } : {}) }),
    onSuccess: () => {
      toast.success(site ? 'Site updated' : 'Site added');
      for (const k of ['trial-sites', 'trial-site', 'directory']) qc.invalidateQueries({ queryKey: [k] });
      onOpenChange(false);
    },
    onError: setError,
  });
  const pi = investigators.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={site ? 'Edit site' : 'Add site'} description={site ? 'Setting the status to inactive or closed stops new enrollments at this site.' : undefined}>
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Site code" error={errors.siteCode?.message}><Input placeholder="CHI-01" disabled={!!site} {...register('siteCode')} /></Field>
            <Field label="Site name" error={errors.name?.message}><Input {...register('name')} /></Field>
            <Field label="City (optional)" error={errors.city?.message}><Input {...register('city')} /></Field>
            <Field label="Country" error={errors.country?.message}><Input {...register('country')} /></Field>
            {site && <Field label="Status" error={errors.status?.message}><Select {...register('status')}><option value="active">Active</option><option value="inactive">Inactive</option><option value="closed">Closed</option></Select></Field>}
          </div>
          <Field label="Principal investigator" hint="Must be an active investigator account.">
            <Select {...register('principalInvestigatorId')} disabled={investigators.isLoading}>
              <option value="">None assigned</option>
              {pi.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              {site?.principalInvestigatorId && !pi.some((u) => u.id === site.principalInvestigatorId) && <option value={site.principalInvestigatorId}>{site.principalInvestigatorName ?? 'Current investigator'} (inactive)</option>}
            </Select>
          </Field>
          <InlineError error={error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={m.isPending}>{site ? 'Save changes' : 'Add site'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
