import React from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select-native';
import { Checkbox } from '@/components/ui/checkbox-native';
import { MembershipTabProps } from './types';

export const MembershipTab: React.FC<MembershipTabProps> = ({
  membershipType,
  marketingAddon,
  contractType,
  recurringTerminationDate,
  savingMembership,
  savingTerminationDate,
  onTypeChange,
  onAddonChange,
  onSave,
  onTerminationDateChange,
  onSaveTerminationDate,
}) => {
  const terminationDateMinLocal = new Date().toLocaleDateString('en-CA');

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-2">
        <Label htmlFor="membershipType">Membership Type</Label>
        <Select
          id="membershipType"
          value={membershipType}
          onChange={(e) => onTypeChange(e.target.value as 'permanent' | 'ad_hoc' | '')}
        >
          <option value="" disabled>
            Select a membership type
          </option>
          <option value="permanent">Permanent</option>
          <option value="ad_hoc">Ad Hoc</option>
        </Select>
      </div>

      <div className="flex items-center space-x-2">
        <Checkbox
          id="marketingAddon"
          checked={marketingAddon}
          onChange={(e) => onAddonChange(e.target.checked)}
        />
        <Label htmlFor="marketingAddon">Enable Marketing Add-on</Label>
      </div>

      <Button onClick={onSave} disabled={savingMembership}>
        {savingMembership ? 'Saving...' : 'Save Membership'}
      </Button>

      {contractType === 'recurring' && (
        <div className="space-y-2 border rounded-md p-3">
          <Label htmlFor="recurringTerminationDate">Recurring Termination Date</Label>
          <div className="flex gap-2">
            <input
              id="recurringTerminationDate"
              type="date"
              min={terminationDateMinLocal}
              className="w-full border rounded-md h-10 px-3 bg-transparent"
              value={recurringTerminationDate}
              onChange={(e) => onTerminationDateChange(e.target.value)}
            />
            <Button
              onClick={onSaveTerminationDate}
              disabled={savingTerminationDate}
              variant="outline"
            >
              {savingTerminationDate ? 'Saving...' : 'Set'}
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            Leave blank and save to clear termination date.
          </p>
        </div>
      )}
    </div>
  );
};
