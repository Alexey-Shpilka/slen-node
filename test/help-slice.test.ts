import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type SlenConfig } from '../src/config.js';
import * as published from '../src/index.js';
import { CONTRACT, PACKAGE } from './paths.js';

/**
 * The help slice of this package — `help-slice.json` — is
 * what the code says today.
 *
 * The console's Help & Docs section prints the options of the client, names
 * methods in prose and anchors articles to symbols, and it reads all of that
 * from the slice (through its own snapshot), never from this source tree. So a
 * stale slice is a reference that lies. `scripts/export-help-slice.mjs` builds
 * the slice; this suite builds it again on every run and compares.
 *
 * "Committed equals fresh" alone would only prove that the exporter is
 * repeatable, so the rest of the file holds what the exporter says against the
 * package by another road than the exporter's own: the members of
 * `SlenOptions` are read off the source, the defaults and the environment
 * variables are asked of `resolveConfig()`, the symbols are compared with the
 * names the text of `src/index.ts` exports and with what it exports at run
 * time, and the calls are walked on a real client, resource by resource.
 *
 * The shape of the slice is described in `AGENTS.md` ("The help slice").
 * When this suite is red after a change to the SDK: regenerate
 * (`node scripts/export-help-slice.mjs --write`, from the package),
 * commit the slice with the change, and re-run the console's `help-sync`.
 */

// ---------------------------------------------------------------------------
// The files and the process. The package has no `@types/node`: the members of
// the Node modules used here are described structurally and the modules are
// loaded through specifiers the compiler does not try to resolve (as in
// `contract.test.ts`).

interface NodeFs {
  readFileSync(path: string | URL, encoding: 'utf8'): string;
  readdirSync(path: string | URL, options: { recursive: true }): string[];
  writeFileSync(path: string, text: string): void;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, options: { recursive: true; force: true }): void;
}

interface NodeChildProcess {
  spawnSync(
    command: string,
    args: string[],
    options: { encoding: 'utf8' },
  ): { status: number | null; stdout: string; stderr: string };
}

interface NodeOs {
  tmpdir(): string;
}

interface NodeProcess {
  execPath: string;
  env: Record<string, string | undefined>;
}

const NODE_FS: string = 'node:fs';
const NODE_CHILD_PROCESS: string = 'node:child_process';
const NODE_OS: string = 'node:os';

const fs = (await import(NODE_FS)) as NodeFs;
const childProcess = (await import(NODE_CHILD_PROCESS)) as NodeChildProcess;
const os = (await import(NODE_OS)) as NodeOs;

function node(): NodeProcess {
  const found = (globalThis as { process?: NodeProcess }).process;

  if (found === undefined) {
    throw new Error('The slice is exported on Node: there is no process here.');
  }

  return found;
}

// ---------------------------------------------------------------------------
// The slice, as `AGENTS.md` describes it.

interface Fallback {
  code: string;
  value?: unknown;
}

interface Option {
  name: string;
  type: string;
  required: boolean;
  default: Fallback | null;
  default_known: boolean;
  env: string[];
  description: string | null;
}

interface Call {
  name: string;
  symbol: string | null;
  member: string;
  deprecated: boolean;
  internal: boolean;
  signature: string;
  /** `METHOD /path` — the line of the call in `contract/calls.json` — or `null` for a call that makes no request. */
  operation: string | null;
}

interface Member {
  name: string;
  kind: string;
  static: boolean;
  optional: boolean;
  deprecated: boolean;
  internal: boolean;
  signature: string;
}

interface SymbolEntry {
  name: string;
  kind: 'class' | 'enum' | 'function' | 'const' | 'interface' | 'type';
  source: string;
  deprecated: boolean;
  internal: boolean;
  alias_of: string | null;
  modifiers: string[];
  type_parameters: string[];
  extends: string[];
  implements: string[];
  signature: string | null;
  members: Member[];
}

interface Slice {
  schema: number;
  language: string;
  package: {
    name: string;
    version: string | null;
    manifest: string;
    runtime: { name: string; constraint: string | null };
    dependencies: Array<{ name: string; constraint: string; optional: boolean }>;
  };
  client: { class: string; options: string };
  options: Option[];
  config_file: null;
  calls: Call[];
  symbols: SymbolEntry[];
}

interface Io {
  out(text: string): void;
  err(text: string): void;
}

interface Exporter {
  SCHEMA: number;
  SLICE_FILE: string;
  buildSlice(): Slice;
  render(slice: Slice): string;
  differences(committed: string, fresh: string): string[];
  main(argv: string[], io?: Io): number;
}

