import { EDITION_PLANS, TIERS, TIER_SHORT, formatPrice } from '@fbrx/shared';

/**
 * The editions at a glance: one small picture each, every edition the one before it and more. Essentials is a computer
 * with its AI on it and its toolkit; Pro adds the everyday tools (security, the dashboard, notes); Ultra joins your
 * phone and other computers (Mesh) and opens the terminal; Black Hole Edition adds the FBRX Server and the network,
 * everything. Colors come from the page (var(--text), var(--surface)), so the pictures follow light and dark.
 */

/** What each edition adds, in a few words (the cards on the pricing page say it in full). */
export const EDITION_TAGS = {
  essentials: ['AI chat, memory and voice', 'AI models on your computer', 'The AI Toolkit'],
  basic: ['Dash, notes and calendar', 'FBRX Shield and updates', 'Storage and backups'],
  ultra: ['Mesh: your computers and phone', 'Terminal and IT tools', 'Plugins and the theme studio'],
  blackhole: ['FBRX Server and network environments', 'The whole Library', 'For the people who run FBRX Command'],
};

const FIRST_LINE = { essentials: 'Your AI on your computer', basic: 'Everything in Essentials, plus', ultra: 'Everything in Pro, plus', blackhole: 'Everything, for the people in charge' };

/** The picture for an edition (an SVG); `uid` keeps its gradient ids apart from the others on the page. */
export function editionArt(t, uid = t) {
  const rank = TIERS.indexOf(t);
  const g = `fx-ed-g-${uid}`;
  const ink = 'var(--ed-ink, var(--text))';
  const paper = 'var(--ed-paper, var(--surface))';
  const s = `stroke="${ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;
  const badge = (x, y, inner) => `<g transform="translate(${x} ${y})"><circle r="17" fill="${paper}" ${s}/>${inner}</g>`;
  const parts = [];
  // Black Hole Edition: everything, pulled in around the computer.
  if (rank >= 3)
    parts.push(
      `<g fill="none" stroke="url(#${g})" stroke-width="2.5" opacity="0.55"><ellipse cx="130" cy="84" rx="124" ry="74"/><ellipse cx="130" cy="84" rx="100" ry="58" opacity="0.7"/><ellipse cx="130" cy="84" rx="76" ry="44" opacity="0.45"/></g>`,
      // The FBRX Server: a small rack with its lights.
      `<g ${s} fill="${paper}"><rect x="20" y="122" width="44" height="44" rx="6"/><line x1="20" y1="137" x2="64" y2="137"/><line x1="20" y1="152" x2="64" y2="152"/></g><g fill="url(#${g})"><circle cx="30" cy="130" r="3"/><circle cx="30" cy="145" r="3"/><circle cx="30" cy="159" r="3"/></g><g stroke="${ink}" stroke-width="2.5" stroke-linecap="round"><line x1="40" y1="130" x2="54" y2="130"/><line x1="40" y1="145" x2="54" y2="145"/><line x1="40" y1="159" x2="54" y2="159"/></g>`,
      `<path d="M64 140 C 78 140, 80 120, 92 116" fill="none" stroke="${ink}" stroke-width="2" stroke-dasharray="3 5"/>`,
    );
  // Ultra: your phone and the terminal, joined to the computer (Mesh).
  if (rank >= 2)
    parts.push(
      `<path d="M180 58 C 192 50, 198 44, 206 40" fill="none" stroke="${ink}" stroke-width="2" stroke-dasharray="3 5"/>`,
      `<g ${s} fill="${paper}"><rect x="206" y="14" width="24" height="42" rx="6"/></g><line x1="214" y1="49" x2="222" y2="49" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/><rect x="210" y="20" width="16" height="22" rx="2" fill="url(#${g})" opacity="0.9"/>`,
      badge(222, 84, `<path d="M-8 -5 L-3 0 L-8 5 M0 6 L8 6" fill="none" ${s}/>`),
    );
  // Pro: the everyday tools around it (security, the dashboard).
  if (rank >= 1)
    parts.push(
      badge(42, 42, `<path d="M0 -10 L8 -6 C 8 2, 5 7, 0 10 C -5 7, -8 2, -8 -6 Z" fill="url(#${g})" ${s.replace('stroke-width="3"', 'stroke-width="2.5"')}/>`),
      badge(42, 92, `<g stroke="${ink}" stroke-width="3" stroke-linecap="round"><line x1="-7" y1="7" x2="-7" y2="1"/><line x1="0" y1="7" x2="0" y2="-7"/><line x1="7" y1="7" x2="7" y2="-2"/></g>`),
      `<path d="M59 46 L80 54 M59 90 L80 84" stroke="${ink}" stroke-width="2" stroke-dasharray="3 5"/>`,
    );
  // Every edition: the computer, its AI and the AI Toolkit.
  parts.push(
    `<g ${s}><rect x="80" y="32" width="100" height="74" rx="10" fill="${paper}"/><rect x="118" y="106" width="24" height="12" fill="${paper}"/><rect x="100" y="118" width="60" height="7" rx="3.5" fill="${paper}"/></g>`,
    `<rect x="88" y="40" width="84" height="58" rx="6" fill="url(#${g})" opacity="0.14"/>`,
    // The AI: a friendly bot on the screen.
    `<line x1="130" y1="50" x2="130" y2="44" ${s}/><circle cx="130" cy="42" r="4" fill="url(#${g})" ${s.replace('stroke-width="3"', 'stroke-width="2"')}/>`,
    `<rect x="108" y="50" width="44" height="36" rx="12" fill="url(#${g})" ${s}/>`,
    `<circle cx="121" cy="66" r="4.5" fill="#fff"/><circle cx="139" cy="66" r="4.5" fill="#fff"/><circle cx="122" cy="67" r="2" fill="#1c1b19"/><circle cx="140" cy="67" r="2" fill="#1c1b19"/>`,
    `<path d="M123 76 Q130 81 137 76" fill="none" stroke="#1c1b19" stroke-width="2.5" stroke-linecap="round"/>`,
    // The toolkit: a toolbox with a wrench.
    `<g ${s}><path d="M188 120 v-5 a4 4 0 0 1 4 -4 h12 a4 4 0 0 1 4 4 v5" fill="none"/><rect x="178" y="120" width="40" height="26" rx="5" fill="url(#${g})"/><line x1="178" y1="131" x2="218" y2="131"/></g>`,
  );
  return `<svg class="ed-art" viewBox="0 0 260 172" role="img" aria-label="${TIER_SHORT[t]}: ${EDITION_TAGS[t].join(', ')}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb547"/><stop offset="0.5" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ff4d5e"/></linearGradient></defs>
  ${parts.join('\n  ')}
</svg>`;
}

/** What it costs, in a few words. */
export function priceWords(t) {
  const p = EDITION_PLANS[t];
  if (p.sold === 'free') return 'Free';
  if (p.monthly == null) return 'With FBRX Command';
  return `${formatPrice(p.monthly)} a month`;
}

/** The four editions in a row, each building on the one before (HTML for the website and the shareable picture). */
export function editionsDiagram(uid = 'site') {
  return `<div class="ed-diagram" role="list">
${TIERS.map(
  (t) => `  <div class="ed-step ${t}" role="listitem">
    ${editionArt(t, `${uid}-${t}`)}
    <h3>${TIER_SHORT[t]}</h3>
    <p class="ed-price">${priceWords(t)}</p>
    <p class="ed-lead">${FIRST_LINE[t]}</p>
    <ul>${EDITION_TAGS[t].map((x) => `<li>${x}</li>`).join('')}</ul>
  </div>`,
).join('\n')}
</div>`;
}
