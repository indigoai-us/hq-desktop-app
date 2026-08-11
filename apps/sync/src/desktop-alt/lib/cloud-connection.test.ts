import { describe, expect, it } from 'vitest';
import {
  CLOUD_PAUSED_STORAGE_KEY,
  CLOUD_PAUSED_CHANGED_EVENT,
  parseCloudPaused,
} from './cloud-connection';

describe('hq-desktop-v2 US-001: Cloud Connected/Off flag', () => {
  it('parses only explicit paused markers — anything else means connected', () => {
    expect(parseCloudPaused('1')).toBe(true);
    expect(parseCloudPaused('true')).toBe(true);
    expect(parseCloudPaused('0')).toBe(false);
    expect(parseCloudPaused('false')).toBe(false);
    expect(parseCloudPaused('')).toBe(false);
    expect(parseCloudPaused(null)).toBe(false);
  });

  it('pins the storage/event contract Overview consumes in a later story', () => {
    expect(CLOUD_PAUSED_STORAGE_KEY).toBe('hq-sync.desktop.cloud-paused.v1');
    expect(CLOUD_PAUSED_CHANGED_EVENT).toBe('hq:cloud-paused-changed');
  });
});
