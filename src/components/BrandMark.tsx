interface BrandMarkProps {
  compact?: boolean;
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className="flex items-center gap-2.5 shrink-0 select-none">
      <svg
        width={compact ? 26 : 30}
        height={compact ? 26 : 30}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="8"
          fill="#1B161B"
          stroke="#7D1D33"
          strokeWidth="1.5"
        />
        <path
          d="M7 18.5C9.2 18.5 10.1 11.5 12.6 11.5C15.1 11.5 15.8 21 18.4 21C21 21 21.8 13.5 25 13.5"
          stroke="#F5EFE6"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="25" cy="13.5" r="2" fill="#992641" />
      </svg>
      <span className="font-display text-lg font-bold tracking-tight text-[#F5EFE6] whitespace-nowrap shrink-0">
        DATAGRAM
      </span>
    </div>
  );
}
