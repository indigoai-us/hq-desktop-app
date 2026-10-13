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

const ORB = `<circle cx='176' cy='212' r='90' ${G}/><circle cx='176' cy='212' r='114' ${D}/>`;

export const DECO: Record<string, string> = {
  // A checklist: three glass rows stepping down, held in a dotted frame.
  needs: `<rect x='122' y='112' width='120' height='26' rx='13' ${G}/><rect x='106' y='148' width='136' height='26' rx='13' ${G}/><rect x='90' y='184' width='152' height='26' rx='13' ${G}/><rect x='74' y='96' width='180' height='130' rx='26' ${D}/>`,
  // A target: a glass ring and its bullseye, with a dotted outer ring.
  oneThing: `<circle cx='180' cy='196' r='62' ${G}/><circle cx='180' cy='196' r='22' ${G}/><circle cx='180' cy='196' r='88' ${D}/>`,
  // A flame, with dotted heat rising around it.
  incident: `<path d='M172 92 C 196 128 236 152 236 198 A 64 64 0 0 1 108 198 C 108 168 128 150 140 132 C 146 150 156 156 162 150 C 168 132 166 112 172 92 Z' ${G}/><path d='M172 58 C 212 110 266 142 266 204 M172 58 C 132 110 80 140 80 204' ${D}/>`,
  // A warning triangle inside a dotted one.
  risk: `<path d='M176 96 L 258 236 L 94 236 Z' ${G}/><path d='M176 62 L 290 258 L 62 258 Z' ${D}/>`,
  // An hourglass: two glass triangles meeting at the waist, dotted caps.
  waiting: `<path d='M116 112 L 236 112 L 176 172 Z' ${G}/><path d='M176 172 L 236 232 L 116 232 Z' ${G}/><path d='M100 98 H 252 M100 246 H 252' ${D}/>`,
  // A calendar page, its weeks in dotted rows.
  agenda: `<rect x='96' y='104' width='150' height='140' rx='18' ${G}/><path d='M96 136 H 246' stroke='white' stroke-opacity='.18' stroke-width='.8'/><path d='M112 160 H 236 M112 184 H 236 M112 208 H 236' ${D}/>`,
  // An arrow going up, with a dotted launch trail.
  shipped: `<path d='M176 98 L 238 160 L 204 160 L 204 236 L 148 236 L 148 160 L 114 160 Z' ${G}/><path d='M126 246 V 270 M176 246 V 280 M226 246 V 270' ${D}/><path d='M176 60 L 270 154' ${D}/>`,
  // A star, ringed with dots.
  firsts: `<path d='${star(178, 194, 72, 30)}' ${G}/><circle cx='178' cy='194' r='96' ${D}/>`,
  // A solved circle with a dotted check through it.
  resolved: `<circle cx='182' cy='196' r='64' ${G}/><path d='M118 190 L 160 232 L 248 144' ${D}/>`,
  // A gavel: the glass head and a dotted handle.
  decided: `<rect x='128' y='104' width='112' height='52' rx='14' transform='rotate(-35 184 130)' ${G}/><path d='M164 162 L 86 256' ${D}/><path d='M110 236 H 230' ${D}/>`,
  // Two people side by side, a dotted arc around them.
  team: `<circle cx='150' cy='204' r='50' ${G}/><circle cx='214' cy='178' r='50' ${G}/><path d='M86 230 A 110 110 0 0 1 270 120' ${D}/>`,
  // Two people, a dotted pass from one to the other.
  handoffs: `<circle cx='128' cy='212' r='40' ${G}/><circle cx='218' cy='146' r='40' ${G}/><path d='M140 166 Q 150 116 196 104' ${D}/>`,
  // A card carried over: a glass page and a dotted bent arrow into it.
  carry: `<rect x='150' y='140' width='100' height='100' rx='18' ${G}/><path d='M86 92 Q 86 186 150 190' ${D}/>`,
  // A video call: the screen and its camera.
  meetings: `<rect x='98' y='124' width='122' height='92' rx='16' ${G}/><path d='M226 152 L 262 130 L 262 210 L 226 188 Z' ${G}/><rect x='82' y='108' width='154' height='124' rx='24' ${D}/>`,
  // A week climbing: glass bars and the dotted trend over them.
  weekArc: `<rect x='98' y='182' width='26' height='60' rx='8' ${G}/><rect x='134' y='154' width='26' height='88' rx='8' ${G}/><rect x='170' y='124' width='26' height='118' rx='8' ${G}/><rect x='206' y='94' width='26' height='148' rx='8' ${G}/><path d='M84 166 L 126 138 L 162 110 L 198 82 L 240 52' ${D}/>`,
  // A bell, with dotted rings either side.
  reminders: `<path d='M176 100 C 142 100 126 128 126 166 L 126 196 L 110 218 L 242 218 L 226 196 L 226 166 C 226 128 210 100 176 100 Z' ${G}/><circle cx='176' cy='232' r='14' ${G}/><path d='M104 112 Q 84 146 96 184 M248 112 Q 268 146 256 184' ${D}/>`,
  // A train: two glass cars on a dotted track.
  releaseTrain: `<rect x='86' y='150' width='74' height='54' rx='12' ${G}/><rect x='170' y='150' width='74' height='54' rx='12' ${G}/><path d='M60 222 H 270' ${D}/>`,
  // A stop: a glass octagon in a dotted one.
  blockedByMe: `<path d='${polygon(180, 194, 64, 8, Math.PI / 8)}' ${G}/><path d='${polygon(180, 194, 90, 8, Math.PI / 8)}' ${D}/>`,
  // First aid: a glass cross in a dotted ring.
  fleetRecovery: `<path d='M162 112 H 198 V 160 H 246 V 196 H 198 V 244 H 162 V 196 H 114 V 160 H 162 Z' ${G}/><circle cx='180' cy='178' r='92' ${D}/>`,
  // A clear run: a dotted road winding to a glass marker.
  runway: `<path d='M64 112 H 168 A 40 40 0 0 1 168 192 H 120 A 30 30 0 0 0 120 252 H 200' ${D}/><circle cx='206' cy='190' r='34' ${G}/>`,
  // Focus: a glass lens on dotted crosshairs.
  focus: `<circle cx='180' cy='192' r='56' ${G}/><path d='M180 100 V 284 M88 192 H 272' ${D}/><circle cx='180' cy='192' r='16' ${G}/>`,
};

/** The motif's SVG for a card kind (the plain orb when the kind has none). */
export function decoSvg(kind: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>${DEFS}${DECO[kind] ?? ORB}</svg>`;
}

/** As a CSS background value, for the card's `--b-deco`. */
export function decoUrl(kind: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(decoSvg(kind))}")`;
}
