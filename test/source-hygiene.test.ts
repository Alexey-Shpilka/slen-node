import ts from 'typescript-api';
import { describe, expect, it } from 'vitest';
import { EXAMPLES, PACKAGE } from './paths.js';

// No `@types/node` in the package: the one Node module used is described structurally.
interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
  readdirSync(path: URL, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
}

const NODE_FS: string = 'node:fs';
const fs = (await import(NODE_FS)) as NodeFs;

/**
 * The rule for comments in `src/` (`AGENTS.md`): a comment says what a reader
 * needs at that line, in at most six lines; no history, no numbers of findings or decisions, no links
 * to the planning docs. Reasons live in AGENTS, not in the code.
 */

const MAX_COMMENT_LINES = 6;

/** Documents and numbered findings or decisions of the planning docs (Cyrillic letters). */
const REFERENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/docs\/v\d/, 'a link to docs/v…'],
  [/(?<![\p{L}\p{N}])[НРПЗВФХ](?:-\d|\d+\.\d)/iu, 'a number of a finding, decision, package or task'],
];

/**
 * What a public repository must not carry, in any file of the package: the patterns of check-public-tree.sh, the
 * guard a public tree is made behind. Each is spelt so it does not find itself.
 */
const INTERNAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/h[o]me\//i, 'a path of a machine'],
  [/d[o]cs\/v\d/i, 'a link to the plans'],
  [/slen\.(?:backend|frontend|infra|docs|sdk)/i, 'a private repository'],
  [/backend\/[o]penapi/i, 'the tree of the backend'],
  [/DEPLOY_[K]EY/i, 'a deploy key'],
  [/localhost:3808[0]/i, 'the local stack'],
  [/sn[o]vio|sp[e]ndguard|l[i]mly/i, 'an earlier name'],
  [/(?<![\p{L}\p{N}_])[НРПЗВФХ](?:-\d|\d+\.\d)/iu, 'a number of a finding, a decision or a task'],
  [/sl_live_[A-Za-z0-9]{20,}/, 'a key that looks real'],
  [/(?<![\p{L}\p{N}./])v\d{2,}\//iu, 'a branch of an iteration'],
  [/_v\d+_/i, 'the number of an iteration in a name'],
  [/\b(?:since|until) v\d{2,}(?![.\d])/i, 'the number of an iteration'],
  [/\b(?:backend|frontend|infra|sdk|master|main)[ @:#][0-9a-f]{7,40}\b/i, 'a branch pinned to a commit'],
];

/** What the package's tools leave in it and a public tree never gets; and git's own directory, no file of the package. */
const LEFT_BEHIND: readonly string[] = ['node_modules', 'dist', '.git'];

function internalIn(text: string): string[] {
  return text.split('\n').flatMap((line, index) => INTERNAL.filter(([pattern]) => pattern.test(line)).map(([, what]) => `${index + 1}: ${what}`));
}

/** Every file of the package, as a path in it. */
function packageFiles(directory: URL = PACKAGE, prefix = ''): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !LEFT_BEHIND.includes(`${prefix}${entry.name}`) && !entry.name.endsWith('.tsbuildinfo'))
    .flatMap((entry) => (entry.isDirectory() ? packageFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
    .sort();
}

/** Words that tell the history of the code instead of what it does. */
const HISTORY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bused to\b/i, '"used to"'],
  [/\buntil v\d+/i, '"until vNN"'],
  [/\bsince v\d+/i, '"since vNN"'],
];

interface Finding {
  readonly line: number;
  readonly problem: string;
}

