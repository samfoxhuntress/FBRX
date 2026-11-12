import type { CSSProperties } from 'react';
import mark from './fbrx-mark.json';
import labs from './fhl-wordmark.json';

const { inset, radius, stroke } = mark.frame;
const side = mark.size - 2 * inset;

/** Path data and frame of the FBRX mark (100 x 100), for drawing or animating it outside this component. */
export const FBRX_MARK = { size: mark.size, frame: { x: inset, y: inset, side, radius, stroke }, letters: mark.letters } as const;

/**
 * The FBRX logo: a rounded frame around the stacked letters FB / RX, in the current text color. `tile` puts it on
 * its black square as in the app icon.
 */
export function FbrxMark({ size = 30, tile = false, className, style, title = 'FBRX', onClick }: { size?: number; tile?: boolean; className?: string; style?: CSSProperties; title?: string; onClick?: () => void }) {
  return (
    <svg className={className} style={style} onClick={onClick} width={size} height={size} viewBox={`0 0 ${mark.size} ${mark.size}`} role="img" aria-label={title}>
      {tile && <rect width={mark.size} height={mark.size} rx={radius + stroke / 2} fill="#0a0a0a" />}
      <rect x={inset} y={inset} width={side} height={side} rx={radius} fill="none" stroke={tile ? '#fff' : 'currentColor'} strokeWidth={stroke} />
      <path d={mark.letters} fill={tile ? '#fff' : 'currentColor'} fillRule="evenodd" />
    </svg>
  );
}

/** The maker of FBRX, for About pages and footers. */
export const MAKER = 'Fox Huntress Labs';

/**
 * The Fox Huntress Labs wordmark (FBRX's maker), in the current text color so it suits light and dark: the wordmark's
 * shape masks a block of that color.
 */
export function LabsMark({ width = 160, className, style }: { width?: number; className?: string; style?: CSSProperties }) {
  return (
    <span
      role="img"
      aria-label={MAKER}
      className={className}
      style={{
        display: 'inline-block',
        width,
        height: Math.round((width * labs.height) / labs.width),
        backgroundColor: 'currentColor',
        WebkitMaskImage: `url(${labs.mask})`,
        maskImage: `url(${labs.mask})`,
        WebkitMaskSize: '100% 100%',
        maskSize: '100% 100%',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        ...style,
      }}
    />
  );
}
