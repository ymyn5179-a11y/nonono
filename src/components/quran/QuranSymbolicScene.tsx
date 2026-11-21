import React from 'react';
import type { QuranStorySpec } from '../../types/nonoland';

interface Props {
  theme: QuranStorySpec['symbolicTheme'];
  title: string;
}

/**
 * Purely symbolic nature/architectural illustrations for Quran Stories.
 * Strictly prohibits depiction of Prophets, Messengers, or human figures.
 */
export const QuranSymbolicScene: React.FC<Props> = ({ theme, title }) => {
  return (
    <div className="rounded-2xl overflow-hidden border border-[#B4862C]/25 bg-[#FFFDF7]">
      <svg
        viewBox="0 0 420 180"
        role="img"
        aria-label={title}
        className="w-full h-44 sm:h-48 block"
      >
        <defs>
          <linearGradient id={`sky-${theme}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={theme === 'kind-brothers' ? '#1E293B' : '#E0F2FE'} />
            <stop offset="100%" stopColor={theme === 'kind-brothers' ? '#312E81' : '#FEF9C3'} />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="420" height="180" fill={`url(#sky-${theme})`} />

        {theme === 'birds-protection' && (
          <>
            <circle cx="345" cy="42" r="24" fill="#FDE68A" opacity="0.9" />
            <path d="M0 142 Q120 124 240 140 T420 138 L420 180 L0 180 Z" fill="#FDE68A" />
            {/* Symbolic Kaaba Sanctuary silhouette */}
            <rect x="172" y="76" width="76" height="72" rx="4" fill="#1E293B" />
            <rect x="172" y="90" width="76" height="9" fill="#D97706" />
            <rect x="198" y="108" width="16" height="32" rx="2" fill="#B45309" />
            {/* Clouds */}
            <ellipse cx="78" cy="48" rx="34" ry="14" fill="#FFFFFF" opacity="0.88" />
            <ellipse cx="98" cy="42" rx="22" ry="12" fill="#FFFFFF" opacity="0.92" />
            {/* Symbolic small birds in sky */}
            <path d="M90 68 q8 -8 16 0 q8 -8 16 0" stroke="#334155" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <path d="M135 50 q7 -7 14 0 q7 -7 14 0" stroke="#334155" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <path d="M268 56 q8 -8 16 0 q8 -8 16 0" stroke="#334155" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </>
        )}

        {theme === 'olive-ark' && (
          <>
            {/* Gentle rainbow arc */}
            <path d="M70 125 A 140 95 0 0 1 350 125" stroke="#FBBF24" strokeWidth="6" fill="none" opacity="0.55" />
            <path d="M84 125 A 126 84 0 0 1 336 125" stroke="#34D399" strokeWidth="6" fill="none" opacity="0.55" />
            {/* Wooden Ark silhouette */}
            <path d="M126 98 L294 98 L272 132 L148 132 Z" fill="#92400E" />
            <rect x="162" y="72" width="96" height="26" rx="4" fill="#B45309" />
            <rect x="186" y="80" width="12" height="10" rx="2" fill="#FEF3C7" />
            <rect x="222" y="80" width="12" height="10" rx="2" fill="#FEF3C7" />
            {/* Olive leaf */}
            <ellipse cx="322" cy="64" rx="14" ry="6" transform="rotate(-24 322 64)" fill="#10B981" />
            <path d="M308 72 Q324 64 338 56" stroke="#047857" strokeWidth="2" fill="none" />
            {/* Calm waves */}
            <path d="M0 132 Q35 122 70 132 T140 132 T210 132 T280 132 T350 132 T420 132 L420 180 L0 180 Z" fill="#38BDF8" />
            <path d="M0 148 Q45 140 90 148 T180 148 T270 148 T360 148 T420 148 L420 180 L0 180 Z" fill="#0284C7" opacity="0.55" />
          </>
        )}

        {theme === 'little-ant' && (
          <>
            <circle cx="72" cy="40" r="22" fill="#FDE047" />
            <path d="M0 120 Q120 88 230 116 T420 108 L420 180 L0 180 Z" fill="#86EFAC" />
            <path d="M0 145 Q170 124 300 148 T420 142 L420 180 L0 180 Z" fill="#22C55E" />
            {/* Tiny friendly symbolic ant */}
            <circle cx="192" cy="134" r="7" fill="#78350F" />
            <circle cx="206" cy="136" r="6" fill="#92400E" />
            <circle cx="220" cy="132" r="8" fill="#78350F" />
            <path d="M188 127 Q182 118 178 120" stroke="#78350F" strokeWidth="2" fill="none" strokeLinecap="round" />
            <path d="M194 127 Q190 117 185 118" stroke="#78350F" strokeWidth="2" fill="none" strokeLinecap="round" />
            {/* Flower & grass */}
            <circle cx="315" cy="122" r="9" fill="#F472B6" />
            <circle cx="315" cy="122" r="4" fill="#FDE047" />
            <rect x="313" y="131" width="4" height="22" fill="#15803D" />
          </>
        )}

        {theme === 'kind-brothers' && (
          <>
            {/* Crescent moon */}
            <circle cx="335" cy="48" r="20" fill="#FDE68A" />
            <circle cx="343" cy="44" r="17" fill="#1E293B" />
            {/* Eleven gentle stars */}
            {[
              [48, 36], [92, 54], [136, 30], [180, 58], [218, 28], [260, 48],
              [70, 82], [156, 86], [234, 78], [292, 74], [380, 84],
            ].map(([cx, cy], idx) => (
              <circle key={idx} cx={cx} cy={cy} r={idx % 2 === 0 ? 3 : 2.2} fill="#FEF08A" />
            ))}
            {/* Warm family home */}
            <path d="M0 144 Q210 130 420 144 L420 180 L0 180 Z" fill="#0F172A" />
            <rect x="164" y="104" width="92" height="52" rx="4" fill="#334155" />
            <polygon points="154,106 210,72 266,106" fill="#475569" />
            <rect x="198" y="124" width="24" height="32" rx="3" fill="#F59E0B" opacity="0.9" />
          </>
        )}

        {theme === 'light-cave' && (
          <>
            <circle cx="210" cy="48" r="32" fill="#FEF08A" opacity="0.85" />
            <path d="M0 132 Q140 112 280 130 T420 126 L420 180 L0 180 Z" fill="#A7F3D0" />
            {/* Olive trees */}
            <rect x="86" y="96" width="12" height="44" rx="4" fill="#92400E" />
            <circle cx="92" cy="84" r="28" fill="#10B981" />
            <rect x="318" y="96" width="12" height="44" rx="4" fill="#92400E" />
            <circle cx="324" cy="84" r="28" fill="#059669" />
            {/* Symbolic sharing basket */}
            <path d="M180 124 L240 124 L232 150 L188 150 Z" fill="#D97706" />
            <path d="M188 124 A 22 18 0 0 1 232 124" stroke="#92400E" strokeWidth="4" fill="none" />
            <circle cx="200" cy="120" r="7" fill="#EF4444" />
            <circle cx="214" cy="118" r="7" fill="#F59E0B" />
            <circle cx="222" cy="121" r="6" fill="#22C55E" />
          </>
        )}
      </svg>
    </div>
  );
};
