/** Prompt a native session uses to turn a seed into a full Board/PRD task. */

export function boardTaskGeneratePrompt(input: {
  title: string;
  description: string;
  projectId: string;
}): string {
  const description = input.description.trim() || "(none)";
  return [
    "Generate a full HQ project Board task (PRD user story) for this project.",
    `Project: ${input.projectId}`,
    "",
    "The two fields below are a starting point, not the finished task.",
    `Title seed: ${input.title.trim()}`,
    `Description seed: ${description}`,
    "",
    "Write a real executable story: stable id (next US-00N if that scheme is in use), description, acceptanceCriteria[], and priority.",
    "Persist it on the live work-mesh Board / project PRD so other members see it.",
    "Do not leave a UUID stub with empty acceptance criteria.",
    "When the story is on the Board, stop. Do not wait for further operator input.",
  ].join("\n");
}

export function messageTaskGeneratePrompt(input: {
  projectId: string;
  messageBody: string;
  notes: string;
  thread: Array<{ author: string; body: string }>;
}): string {
  const thread = input.thread
    .slice(-12)
    .map((row) => `- ${row.author}: ${row.body}`)
    .join("\n");
  const notes = input.notes.trim() || "(none)";
  return [
    "Generate a full HQ project Board task (PRD user story) from this channel message.",
    `Project: ${input.projectId}`,
    "",
    "Source message:",
    input.messageBody.trim() || "(empty)",
    "",
    "Operator notes:",
    notes,
    "",
    "Recent channel thread (context):",
    thread || "(none)",
    "",
    "Write a real executable story: stable id, description, acceptanceCriteria[], priority.",
    "Persist it on the live work-mesh Board / project PRD.",
    "Do not leave a UUID stub with empty acceptance criteria.",
    "When the story is on the Board, stop. Do not wait for further operator input.",
  ].join("\n");
}
