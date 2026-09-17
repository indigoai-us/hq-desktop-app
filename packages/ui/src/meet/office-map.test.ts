import {describe,it,expect} from 'vitest';
import {officeMapRooms,projectFloor,humanOfficePeople,parseOfficeMembers} from './office-map.js';
import type {OfficePerson} from './office-store.svelte.js';
const person=(personUid:string,room?:OfficePerson['room']):OfficePerson=>({personUid,connectivity:'online',connectivityExpiresAt:null,willingness:'knock',willingnessExpiresAt:null,occupancy:room?'occupied':'unoccupied',occupancyExpiresAt:null,...(room?{room}:{})});
describe('spatial office',()=>{
 it('groups the same disclosed room once without inventing hidden membership',()=>{const room={roomId:'r',callId:'c',epoch:1,participants:['a','b']};const rooms=officeMapRooms([person('b',room),person('a',room),person('hidden')]);expect(rooms).toHaveLength(2);expect(rooms[0].members).toEqual(['a','b']);expect(rooms[1].members).toEqual(['hidden']);});
 it('is stable across roster ordering',()=>{const a=person('a'),b=person('b');expect(officeMapRooms([a,b])).toEqual(officeMapRooms([b,a]));});
 it('rotates geometry around its center while keeping vertical height independent',()=>{expect(projectFloor(345,195,90)).toEqual(projectFloor(345,195,0));const a=projectFloor(500,200,0),b=projectFloor(500,200,90);expect(b).not.toEqual(a);expect(projectFloor(500,200,360)[0]).toBeCloseTo(a[0]);expect(projectFloor(500,200,90,20)[1]).toBeCloseTo(b[1]-20);});
});

it('uses real humans, includes self and gives directory-only people no live room access',()=>{
 const members=parseOfficeMembers({contacts:[{personUid:'prs_b',displayName:'Bea'},{personUid:'agt_bot',displayName:'Bot'}]});
 const people=humanOfficePeople([person('agt_other')],members,'prs_self');
 expect(people.map(p=>p.personUid)).toEqual(['prs_b','prs_self']);
 expect(people.every(p=>p.presenceUnknown && p.connectivity==='offline' && !p.room)).toBe(true);
 expect(officeMapRooms(people,'prs_self')[0].owner.personUid).toBe('prs_self');
});
