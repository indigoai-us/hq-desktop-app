import { describe,it,expect } from 'vitest';
import {parseConversation,conversationElapsed,formatConversationTime} from './conversation';
const base={conversationId:'conversation-a',state:'active' as const,startedAt:1000,activeSince:5000,pausedAt:null,elapsedMs:2000,endedAt:null};
describe('conversation projection',()=>{
 it('counts only active intervals and tolerates a skewed clock',()=>{
 expect(conversationElapsed(base,7000)).toBe(4000);
 expect(conversationElapsed(base,4000)).toBe(2000);
 expect(conversationElapsed({...base,state:'paused'},9000)).toBe(2000);
 });
 it('rejects corrupt authority instead of starting a timer',()=>{
 expect(parseConversation({...base,elapsedMs:NaN})).toBeNull();
 expect(parseConversation({...base,state:'unknown'})).toBeNull();
 expect(parseConversation(base)).toEqual(base);
 expect(formatConversationTime(125000)).toBe('02:05');
 });
});