/** Every comment of a source, once, in the order it is written. */
function commentsOf(text: string): ts.CommentRange[] {
  const file = ts.createSourceFile('hygiene.ts', text, ts.ScriptTarget.Latest, true);
  const found = new Map<number, ts.CommentRange>();
  const take = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      found.set(range.pos, range);
    }
  };
  const visit = (node: ts.Node): void => {
    take(ts.getLeadingCommentRanges(text, node.getFullStart()));
    take(ts.getTrailingCommentRanges(text, node.getEnd()));
    // Tokens too: the comments of an empty block lead its closing brace.
    for (const child of node.getChildren(file)) {
      visit(child);
    }
  };

  visit(file);

  return [...found.values()].sort((left, right) => left.pos - right.pos);
}

/** Comments that follow each other with nothing but blank space between, as runs of lines. */
function commentRuns(text: string): Array<{ readonly startLine: number; readonly lines: number }> {
  const lineOf = (position: number): number => text.slice(0, position).split('\n').length;
  const runs: Array<{ startLine: number; endLine: number; end: number }> = [];

  for (const comment of commentsOf(text)) {
    const startLine = lineOf(comment.pos);
    const endLine = lineOf(comment.end);
    const previous = runs.at(-1);
    const between = previous === undefined ? '' : text.slice(previous.end, comment.pos);

    if (previous !== undefined && /^[ \t]*\r?\n?[ \t]*$/.test(between) && startLine <= previous.endLine + 1) {
      previous.endLine = endLine;
      previous.end = comment.end;
    } else {
      runs.push({ startLine, endLine, end: comment.end });
    }
  }

  return runs.map((run) => ({ startLine: run.startLine, lines: run.endLine - run.startLine + 1 }));
}

function findingsOf(text: string): Finding[] {
  const findings: Finding[] = [];

  for (const run of commentRuns(text)) {
    if (run.lines > MAX_COMMENT_LINES) {
      findings.push({ line: run.startLine, problem: `a comment of ${run.lines} lines (at most ${MAX_COMMENT_LINES})` });
    }
  }

  text.split('\n').forEach((line, index) => {
    for (const [pattern, what] of [...REFERENCES, ...HISTORY]) {
      if (pattern.test(line)) {
        findings.push({ line: index + 1, problem: what });
      }
    }
  });

  return findings;
}

/** The share of the lines of `src/` that may be comments (a line that starts with `//`, `/*` or `*`). */
const MAX_COMMENT_SHARE = 0.1;

/** Whether a line of source is a comment line, as the share counts it. */
function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*)/.test(line);
}

function isHiddenMember(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node) && !ts.isClassElement(node)) {
    return false;
  }

  const name = (node as { name?: ts.Node }).name;
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);

  return (name !== undefined && ts.isPrivateIdentifier(name)) || (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
}

/**
 * Whether a caller's editor shows the node: an export of `src/index.ts` (`surface`), or a public member
 * of one, and not `@internal`.
 */
function isOnTheSurface(node: ts.Node, surface: ReadonlySet<ts.Node>): boolean {
  if (ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'internal')) {
    return false;
  }

  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.some((declaration) => surface.has(declaration));
  }

  if (surface.has(node)) {
    return true;
  }

  const owner = node.parent;

  if (owner === undefined || isHiddenMember(node)) {
    return false;
  }

  if (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) {
    return isOnTheSurface(owner, surface);
  }

  return ts.isTypeLiteralNode(owner) && isOnTheSurface(owner.parent, surface);
}

