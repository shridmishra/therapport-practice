import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ThemeToggle } from '../../components/theme/ThemeToggle';
import { Icon } from '@/components/ui/Icon';
import { publicApi } from '@/services/api';
import axios from 'axios';
import { useEffect } from 'react';

const MEMBERSHIP_OPTIONS = [
  {
    type: 'permanent',
    marketing: false,
    contractType: 'standard',
    label: 'Permanent',
    description: 'Rent a regular slot each week.',
  },
  {
    type: 'permanent',
    marketing: true,
    contractType: 'standard',
    label: 'Permanent + Marketing',
    description: 'Rent a regular slot + advertising on website.',
  },
  {
    type: 'permanent',
    marketing: false,
    contractType: 'recurring',
    label: 'Recurring Slot',
    description: 'Reserve a fixed weekly room slot with a start date.',
  },
  {
    type: 'ad_hoc',
    marketing: false,
    contractType: 'standard',
    label: 'Ad Hoc',
    description: 'Book individual hours when available.',
  },
  {
    type: 'ad_hoc',
    marketing: true,
    contractType: 'standard',
    label: 'Ad Hoc + Marketing',
    description: 'Book individual hours + advertising on website.',
  },
] as const;

export const Signup: React.FC = () => {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
  });
  const [membershipType, setMembershipType] = useState<'permanent' | 'ad_hoc'>('permanent');
  const [marketingAddon, setMarketingAddon] = useState(false);
  const [contractType, setContractType] = useState<'standard' | 'recurring'>('standard');
  const [location, setLocation] = useState<'Pimlico' | 'Kensington'>('Pimlico');
  const [rooms, setRooms] = useState<Array<{ id: string; name: string; roomNumber: number }>>([]);
  const [recurringSlot, setRecurringSlot] = useState({
    startDate: '',
    practitionerName: '',
    weekday: 'monday' as 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday',
    roomId: '',
    timeBand: 'morning' as 'morning' | 'afternoon',
  });

  const [error, setError] = useState('');
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState('');
  const [loading, setLoading] = useState(false);
  const recurringStartMinDate = (() => {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  })();
  const { register } = useAuth();
  const navigate = useNavigate();

  // Update formData when membership selection changes
  const updateMembership = (
    type: 'permanent' | 'ad_hoc',
    marketing: boolean,
    selectedContractType: 'standard' | 'recurring'
  ) => {
    setMembershipType(type);
    setMarketingAddon(marketing);
    setContractType(selectedContractType);
  };

  useEffect(() => {
    if (contractType !== 'recurring') {
      setRooms([]);
      setRoomsLoading(false);
      setRoomsError('');
      setRecurringSlot((prev) => ({ ...prev, roomId: '' }));
      return;
    }
    const controller = new AbortController();
    setRecurringSlot((prev) => ({ ...prev, roomId: '' }));
    setRoomsError('');
    setRoomsLoading(true);
    (async () => {
      try {
        const response = await publicApi.getRooms(location, controller.signal);
        if (response.data.success && response.data.data) {
          const loadedRooms = response.data.data;
          setRooms(loadedRooms);
          setRecurringSlot((prev) =>
            loadedRooms.some((room) => room.id === prev.roomId) ? prev : { ...prev, roomId: '' }
          );
        }
      } catch (err) {
        if (axios.isCancel(err)) return;
        setRooms([]);
        setRecurringSlot((prev) => ({ ...prev, roomId: '' }));
        setRoomsError('Failed to load rooms. Please try again.');
      } finally {
        if (!controller.signal.aborted) {
          setRoomsLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [contractType, location]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await register({
        ...formData,
        membershipType,
        marketingAddon,
        recurringSlot:
          contractType === 'recurring'
            ? {
                ...recurringSlot,
                practitionerName: recurringSlot.practitionerName.trim(),
              }
            : undefined,
      });
      navigate(membershipType === 'ad_hoc' ? '/subscription' : '/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background-light dark:bg-background-dark flex items-center justify-center px-4 font-display py-8">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-2xl">
        <CardHeader className="space-y-1">
          <div className="flex items-center justify-center mb-4">
            <div className="bg-primary/10 p-3 rounded-xl">
              <Icon name="medical_services" className="text-primary text-3xl" />
            </div>
          </div>
          <CardTitle className="text-2xl font-black text-center">Create account</CardTitle>
          <CardDescription className="text-center">
            Sign up to start managing your practice
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg flex items-center gap-2">
              <Icon name="error" size={20} />
              <span className="text-sm font-medium">{error}</span>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name</Label>
                <div className="relative">
                  <Icon
                    name="person"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                    size={20}
                  />
                  <Input
                    id="firstName"
                    type="text"
                    placeholder="John"
                    value={formData.firstName}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setFormData({ ...formData, firstName: e.target.value })
                    }
                    className="pl-10"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name</Label>
                <div className="relative">
                  <Icon
                    name="person"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                    size={20}
                  />
                  <Input
                    id="lastName"
                    type="text"
                    placeholder="Doe"
                    value={formData.lastName}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setFormData({ ...formData, lastName: e.target.value })
                    }
                    className="pl-10"
                    required
                  />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Icon
                  name="mail"
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  size={20}
                />
                <Input
                  id="email"
                  type="email"
                  placeholder="john.doe@example.com"
                  value={formData.email}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  className="pl-10"
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Icon
                  name="lock"
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  size={20}
                />
                <Input
                  id="password"
                  type="password"
                  placeholder="At least 8 characters"
                  value={formData.password}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFormData({ ...formData, password: e.target.value })
                  }
                  className="pl-10"
                  required
                  minLength={8}
                />
              </div>
            </div>

            <div className="space-y-3">
              <Label>Select Membership Plan</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {MEMBERSHIP_OPTIONS.map((option) => (
                  <button
                    key={`${option.type}-${option.marketing}-${option.contractType}`}
                    type="button"
                    aria-pressed={
                      membershipType === option.type && marketingAddon === option.marketing
                      && contractType === option.contractType
                    }
                    className={`w-full text-left border rounded-xl p-4 cursor-pointer transition-all focus:outline-none focus:ring-2 focus:ring-primary ${
                      membershipType === option.type && marketingAddon === option.marketing
                      && contractType === option.contractType
                        ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                        : 'border-border hover:border-primary/50'
                    }`}
                    onClick={() =>
                      updateMembership(option.type, option.marketing, option.contractType)
                    }
                  >
                    <div className="font-bold text-lg mb-1">{option.label}</div>
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {option.description}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            {contractType === 'recurring' && (
              <div className="space-y-4 border rounded-lg p-4">
                <h3 className="font-semibold text-sm">Recurring Slot Details</h3>
                {roomsError && (
                  <p className="text-sm text-red-600 dark:text-red-400">{roomsError}</p>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="recurring-start-date">Starting Date</Label>
                    <Input
                      id="recurring-start-date"
                      type="date"
                      required
                      min={recurringStartMinDate}
                      value={recurringSlot.startDate}
                      onChange={(e) =>
                        setRecurringSlot((prev) => ({ ...prev, startDate: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recurring-practitioner-name">Permanent Practitioner Name</Label>
                    <Input
                      id="recurring-practitioner-name"
                      type="text"
                      required
                      value={recurringSlot.practitionerName}
                      onChange={(e) =>
                        setRecurringSlot((prev) => ({
                          ...prev,
                          practitionerName: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recurring-location">Location</Label>
                    <select
                      id="recurring-location"
                      className="w-full border rounded-md h-10 px-3 bg-transparent"
                      value={location}
                      onChange={(e) => setLocation(e.target.value as 'Pimlico' | 'Kensington')}
                    >
                      <option value="Pimlico">Pimlico</option>
                      <option value="Kensington">Kensington</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recurring-day">Day</Label>
                    <select
                      id="recurring-day"
                      className="w-full border rounded-md h-10 px-3 bg-transparent"
                      value={recurringSlot.weekday}
                      onChange={(e) =>
                        setRecurringSlot((prev) => ({
                          ...prev,
                          weekday: e.target.value as
                            | 'monday'
                            | 'tuesday'
                            | 'wednesday'
                            | 'thursday'
                            | 'friday',
                        }))
                      }
                    >
                      <option value="monday">Monday</option>
                      <option value="tuesday">Tuesday</option>
                      <option value="wednesday">Wednesday</option>
                      <option value="thursday">Thursday</option>
                      <option value="friday">Friday</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recurring-room">Room</Label>
                    <select
                      id="recurring-room"
                      className="w-full border rounded-md h-10 px-3 bg-transparent"
                      value={recurringSlot.roomId}
                      required
                      disabled={roomsLoading}
                      onChange={(e) =>
                        setRecurringSlot((prev) => ({ ...prev, roomId: e.target.value }))
                      }
                    >
                      <option value="">
                        {roomsLoading ? 'Loading rooms...' : 'Select room'}
                      </option>
                      {rooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recurring-slot">Slot</Label>
                    <select
                      id="recurring-slot"
                      className="w-full border rounded-md h-10 px-3 bg-transparent"
                      value={recurringSlot.timeBand}
                      onChange={(e) =>
                        setRecurringSlot((prev) => ({
                          ...prev,
                          timeBand: e.target.value as 'morning' | 'afternoon',
                        }))
                      }
                    >
                      <option value="morning">8am to 3pm</option>
                      <option value="afternoon">3pm to 10pm</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Creating account...' : 'Sign Up'}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-bold text-primary hover:text-blue-600 dark:hover:text-blue-400"
            >
              Login
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
};
