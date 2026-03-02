import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';

interface KioskLayoutProps {
  locationName: 'Pimlico' | 'Kensington';
  children: ReactNode;
  bottomRightLabel: string;
  bottomRightOnClick: () => void;
}

export function KioskLayout({
  locationName,
  children,
  bottomRightLabel,
  bottomRightOnClick,
}: KioskLayoutProps) {
  const isPimlico = locationName === 'Pimlico';

  return (
    <div
      className={`min-h-screen flex flex-col relative ${
        isPimlico ? 'text-slate-900 bg-white' : 'text-white'
      }`}
    >
      {!isPimlico && (
        <div
          className="absolute inset-0 z-0"
          style={{
            backgroundColor: '#d8d8d8',
            backgroundImage: "url('/images/bg.svg')",
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      )}

      <div className="relative z-10 flex flex-col min-h-screen">
        <header className="w-full px-4 py-5 sm:py-6">
          <div className="max-w-4xl mx-auto">
            <h1
              className={`font-bold tracking-tight uppercase ${
                isPimlico ? '' : 'text-2xl sm:text-3xl md:text-4xl text-white drop-shadow-sm'
              }`}
              style={isPimlico ? { color: '#8AC047', fontFamily: "'Amatic SC'", fontSize: '74px' } : undefined}
            >
              Therapists Working Now
            </h1>
            <span
              className={`mt-1 block text-sm font-medium ${
                isPimlico ? 'text-slate-600' : 'text-white/90'
              }`}
            >
              {locationName}
            </span>
          </div>
        </header>

        <main className="flex-1 w-full">
          <div className="max-w-4xl mx-auto px-4 py-2 pb-28">{children}</div>
        </main>

        <footer className="fixed bottom-0 right-0 z-20 p-4">
          <button
            type="button"
            onClick={bottomRightOnClick}
            className={`flex flex-col items-center gap-0.5 rounded-lg p-2 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
              isPimlico
                ? 'text-slate-800 hover:text-slate-900 focus:ring-[#8AC047]'
                : 'text-white/95 hover:text-white focus:ring-white/50'
            }`}
            aria-label={bottomRightLabel}
          >
            <Icon name="swap_horiz" size={28} className="block" />
            <span className="text-[10px] sm:text-xs font-medium leading-tight text-center whitespace-nowrap">
              {bottomRightLabel}
            </span>
          </button>
        </footer>
      </div>
    </div>
  );
}