/** The doc comments of a source that say more than their place allows: one line of prose on the surface, none elsewhere. */
function docProblemsOf(file: ts.SourceFile, surface: ReadonlySet<ts.Node>): Finding[] {
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    const docs = ts.getJSDocCommentsAndTags(node).filter((doc): doc is ts.JSDoc => ts.isJSDoc(doc) && doc.parent === node);

    for (const doc of docs) {
      const prose = (ts.getTextOfJSDocComment(doc.comment) ?? '').trim();
      const lines = prose === '' ? 0 : prose.split('\n').length;
      const allowed = isOnTheSurface(node, surface) ? 1 : 0;

      if (lines > allowed) {
        findings.push({
          line: lineOf(file, doc),
          problem: allowed === 0 ? 'prose in the doc of an internal declaration: tags only' : `${lines} lines of prose in a public doc: one line, then tags`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  return findings;
}

/** The program over `src/index.ts`, and the declarations the package exports. */
function thePackage(): { program: ts.Program; surface: Set<ts.Node> } {
  const entry = new URL('../src/index.ts', import.meta.url).pathname;
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const index = program.getSourceFile(entry);
  const module = index === undefined ? undefined : checker.getSymbolAtLocation(index);
  const surface = new Set<ts.Node>();

  for (const exported of module === undefined ? [] : checker.getExportsOfModule(module)) {
    const symbol = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;

    for (const declaration of symbol.declarations ?? []) {
      surface.add(declaration);
    }
  }

  return { program, surface };
}

/** The most parameters a function, a method or a constructor of `src/` takes: more belong in one object. */
const MAX_PARAMETERS = 3;

function parsed(text: string): ts.SourceFile {
  return ts.createSourceFile('rules.ts', text, ts.ScriptTarget.Latest, true);
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** The lines where an `if` of the source goes on with `else`: a branch returns early instead. */
function elseLinesOf(text: string): number[] {
  const file = parsed(text);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.elseStatement !== undefined) {
      lines.push(lineOf(file, node.elseStatement));
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  return lines;
}

/** Every function-like declaration of the source that takes more than `MAX_PARAMETERS`, as `line: name (count)`. */
function longParameterListsOf(text: string): string[] {
  const file = parsed(text);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node.parameters.length > MAX_PARAMETERS) {
      found.push(`${lineOf(file, node)}: ${node.name?.getText(file) ?? ts.SyntaxKind[node.kind]} (${node.parameters.length})`);
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  return found;
}

/** The Node examples of Help & Docs: code a reader copies. */
function exampleFiles(): string[] {
  return fs
    .readdirSync(new URL('help/', EXAMPLES), { recursive: true })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('/node.ts'))
    .map((file) => `examples/help/${file}`)
    .sort();
}

function sourceFiles(): string[] {
  return fs
    .readdirSync(new URL('src/', PACKAGE), { recursive: true })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `src/${file.replaceAll('\\', '/')}`)
    .sort();
}

/** A file of the package, or an example (`examples/…`, where `test/paths.ts` says). */
function read(file: string): string {
  return fs.readFileSync(file.startsWith('examples/') ? new URL(file.slice('examples/'.length), EXAMPLES) : new URL(file, PACKAGE), 'utf8');
}

describe('the source of the package', () => {
  it('keeps comments short and free of history and plan references', () => {
    const files = sourceFiles();
    const report = files.flatMap((file) => findingsOf(read(file)).map((finding) => `${file}:${finding.line} — ${finding.problem}`));

    // Every file of `src/` is read; finding hardly any means the walk no longer reaches them.
    expect(files.length).toBeGreaterThan(30);
    expect(report).toEqual([]);
  });

  it('names nothing that stays internal, in any file of the package', () => {
    const files = packageFiles();
    const report = files.flatMap((file) => internalIn(read(file)).map((found) => `${file}:${found}`));

    expect(files).toContain('README.md');
    expect(files).toContain('test/source-hygiene.test.ts');
    expect(files.length).toBeGreaterThan(60);
    expect(report).toEqual([]);
  });

  it('branches without else, and so do the examples a reader copies', () => {
    const files = [...sourceFiles(), ...exampleFiles()];
    const report = files.flatMap((file) => elseLinesOf(read(file)).map((line) => `${file}:${line}`));

    expect(exampleFiles().length).toBeGreaterThan(10);
    expect(report).toEqual([]);
  });

  it('says in a doc comment one line on the public surface, then tags; elsewhere tags only', () => {
    const { program, surface } = thePackage();
    const root = new URL('../src/', import.meta.url).pathname;
    const files = program.getSourceFiles().filter((file) => file.fileName.startsWith(root));
    const report = files.flatMap((file) =>
      docProblemsOf(file, surface).map((finding) => `src/${file.fileName.slice(root.length)}:${finding.line} — ${finding.problem}`),
    );

    // The surface is the package's exports; finding hardly any means the checker no longer reads them.
    expect(surface.size).toBeGreaterThan(100);
    expect(files.length).toBe(sourceFiles().length);
    expect(report).toEqual([]);
  });

  it(`keeps comments to at most ${MAX_COMMENT_SHARE * 100} % of the lines of src/`, () => {
    const lines = sourceFiles().flatMap((file) => read(file).replace(/\n$/, '').split('\n'));
    const comments = lines.filter(isCommentLine).length;

    expect(lines.length).toBeGreaterThan(3_000);
    expect(comments / lines.length, `${comments} comment lines of ${lines.length}`).toBeLessThanOrEqual(MAX_COMMENT_SHARE);
  });

  it(`takes at most ${MAX_PARAMETERS} parameters in every function, method and constructor`, () => {
    const report = sourceFiles().flatMap((file) => longParameterListsOf(read(file)).map((found) => `${file}:${found}`));

    expect(report).toEqual([]);
  });
});

describe('the hygiene check itself', () => {
  const lines = (count: number, prefix: string): string => Array.from({ length: count }, (_, index) => `${prefix} line ${index}`).join('\n');

  it('allows six lines of comment and refuses seven, whichever way they are written', () => {
    expect(findingsOf(`${lines(6, '//')}\nexport const a = 1;\n`)).toEqual([]);
    expect(findingsOf(`/**\n${lines(4, ' *')}\n */\nexport const a = 1;\n`)).toEqual([]);
    expect(findingsOf(`${lines(7, '//')}\nexport const a = 1;\n`)).toEqual([{ line: 1, problem: 'a comment of 7 lines (at most 6)' }]);
    expect(findingsOf(`export const a = 1;\n/**\n${lines(5, ' *')}\n */\nexport const b = 2;\n`)).toEqual([
      { line: 2, problem: 'a comment of 7 lines (at most 6)' },
    ]);
  });

  it('counts comments split by code or by a blank line as separate ones', () => {
    expect(findingsOf(`${lines(4, '//')}\nexport const a = 1;\n${lines(4, '//')}\nexport const b = 2;\n`)).toEqual([]);
    expect(findingsOf(`${lines(4, '//')}\n\n${lines(4, '//')}\nexport const a = 1;\n`)).toEqual([]);
    expect(findingsOf(`function f(): void {\n${lines(4, '  //')}\n${lines(3, '  //')}\n}\n`)).toEqual([
      { line: 2, problem: 'a comment of 7 lines (at most 6)' },
    ]);
  });

  it('finds an else wherever it is, and no word that only spells it', () => {
    expect(elseLinesOf("if (a) {\n  f();\n} else {\n  g();\n}\n// or else\nconst elsewhere = 'else';\n")).toEqual([3]);
    expect(elseLinesOf('function f(a: boolean): number {\n  if (a) return 1;\n  else if (!a) return 2;\n  return 3;\n}\n')).toEqual([3]);
  });

  it('allows one line of prose on the surface and none elsewhere', () => {
    const file = parsed(
      [
        '/** One line. @throws X */',
        'export class Open {',
        '  /** A member, one line. */',
        '  a = 1;',
        '  /** Two',
        '   * lines. */',
        '  b = 2;',
        '  /** @internal */',
        '  constructor() {}',
        '  /** Kept to itself. */',
        '  #c = 3;',
        '}',
        '/** Anything at all. */',
        'function helper(): void {}',
        '/** @internal */',
        'export const tagged = 1;',
      ].join('\n'),
    );
    const open = file.statements.find(ts.isClassDeclaration) as ts.ClassDeclaration;

    expect(docProblemsOf(file, new Set([open])).map((finding) => finding.line)).toEqual([5, 10, 13]);
    expect(isCommentLine('  * a line of a doc')).toBe(true);
    expect(isCommentLine("const url = 'https://example.com';")).toBe(false);
  });

  it('counts the parameters of functions, methods, constructors and arrows', () => {
    expect(longParameterListsOf('function f(a: 1, b: 2, c: 3): void {}\n')).toEqual([]);
    expect(longParameterListsOf('function f(a: 1, b: 2, c: 3, d: 4): void {}\n')).toEqual(['1: f (4)']);
    expect(longParameterListsOf('class A {\n  constructor(a: 1, b: 2, c: 3, d: 4) {}\n  m(a: 1, b: 2, c: 3, d = 4): void {}\n}\n')).toEqual([
      '2: Constructor (4)',
      '3: m (4)',
    ]);
    expect(longParameterListsOf('const f = (a: 1, b: 2, c: 3, ...rest: number[]): void => undefined;\n')).toEqual(['1: ArrowFunction (4)']);
  });

  it('finds what stays internal, and nothing else', () => {
    const text = [
      'see /h' + 'ome/someone/x',
      'docs' + '/v35/02-spec.md',
      'slen' + '.frontend',
      'backend' + '/openapi/v1.yaml',
      'SDK_DEPLOY' + '_KEY',
      'http://localhost' + ':38080',
      'Spend' + 'Guard',
      'fixes \u041D-17',
      'dropped in \u04123.1',
      'sl_live_' + 'x'.repeat(20),
      'signed on backend v' + '26/backend',
      'whsec_v' + '26_contract_vectors',
      'kept until v' + '29',
      'backend' + ' a72a940',
      'H-1 is not Cyrillic; https://api.test; sl_live_…; docs/configuration; v0.3.0 on Node 20.3, 1.2.3',
      't=1792238400,v1=d90c1b78be2a0b86, v0=deadbeef; GET /v1/customers; since v1.2; whsec_contract_vectors_7f3a91c2',
    ].join('\n');

    expect(internalIn(text)).toEqual([
      '1: a path of a machine',
      '2: a link to the plans',
      '3: a private repository',
      '4: the tree of the backend',
      '5: a deploy key',
      '6: the local stack',
      '7: an earlier name',
      '8: a number of a finding, a decision or a task',
      '9: a number of a finding, a decision or a task',
      '10: a key that looks real',
      '11: a branch of an iteration',
      '12: the number of an iteration in a name',
      '13: the number of an iteration',
      '14: a branch pinned to a commit',
    ]);
  });

  it('does not read a regular expression or a string as a comment', () => {
    expect(findingsOf("export const a = /\\/+$/;\nexport const b = '// not a comment';\n")).toEqual([]);
  });

  it('refuses links to the planning docs, numbered findings and history words', () => {
    expect(findingsOf('// see docs' + '/v26/01-spec.md\n').map((finding) => finding.problem)).toEqual(['a link to docs/v…']);
    expect(findingsOf('// decided in \u0420-7\n').map((finding) => finding.problem)).toEqual(['a number of a finding, decision, package or task']);
    expect(findingsOf("const reason = '\u041D-12';\n").map((finding) => finding.problem)).toEqual(['a number of a finding, decision, package or task']);
    expect(findingsOf('// dropped in \u04123.1\n').map((finding) => finding.problem)).toEqual(['a number of a finding, decision, package or task']);
    expect(findingsOf('// as of 0.3.0, on Node 20.3\n')).toEqual([]);
    expect(findingsOf('// this used to retry\n').map((finding) => finding.problem)).toEqual(['"used to"']);
    expect(findingsOf('// kept until \u{76}29\n// added since \u{76}24\n').map((finding) => finding.problem)).toEqual(['"until vNN"', '"since vNN"']);
    expect(findingsOf('// a P-3 in Latin letters is not a plan number\n')).toEqual([]);
  });
});
