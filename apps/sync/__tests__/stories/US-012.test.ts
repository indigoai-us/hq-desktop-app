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

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

function blockFrom(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return source.slice(startIndex, endIndex);
}

describe('US-012: Secrets panel reads metadata only with no plaintext values', () => {

  it('returns only env/count/items metadata from the Tauri command and registers no plaintext DTO fields', () => {
    const command = normalize(desktopAltCommand);

    expect(command).toContain('pub struct SecretItem { pub key: String, pub upd: String, pub rot: String, }');
    expect(command).toContain('pub struct SecretEnv { pub env: String, pub count: usize, pub items: Vec<SecretItem>, }');
    expect(command).toContain('pub async fn get_company_secrets(slug: String) -> Result<Vec<SecretEnv>, String>');
    expect(command).toContain('SecretEnv { env, count: items.len(), items, }');
    expect(command).toContain('grouped.entry(env).or_default().push(SecretItem { key, upd: secret_updated_at(row), rot: secret_rotation(row), });');
    expect(command).toContain('let serialized = serde_json::to_value(&envs).unwrap();');
    expect(command).toContain('assert!(!serialized_text.contains("\\\"value\\\""));');
    expect(command).toContain('assert!(!serialized_text.contains("\\\"secret\\\""));');
    expect(command).toContain('assert!(serialized.get(0).unwrap().get("value").is_none());');
  });

  it('uses a metadata-list GET endpoint and does not call a fetch-secret/value endpoint', () => {
    const getCompanySecrets = normalize(
      blockFrom(
        desktopAltCommand,
        'pub async fn get_company_secrets(slug: String) -> Result<Vec<SecretEnv>, String>',
        '/// Open or focus the desktop workspace window.',
      ),
    );
    const urlBuilder = normalize(
      blockFrom(desktopAltCommand, 'fn secrets_url(base: &str, company_uid: &str)', 'fn parse_board_response'),
    );

    expect(getCompanySecrets).toContain('let url = secrets_url(&vault_base()?, &company_uid)?;');
    expect(getCompanySecrets).toContain('build_client() .get(&url)');
    expect(getCompanySecrets).toContain('parse_secrets_response(status, &text)');
    expect(urlBuilder).toContain('format!( "{}/secrets/{}", base.trim_end_matches(\'/\'), company_uid )');
    expect(getCompanySecrets).not.toMatch(/\.(post|put|patch)\s*\(/);
    expect(getCompanySecrets).not.toMatch(/fetch[_-]?secret|read[_-]?secret|get[_-]?secret[_-]?value/i);
    expect(urlBuilder).not.toMatch(/\/secret\/|\/value|\/reveal|\/decrypt/i);
  });
});
