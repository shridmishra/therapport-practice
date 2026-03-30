// User types
export type UserRole = 'practitioner' | 'admin';
export type UserStatus = 'pending' | 'active' | 'suspended' | 'rejected';

export interface NextOfKin {
  name: string;
  relationship: string;
  phone: string;
  email?: string;
}

export interface PractitionerDocument {
  id: string;
  documentType: 'insurance' | 'clinical_registration' | 'reference';
  fileName: string;
  fileUrl: string;
  expiryDate: string | null;
  createdAt: string;
}

export interface PractitionerMembership {
  id?: string;
  type: 'permanent' | 'ad_hoc';
  marketingAddon: boolean;
  contractType?: 'standard' | 'recurring';
  recurringStartDate?: string | null;
  recurringPractitionerName?: string | null;
  recurringWeekday?: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | null;
  recurringRoomId?: string | null;
  recurringTimeBand?: 'morning' | 'afternoon' | null;
  recurringTerminationDate?: string | null;
}

export interface ClinicalExecutor {
  id: string;
  name: string;
  email: string;
  phone: string;
}

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  photoUrl?: string;
  role: UserRole;
  status: UserStatus;
  nextOfKin?: NextOfKin; // Note: This might need to match backend response exactly, usually it's null or object
  emailVerifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  membership?: PractitionerMembership;
}

// Auth types
export interface RegisterRequest {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  membershipType: 'permanent' | 'ad_hoc';
  marketingAddon: boolean;
  recurringSlot?: {
    startDate: string;
    practitionerName: string;
    weekday: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';
    roomId: string;
    timeBand: 'morning' | 'afternoon';
  };
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

export interface ChangeEmailRequest {
  newEmail: string;
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
  };
}

