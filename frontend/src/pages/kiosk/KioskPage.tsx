import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { kioskApi, type KioskPractitioner } from '@/services/api';
import { KioskLayout } from './KioskLayout';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
      {/* Location toggle – subtle, works on gradient/grey */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex rounded-full bg-white/20 backdrop-blur-sm p-0.5 border border-white/30">
          <button
            type="button"
            onClick={() => navigate('/kiosk/pimlico')}
            className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
              location === 'Pimlico'
                ? 'bg-white/90 text-slate-800'
                : 'text-white/90 hover:text-white'
            }`}
          >
            Pimlico
          </button>
          <button
            type="button"
            onClick={() => navigate('/kiosk/kensington')}
            className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
              location === 'Kensington'
                ? 'bg-white/90 text-slate-800'
                : 'text-white/90 hover:text-white'
            }`}
          >
            Kensington
          </button>
        </div>
        <span className="text-xs text-white/80">
          Viewing {location}. Switch to {otherLocation}.
        </span>
      </div>

      {/* View mode toggle – subtle */}
      <div className="flex justify-center mb-6">
        <div className="inline-flex rounded-full bg-white/20 backdrop-blur-sm p-0.5 border border-white/30">
          <button
            type="button"
            onClick={() => setViewMode('signIn')}
            className={`px-4 py-2 text-sm font-medium rounded-full transition-colors ${
              viewMode === 'signIn'
                ? 'bg-white/90 text-slate-800'
                : 'text-white/90 hover:text-white'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => setViewMode('signedIn')}
            className={`px-4 py-2 text-sm font-medium rounded-full transition-colors ${
              viewMode === 'signedIn'
                ? 'bg-white/90 text-slate-800'
                : 'text-white/90 hover:text-white'
            }`}
          >
            Signed In Now
          </button>
        </div>
      </div>

      {loading && (
        <div className="py-12 text-center text-lg text-white/90">
          Loading therapists…
        </div>
      )}

      {!loading && error && (
        <div className="py-8 text-center space-y-4">
          <p className="text-white font-semibold drop-shadow-sm">{error}</p>
          <Button
            type="button"
            onClick={() => loadPractitioners()}
            className="bg-white/90 text-slate-800 hover:bg-white border-0"
          >
            <Icon name="refresh" size={18} className="mr-2" />
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-6 pb-4">
          {displayedPractitioners.length === 0 ? (
            <p className="col-span-full text-center text-white/90 text-base py-8">
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
                  className={`flex flex-col items-center gap-3 rounded-2xl p-4 transition-transform focus:outline-none focus:ring-2 focus:ring-white/50 ${
                    isSignedIn
                      ? 'ring-2 ring-white/60 bg-white/15'
                      : 'bg-white/10 hover:bg-white/20'
                  } ${isDisabled ? 'opacity-60 cursor-not-allowed' : 'hover:scale-[1.02]'}`}
                >
                  <div className="relative">
                    <Avatar className="h-24 w-24 sm:h-28 sm:w-28 border-2 border-white/50 shadow-lg ring-2 ring-white/20 rounded-full overflow-hidden">
                      <AvatarImage src={p.photoUrl} alt={fullName} />
                      <AvatarFallback className="bg-white/30 text-white text-xl font-bold">
                        {getInitials(p.firstName, p.lastName)}
                      </AvatarFallback>
                    </Avatar>
                    {isSignedIn && (
                      <span className="absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-white/90 text-slate-700 p-1 shadow">
                        <Icon name="check" size={14} />
                      </span>
                    )}
                    {p.isDummy && (
                      <span className="absolute -top-0.5 -left-0.5 inline-flex items-center justify-center rounded-full bg-white/90 text-slate-700 text-[10px] font-medium px-1.5 py-0.5">
                        Demo
                      </span>
                    )}
                  </div>
                  <span className="text-sm sm:text-base font-semibold text-white drop-shadow-sm text-center leading-tight">
                    {fullName}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </KioskLayout>
  );
}
