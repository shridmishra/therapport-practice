import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { kioskApi, type KioskPractitioner } from '@/services/api';
import { KioskLayout } from './KioskLayout';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/Icon';

type LocationName = 'Pimlico' | 'Kensington';

interface KioskPageProps {
  location: LocationName;
}

type ViewMode = 'signIn' | 'signedIn';

export function KioskPage({ location }: KioskPageProps) {
  const navigate = useNavigate();
  const [practitioners, setPractitioners] = useState<KioskPractitioner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('signIn');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const loadPractitioners = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError(null);
      const res = await kioskApi.getPractitioners(location, signal);
      if (res.data.success) {
        setPractitioners(res.data.data.practitioners);
      } else {
        setError('Failed to load practitioners');
      }
    } catch (err) {
      if (signal && signal.aborted) return;
      setError('Unable to load kiosk data. Please try again.');
    } finally {
      if (!signal || !signal.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    loadPractitioners(controller.signal);
    return () => controller.abort();
  }, [location]);

  const handleSignIn = async (userId: string, fullName: string) => {
    const confirmed = window.confirm(`Sign in ${fullName} at ${location}?`);
    if (!confirmed) return;
    setBusyUserId(userId);
    try {
      const res = await kioskApi.signIn(location, userId);
      if (res.data.success) {
        setPractitioners(res.data.data.practitioners);
        setViewMode('signedIn');
      }
    } catch {
      setError('Sign-in failed. Please try again.');
    } finally {
      setBusyUserId(null);
    }
  };

  const handleSignOut = async (userId: string, fullName: string, isDummy: boolean) => {
    if (isDummy) return;
    const confirmed = window.confirm(`Sign out ${fullName}?`);
    if (!confirmed) return;
    setBusyUserId(userId);
    try {
      const res = await kioskApi.signOut(location, userId);
      if (res.data.success) {
        setPractitioners(res.data.data.practitioners);
      }
    } catch {
      setError('Sign-out failed. Please try again.');
    } finally {
      setBusyUserId(null);
    }
  };

  const displayedPractitioners = useMemo(() => {
    if (viewMode === 'signedIn') {
      return practitioners.filter((p) => p.isSignedIn);
    }
    return practitioners;
  }, [viewMode, practitioners]);

  const handleHome = () => {
    setViewMode('signIn');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const getInitials = (firstName: string, lastName: string) => {
    const first = firstName?.charAt(0) || '';
    const last = lastName?.charAt(0) || '';
    return `${first}${last}`.toUpperCase() || 'U';
  };

  const otherLocation: LocationName = location === 'Pimlico' ? 'Kensington' : 'Pimlico';

  return (
    <KioskLayout
      locationName={location}
      onHome={handleHome}
    >
      {/* Location toggle (to switch between Pimlico and Kensington kiosks) */}
      <div className="flex justify-between items-center mb-4">
        <div className="inline-flex rounded-full bg-slate-200 p-1">
          <button
            type="button"
            onClick={() => navigate('/kiosk/pimlico')}
            className={`px-4 py-1 text-sm font-semibold rounded-full ${
              location === 'Pimlico'
                ? 'bg-white shadow text-slate-900'
                : 'text-slate-600'
            }`}
          >
            Pimlico
          </button>
          <button
            type="button"
            onClick={() => navigate('/kiosk/kensington')}
            className={`px-4 py-1 text-sm font-semibold rounded-full ${
              location === 'Kensington'
                ? 'bg-white shadow text-slate-900'
                : 'text-slate-600'
            }`}
          >
            Kensington
          </button>
        </div>
        <span className="text-xs sm:text-sm text-slate-500">
          You are viewing the {location} kiosk. Other location: {otherLocation}.
        </span>
      </div>

      {/* View mode toggle */}
      <div className="flex justify-center mb-4">
        <div className="inline-flex rounded-full bg-slate-200 p-1">
          <button
            type="button"
            onClick={() => setViewMode('signIn')}
            className={`px-4 py-1 text-sm font-semibold rounded-full ${
              viewMode === 'signIn'
                ? 'bg-white shadow text-slate-900'
                : 'text-slate-600'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => setViewMode('signedIn')}
            className={`px-4 py-1 text-sm font-semibold rounded-full ${
              viewMode === 'signedIn'
                ? 'bg-white shadow text-slate-900'
                : 'text-slate-600'
            }`}
          >
            Signed In Now
          </button>
        </div>
      </div>

      {loading && (
        <div className="py-10 text-center text-slate-500 text-lg">
          Loading therapists…
        </div>
      )}

      {!loading && error && (
        <div className="py-6 text-center space-y-3">
          <p className="text-red-600 text-base font-semibold">{error}</p>
          <Button type="button" onClick={() => loadPractitioners()}>
            <Icon name="refresh" size={18} className="mr-2" />
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 pb-24">
          {displayedPractitioners.length === 0 ? (
            <p className="col-span-full text-center text-slate-500 text-base">
              No therapists are currently signed in.
            </p>
          ) : (
            displayedPractitioners.map((p) => {
              const fullName = `${p.firstName} ${p.lastName}`.trim();
              const isSignedIn = p.isSignedIn;
              const isDisabled =
                (viewMode === 'signIn' && isSignedIn) ||
                (viewMode === 'signedIn' && !isSignedIn) ||
                busyUserId === p.id;

              const handleClick =
                viewMode === 'signedIn'
                  ? () => handleSignOut(p.id, fullName, p.isDummy)
                  : () => handleSignIn(p.id, fullName);

              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={isDisabled}
                  onClick={handleClick}
                  className={`flex flex-col items-center justify-between gap-2 rounded-2xl p-3 sm:p-4 shadow-md transition-transform ${
                    isSignedIn
                      ? 'bg-emerald-50 border-2 border-emerald-400'
                      : 'bg-white border border-slate-200'
                  } ${isDisabled ? 'opacity-60 cursor-not-allowed' : 'hover:scale-[1.02]'}`}
                >
                  <div className="relative">
                    <Avatar className="h-20 w-20 sm:h-24 sm:w-24 border-2 border-white shadow">
                      <AvatarImage src={p.photoUrl} alt={fullName} />
                      <AvatarFallback className="bg-slate-100 text-slate-700 text-xl font-bold">
                        {getInitials(p.firstName, p.lastName)}
                      </AvatarFallback>
                    </Avatar>
                    {isSignedIn && (
                      <span className="absolute -bottom-1 -right-1 inline-flex items-center justify-center rounded-full bg-emerald-500 text-white p-1 shadow">
                        <Icon name="check" size={16} />
                      </span>
                    )}
                    {p.isDummy && (
                      <span className="absolute -top-1 -left-1 inline-flex items-center justify-center rounded-full bg-slate-800 text-white text-[10px] px-1.5 py-0.5">
                        Dummy
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-sm sm:text-base font-semibold text-slate-900">
                      {fullName}
                    </span>
                    <Badge
                      variant={isSignedIn ? 'default' : 'outline'}
                      className={
                        isSignedIn
                          ? 'bg-emerald-500 text-white border-none'
                          : 'border-slate-300 text-slate-600'
                      }
                    >
                      {isSignedIn ? 'In' : 'Out'}
                    </Badge>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </KioskLayout>
  );
}

