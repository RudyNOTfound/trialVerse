import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { homePathFor } from '@/utils/roles';

function Centered({ code, title, body }: { code: string; title: string; body: string }) {
  const { user } = useAuth();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
      <p className="text-sm font-semibold text-brand-600">{code}</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">{body}</p>
      <Button asChild className="mt-6"><Link to={user ? homePathFor(user.role) : '/login'}>{user ? 'Back to my workspace' : 'Go to sign in'}</Link></Button>
    </div>
  );
}
export const ForbiddenPage = () => <Centered code="403" title="Access restricted" body="Your role does not have access to this area. The server enforces permissions independently of what the interface shows." />;
export const NotFoundPage = () => <Centered code="404" title="Page not found" body="The page you are looking for does not exist." />;
