import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/Icon';

interface KioskLayoutProps {
  locationName: 'Pimlico' | 'Kensington';
  children: ReactNode;
  onHome?: () => void;
}

export function KioskLayout({ locationName, children, onHome }: KioskLayoutProps) {
  return (
    <div className="min-h-screen flex flex-col bg-slate-100 text-slate-900">
      {/* Header */}
      <header className="w-full border-b border-slate-200 bg-white/90 backdrop-blur px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Therapport
            </span>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight">
              {locationName} – Therapists Working Now
            </h1>
          </div>
        </div>
      </header>

      {/* Scrollable content */}
      <main className="flex-1 w-full">
        <div className="max-w-4xl mx-auto px-4 py-4">
          {children}
        </div>
      </main>

      {/* Fixed bottom bar with Home button (always visible) */}
      <footer className="w-full border-t border-slate-200 bg-white/95 backdrop-blur sticky bottom-0">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <p className="text-xs sm:text-sm text-slate-500">
            Tap your name or photo to sign in. Tap your photo again to sign out.
          </p>
          <Button
            type="button"
            size="lg"
            className="flex items-center gap-2 px-6 text-base sm:text-lg rounded-full"
            onClick={onHome}
          >
            <Icon name="home" size={20} />
            Home
          </Button>
        </div>
      </footer>
    </div>
  );
}

