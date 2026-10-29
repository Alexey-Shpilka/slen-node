import { afterEach, describe, expect, it, vi } from 'vitest';
import { Slen } from '../src/slen.js';
import { resolveConfig } from '../src/config.js';
import { FakeFetch } from '../src/testing/index.js';
import { PACKAGE } from './paths.js';

// No `@types/node` in the package: the members of `node:fs` used here are described structurally.
interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
}

const NODE_FS: string = 'node:fs';
const fs = (await import(NODE_FS)) as NodeFs;

/**
 * The environment is read in one place and under one name, `SLEN_API_KEY`; nothing for the host:
 * `SLEN_BASE_URL` is not read either. A process that sets any other name configures nothing.
 */
describe('the environment a client reads', () => {
  const NAMES = ['SLEN_API_KEY', 'SLEN_BASE_URL'];

  function nothingSet(): void {
    for (const name of NAMES) {
      vi.stubEnv(name, undefined);
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('takes the key from SLEN_API_KEY, and never the host from SLEN_BASE_URL', async () => {
    nothingSet();
    vi.stubEnv('SLEN_API_KEY', 'sl_live_from_env');
    vi.stubEnv('SLEN_BASE_URL', 'https://api.test/');

    const config = resolveConfig({});

    expect(config.apiKey).toBe('sl_live_from_env');
    expect(config.baseUrl).toBe('https://api.slen.ai');

    const http = new FakeFetch().push({ body: { status: 'ok' } });

    await new Slen({ fetch: http.fetch }).health();

    expect(http.last()?.url).toBe('https://api.slen.ai/api/health');
    expect(http.last()?.headers['authorization']).toBe('Bearer sl_live_from_env');
  });

  it('is read by src/config.ts alone, under the one name SLEN_API_KEY', () => {
    const source = new URL('src/', PACKAGE);
    const readers = fs
      .readdirSync(source, { recursive: true })
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /\.env\b|\bfromEnv\(/.test(fs.readFileSync(new URL(file, source), 'utf8')))
      .sort();
    const config = fs.readFileSync(new URL('config.ts', source), 'utf8');

    expect(readers).toEqual(['config.ts']);
    expect([...config.matchAll(/\bfromEnv\(([^)]*)\)/g)].map((call) => call[1])).toEqual(["'SLEN_API_KEY'", 'name: string']);
    expect(config.match(/\.env\b/g)).toHaveLength(1);
  });

  it('puts what the options say before what the environment says', () => {
    nothingSet();
    vi.stubEnv('SLEN_API_KEY', 'sl_live_from_env');
    vi.stubEnv('SLEN_BASE_URL', 'https://api.test');

    const config = resolveConfig({ apiKey: 'sl_live_option', baseUrl: 'https://eu.slen.example/' });

    expect(config.apiKey).toBe('sl_live_option');
    expect(config.baseUrl).toBe('https://eu.slen.example');
  });

  it('names SLEN_API_KEY when there is no key at all', () => {
    nothingSet();

    expect(() => new Slen({})).toThrow(/set SLEN_API_KEY/);
  });
});
