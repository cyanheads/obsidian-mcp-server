/**
 * @fileoverview Unit tests for the pseudo-tag filter used by `listTags` to drop
 * CSS color literals that Obsidian's tag tokenizer surfaces from prose/code.
 * @module tests/services/obsidian-pseudo-tag.test
 */

import { describe, expect, it } from 'vitest';
import { isObsidianPseudoTag } from '@/services/obsidian/obsidian-service.js';

describe('isObsidianPseudoTag', () => {
  it('filters 6- and 8-digit hex color literals', () => {
    for (const t of ['ffffff', 'FFFFFF', '00ff00', 'deadbe', 'ffffffff', '00ff00ff']) {
      expect(isObsidianPseudoTag(t)).toBe(true);
    }
  });

  it('strips a leading "#" before testing', () => {
    expect(isObsidianPseudoTag('#ffffff')).toBe(true);
  });

  it('keeps 3-hex names and pure-numeric / year tags', () => {
    for (const t of ['fff', 'ace', 'bad', 'fed', '2024', '1984', '42']) {
      expect(isObsidianPseudoTag(t)).toBe(false);
    }
  });

  it('keeps ordinary and hierarchical tags', () => {
    for (const t of ['project', 'work/tasks', 'cafe', 'decade-review']) {
      expect(isObsidianPseudoTag(t)).toBe(false);
    }
  });
});
