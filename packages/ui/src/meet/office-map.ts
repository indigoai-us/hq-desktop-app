import { isAgentUid } from '../shell/mesh-overlay.js';
import type { OfficePerson } from './office-store.svelte.js';
export interface MapRoom { id: string; owner: OfficePerson; members: string[]; }
/** Group only explicitly disclosed rooms. Missing/private membership is never inferred. */
export function officeMapRooms(people: readonly OfficePerson[], selfUid?: string): MapRoom[] {
  const rooms = new Map<string, MapRoom>();
  for (const person of [...people].filter(p => !isAgentUid(p.personUid)).sort((a,b)=>a.personUid===selfUid ? -1 : b.personUid===selfUid ? 1 : a.personUid.localeCompare(b.personUid))) {
    const id = person.room ? `room:${person.room.roomId}` : `office:${person.personUid}`;
    if (!rooms.has(id)) rooms.set(id, { id, owner: person, members: person.room ? [...new Set(person.room.participants)].filter(uid => !isAgentUid(uid)) : [person.personUid] });
  }
  return [...rooms.values()];
}
export function projectFloor(x: number, y: number, angle: number, z = 0): [number, number] {
  const a=angle*Math.PI/180, dx=x-345, dy=y-195;
  const rx=345+dx*Math.cos(a)-dy*Math.sin(a), ry=195+dx*Math.sin(a)+dy*Math.cos(a);
  return [385+(rx-ry)*.78,108+(rx+ry)*.39-z];
}
export function memberLabel(uid: string, resolve: (uid:string)=>string): string {
  const label=resolve(uid)?.trim();
  return label && label!==uid ? label : /^(prs|agt|usr|person)_/i.test(uid) ? 'Team member' : label || 'Team member';
}
export function initials(label: string): string { return label.split(/\s+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase() || '?'; }

export interface OfficeMember { personUid: string; displayName: string; }
export function parseOfficeMembers(value: unknown): OfficeMember[] {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rows = Array.isArray(value) ? value : Array.isArray(body.contacts) ? body.contacts : Array.isArray(body.members) ? body.members : [];
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const r = row as Record<string, unknown>;
    if (typeof r.personUid !== 'string' || isAgentUid(r.personUid) || r.isAgent === true || r.kind === 'agent') return [];
    return [{ personUid: r.personUid, displayName: typeof r.displayName === 'string' ? r.displayName : typeof r.email === 'string' ? r.email : r.personUid }];
  });
}
export function humanOfficePeople(presence: readonly OfficePerson[], members: readonly OfficeMember[], selfUid: string): OfficePerson[] {
  const roster = new Map(presence.filter(p => !isAgentUid(p.personUid)).map(p => [p.personUid, p]));
  for (const uid of [...members.map(m => m.personUid), selfUid]) {
    if (uid && !isAgentUid(uid) && !roster.has(uid)) roster.set(uid, {
      personUid: uid, presenceUnknown: true, connectivity: 'offline', connectivityExpiresAt: null,
      willingness: 'knock', willingnessExpiresAt: null, occupancy: 'unoccupied', occupancyExpiresAt: null,
    });
  }
  return [...roster.values()];
}
