import { renderInline } from './markdown';

export function renderMessageBodyMarkdown(body: string): string {
  return renderInline(body);
}
