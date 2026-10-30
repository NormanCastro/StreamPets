/** Huella de mascota con degradado: la marca del panel. */
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d8b4fe" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#lg)" />
      <g fill="#fff">
        <ellipse cx="11" cy="12" rx="2.2" ry="2.8" />
        <ellipse cx="21" cy="12" rx="2.2" ry="2.8" />
        <ellipse cx="7.6" cy="18" rx="2" ry="2.5" />
        <ellipse cx="24.4" cy="18" rx="2" ry="2.5" />
        <path d="M16 15.5c-3.4 0-6.2 3.1-6.2 5.9 0 2 1.6 3 3.2 3 1.2 0 2-.5 3-.5s1.8.5 3 .5c1.6 0 3.2-1 3.2-3 0-2.8-2.8-5.9-6.2-5.9z" />
      </g>
    </svg>
  );
}
