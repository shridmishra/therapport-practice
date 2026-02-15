import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type {
  ApiResponse,
  UserStatus,
  PractitionerMembership,
  NextOfKin,
  ClinicalExecutor,
} from '../types';
import type { DocumentData } from '../types/documents';

/** Permanent membership slot (from subscription status permanentSlots). */
export interface PermanentSlot {
  dayOfWeek: string;
  roomName: string;
  locationName: string;
  startTime: string;
  endTime: string;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value?: any) => void;
  reject: (error?: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle errors and token refresh
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResponse>) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // If error is 401 and we haven't tried refreshing yet
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      if (isRefreshing) {
        // If already refreshing, queue this request
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return api(originalRequest);
          })
          .catch((err) => {
            return Promise.reject(err);
          });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) {
        // No refresh token, clear everything and let ProtectedRoute handle redirect
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        processQueue(new Error('No refresh token'), null);
        isRefreshing = false;
        // Dispatch custom event to trigger auth check
        window.dispatchEvent(new Event('auth:logout'));
        return Promise.reject(error);
      }

      try {
        // Try to refresh the token
        const response = await axios.post<{
          success: boolean;
          data: { accessToken: string; refreshToken: string };
        }>(`${API_URL}/auth/refresh`, { refreshToken });

        if (response.data.success && response.data.data) {
          const { accessToken, refreshToken: newRefreshToken } = response.data.data;
          localStorage.setItem('accessToken', accessToken);
          localStorage.setItem('refreshToken', newRefreshToken);

          // Update the original request with new token
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${accessToken}`;
          }

          processQueue(null, accessToken);
          isRefreshing = false;

          // Retry the original request
          return api(originalRequest);
        }
      } catch (refreshError) {
        // Refresh failed, clear tokens
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        processQueue(refreshError, null);
        isRefreshing = false;
        // Dispatch custom event to trigger auth check
        window.dispatchEvent(new Event('auth:logout'));
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

// Helper function to validate userId
const validateUserId = (userId: string): void => {
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error(`Invalid userId parameter: "${userId}". userId must be a non-empty string.`);
  }
};

// Booking and credit types (practitioner)
export interface BookingItem {
  id: string;
  roomId: string;
  roomName: string;
  locationName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  pricePerHour: number;
  totalPrice: number;
  status: string;
  bookingType: string;
}

export interface BookingSlot {
  startTime: string;
  endTime: string;
  available: boolean;
}

export interface RoomItem {
  id: string;
  name: string;
  roomNumber: number;
  active: boolean;
  locationName: string;
}

export interface CreditSummary {
  currentMonth: {
    monthYear: string;
    totalGranted: number;
    totalUsed: number;
    remainingCredit: number;
  } | null;
  nextMonth: {
    monthYear: string;
    nextMonthAllocation: number;
  } | null;
  /**
   * Optional breakdown of remaining credit by expiry month (YYYY-MM).
   * When present, this should be used by the UI in preference to currentMonth/nextMonth
   * for showing monthly buckets.
   */
  byMonth?: Array<{
    month: string;
    remainingCredit: number;
  }>;
  membershipType: 'permanent' | 'ad_hoc' | null;
}

export interface VoucherSummary {
  totalHoursAllocated: number;
  totalHoursUsed: number;
  remainingHours: number;
  earliestExpiry: string | null;
  vouchers: Array<{
    id: string;
    hoursAllocated: number;
    hoursUsed: number;
    remainingHours: number;
    expiryDate: string;
    reason: string | null;
  }>;
}

export interface InvoiceItem {
  id: string;
  number: string | null;
  status: string;
  amount_paid: number;
  currency: string;
  created: number;
  invoice_pdf: string | null;
}

/** Response type for successful createBooking calls (2xx status codes). */
export type CreateBookingResponse =
  | { success: true; booking: { id: string } }
  | { success: false; error?: string };

/** Error response payload for 402 Payment Required (appears in AxiosError.response.data). */
export type CreateBookingPaymentRequiredError = {
      success: false;
      paymentRequired: true;
      clientSecret: string;
      paymentIntentId: string;
      amountPence: number;
      error?: string;
};

// Practitioner API methods
export const practitionerApi = {
  getInsuranceDocument: (signal?: AbortSignal) => {
    return api.get<ApiResponse<DocumentData>>('/practitioner/documents/insurance', {
      signal,
    });
  },

  getClinicalDocument: (signal?: AbortSignal) => {
    return api.get<ApiResponse<DocumentData>>('/practitioner/documents/clinical', {
      signal,
    });
  },

  // Bookings (PR 12) — backend returns { success, bookings } / { success, rooms } / etc.
  getRooms: (location?: 'Pimlico' | 'Kensington', signal?: AbortSignal) => {
    const params = location ? { location } : {};
    return api.get<{ success: boolean; rooms: RoomItem[] }>('/practitioner/rooms', {
      params,
      signal,
    });
  },

  getBookings: (
    params?: { fromDate?: string; toDate?: string; status?: string },
    signal?: AbortSignal
  ) => {
    return api.get<{ success: boolean; bookings: BookingItem[] }>('/practitioner/bookings', {
      params,
      signal,
    });
  },

  getBookingById: (id: string, signal?: AbortSignal) => {
    return api.get<{ success: boolean; booking: BookingItem }>(`/practitioner/bookings/${id}`, {
      signal,
    });
  },

  getBookingAvailability: (roomId: string, date: string, signal?: AbortSignal) => {
    return api.get<{ success: boolean; slots: BookingSlot[] }>(
      '/practitioner/bookings/availability',
      {
        params: { roomId, date },
        signal,
      }
    );
  },

  getCalendar: (location: 'Pimlico' | 'Kensington', date: string, signal?: AbortSignal) => {
    return api.get<{
      success: boolean;
      rooms: Array<{ id: string; name: string }>;
      bookings: Array<{
        id?: string;
        roomId: string;
        startTime: string;
        endTime: string;
        bookerName?: string;
      }>;
    }>('/practitioner/bookings/calendar', {
      params: { location, date },
      signal,
    });
  },

  getBookingQuote: (
    roomId: string,
    date: string,
    startTime: string,
    endTime: string,
    signal?: AbortSignal
  ) => {
    return api.get<{
      success: boolean;
      totalPrice: number;
      currency: string;
      error?: string;
    }>('/practitioner/bookings/quote', {
      params: { roomId, date, startTime, endTime },
      signal,
    });
  },

  createBooking: (data: {
    roomId: string;
    date: string;
    startTime: string;
    endTime: string;
    bookingType: 'permanent_recurring' | 'ad_hoc' | 'free';
    targetUserId?: string;
  }) => {
    return api.post<CreateBookingResponse>('/practitioner/bookings', data);
  },

  updateBooking: (
    id: string,
    data: { roomId?: string; bookingDate?: string; startTime?: string; endTime?: string }
  ) => {
    return api.patch<
      | ApiResponse<{ message?: string }>
      | {
          success: false;
          paymentRequired: true;
          clientSecret: string;
          paymentIntentId: string;
          amountPence: number;
        }
    >(`/practitioner/bookings/${id}`, data);
  },

  cancelBooking: (id: string) => {
    return api.delete<ApiResponse<{ message?: string }>>(`/practitioner/bookings/${id}`);
  },

  getCredits: (signal?: AbortSignal) => {
    return api.get<{ success: boolean; credit: CreditSummary }>('/practitioner/credits', {
      signal,
    });
  },

  // Subscriptions (PR 14)
  getSubscriptionStatus: (signal?: AbortSignal) => {
    return api.get<{
      success: boolean;
      canBook: boolean;
      reason?: string;
      membership?: {
        type: string;
        subscriptionType: string | null;
        subscriptionEndDate: string | null;
        suspensionDate: string | null;
        terminationRequestedAt: string | null;
      };
      monthlyPriceGbp?: number;
      permanentSlots?: PermanentSlot[];
    }>('/practitioner/subscriptions/status', { signal });
  },

  createMonthlySubscription: (joinDate?: string) => {
    return api.post<{
      success: boolean;
      error?: string;
      checkoutUrl?: string;
      clientSecret?: string;
      subscriptionId?: string;
      currentMonthAmount?: number;
    }>('/practitioner/subscriptions/monthly', joinDate ? { joinDate } : {});
  },

  createAdHocSubscription: (purchaseDate?: string) => {
    return api.post<{
      success: boolean;
      error?: string;
      clientSecret?: string;
      paymentIntentId?: string;
    }>('/practitioner/subscriptions/ad-hoc', purchaseDate ? { purchaseDate } : {});
  },

  terminateSubscription: (terminationDate?: string) => {
    return api.post<{
      success: boolean;
      message?: string;
      suspensionDate?: string;
    }>('/practitioner/subscriptions/terminate', terminationDate ? { terminationDate } : {});
  },

  getInvoices: (signal?: AbortSignal) => {
    return api.get<{
      success: boolean;
      invoices: InvoiceItem[];
    }>('/practitioner/invoices', { signal });
  },

  getTransactionHistory: (month?: string, signal?: AbortSignal) => {
    const params = month ? { month } : {};
    return api.get<{
      success: boolean;
      data: Array<{
        date: string;
        description: string;
        amount: number;
        type: 'credit_grant' | 'booking' | 'voucher_allocation' | 'stripe_payment';
      }>;
    }>('/practitioner/transaction-history', { params, signal });
  },
};

// Admin API methods
export const adminApi = {
  getAdminStats: (params?: { fromDate?: string; toDate?: string }) => {
    return api.get<
      ApiResponse<{
        practitionerCount: number;
        adHocCount: number;
        permanentCount: number;
        occupancy: {
          fromDate: string;
          toDate: string;
          totalSlotHours: number;
          bookedHours: number;
          occupancyPercent: number;
        };
        revenueCurrentMonthGbp: number;
      }>
    >('/admin/stats', { params });
  },

  getPractitioners: (search?: string, page = 1, limit = 10) => {
    const params = { ...(search ? { search } : {}), page, limit };
    // Refine the type to include mandatory pagination at the top level
    return api.get<
      ApiResponse<
        Array<{
          id: string;
          email: string;
          firstName: string;
          lastName: string;
          status: UserStatus;
          membership: PractitionerMembership | null;
        }>
      > & {
        pagination: {
          page: number;
          limit: number;
          totalCount: number;
          totalPages: number;
        };
      }
    >('/admin/practitioners', { params });
  },

  getPractitioner: (userId: string) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.get<
      ApiResponse<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        phone?: string;
        role: string;
        status: UserStatus;
        membership: PractitionerMembership | null;
      }>
    >(`/admin/practitioners/${userId}`);
  },

  getPractitionersWithMissingInfo: (page = 1, limit = 10, signal?: AbortSignal) => {
    return api.get<
      ApiResponse<{
        data: Array<{
          id: string;
          name: string;
          missing: string[];
        }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      }>
    >('/admin/practitioners/missing-info', { params: { page, limit }, signal });
  },

  updateMembership: (
    userId: string,
    data: {
      type?: 'permanent' | 'ad_hoc' | null;
      marketingAddon?: boolean;
    }
  ) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.put<
      ApiResponse<{
        id: string;
        type: 'permanent' | 'ad_hoc';
        marketingAddon: boolean;
      }>
    >(`/admin/practitioners/${userId}/membership`, data);
  },

  // Get full practitioner details (documents, next of kin, clinical executor)
  getFullPractitioner: (userId: string) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.get<
      ApiResponse<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        phone?: string;
        photoUrl?: string;

        role: string;
        status: UserStatus;
        nextOfKin: NextOfKin | null;
        createdAt: string;
        membership: PractitionerMembership | null;
        documents: Array<{
          id: string;
          documentType: 'insurance' | 'clinical_registration';
          fileName: string;
          fileUrl: string;
          expiryDate: string | null;
          createdAt: string;
        }>;
        clinicalExecutor: ClinicalExecutor | null;
      }>
    >(`/admin/practitioners/${userId}/full`);
  },

  // Update practitioner profile
  updatePractitioner: (
    userId: string,
    data: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      status?: UserStatus;
    }
  ) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.put<
      ApiResponse<{
        id: string;
        firstName: string;
        lastName: string;
        phone?: string;
        status?: UserStatus;
      }>
    >(`/admin/practitioners/${userId}`, data);
  },

  // Update next of kin
  updateNextOfKin: (
    userId: string,
    data: {
      name: string;
      relationship: string;
      phone: string;
      email?: string;
    }
  ) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.put<
      ApiResponse<{
        nextOfKin: NextOfKin;
      }>
    >(`/admin/practitioners/${userId}/next-of-kin`, data);
  },

  // Update clinical executor
  updateClinicalExecutor: (
    userId: string,
    data: {
      name: string;
      email: string;
      phone: string;
    }
  ) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.put<ApiResponse<ClinicalExecutor>>(
      `/admin/practitioners/${userId}/clinical-executor`,
      data
    );
  },

  // Get practitioner credits and voucher summary (admin)
  getPractitionerCredits: (userId: string) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.get<
      ApiResponse<{
        credit: {
          currentMonth: {
            monthYear: string;
            totalGranted: number;
            totalUsed: number;
            remainingCredit: number;
          } | null;
          nextMonth: { monthYear: string; nextMonthAllocation: number } | null;
          byMonth?: Array<{ month: string; remainingCredit: number }>;
          membershipType: 'permanent' | 'ad_hoc' | null;
        };
        voucher: {
          totalHoursAllocated: number;
          totalHoursUsed: number;
          remainingHours: number;
          earliestExpiry: string | null;
          vouchers: Array<{
            id: string;
            hoursAllocated: number;
            hoursUsed: number;
            remainingHours: number;
            expiryDate: string;
            reason: string | null;
          }>;
        };
      }>
    >(`/admin/practitioners/${userId}/credits`);
  },

  // Allocate free booking hours (voucher) to practitioner
  allocateVoucher: (
    userId: string,
    data: { hoursAllocated: number; expiryDate: string; reason?: string }
  ) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.post<
      ApiResponse<{
        id: string;
        hoursAllocated: number;
        expiryDate: string;
        reason?: string;
      }>
    >(`/admin/practitioners/${userId}/vouchers`, data);
  },

  // Delete practitioner
  deletePractitioner: (userId: string) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }

    return api.delete<ApiResponse<null>>(`/admin/practitioners/${userId}`);
  },

  // Update document expiry date
  updateDocumentExpiry: (userId: string, documentId: string, expiryDate: string | null) => {
    try {
      validateUserId(userId);
      if (!documentId || typeof documentId !== 'string' || documentId.trim().length === 0) {
        throw new Error(
          `Invalid documentId parameter: "${documentId}". documentId must be a non-empty string.`
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }

    return api.put<
      ApiResponse<{
        id: string;
        documentType: 'insurance' | 'clinical_registration';
        fileName: string;
        expiryDate: string | null;
        isExpired: boolean;
        isExpiringSoon: boolean;
        daysUntilExpiry: number | null;
      }>
    >(`/admin/practitioners/${userId}/documents/${documentId}/expiry`, {
      expiryDate,
    });
  },

  getReferenceUploadUrl: (
    userId: string,
    data: { filename: string; fileType: string; fileSize: number }
  ) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }
    return api.post<
      ApiResponse<{ presignedUrl: string; filePath: string; oldDocumentId?: string }>
    >(`/admin/practitioners/${userId}/documents/reference/upload-url`, data);
  },

  confirmReferenceUpload: (
    userId: string,
    data: { filePath: string; fileName: string; oldDocumentId?: string }
  ) => {
    try {
      validateUserId(userId);
    } catch (error) {
      return Promise.reject(error);
    }
    return api.put<ApiResponse<{ id: string; fileName: string; documentUrl: string }>>(
      `/admin/practitioners/${userId}/documents/reference/confirm`,
      data
    );
  },
};

export default api;
