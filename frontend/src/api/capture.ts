import { get, getPage, patch, post } from './client';

/** Shapes mirror src/modules/capture/service.ts. Units are fixed by ML contract v1.1 and never converted. */
export interface Measurement { id: string; visitId: string; patientId: string; performedAt: string; enteredAt: string; systolicBp: number | null; diastolicBp: number | null; heartRate: number | null; weightKg: number | null; glucoseMgDl: number | null }
/** `fileRef` / `fileSha256` are omitted by the API for participants. */
export interface Ecg { id: string; visitId: string; patientId: string; recordedAt: string | null; createdAt: string; fileRef?: string; fileSha256?: string | null }
export type ReminderOutcome = 'sent' | 'acknowledged' | 'missed';
export const REMINDER_CHANNELS = ['sms', 'ivr', 'call', 'other'] as const;
export interface Reminder { id: string; enrollmentId: string; patientId: string; visitId: string | null; channel: string; sentAt: string; outcome: ReminderOutcome; acknowledgedAt: string | null; outcomeRecordedAt: string | null }
export interface AdverseEvent { id: string; enrollmentId: string; patientId: string; visitId: string | null; reportedAt: string; createdAt: string }

const q = { pageSize: 100 };
export const captureApi = {
  measurements: (patientId: string) => getPage<Measurement>(`/patients/${patientId}/measurements`, q),
  createMeasurement: (patientId: string, b: { visitId: string; performedAt: string; systolicBp?: number; diastolicBp?: number; heartRate?: number; weightKg?: number; glucoseMgDl?: number }) => post<Measurement>(`/patients/${patientId}/measurements`, b),
  ecgs: (patientId: string) => getPage<Ecg>(`/patients/${patientId}/ecgs`, q),
  createEcg: (patientId: string, b: { visitId: string; fileRef: string; fileSha256?: string; recordedAt?: string }) => post<Ecg>(`/patients/${patientId}/ecgs`, b),
  reminders: (patientId: string) => getPage<Reminder>(`/patients/${patientId}/reminders`, q),
  createReminder: (patientId: string, b: { enrollmentId?: string; visitId?: string; channel: (typeof REMINDER_CHANNELS)[number]; sentAt: string }) => post<Reminder>(`/patients/${patientId}/reminders`, b),
  resolveReminder: (id: string, b: { outcome: 'acknowledged' | 'missed'; acknowledgedAt?: string }) => patch<Reminder>(`/reminders/${id}`, b),
  adverseEvents: (patientId: string) => getPage<AdverseEvent>(`/patients/${patientId}/adverse-events`, q),
  reportAdverseEvent: (patientId: string, b: { enrollmentId?: string; visitId?: string; reportedAt?: string }) => post<AdverseEvent>(`/patients/${patientId}/adverse-events`, b),
  getReminder: (id: string) => get<Reminder>(`/reminders/${id}`),
};
