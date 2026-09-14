import { describe, it, expect } from 'vitest';
import { createTenantStorage } from '@hq/ui';
import { addChannelNotification, readChannelNotifications, saveChannelNotifications } from './channel-notifications';

describe('channel notification history', () => {
  const wake = {channelId:'chan',eventId:'event',createdAt:'2026-09-08T12:00:00Z',absoluteUnread:true,unread:2};
  it('ignores history hydration, own messages and read rollups', () => {
    expect(addChannelNotification([], {...wake,absoluteUnread:false}, 'self','dev')).toEqual([]);
    expect(addChannelNotification([], {...wake,fromPersonUid:'self'}, 'self','dev')).toEqual([]);
    expect(addChannelNotification([], {...wake,unread:0}, 'self','dev')).toEqual([]);
  });
  it('persists read state across restart and deduplicates repeat wakes', () => {
    const data = new Map<string,string>();
    const storage = {getItem:(key:string)=>data.get(key) ?? null,setItem:(key:string,value:string)=>{data.set(key,value);}};
    const rows = addChannelNotification([], wake, 'self', 'dev').map(row=>({...row,status:'read'}));
    saveChannelNotifications(storage, rows);
    const restored = readChannelNotifications(storage);
    expect(restored).toEqual(rows);
    expect(addChannelNotification(restored,wake,'self','dev')).toBe(restored);
    expect(restored[0]).toMatchObject({sourceEventId:'event',status:'read',actorName:'#dev'});
  });
  it('accepts the production native payload containing only channelId and unread', () => {
    const rows = addChannelNotification([], {channelId:'chan',unread:3,absoluteUnread:true}, 'self', 'dev', 1000);
    expect(rows[0]).toMatchObject({id:'local:channel:chan:1000',createdAt:'1970-01-01T00:00:01.000Z',status:'unread'});
  });
  it('keeps persisted notifications isolated between signed-in accounts', () => {
    const data = new Map<string,string>();
    const storage = {getItem:(key:string)=>data.get(key) ?? null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
    const a = createTenantStorage(storage,{accountId:'account-a',companyId:'all'});
    const b = createTenantStorage(storage,{accountId:'account-b',companyId:'all'});
    saveChannelNotifications(a,addChannelNotification([],wake,'self','dev'));
    expect(readChannelNotifications(a)).toHaveLength(1);
    expect(readChannelNotifications(b)).toEqual([]);
  });
  it('bounds history and tolerates unavailable storage', () => {
    const rows = Array.from({length:60},(_,n)=>({id:`local:channel:${n}`}));
    expect(addChannelNotification(rows,wake,'self','dev')).toHaveLength(50);
    const storage = {getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}};
    expect(readChannelNotifications(storage)).toEqual([]);
    expect(()=>saveChannelNotifications(storage,rows)).not.toThrow();
  });
});
