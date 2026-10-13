/**
 * The corner motif on each card: one glass shape and one dotted line, in the
 * same style and spot on every card (bottom right, bleeding off the edge), but
 * drawn from what the card is about: a checklist for priorities, a flame for
 * an incident, rising bars for the week, and so on. Kinds without their own
 * motif get the plain glass orb. Drawn in a 200 x 200 box, white on the field.
 */

/** The glass fill and its rim, shared by every motif. */
const DEFS =
  "<defs>" +
  "<radialGradient id='o' cx='.34' cy='.22' r='.85'><stop offset='0' stop-color='white' stop-opacity='.18'/><stop offset='.45' stop-color='white' stop-opacity='.07'/><stop offset='1' stop-color='white' stop-opacity='.02'/></radialGradient>" +
  "<linearGradient id='r' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='white' stop-opacity='.45'/><stop offset='.6' stop-color='white' stop-opacity='.06'/></linearGradient>" +
  // Fades a motif out from the bottom-right corner (used by the priorities grid).
  "<radialGradient id='fg' cx='1' cy='1' r='1'><stop offset='0' stop-color='white'/><stop offset='.55' stop-color='white' stop-opacity='.5'/><stop offset='1' stop-color='white' stop-opacity='0'/></radialGradient>" +
  "<mask id='fade' maskUnits='userSpaceOnUse' x='0' y='0' width='200' height='200'><rect width='200' height='200' fill='url(#fg)'/></mask>" +
  "</defs>";

/** Glass: soft white fill with a light rim. */
const G = "fill='url(#o)' stroke='url(#r)' stroke-width='.8' stroke-linejoin='round'";
/** The dotted line: round dots, 5 apart. */
const D = "fill='none' stroke='white' stroke-opacity='.22' stroke-width='1.1' stroke-dasharray='0 5' stroke-linecap='round' stroke-linejoin='round'";

function star(cx: number, cy: number, r: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? inner : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join(" L")} Z`;
}

function polygon(cx: number, cy: number, r: number, sides: number, turn = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i += 1) {
    const a = turn + (i * 2 * Math.PI) / sides;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${pts.join(" L")} Z`;
}

/** Grid lines every `step` over a box, as one path. */
function grid(x: number, y: number, w: number, h: number, step: number): string {
  let d = "";
  for (let gx = x; gx <= x + w + 0.1; gx += step) d += `M${gx} ${y} V ${y + h} `;
  for (let gy = y; gy <= y + h + 0.1; gy += step) d += `M${x} ${gy} H ${x + w} `;
  return d.trim();
}

const ORB = `<circle cx='176' cy='212' r='90' ${G}/><circle cx='176' cy='212' r='114' ${D}/>`;

