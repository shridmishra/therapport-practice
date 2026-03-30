export interface NavItem {
  name: string;
  icon: string;
  path: string;
  active?: boolean;
  implemented?: boolean;
}

export const practitionerNavItems: NavItem[] = [
  { name: 'Dashboard', icon: 'dashboard', path: '/dashboard', implemented: true },
  { name: 'Bookings', icon: 'calendar_month', path: '/bookings', implemented: true },
  { name: 'Subscription', icon: 'credit_card', path: '/subscription', implemented: true },
  { name: 'Finance', icon: 'account_balance_wallet', path: '/finance', implemented: true },
  { name: 'Compliance', icon: 'description', path: '/compliance', implemented: false },
  { name: 'Support', icon: 'support_agent', path: '/support', implemented: false },
  { name: 'Profile', icon: 'person', path: '/profile', implemented: true },
];

export const adminNavItems: NavItem[] = [
  { name: 'Dashboard', icon: 'dashboard', path: '/admin', implemented: true },
  { name: 'Practitioners', icon: 'people', path: '/admin/practitioners', implemented: true },
  { name: 'Calendar', icon: 'calendar_month', path: '/admin/calendar', implemented: true },
  { name: 'Prices', icon: 'payments', path: '/admin/prices', implemented: true },
   { name: 'Kiosk Logs', icon: 'history', path: '/admin/kiosk-logs', implemented: true },
  { name: 'Profile', icon: 'person', path: '/admin/profile', implemented: true },
];
