import { describe, expect, test } from 'bun:test';
import { claudeAuthStatusIsLoggedIn } from '../src/cli-providers/providers/claude-code';

describe('claudeAuthStatusIsLoggedIn', () => {
  test('accepts an authenticated the reference agent CLI status response', () => {
    expect(claudeAuthStatusIsLoggedIn('{"loggedIn":true,"authMethod":"oauth"}', 0)).toBe(true);
  });

  test('rejects logged-out, malformed, and failed responses', () => {
    expect(claudeAuthStatusIsLoggedIn('{"loggedIn":false}', 0)).toBe(false);
    expect(claudeAuthStatusIsLoggedIn('not json', 0)).toBe(false);
    expect(claudeAuthStatusIsLoggedIn('{"loggedIn":true}', 1)).toBe(false);
    expect(claudeAuthStatusIsLoggedIn('{"loggedIn":true}', null)).toBe(false);
  });
});
