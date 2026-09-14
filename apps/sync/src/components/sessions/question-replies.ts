export interface QuestionReply { question: string; answer: string }

/** Decode only a complete protocol envelope, never examples embedded in prose. */
export function readQuestionReplies(text: string): QuestionReply[] | null {
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return null;
  try {
    const rows: unknown = JSON.parse(match[1]);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    if (!rows.every((row) => row && typeof row.question === 'string' && typeof row.answer === 'string')) return null;
    return rows.map(({ question, answer }) => ({ question, answer }));
  } catch { return null; }
}