const SCRIPT = new URL('scripts/export-help-slice.mjs', PACKAGE);
const COMMITTED_FILE = new URL('help-slice.json', PACKAGE);
/** The package: the slice names its sources relative to it. */
const SOURCES = PACKAGE;
const ROOT = SOURCES.pathname.replace(/\/$/, '');

const exporter = (await import(/* @vite-ignore */ SCRIPT.href)) as Exporter;

const FRESH = exporter.render(exporter.buildSlice());
const SLICE = JSON.parse(FRESH) as Slice;

function committed(): string {
  return fs.readFileSync(COMMITTED_FILE, 'utf8');
}

/** The command line, run in this process: its exit code and what it said. */
function run(...argv: string[]): { code: number; out: string; err: string } {
  const said = { out: '', err: '' };
  const code = exporter.main(argv, {
    out: (text) => {
      said.out += text;
    },
    err: (text) => {
      said.err += text;
    },
  });

  return { code, ...said };
}

/** Runs `body` with a scratch file that is gone afterwards. */
function withScratchFile<T>(body: (file: string) => T): T {
  const directory = fs.mkdtempSync(`${os.tmpdir()}/help-slice-`);

  try {
    return body(`${directory}/help-slice.json`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Order by code unit — the order the slice is sorted in. */
function sorted(texts: readonly string[]): string[] {
  return [...texts].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sourceFile(relative: string): ts.SourceFile {
  const url = new URL(`../${relative}`, import.meta.url);

  return ts.createSourceFile(url.pathname, fs.readFileSync(url, 'utf8'), ts.ScriptTarget.ES2022, true);
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isHidden(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];

  // A `#field` is private at run time too: the declarations do not publish it.
  if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) {
    return true;
  }

  return modifiers.some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

/** `./modules/customers/customers.js`, written in `src/slen.ts` → `src/modules/customers/customers.ts`. */
function moduleFile(from: string, specifier: ts.Expression | undefined): string {
  if (specifier === undefined || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) {
    throw new Error(`${from} names a module this suite cannot follow: ${specifier?.getText() ?? '(none)'}`);
  }

  const parts = from.split('/').slice(0, -1);

  for (const part of specifier.text.replace(/\.js$/, '.ts').split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.') {
      parts.push(part);
    }
  }

  return parts.join('/');
}

/**
 * What a file declares with `export` — not what it passes on from another
 * module: the name, and whether it can stand where a type is written (an
 * interface, a type alias, a class, an enum).
 */
function declaredExports(relative: string): Array<{ name: string; type: boolean }> {
  const declared: Array<{ name: string; type: boolean }> = [];

  for (const statement of sourceFile(relative).statements) {
    if (ts.isExportAssignment(statement)) {
      throw new Error(`${relative} has a default export: teach this suite what it is called.`);
    }

    if (ts.isExportDeclaration(statement) || !isExported(statement)) {
      continue;
    }

    if (ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      throw new Error(`${relative} has a default export: teach this suite what it is called.`);
    }

    if (ts.isVariableStatement(statement)) {
      declared.push(...statement.declarationList.declarations.map((declaration) => ({ name: declaration.name.getText(), type: false })));
    } else if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      declared.push({ name: statement.name.text, type: !ts.isFunctionDeclaration(statement) });
    } else {
      throw new Error(`${relative} exports something this suite cannot name: ${statement.getText().slice(0, 80)}`);
    }
  }

  return declared;
}

/**
 * The names a module exports, read off its text and nothing else: the names
 * of `export { a, type b, c as d }`, what the file declares with `export`,
 * and — for `export * from` — the same of the file it names. No compiler
 * resolves anything here: this is the list a person reads in `src/index.ts`.
 */
function exportedNames(relative: string): string[] {
  const names = declaredExports(relative).map((declared) => declared.name);

  for (const statement of sourceFile(relative).statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    if (statement.exportClause === undefined) {
      names.push(...exportedNames(moduleFile(relative, statement.moduleSpecifier)));
    } else if (ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
    } else {
      throw new Error(`${relative} exports a namespace (${statement.getText()}): teach this suite what its names are.`);
    }
  }

  return names;
}

/** Every `.ts` file of `src/`, as `src/…`. */
function sourceFiles(): string[] {
  return sorted(
    fs
      .readdirSync(new URL('../src', import.meta.url), { recursive: true })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => `src/${file}`),
  );
}

// ---------------------------------------------------------------------------

describe('the committed help slice', () => {
  it('is what the exporter builds from the tree as it is now', () => {
    const file = committed();

    // The first line names the entities that differ; the second holds the bytes.
    expect(exporter.differences(file, FRESH)).toEqual([]);
    expect(file).toBe(FRESH);
  });

  it('is what the command prints, to the byte, with nothing about the machine in it', () => {
    const printed = childProcess.spawnSync(node().execPath, [SCRIPT.pathname], { encoding: 'utf8' });

    expect(printed.stderr).toBe('');
    expect(printed.status).toBe(0);
    // A second process, a second build: the output does not depend on the run.
    expect(printed.stdout).toBe(FRESH);
    // Booleans, not `toContain`: a failure should not print the whole slice.
    expect(printed.stdout.includes(`${ROOT}/`), 'the slice names a path of this machine').toBe(false);
    expect(printed.stdout.endsWith('}\n'), 'the slice ends with one line break').toBe(true);
    expect(printed.stdout.includes('\r'), 'the slice has LF line ends').toBe(false);
  });

  it('keeps its keys and its lists in the order its readers are told', () => {
    expect(Object.keys(SLICE)).toEqual(['schema', 'language', 'package', 'client', 'options', 'config_file', 'calls', 'symbols']);
    expect(SLICE.schema).toBe(exporter.SCHEMA);
    expect(SLICE.language).toBe('node');
    expect(SLICE.config_file).toBeNull();

    expect(SLICE.symbols.map((symbol) => symbol.name)).toEqual(sorted(SLICE.symbols.map((symbol) => symbol.name)));
    expect(SLICE.calls.map((call) => call.name)).toEqual(sorted(SLICE.calls.map((call) => call.name)));
    expect(SLICE.package.dependencies.map((one) => one.name)).toEqual(sorted(SLICE.package.dependencies.map((one) => one.name)));
  });
});

describe('the command line of the exporter', () => {
  it('--check passes on the committed slice', () => {
    expect(run('--check')).toEqual({ code: 0, out: '', err: '' });
  });

  it('--check fails on a stale slice and names what moved', () => {
    const stale = JSON.parse(FRESH) as Slice;
    const dropped = stale.options.pop();
    const changed = stale.calls[0];

    if (dropped === undefined || changed === undefined) {
      throw new Error('The slice has no options or no calls to make stale.');
    }

    changed.signature = 'something else';
    // A name no option can have, so the stale entry is never a real one.
    stale.options.push({ ...dropped, name: 'gone since' });
    stale.package.version = '0.0.0';

    withScratchFile((file) => {
      fs.writeFileSync(file, exporter.render(stale));

      const checked = run('--check', '--out', file);

      expect(checked.code).toBe(1);
      expect(checked.out).toBe('');
      expect(checked.err).toContain('help-slice.json is not what the code says now');
      expect(checked.err).toContain(`+ options: ${dropped.name}`);
      expect(checked.err).toContain('- options: gone since');
      expect(checked.err).toContain(`~ calls: ${changed.name}`);
      expect(checked.err).toContain('~ package');
      expect(checked.err).toContain('--write');
      // Nothing about the rest: one line per entity that moved.
      expect(checked.err).not.toContain('symbols');
    });
  });

  it('--check fails on a slice that is not there', () => {
    withScratchFile((file) => {
      const checked = run('--check', '--out', file);

      expect(checked.code).toBe(1);
      expect(checked.err).toContain('is not there');

      // A directory under that name is no slice either — and no exception.
      const directory = run('--check', '--out', file.slice(0, file.lastIndexOf('/')));

      expect(directory.code).toBe(1);
      expect(directory.err).toContain('is not there');
    });
  });

  it('--write answers 2 in one line when the file cannot be written', () => {
    withScratchFile((file) => {
      // A directory that is not there: the write fails as it does on a read-only tree.
      const target = `${file.slice(0, file.lastIndexOf('/'))}/gone/help-slice.json`;
      const written = run('--write', '--out', target);

      // 1 would say "the slice is stale"; nothing was compared here.
      expect(written).toEqual({ code: 2, out: '', err: 'export-help-slice: cannot write help-slice.json.\n' });

      // The same from the shell: one line and the code, not a stack trace and Node's own 1.
      const spawned = childProcess.spawnSync(node().execPath, [SCRIPT.pathname, '--write', '--out', target], { encoding: 'utf8' });

      expect(spawned.status).toBe(2);
      expect(spawned.stdout).toBe('');
      expect(spawned.stderr).toBe('export-help-slice: cannot write help-slice.json.\n');
    });
  });

  it('--write writes the bytes --check then accepts', () => {
    withScratchFile((file) => {
      expect(run('--write', '--out', file).code).toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toBe(FRESH);
      // Both spellings of the option, as in the PHP exporter.
      expect(run('--check', `--out=${file}`).code).toBe(0);
    });
  });

  it('prints the slice when it is given nothing', () => {
    expect(run()).toEqual({ code: 0, out: FRESH, err: '' });
  });

  it('refuses a command line it does not know', () => {
    expect(run('--fix').code).toBe(2);
    expect(run('--write', '--check').code).toBe(2);
    expect(run('--out').code).toBe(2);
    expect(run('--out=').code).toBe(2);
    expect(run('--fix').err).toContain('usage:');
    expect(run('--fix').out).toBe('');
  });
});

describe('what differs between two slices', () => {
  const slice = (change: (draft: Slice) => void): string => {
    const draft = JSON.parse(FRESH) as Slice;

    change(draft);

    return exporter.render(draft);
  };

  it('is nothing for the same bytes', () => {
    expect(exporter.differences(FRESH, FRESH)).toEqual([]);
  });

  it('names an entity that was added, dropped or changed', () => {
    const before = slice((draft) => {
      draft.symbols = draft.symbols.filter((symbol) => symbol.name !== 'Slen');
      draft.symbols.push({ ...(draft.symbols[0] as SymbolEntry), name: 'Zzz' });
      (draft.options[0] as Option).type = 'number';
    });

    expect(exporter.differences(before, FRESH)).toEqual([`~ options: ${(SLICE.options[0] as Option).name}`, '+ symbols: Slen', '- symbols: Zzz']);
  });

  it('says so when only the order moved', () => {
    const before = slice((draft) => {
      draft.calls.reverse();
    });

    expect(exporter.differences(before, FRESH)).toEqual(['~ calls: the order']);
  });

  it('says so when the facts are the same and the bytes are not', () => {
    expect(exporter.differences(JSON.stringify(SLICE), FRESH)).toEqual([
      'the same facts, written differently (indentation, key order, line ends)',
    ]);
  });

  it('says so when the committed file is not JSON', () => {
    expect(exporter.differences('<<<<<<< ours', FRESH)).toEqual(['the committed slice is not JSON']);
  });
});

describe('the options of the client in the slice', () => {
  const declared = sourceFile('src/config.ts').statements.find(
    (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === 'SlenOptions',
  );

  it('are the members of SlenOptions, every one, in the order of the source', () => {
    if (declared === undefined) {
      throw new Error('src/config.ts does not declare SlenOptions any more.');
    }

    const members = declared.members.filter(ts.isPropertySignature).map((member) => ({
      name: member.name.getText(),
      required: member.questionToken === undefined,
    }));

    expect(members.length).toBeGreaterThan(0);
    expect(SLICE.options.map((option) => ({ name: option.name, required: option.required }))).toEqual(members);
    expect(SLICE.client).toEqual({ class: 'Slen', options: 'SlenOptions' });

    for (const option of SLICE.options) {
      expect(option.type, option.name).not.toBe('');
      expect(Object.keys(option), option.name).toEqual(['name', 'type', 'required', 'default', 'default_known', 'env', 'description']);
    }
  });

  it('carry the doc comment of the option, on one line', () => {
    const documented = SLICE.options.filter((option) => option.description !== null);

    // An option without a comment carries null, never '': the check below is for the ones that have one.
    expect(documented.length).toBeGreaterThan(0);

    for (const option of documented) {
      expect(option.description, option.name).not.toMatch(/\n|\s{2,}|^\s|\s$|^$|\*\//);
    }
  });

  /** `resolveConfig()` with nothing in the environment but what `set` puts there. */
  function resolved(set: Record<string, string>, options: Parameters<typeof resolveConfig>[0] = {}): SlenConfig {
    const env = node().env;
    const names = SLICE.options.flatMap((option) => option.env);
    const kept = new Map(names.map((name) => [name, env[name]]));

    try {
      for (const name of names) {
        delete env[name];
      }

      Object.assign(env, set);

      return resolveConfig(options);
    } finally {
      for (const [name, value] of kept) {
        if (value === undefined) {
          delete env[name];
        } else {
          env[name] = value;
        }
      }
    }
  }

  it('say the default the client really falls back to', () => {
    const config = resolved({}, { apiKey: 'sl_live_help_slice' }) as unknown as Record<string, unknown>;
    const literal = SLICE.options.filter((option) => option.default !== null && 'value' in option.default);

    // Every default the slice states as a value is a setting `resolveConfig()` answers with.
    expect(literal.length).toBeGreaterThan(0);

    for (const option of literal) {
      expect(Object.hasOwn(config, option.name), `${option.name} is not a resolved setting`).toBe(true);
      expect(config[option.name], option.name).toEqual(option.default?.value);
    }

    // And a setting that resolves to something without being passed has its default in the slice: a
    // value as the value, a collaborator (the logger, `fetch`) as the code that names it.
    const collaborator = (value: unknown): boolean =>
      typeof value === 'function' ||
      (typeof value === 'object' && value !== null && Object.values(value).some((member) => typeof member === 'function'));

    for (const [name, value] of Object.entries(config)) {
      const stated = SLICE.options.find((option) => option.name === name)?.default;

      if (name === 'apiKey') {
        continue;
      }

      if (collaborator(value)) {
        expect(stated, name).toEqual({ code: expect.any(String) });
      } else {
        expect(stated, name).toEqual(expect.objectContaining({ value }));
      }
    }
  });

  it('say which defaults were read, and claim nothing about an option the client handles another way', () => {
    // The exporter finds the `??` chains with the type checker. This reads the text instead: inside a
    // function that takes a `SlenOptions`, `<that parameter>.<option> ??` is where a chain starts.
    const coalesced = new Set<string>();
    const visit = (found: ts.Node, inScope: ReadonlySet<string>): void => {
      let scope = inScope;

      if (ts.isFunctionLike(found)) {
        const taken = found.parameters
          .filter((parameter) => ts.isIdentifier(parameter.name) && parameter.type?.getText() === 'SlenOptions')
          .map((parameter) => parameter.name.getText());

        scope = taken.length === 0 ? inScope : new Set([...inScope, ...taken]);
      }

      if (
        ts.isPropertyAccessExpression(found) &&
        ts.isIdentifier(found.expression) &&
        scope.has(found.expression.text) &&
        ts.isBinaryExpression(found.parent) &&
        found.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        found.parent.left === found
      ) {
        coalesced.add(found.name.text);
      }

      ts.forEachChild(found, (child) => visit(child, scope));
    };

    for (const file of sourceFiles()) {
      visit(sourceFile(file), new Set());
    }

    expect(coalesced.size).toBeGreaterThan(0);
    // Every chain the text shows starts at an option, so the reading above picked up nothing else.
    expect(SLICE.options.map((option) => option.name)).toEqual(expect.arrayContaining([...coalesced]));

    for (const option of SLICE.options) {
      // Known: a chain starts at the option, or the type demands it and nothing stands in for it.
      expect(option.default_known, option.name).toBe(coalesced.has(option.name) || option.required);

      if (!option.default_known) {
        // Not read is not "none": the slice says nothing, and the flag is what tells the two apart.
        expect(option.default, option.name).toBeNull();
        expect(option.env, option.name).toEqual([]);
      }
    }
  });

  it('name the environment variables the client really reads, the one that wins first', () => {
    const fromEnvironment = SLICE.options.filter((option) => option.env.length > 0);

    expect(fromEnvironment.length).toBeGreaterThan(0);

    for (const option of fromEnvironment) {
      const all = Object.fromEntries(option.env.map((name, index) => [name, `from-${index}`]));
      const base = option.name === 'apiKey' ? {} : { apiKey: 'sl_live_help_slice' };
      const read = (set: Record<string, string>): unknown => (resolved(set, base) as unknown as Record<string, unknown>)[option.name];

      option.env.forEach((name, index) => {
        expect(read({ [name]: `from-${index}` }), `${name} alone`).toBe(`from-${index}`);
      });

      expect(read(all), `${option.env.join(' over ')}`).toBe('from-0');
    }
  });

  it('leave out no variable the configuration reads', () => {
    const named = new Set<string>();
    const visit = (found: ts.Node): void => {
      if (ts.isStringLiteral(found) && /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(found.text)) {
        named.add(found.text);
      }

      ts.forEachChild(found, visit);
    };

    visit(sourceFile('src/config.ts'));

    expect(named.size).toBeGreaterThan(0);
    expect(sorted(SLICE.options.flatMap((option) => option.env))).toEqual(sorted([...named]));
  });
});

describe('the public symbols in the slice', () => {
  const byName = new Map(SLICE.symbols.map((symbol) => [symbol.name, symbol]));

  it('are the names src/index.ts exports, every one — the types among them — and no name more', () => {
    // The run-time exports below see no type, and the wire files hold fewer than half of the types:
    // a type exported from any other module (`WaitOptions`, `MovementOptions`) is held by this list alone.
    const written = exportedNames('src/index.ts');

    expect(written.length).toBeGreaterThan(0);
    expect(SLICE.symbols.map((symbol) => symbol.name)).toEqual(sorted([...new Set(written)]));
  });

  it('are the values src/index.ts exports at run time, and no value more', () => {
    const values = SLICE.symbols.filter((symbol) => ['class', 'enum', 'function', 'const'].includes(symbol.kind));

    expect(values.map((symbol) => symbol.name)).toEqual(sorted(Object.keys(published)));
  });

  it('say of a value what it is', () => {
    const exported = published as unknown as Record<string, unknown>;

    for (const symbol of SLICE.symbols) {
      const value = exported[symbol.name];

      if (symbol.kind === 'class') {
        expect(typeof value, symbol.name).toBe('function');
        expect(String(value).startsWith('class'), symbol.name).toBe(true);
      } else if (symbol.kind === 'function') {
        expect(typeof value, symbol.name).toBe('function');
      } else if (symbol.kind === 'const') {
        expect(value, symbol.name).toBeDefined();
      } else {
        // An interface or a type alias is gone at run time.
        expect(value, symbol.name).toBeUndefined();
      }
    }
  });

  it('include every type the wire files export', () => {
    const files = ['src/wire.ts', ...['operations', 'executions', 'customers', 'webhooks'].map((module) => `src/modules/${module}/types.ts`)];
    let declared = 0;

    for (const file of files) {
      const names = sourceFile(file)
        .statements.filter((statement) => (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && isExported(statement))
        .map((statement) => (statement as ts.InterfaceDeclaration | ts.TypeAliasDeclaration).name.text);

      declared += names.length;

      for (const name of names) {
        expect(byName.get(name)?.source, name).toBe(file);
      }
    }

    expect(declared).toBeGreaterThan(20);
  });

  /**
   * The types a published signature names although `src/index.ts` does not
   * export them: their module exports them, a declaration of the public
   * surface mentions them, and a consumer cannot import them by name. They are
   * no symbols of the slice, so a reader that looks a type of a signature up
   * finds nothing for these (`AGENTS.md`, "The help slice").
   * Held in both directions: a new one is exported from `src/index.ts` or
   * written here with where it is named; one that got exported, or is named
   * no more, is taken out — here and in `AGENTS.md`.
   */
  const NAMED_NOT_EXPORTED: Record<string, string> = {
    Clock: 'the `@internal` constructor of ExecutionsModule: `Slen` builds the modules, a caller never does',
    ModuleContext: 'the `@internal` constructor of every module: `Slen` builds the modules, a caller never does',
  };

  it('name in a signature no type that cannot be imported, except the ones written down', () => {
    const importable = new Set(SLICE.symbols.map((symbol) => symbol.name));
    // Everything a signature of the slice may name a type in.
    const printed = [
      ...SLICE.options.map((option) => option.type),
      ...SLICE.calls.map((call) => call.signature),
      ...SLICE.symbols.flatMap((symbol) => [
        symbol.signature ?? '',
        ...symbol.type_parameters,
        ...symbol.extends,
        ...symbol.implements,
        ...symbol.members.map((member) => member.signature),
      ]),
    ].join('\n');
    const named = new Set<string>();

    for (const file of sourceFiles()) {
      for (const declared of declaredExports(file)) {
        if (declared.type && !importable.has(declared.name) && new RegExp(`(?<![\\w$.])${declared.name}(?![\\w$])`).test(printed)) {
          named.add(declared.name);
        }
      }
    }

    expect(sorted([...named])).toEqual(sorted(Object.keys(NAMED_NOT_EXPORTED)));
  });

  it('give another name for a symbol as an alias of it, and nothing else', () => {
    const exported = published as unknown as Record<string, unknown>;
    const aliases = SLICE.symbols.filter((symbol) => symbol.alias_of !== null);

    // No earlier name is bridged, so the slice names no alias. Should one come back, this pin goes and
    // the rules below hold it.
    expect(aliases).toEqual([]);

    for (const alias of aliases) {
      const target = byName.get(alias.alias_of ?? '');

      expect(target, alias.name).toBeDefined();
      expect(target?.alias_of, alias.name).toBeNull();
      expect(alias.kind, alias.name).toBe(target?.kind);
      expect(alias.deprecated, alias.name).toBe(true);
      expect(alias.members, alias.name).toEqual([]);
      expect(exported[alias.name], alias.name).toBe(exported[alias.alias_of ?? '']);
    }
  });

  it('give a class its public members as the declarations publish them', () => {
    const client = byName.get('Slen');
    const source = sourceFile('src/slen.ts').statements.find(
      (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === 'Slen',
    );

    if (client === undefined || source === undefined) {
      throw new Error('Slen is not a class of src/slen.ts any more.');
    }

    const open = source.members.filter((member) => !isHidden(member));
    const names = open.map((member) => (ts.isConstructorDeclaration(member) ? 'constructor' : (member.name?.getText() ?? '')));

    expect(client.members.map((member) => member.name)).toEqual(names);
    // Nothing private, no body, no comment, one line.
    expect(client.members.some((member) => member.name.startsWith('#'))).toBe(false);

    for (const member of client.members) {
      expect(member.signature, member.name).not.toMatch(/\n|\/\*|private |=>\s*\{|\s{2,}/);
    }

    // `@internal` is a flag, not an omission: the declarations still publish the member (a module's constructor).
    expect(client.members.filter((member) => member.internal).map((member) => member.name)).toEqual([]);
    expect(byName.get('CustomersModule')?.members.filter((member) => member.internal).map((member) => member.name)).toEqual(['constructor']);
  });

  it('name the file each symbol is declared in, from the root of the package', () => {
    for (const symbol of SLICE.symbols) {
      expect(symbol.source, symbol.name).toMatch(/^src\/[A-Za-z/-]+\.ts$/);
      expect(() => fs.readFileSync(new URL(symbol.source, SOURCES), 'utf8'), symbol.name).not.toThrow();
    }
  });
});

/**
 * The methods of `Slen` that answer a `Slen`: each builds another client
 * (`withLogger`) and is not a call — the contract test and the exporter
 * classify them so, as the PHP suite does `SlenSdk::withLogger()`.
 */
const BUILDS_A_CLIENT: string[] = (() => {
  const client = sourceFile('src/slen.ts').statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === 'Slen',
  );

  const members: readonly ts.ClassElement[] = client?.members ?? [];

  return members
    .filter((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && !isHidden(member))
    .filter((method) => method.type !== undefined && ts.isTypeReferenceNode(method.type) && method.type.typeName.getText() === 'Slen')
    .map((method) => method.name.getText());
})();

describe('the calls of the client in the slice', () => {
  const client = new published.Slen({
    apiKey: 'sl_live_help_slice',
    baseUrl: 'https://api.slen.ai',
    fetch: (() => {
      throw new Error('The slice is checked without a call.');
    }) as unknown as typeof fetch,
  });

  /** What `operations.execute` is on a client: each part read off the one before. */
  function reach(name: string): unknown {
    return name.split('.').reduce<unknown>((holder, part) => (holder as Record<string, unknown> | undefined)?.[part], client);
  }

  /** True when the value has a function a caller could reach in one step. */
  function offersMethods(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    const names = [
      ...Object.getOwnPropertyNames(value),
      ...(prototype === null || prototype === Object.prototype ? [] : Object.getOwnPropertyNames(prototype)),
    ].filter((name) => name !== 'constructor');

    return names.some((name) => typeof (value as Record<string, unknown>)[name] === 'function');
  }

  it('are methods a real client has', () => {
    expect(SLICE.calls.length).toBeGreaterThan(0);

    for (const call of SLICE.calls) {
      expect(typeof reach(call.name), call.name).toBe('function');
      expect(call.signature.startsWith(`${call.name.split('.').pop() ?? ''}`), call.name).toBe(true);
    }
  });

  it('leave out no public method of Slen and no resource it carries', () => {
    const source = sourceFile('src/slen.ts').statements.find(
      (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === 'Slen',
    );

    if (source === undefined) {
      throw new Error('Slen is not a class of src/slen.ts any more.');
    }

    const names = new Set(SLICE.calls.map((call) => call.name));
    const prefixes = new Set(SLICE.calls.filter((call) => call.name.includes('.')).map((call) => call.name.split('.')[0]));
    const resources: string[] = [];

    for (const member of source.members.filter((one) => !isHidden(one))) {
      const name = member.name?.getText() ?? '';

      if (ts.isMethodDeclaration(member)) {
        expect(names.has(name), `${name}()`).toBe(!BUILDS_A_CLIENT.includes(name));
      } else if ((ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) && offersMethods(reach(name))) {
        resources.push(name);
      }
    }

    expect(resources.length).toBeGreaterThan(0);
    expect(sorted([...prefixes].filter((prefix): prefix is string => prefix !== undefined))).toEqual(sorted(resources));
  });

  /** What can be called on a value in one step: the functions it holds and the ones its classes give it, `constructor` aside. */
  function methodsOf(value: object): string[] {
    const names = new Set<string>();

    for (let holder: object | null = value; holder !== null && holder !== Object.prototype; holder = Object.getPrototypeOf(holder) as object | null) {
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(holder))) {
        if (name !== 'constructor' && typeof descriptor.value === 'function') {
          names.add(name);
        }
      }
    }

    return sorted([...names]);
  }

  /**
   * The methods the class of a value declares `private` or `protected`.
   * TypeScript's privacy is gone at run time — a real client still has
   * `customers.move` — so what the source hides is read off the source: the
   * class is `Slen` itself or one `src/slen.ts` imports.
   */
  function keptToItself(value: object): string[] {
    const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;

    // A resource declared in place is an object literal: it hides nothing.
    if (prototype === null || prototype === Object.prototype) {
      return [];
    }

    const className = prototype.constructor?.name ?? '';
    const client = sourceFile('src/slen.ts');
    const imported = client.statements.filter(ts.isImportDeclaration).find((statement) => {
      const bindings = statement.importClause?.namedBindings;

      return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === className);
    });
    const file = imported === undefined ? client : sourceFile(moduleFile('src/slen.ts', imported.moduleSpecifier));
    const declared = file.statements.find(
      (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === className,
    );

    if (declared === undefined) {
      throw new Error(`The class ${className} is neither declared in src/slen.ts nor imported there: teach this suite where it is.`);
    }

    return declared.members.filter(isHidden).map((member) => member.name?.getText() ?? '');
  }

  it('are, resource by resource, every method a real client has there and none the class keeps to itself', () => {
    const open = (value: object): string[] => {
      const hidden = keptToItself(value);

      return methodsOf(value).filter((name) => !hidden.includes(name));
    };
    const resources = [...new Set(SLICE.calls.filter((call) => call.name.includes('.')).map((call) => call.name.slice(0, call.name.indexOf('.'))))];

    // The test above holds the list of resources; this one holds what each of them offers.
    expect(resources.length).toBeGreaterThan(0);

    for (const resource of resources) {
      const value = reach(resource);

      if (typeof value !== 'object' || value === null) {
        throw new Error(`${resource} is not a resource of a real client.`);
      }

      const listed = SLICE.calls.filter((call) => call.name.startsWith(`${resource}.`)).map((call) => call.name.slice(resource.length + 1));

      expect(sorted(listed), resource).toEqual(open(value));
    }

    // And the client itself: its own methods are the calls without a dot, but for the ones that build another client.
    expect(sorted(SLICE.calls.filter((call) => !call.name.includes('.')).map((call) => call.name))).toEqual(
      open(client).filter((name) => !BUILDS_A_CLIENT.includes(name)),
    );
    expect(BUILDS_A_CLIENT).toEqual(['withLogger']);
  });

  // The HTTP operation of a call is its line in `contract/calls.json`, which
  // `contract.test.ts` holds to the code, and nothing else: every
  // line that names typescript is a call of the slice with that operation, and
  // every other call makes none — the public members `contract.test.ts` lists
  // in `NOT_CALLS` (`webhooks.verify`, `webhooks.constructEvent`, `flush`).
  it('carry the operation of their line in contract/calls.json, and null where they have none', () => {
    const table = (
      JSON.parse(fs.readFileSync(new URL('calls.json', CONTRACT), 'utf8')) as {
        calls: Record<string, { operation: string; sdks: string[] }>;
      }
    ).calls;
    const lines = new Map(Object.entries(table).filter(([, line]) => line.sdks.includes('typescript')));
    const names = new Set(SLICE.calls.map((call) => call.name));

    expect([...lines.keys()].filter((name) => !names.has(name))).toEqual([]);

    for (const call of SLICE.calls) {
      expect(call.operation, call.name).toBe(lines.get(call.name)?.operation ?? null);
      expect(Object.keys(call).at(-1), 'the operation is the last key of a call (AGENTS.md, "The help slice")').toBe('operation');
    }

    expect(SLICE.calls.filter((call) => call.operation === null).map((call) => call.name)).toEqual(['flush', 'webhooks.constructEvent', 'webhooks.verify']);
  });

  it('point at the symbol and the member that declare them', () => {
    const byName = new Map(SLICE.symbols.map((symbol) => [symbol.name, symbol]));

    for (const call of SLICE.calls) {
      const owner = byName.get(call.symbol ?? '');

      expect(owner?.kind, call.name).toBe('class');
      expect(owner?.members.some((member) => member.name === call.member), call.name).toBe(true);
    }
  });
});

describe('the package in the slice', () => {
  it('is what package.json states', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string;
      version: string;
      engines: { node: string };
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(SLICE.package.name).toBe(manifest.name);
    expect(SLICE.package.version).toBe(manifest.version);
    expect(SLICE.package.manifest).toBe('package.json');
    expect(SLICE.package.runtime).toEqual({ name: 'node', constraint: manifest.engines.node });
    expect(SLICE.package.dependencies).toEqual(
      sorted([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]).map((name) => ({
        name,
        constraint: manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name],
        optional: manifest.dependencies?.[name] === undefined && manifest.peerDependenciesMeta?.[name]?.optional === true,
      })),
    );
  });
});
