import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';

interface KioskLayoutProps {
  locationName: 'Pimlico' | 'Kensington';
  children: ReactNode;
  onHome?: () => void;
}

export function KioskLayout({ locationName, children, onHome }: KioskLayoutProps) {
  return (
    <div className="min-h-screen flex flex-col relative text-white">
      {/* Full-bleed background: SVG + fallback grey */}
      <div
        className="absolute inset-0 z-0"
        style={{
          backgroundColor: '#d8d8d8',
          backgroundImage: "url('/images/bg.svg')",
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />

      {/* Content above background */}
      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Header: THERAPISTS WORKING NOW only */}
        <header className="w-full px-4 py-5 sm:py-6">
          <div className="max-w-4xl mx-auto">
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight uppercase text-white drop-shadow-sm">
              Therapists Working Now
            </h1>
            <span className="mt-1 block text-sm font-medium text-white/90">
              {locationName}
            </span>
          </div>
        </header>

        {/* Scrollable content */}
        <main className="flex-1 w-full">
          <div className="max-w-4xl mx-auto px-4 py-2 pb-28">
            {children}
          </div>
        </main>

        {/* Fixed bottom-right: Sign In/Out (Home) control only */}
        <footer className="fixed bottom-0 right-0 z-20 p-4">
          <button
            type="button"
            onClick={onHome}
            className="flex flex-col items-center gap-0.5 text-white/95 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/50 rounded-lg p-2 transition-colors"
            aria-label="Sign In / Out and Home"
          >
            <Icon name="swap_horiz" size={28} className="block" />
            <span className="text-[10px] sm:text-xs font-medium leading-tight text-center">
              Sign In
              <br />
              / Out
            </span>
          </button>
        </footer>
      </div>
    </div>
  );
}
