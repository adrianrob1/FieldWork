import { describe, expect, it } from 'vitest';

import { spliceFrontmatter } from '../../src/files/frontmatter.js';
import { hashOf } from '../../src/operations/edit.js';
import { deriveRepositoryIds } from '../../src/operations/register.js';

describe('deriveRepositoryIds', () => {
  it('uses the last path segment as a slug', () => {
    expect(deriveRepositoryIds(['repositories/evon'])).toEqual([
      'resource_repo_evon',
    ]);
    expect(deriveRepositoryIds(['../../repositories/SOAP Bubbles'])).toEqual([
      'resource_repo_soap_bubbles',
    ]);
    expect(deriveRepositoryIds(['D:\\research\\evon-experiments'])).toEqual([
      'resource_repo_evon_experiments',
    ]);
  });

  it('disambiguates repeated last segments in input order', () => {
    expect(deriveRepositoryIds(['a/lib', 'b/lib', 'c/lib'])).toEqual([
      'resource_repo_lib',
      'resource_repo_lib_2',
      'resource_repo_lib_3',
    ]);
  });

  it('falls back to a deterministic hash when no slug remains', () => {
    const [first] = deriveRepositoryIds(['...']);
    const [second] = deriveRepositoryIds(['...']);
    expect(first).toMatch(/^resource_repo_[0-9a-f]{8}$/);
    expect(first).toBe(second);
  });

  it('ignores trailing separators', () => {
    expect(deriveRepositoryIds(['repositories/evon/'])).toEqual([
      'resource_repo_evon',
    ]);
  });
});

describe('spliceFrontmatter', () => {
  it('replaces only the frontmatter and keeps the body bytes', () => {
    const source = '---\na: 1\n---\n\nBody\r\nwith CRLF.\n';
    const spliced = spliceFrontmatter(source, 'b: 2\n');

    expect(spliced).toBe('---\nb: 2\n---\n\nBody\r\nwith CRLF.\n');
  });

  it('returns null when there is no frontmatter block', () => {
    expect(spliceFrontmatter('no frontmatter\n', 'b: 2\n')).toBeNull();
  });

  it('returns null when the frontmatter block is unclosed', () => {
    expect(spliceFrontmatter('---\na: 1\n', 'b: 2\n')).toBeNull();
  });
});

describe('hashOf', () => {
  it('is deterministic over bytes', () => {
    const content = Buffer.from('canonical bytes', 'utf8');
    expect(hashOf(content)).toBe(hashOf(content));
    expect(hashOf(content)).not.toBe(hashOf(Buffer.from('other', 'utf8')));
  });
});
