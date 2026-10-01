import type { CSSProperties } from 'react';
import mark from './fbrx-mark.json';

const { inset, radius, stroke } = mark.frame;
const side = mark.size - 2 * inset;

/** Path data and frame of the FBRX mark (100 x 100), for drawing or animating it outside this component. */
export const FBRX_MARK = { size: mark.size, frame: { x: inset, y: inset, side, radius, stroke }, letters: mark.letters } as const;

/**
 * The FBRX logo: a rounded frame around the stacked letters FB / RX, in the current text colour. `tile` puts it on
 * its black square as in the app icon.
 */
export function FbrxMark({ size = 30, tile = false, className, style, title = 'FBRX' }: { size?: number; tile?: boolean; className?: string; style?: CSSProperties; title?: string }) {
  return (
    <svg className={className} style={style} width={size} height={size} viewBox={`0 0 ${mark.size} ${mark.size}`} role="img" aria-label={title}>
      {tile && <rect width={mark.size} height={mark.size} rx={radius + stroke / 2} fill="#0a0a0a" />}
      <rect x={inset} y={inset} width={side} height={side} rx={radius} fill="none" stroke={tile ? '#fff' : 'currentColor'} strokeWidth={stroke} />
      <path d={mark.letters} fill={tile ? '#fff' : 'currentColor'} fillRule="evenodd" />
    </svg>
  );
}
