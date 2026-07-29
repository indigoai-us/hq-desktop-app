import { renderMarkdown } from './markdown';

export function renderMessageBodyMarkdown(body: string): string {
  return renderMarkdown(body);
}