export const DECO: Record<string, string> = {
  // Priorities: just a fine grid fading out from the corner, quiet under a list of rows.
  needs: `<path d='${grid(96, 96, 104, 104, 16)}' fill='none' stroke='white' stroke-opacity='.2' stroke-width='.6' mask='url(#fade)'/>`,
  // A target: a glass ring and its bullseye, with a dotted outer ring.
  oneThing: `<circle cx='182' cy='184' r='48' ${G}/><circle cx='182' cy='184' r='16' ${G}/><circle cx='182' cy='184' r='70' ${D}/>`,
  // A flame, with dotted heat rising around it.
  incident: `<g transform='translate(28 26) scale(.8)'><path d='M172 92 C 196 128 236 152 236 198 A 64 64 0 0 1 108 198 C 108 168 128 150 140 132 C 146 150 156 156 162 150 C 168 132 166 112 172 92 Z' ${G}/><path d='M172 58 C 212 110 266 142 266 204 M172 58 C 132 110 80 140 80 204' ${D}/></g>`,
  // A warning sign: a glass triangle with its "!", inside a dotted one.
  risk: `<path d='M164 92 L 240 222 L 88 222 Z' ${G}/><rect x='157' y='138' width='14' height='38' rx='7' ${G}/><circle cx='164' cy='194' r='7' ${G}/><path d='M164 60 L 274 250 L 54 250 Z' ${D}/>`,
  // An hourglass: both bulbs in view, dotted caps.
  waiting: `<g transform='translate(-20 -34)'><path d='M116 112 L 236 112 L 176 172 Z' ${G}/><path d='M176 172 L 236 232 L 116 232 Z' ${G}/><path d='M100 98 H 252 M100 246 H 252' ${D}/></g>`,
  // A calendar page with its binder tabs, weeks in dotted rows.
  agenda: `<rect x='122' y='118' width='104' height='100' rx='16' ${G}/><rect x='142' y='108' width='8' height='18' rx='4' ${G}/><rect x='196' y='108' width='8' height='18' rx='4' ${G}/><path d='M122 142 H 226' stroke='white' stroke-opacity='.18' stroke-width='.8'/><path d='M134 166 H 214 M134 190 H 214' ${D}/>`,
  // An arrow going up, with a dotted launch trail.
  shipped: `<g transform='translate(-6 -22)'><path d='M176 98 L 238 160 L 204 160 L 204 236 L 148 236 L 148 160 L 114 160 Z' ${G}/><path d='M126 246 V 270 M176 246 V 280 M226 246 V 270' ${D}/><path d='M176 60 L 270 154' ${D}/></g>`,
  // A star, ringed with dots.
  firsts: `<path d='${star(162, 168, 66, 28)}' ${G}/><circle cx='162' cy='168' r='90' ${D}/>`,
  // A solved circle with a dotted check through it.
  resolved: `<circle cx='172' cy='176' r='56' ${G}/><path d='M136 176 L 160 200 L 208 150' ${D}/>`,
  // A gavel: glass head and handle over a dotted base.
  decided: `<rect x='110' y='108' width='112' height='52' rx='14' transform='rotate(-35 166 134)' ${G}/><rect x='150' y='150' width='16' height='86' rx='8' transform='rotate(40 158 193)' ${G}/><path d='M96 232 H 216' ${D}/>`,
  // Two people side by side, a dotted arc around them.
  team: `<circle cx='146' cy='176' r='44' ${G}/><circle cx='196' cy='154' r='44' ${G}/><path d='M80 220 A 110 110 0 0 1 250 100' ${D}/>`,
  // Two people, a dotted pass from one to the other.
  handoffs: `<circle cx='118' cy='170' r='32' ${G}/><circle cx='182' cy='122' r='32' ${G}/><path d='M112 134 Q 118 96 152 100' ${D}/>`,
  // A card carried over: a glass page and a dotted bent arrow into it.
  carry: `<rect x='124' y='118' width='96' height='96' rx='16' ${G}/><path d='M80 96 Q 80 166 120 168 M110 158 L 120 168 L 110 178' ${D}/>`,
  // A video call: the screen and its camera, in a dotted frame.
  meetings: `<rect x='92' y='118' width='84' height='64' rx='14' ${G}/><path d='M182 136 L 206 122 L 206 178 L 182 164 Z' ${G}/><rect x='78' y='104' width='146' height='96' rx='22' ${D}/>`,
  // The week rising: a glass sun on a dotted arc (not bars, which would read as data).
  weekArc: `<circle cx='182' cy='170' r='46' ${G}/><path d='M70 210 Q 130 120 230 96' ${D}/>`,
  // A bell with its clapper, dotted rings either side.
  reminders: `<g transform='translate(-12 -38)'><path d='M176 100 C 142 100 126 128 126 166 L 126 196 L 110 218 L 242 218 L 226 196 L 226 166 C 226 128 210 100 176 100 Z' ${G}/><circle cx='176' cy='232' r='14' ${G}/><path d='M104 112 Q 84 146 96 184 M248 112 Q 268 146 256 184' ${D}/></g>`,
  // A train: two glass cars low on a dotted track, under the card's buttons.
  releaseTrain: `<rect x='86' y='178' width='74' height='40' rx='12' ${G}/><rect x='170' y='178' width='74' height='40' rx='12' ${G}/><path d='M60 226 H 270' ${D}/>`,
  // A stop: a glass octagon in a dotted one.
  blockedByMe: `<path d='${polygon(172, 182, 64, 8, Math.PI / 8)}' ${G}/><path d='${polygon(172, 182, 90, 8, Math.PI / 8)}' ${D}/>`,
  // First aid: a glass cross in a dotted ring.
  fleetRecovery: `<path d='M138 102 H 174 V 132 H 204 V 168 H 174 V 198 H 138 V 168 H 108 V 132 H 138 Z' ${G}/><circle cx='156' cy='150' r='84' ${D}/>`,
  // A clear run: a dotted road winding to a glass marker.
  runway: `<g transform='translate(-20 -24)'><path d='M64 112 H 168 A 40 40 0 0 1 168 192 H 120 A 30 30 0 0 0 120 252 H 200' ${D}/></g><circle cx='170' cy='158' r='40' ${G}/>`,
  // Focus: a glass lens on dotted crosshairs.
  focus: `<circle cx='176' cy='168' r='56' ${G}/><path d='M176 112 V 260 M116 168 H 260' ${D}/><circle cx='176' cy='168' r='16' ${G}/>`,
};

/** The motif's SVG for a card kind (the plain orb when the kind has none). */
export function decoSvg(kind: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>${DEFS}${DECO[kind] ?? ORB}</svg>`;
}

/** As a CSS background value, for the card's `--b-deco`. */
export function decoUrl(kind: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(decoSvg(kind))}")`;
}
