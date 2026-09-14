import { describe, expect, it } from 'vitest';
import { readQuestionReplies } from './question-replies';
describe('question reply envelopes', () => {
  it('leaves malformed or mixed prose untouched', () => {
    for (const body of ['bad json', '{}', '[]', '[{"question":"Q","answer":42}]']) {
      expect(readQuestionReplies(`<send_user_message_question_reply>${body}</send_user_message_question_reply>`)).toBeNull();
    }
    expect(readQuestionReplies('Example: <send_user_message_question_reply>[]</send_user_message_question_reply>')).toBeNull();
  });
  it('preserves unicode, line breaks and empty answers without exposing metadata', () => {
    const rows = [{ questionItemId: 'secret-internal-id', question: '你好\nNext?', answer: '' }];
    expect(readQuestionReplies(`<send_user_message_question_reply>${JSON.stringify(rows)}</send_user_message_question_reply>`)).toEqual([{ question: '你好\nNext?', answer: '' }]);
  });
});
