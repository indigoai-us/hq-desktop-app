import { invoke } from '@tauri-apps/api/core';

/** Wire shape from the `export_skill_catalog` Tauri command. */
export interface SkillCatalogExport {
  skillsAvailable: number;
  renderedBytes: number;
  body: string;
}

/** Load the bounded HQ skill catalog for Claude Code Desktop bootstrap. */
export async function fetchSkillCatalog(
  companySlug?: string | null,
): Promise<SkillCatalogExport> {
  return invoke<SkillCatalogExport>('export_skill_catalog', {
    companySlug: companySlug ?? null,
  });
}

/** Prefix a Claude handoff prompt with the compact skill catalog block. */
export function prefixPromptWithSkillCatalog(
  prompt: string,
  catalog: SkillCatalogExport,
): string {
  const body = catalog.body.trim();
  if (!body) return prompt;
  return ['<!-- hq-section: skill-catalog -->', body, '', prompt].join('\n');
}

/** Fetch catalog + prefix in one call for Claude Code deep links. */
export async function buildClaudePromptWithSkillCatalog(
  prompt: string,
  companySlug?: string | null,
): Promise<string> {
  try {
    const catalog = await fetchSkillCatalog(companySlug);
    return prefixPromptWithSkillCatalog(prompt, catalog);
  } catch (error) {
    console.warn('skill catalog export failed; launching without catalog prefix', error);
    return prompt;
  }
}
