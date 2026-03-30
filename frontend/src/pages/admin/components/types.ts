import { UserStatus, PractitionerDocument } from '@/types';

// Defining shared interfaces for the sub-components
export interface ProfileTabProps {
    firstName: string;
    lastName: string;
    phone: string;
    status: UserStatus;
    saving: boolean;
    onChange: (data: { firstName: string; lastName: string; phone: string; status: UserStatus }) => void;
    onSave: () => void;
    onDelete: () => void;
    practitionerName: string;
}

export interface MembershipTabProps {
    membershipType: 'permanent' | 'ad_hoc' | '';
    marketingAddon: boolean;
    contractType?: 'standard' | 'recurring';
    recurringTerminationDate: string;
    savingMembership: boolean;
    savingTerminationDate: boolean;
    onTypeChange: (type: 'permanent' | 'ad_hoc' | '') => void;
    onAddonChange: (addon: boolean) => void;
    onSave: () => void;
    onTerminationDateChange: (date: string) => void;
    onSaveTerminationDate: () => void;
}

export interface NextOfKinTabProps {
    form: {
        name: string;
        relationship: string;
        phone: string;
        email: string;
    };
    saving: boolean;
    onChange: (data: { name: string; relationship: string; phone: string; email: string }) => void;
    onSave: () => void;
}

export interface ClinicalTabProps {
    documents: PractitionerDocument[];
    executorForm: {
        name: string;
        email: string;
        phone: string;
    };
    saving: boolean;
    onExecutorChange: (data: { name: string; email: string; phone: string }) => void;
    onSaveExecutor: () => void;
    onUpdateExpiry: (documentId: string, expiryDate: string | null) => Promise<void>;
    onReferenceUploaded?: () => void;
    practitionerId: string;
}
