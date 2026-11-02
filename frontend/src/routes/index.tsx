import { Suspense, lazy } from 'react';
import { Navigate, createBrowserRouter } from 'react-router-dom';
import { Skeleton } from '@/components/common/States';
import LoginPage from '@/features/auth/LoginPage';
import RegisterPage from '@/features/auth/RegisterPage';
import OperationsLayout from '@/layouts/OperationsLayout';
import SponsorLayout from '@/layouts/SponsorLayout';
import ParticipantLayout from '@/layouts/ParticipantLayout';
import { ForbiddenPage, NotFoundPage } from '@/pages/Misc';
import { RedirectHome, RequireAuth } from './guards';
import { WORKSPACE_ROLES } from '@/utils/roles';


const OverviewPage = lazy(() => import('@/features/coordinator/OverviewPage'));
const PatientsPage = lazy(() => import('@/features/patients/PatientsPage'));
const PatientDetailPage = lazy(() => import('@/features/patients/PatientDetailPage'));
const TrialsPage = lazy(() => import('@/features/trials/TrialsPage'));
const TrialDetailPage = lazy(() => import('@/features/trials/TrialDetailPage'));
const EnrollmentsPage = lazy(() => import('@/features/trials/EnrollmentsPage'));
const VisitsPage = lazy(() => import('@/features/visits/VisitsPage'));
const VisitDetailPage = lazy(() => import('@/features/visits/VisitDetailPage'));
const ReimbursementsPage = lazy(() => import('@/features/reimbursements/ReimbursementsPage'));
const SiteDetailPage = lazy(() => import('@/features/trials/SiteDetailPage'));
const RulesPage = lazy(() => import('@/features/sponsor/RulesPage'));
const UsersPage = lazy(() => import('@/features/users/UsersPage'));
const ActionsPage = lazy(() => import('@/features/actions/ActionsPage'));
const SponsorOverview = lazy(() => import('@/features/sponsor/SponsorOverview'));
const RiskPage = lazy(() => import('@/features/sponsor/RiskPage'));
const IntegrityPage = lazy(() => import('@/features/sponsor/IntegrityPage'));
const AuditPage = lazy(() => import('@/features/sponsor/AuditPage'));
const ParticipantHome = lazy(() => import('@/features/participant/ParticipantHome'));
const ParticipantReimbursements = lazy(() => import('@/features/participant/ParticipantReimbursements'));
const ParticipantProfile = lazy(() => import('@/features/participant/ParticipantProfile'));
const ParticipantVisits = lazy(() => import('@/features/participant/ParticipantVisits').then((m) => ({ default: m.ParticipantVisits })));
const ParticipantVisitDetail = lazy(() => import('@/features/participant/ParticipantVisits').then((m) => ({ default: m.ParticipantVisitDetail })));

const S = ({ children }: { children: React.ReactNode }) => <Suspense fallback={<Skeleton className="h-64 w-full" />}>{children}</Suspense>;

export const router = createBrowserRouter([
  { path: '/', element: <RedirectHome /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forbidden', element: <ForbiddenPage /> },
  {
    element: <RequireAuth roles={WORKSPACE_ROLES.operations} />,
    children: [{
      path: '/app', element: <OperationsLayout />,
      children: [
        { index: true, element: <S><OverviewPage /></S> },
        { path: 'patients', element: <S><PatientsPage /></S> },
        { path: 'patients/:id', element: <S><PatientDetailPage /></S> },
        { path: 'trials', element: <S><TrialsPage /></S> },
        { path: 'trials/:id', element: <S><TrialDetailPage /></S> },
        { path: 'trials/:id/sites/:siteId', element: <S><SiteDetailPage /></S> },
        { path: 'enrollments', element: <S><EnrollmentsPage /></S> },
        { path: 'visits', element: <S><VisitsPage /></S> },
        { path: 'visits/:id', element: <S><VisitDetailPage /></S> },
        { path: 'reimbursements', element: <S><ReimbursementsPage /></S> },
        { path: 'actions', element: <S><ActionsPage /></S> },
        { path: '*', element: <Navigate to="/app" replace /> },
      ],
    }],
  },
  {
    element: <RequireAuth roles={['admin']} />,
    children: [{ path: '/app/users', element: <OperationsLayout />, children: [{ index: true, element: <S><UsersPage /></S> }] }],
  },
  {
    element: <RequireAuth roles={WORKSPACE_ROLES.sponsor} />,
    children: [{
      path: '/sponsor', element: <SponsorLayout />,
      children: [
        { index: true, element: <S><SponsorOverview /></S> },
        { path: 'trials', element: <S><TrialsPage base="/sponsor/trials" readOnly /></S> },
        { path: 'trials/:id', element: <S><TrialDetailPage backTo="/sponsor/trials" readOnly /></S> },
        { path: 'trials/:id/sites/:siteId', element: <S><SiteDetailPage base="/sponsor/trials" readOnly /></S> },
        { path: 'risk', element: <S><RiskPage /></S> },
        { path: 'integrity', element: <S><IntegrityPage /></S> },
        { path: 'audit', element: <S><AuditPage /></S> },
        { path: 'rules', element: <S><RulesPage /></S> },
        { path: '*', element: <Navigate to="/sponsor" replace /> },
      ],
    }],
  },
  {
    element: <RequireAuth roles={WORKSPACE_ROLES.participant} />,
    children: [{
      path: '/me', element: <ParticipantLayout />,
      children: [
        { index: true, element: <S><ParticipantHome /></S> },
        { path: 'visits', element: <S><ParticipantVisits /></S> },
        { path: 'visits/:id', element: <S><ParticipantVisitDetail /></S> },
        { path: 'reimbursements', element: <S><ParticipantReimbursements /></S> },
        { path: 'profile', element: <S><ParticipantProfile /></S> },
        { path: '*', element: <Navigate to="/me" replace /> },
      ],
    }],
  },
  { path: '*', element: <NotFoundPage /> },
]);
