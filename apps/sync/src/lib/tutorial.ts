export const TUTORIAL_FIRST_LESSON_URL =
  'https://www.hqforwork.com/getting-started/tutorials/install-hq-macos';

export function tutorialUrl(source: string): string {
  const url = new URL(TUTORIAL_FIRST_LESSON_URL);
  url.searchParams.set('source', source);
  return url.toString();
}
