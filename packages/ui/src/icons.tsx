import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: string[]) {
  return function Icon({ size = 16, ...rest }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
        {paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    );
  };
}

/** Minimal stroke icon set (24px grid, 2px stroke). */
export const Icons = {
  dashboard: make(['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z']),
  agent: make(['M12 8V4H8', 'M4 12h16v8H4z', 'M2 14h2', 'M20 14h2', 'M9 16v1', 'M15 16v1']),
  shield: make(['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4']),
  key: make(['M21 2l-2 2', 'M15.5 7.5l3 3L22 7l-3-3', 'M11.4 12.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8z', 'M11.4 12.6L19 5']),
  plug: make(['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a6 6 0 0 1-12 0V8z']),
  link: make(['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7']),
  cpu: make(['M6 6h12v12H6z', 'M9 9h6v6H9z', 'M9 2v4', 'M15 2v4', 'M9 18v4', 'M15 18v4', 'M2 9h4', 'M2 15h4', 'M18 9h4', 'M18 15h4']),
  archive: make(['M3 4h18v4H3z', 'M5 8v12h14V8', 'M10 12h4']),
  globe: make(['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M2 12h20', 'M12 2a15 15 0 0 1 0 20', 'M12 2a15 15 0 0 0 0 20']),
  settings: make([
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ]),
  check: make(['M20 6L9 17l-5-5']),
  checkCircle: make(['M22 11.1V12a10 10 0 1 1-5.9-9.1', 'M22 4L12 14l-3-3']),
  x: make(['M18 6L6 18', 'M6 6l12 12']),
  xCircle: make(['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M15 9l-6 6', 'M9 9l6 6']),
  alert: make(['M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01']),
  octagon: make(['M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z', 'M12 8v4', 'M12 16h.01']),
  info: make(['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 16v-4', 'M12 8h.01']),
  clock: make(['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 6v6l4 2']),
  refresh: make(['M23 4v6h-6', 'M1 20v-6h6', 'M3.5 9a9 9 0 0 1 14.9-3.4L23 10', 'M1 14l4.6 4.4A9 9 0 0 0 20.5 15']),
  plus: make(['M12 5v14', 'M5 12h14']),
  trash: make(['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6']),
  copy: make(['M9 9h13v13H9z', 'M5 15H2V2h13v3']),
  eye: make(['M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z']),
  eyeOff: make(['M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-5.9', 'M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2', 'M14.1 14.1a3 3 0 1 1-4.2-4.2', 'M1 1l22 22']),
  download: make(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3']),
  upload: make(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12']),
  play: make(['M6 4l14 8-14 8z']),
  stop: make(['M6 6h12v12H6z']),
  send: make(['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z']),
  lock: make(['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4']),
  unlock: make(['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 7.9-1']),
  users: make(['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M23 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8']),
  terminal: make(['M4 17l6-6-6-6', 'M12 19h8']),
  pkg: make(['M16.5 9.4L7.5 4.2', 'M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z', 'M3.3 7L12 12l8.7-5', 'M12 22V12']),
  file: make(['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']),
  chevronRight: make(['M9 18l6-6-6-6']),
  chevronDown: make(['M6 9l6 6 6-6']),
  search: make(['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3']),
  logout: make(['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9']),
  laptop: make(['M4 5h16v11H4z', 'M2 20h20']),
  activity: make(['M22 12h-4l-3 9L9 3l-3 9H2']),
  tag: make(['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z', 'M7 7h.01']),
  sparkles: make(['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z']),
  server: make(['M2 3h20v8H2z', 'M2 13h20v8H2z', 'M6 7h.01', 'M6 17h.01']),
  history: make(['M3 3v5h5', 'M3.1 13a9 9 0 1 0 2.1-9.4L3 8', 'M12 7v5l4 2']),
  wrench: make(['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z']),
  menu: make(['M3 12h18', 'M3 6h18', 'M3 18h18']),
  sun: make(['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2', 'M12 21v2', 'M4.2 4.2l1.4 1.4', 'M18.4 18.4l1.4 1.4', 'M1 12h2', 'M21 12h2', 'M4.2 19.8l1.4-1.4', 'M18.4 5.6l1.4-1.4']),
  moon: make(['M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z']),
  external: make(['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3']),
};

export type IconName = keyof typeof Icons;

export function Icon({ name, ...p }: P & { name: IconName }) {
  const C = Icons[name];
  return <C {...p} />;
}
