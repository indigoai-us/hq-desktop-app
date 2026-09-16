import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readIfExists(p: string): string {
  try {
    return readFileSync(resolve(process.cwd(), p), 'utf8');
  } catch {
    return '';
  }
}
const desktopAltCommand =
  readIfExists('src-tauri/src/commands/desktop_alt.rs') +
  '\n' +
  readIfExists('../../crates/hq-desktop-core/src/desktop_alt.rs');
const tauriMain = readFileSync(resolve(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');
const desktopAltCapability = readFileSync(
  resolve(process.cwd(), 'src-tauri/capabilities/desktop-alt.json'),
  'utf8',
);

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-011: Deployments panel reads hq-deploy subdomains via Tauri command', () => {

  it('returns the prototype DeploymentEntry shape from hq-deploy reuse-as-is with Cognito bearer auth', () => {
    const command = normalize(desktopAltCommand);

    expect(command).toContain('pub struct DeploymentEntry { pub sub: String, pub url: String, pub state: String, pub last_deploy: String, pub size: String, pub ver: String, pub pwd: bool, }');
    expect(command).toContain('pub async fn get_company_deployments(slug: String) -> Result<Vec<DeploymentEntry>, String>');
    expect(command).toContain('let slug = normalize_slug(&slug)?;');
    expect(command).toContain('const HQ_DEPLOY_API_BASE: &str = "https://api.indigo-hq.com";');
    expect(command).toContain('let url = deployments_url(HQ_DEPLOY_API_BASE);');
    expect(command).toContain('format!("{}/api/apps", base.trim_end_matches(\'/\'))');
    expect(command).toContain('let token = cognito::get_valid_access_token() .await .map_err(|e| format!("auth: {e}"))?;');
    expect(command).toContain('.header("authorization", format!("Bearer {token}"))');
    expect(command).toContain('.header("x-org-slug", &slug)');
    expect(command).toContain('parse_deployments_response(status, &text, &slug)');
  });

  it('uses the selected company slug to scope hq-deploy requests and filter compatible responses', () => {
    const command = normalize(desktopAltCommand);

    expect(command).toContain('.header("x-org-slug", &slug)');
    expect(command).toContain('fn parse_deployments_response( status: StatusCode, text: &str, selected_slug: &str, ) -> Result<Vec<DeploymentEntry>, String>');
    expect(command).toContain('.filter(|row| deployment_matches_selected_slug(row, selected_slug))');
    expect(command).toContain('fn deployment_org_slug(value: &serde_json::Value) -> Option<String>');
    expect(command).toContain('string_field(value, &["orgSlug", "org_slug"])');
    expect(command).toContain('string_field(org, &["slug", "orgSlug", "org_slug"])');
    expect(command).toContain('.unwrap_or(true)');
    expect(command).toContain('fn company_deployments_filters_rows_with_org_slug_when_present()');
  });
});
