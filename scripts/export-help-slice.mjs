// The help slice of the TypeScript SDK: what the console's Help & Docs section
// is allowed to say about `@slen/sdk` without reading its source — the options
// of the client, the public symbols, the calls a client offers, the version
// and the runtime the manifest asks for.
//
// The slice is `help-slice.json`, committed. The console's sync
// step (`help-sync`) copies it into its snapshot; an article
// that names an option or a method is then held against the snapshot. So the
// file has to be what the code says today: `test/help-slice.test.ts`
// builds it afresh on every run and fails when the committed one differs.
//
//   node scripts/export-help-slice.mjs            print the slice
//   node scripts/export-help-slice.mjs --write    write help-slice.json
//   node scripts/export-help-slice.mjs --check    exit 1 and say what differs
//   … --out <file>                                another file for --write / --check
//
// Where each fact is read from:
//   - the public symbols — the exports of `src/index.ts`, resolved
//     with the compiler, and printed as the DECLARATIONS the build publishes
//     (`.d.ts`, emitted in memory): an inferred type, a parameter that became
//     optional through its default, a private member — all come out the way a
//     consumer's editor shows them;
//   - the options — the members of `SlenOptions`; what an option falls back to
//     is read off the `??` chains that start at it (`options.retries ?? 2`),
//     and an option no chain starts at says so (`default_known: false`);
//   - the calls — the public members of `Slen`, classified as the contract test
//     classifies them; the HTTP operation of each — its line in
//     `contract/calls.json`, which the contract test holds;
//   - version, runtime, dependencies — `package.json`.
//
// Nothing here may depend on the machine or the moment: no dates, no absolute
// paths, every set sorted by code unit. The shape is described for its readers
// in `AGENTS.md` ("The help slice") — change both together, and bump
// `SCHEMA` when a reader written against the old shape would misread the new.
//
// The directories are those of `test/paths.ts` (`scripts/paths.mjs`); a source
// is named relative to the directory that holds `contract/`. It needs the dev
// dependencies (the compiler) and writes nothing unless asked to:
// `node_modules` and the tree may be read-only.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { roots } from './paths.mjs';

export const SCHEMA = 2;

const DIRECTORIES = roots();
const CONTRACT = path.resolve(fileURLToPath(DIRECTORIES.CONTRACT));
const PACKAGE = path.resolve(fileURLToPath(DIRECTORIES.PACKAGE));
/** What a source and the manifest are named relative to: the package. */
const ROOT = PACKAGE;
const MANIFEST = path.join(PACKAGE, 'package.json');
const ENTRY = path.join(PACKAGE, 'src', 'index.ts');

/** The committed slice. */
export const SLICE_FILE = path.join(PACKAGE, 'help-slice.json');

/** The class a consumer builds, and the type of what it is built from. */
const CLIENT = 'Slen';
const OPTIONS = 'SlenOptions';

/** The one function of `src/config.ts` that reads the environment: `fromEnv(name)` — every argument names a variable, in the order it is read. */
const ENV_READER = 'fromEnv';

const KINDS = ['class', 'enum', 'function', 'const', 'interface', 'type'];

/** Repository-relative, with forward slashes — the same on every machine. */
function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/** Order by code unit: `localeCompare` answers differently from one ICU build to the next. */
function byName(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function sorted(texts) {
  return [...texts].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function compiler() {
  try {
    return createRequire(MANIFEST)('typescript');
  } catch (error) {
    throw new Error(
      'export-help-slice: the TypeScript compiler is not installed — run `npm ci` first.',
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// The package, as its manifest states it.

function describePackage() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const optional = manifest.peerDependenciesMeta ?? {};
  const dependencies = [
    ...Object.entries(manifest.dependencies ?? {}).map(([name, constraint]) => ({ name, constraint, optional: false })),
    ...Object.entries(manifest.peerDependencies ?? {}).map(([name, constraint]) => ({
      name,
      constraint,
      optional: optional[name]?.optional === true,
    })),
  ];

  return {
    name: manifest.name,
    version: manifest.version ?? null,
    manifest: relative(MANIFEST),
    runtime: { name: 'node', constraint: manifest.engines?.node ?? null },
    dependencies: dependencies.sort(byName),
  };
}

// ---------------------------------------------------------------------------
// The source and its declarations.

/**
 * The program over `src/index.ts` under the package's own compiler options,
 * and the `.d.ts` of every file of it — emitted into memory, never to disk.
 */
function read(ts) {
  const config = ts.readConfigFile(path.join(PACKAGE, 'tsconfig.json'), ts.sys.readFile);

  if (config.error !== undefined) {
    throw new Error(`export-help-slice: ${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}`);
  }

  const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions ?? {}, PACKAGE);

  if (converted.errors.length > 0) {
    throw new Error(`export-help-slice: ${problems(ts, converted.errors)}`);
  }

  const program = ts.createProgram({
    rootNames: [ENTRY],
    options: {
      ...converted.options,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      sourceMap: false,
      removeComments: false,
      incremental: false,
      composite: false,
    },
  });

  const texts = new Map();
  const emitted = program.emit(undefined, (fileName, text) => texts.set(fileName, text), undefined, true);
  const failed = [...program.getSyntacticDiagnostics(), ...emitted.diagnostics];

  if (failed.length > 0) {
    throw new Error(`export-help-slice: the package does not compile to declarations:\n${problems(ts, failed)}`);
  }

  const parsed = new Map();

  /** The published declarations of one source file, parsed. */
  function declarations(source) {
    const name = source.fileName.replace(/\.ts$/, '.d.ts');
    const text = texts.get(name);

    if (text === undefined) {
      throw new Error(`export-help-slice: no declarations were emitted for ${relative(source.fileName)}.`);
    }

    if (!parsed.has(name)) {
      parsed.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true));
    }

    return parsed.get(name);
  }

  return { program, checker: program.getTypeChecker(), declarations };
}

function problems(ts, diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const where = diagnostic.file === undefined ? '' : `${relative(diagnostic.file.fileName)}: `;

      return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    })
    .join('\n');
}

/** How nodes are turned into text: no comments, one line, one space. */
function printerOf(ts) {
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

  return (node) =>
    printer
      .printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
      .replace(/\s+/g, ' ')
      .trim();
}

function tagged(ts, node, tag) {
  return node !== undefined && ts.getJSDocTags(node).some((found) => found.tagName.text === tag);
}

/** The prose of a doc comment — without its tags — on one line; null when there is none. */
function described(ts, node) {
  const text = ts
    .getJSDocCommentsAndTags(node)
    .filter((found) => ts.isJSDoc(found))
    .map((found) => ts.getTextOfJSDocComment(found.comment) ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text === '' ? null : text;
}

function has(ts, node, kind) {
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** Not `private`, not `protected`, not `#private`. */
function isPublic(ts, member) {
  return (
    !has(ts, member, ts.SyntaxKind.PrivateKeyword) &&
    !has(ts, member, ts.SyntaxKind.ProtectedKeyword) &&
    !(member.name !== undefined && ts.isPrivateIdentifier(member.name))
  );
}

// ---------------------------------------------------------------------------
// The public symbols.

/** The top-level declarations of a `.d.ts` that carry `name`, each with its kind. */
function declaredAs(ts, file, name) {
  const found = [];

  for (const statement of file.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      found.push({ kind: 'class', node: statement, documented: statement });
    } else if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
      found.push({ kind: 'interface', node: statement, documented: statement });
    } else if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      found.push({ kind: 'type', node: statement, documented: statement });
    } else if (ts.isEnumDeclaration(statement) && statement.name.text === name) {
      found.push({ kind: 'enum', node: statement, documented: statement });
    } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      found.push({ kind: 'function', node: statement, documented: statement });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          found.push({ kind: 'const', node: declaration, documented: statement });
        }
      }
    }
  }

  return found;
}

function memberName(ts, print, member) {
  if (ts.isConstructorDeclaration(member) || ts.isConstructSignatureDeclaration(member)) {
    return 'constructor';
  }

  if (ts.isIndexSignatureDeclaration(member)) {
    return `[${member.parameters.map(print).join(', ')}]`;
  }

  if (ts.isCallSignatureDeclaration(member)) {
    return '()';
  }

  return member.name === undefined ? '' : print(member.name);
}

function memberKind(ts, member) {
  if (ts.isConstructorDeclaration(member) || ts.isConstructSignatureDeclaration(member)) {
    return 'constructor';
  }

  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
    return 'method';
  }

  if (ts.isGetAccessorDeclaration(member)) {
    return 'getter';
  }

  if (ts.isSetAccessorDeclaration(member)) {
    return 'setter';
  }

  if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
    return 'property';
  }

  if (ts.isIndexSignatureDeclaration(member)) {
    return 'index';
  }

  if (ts.isCallSignatureDeclaration(member)) {
    return 'call';
  }

  if (ts.isEnumMember(member)) {
    return 'case';
  }

  return null;
}

/** A member as the declarations publish it: `readonly spans: SlenSpan[]`, `wait(id: string, options?: WaitOptions): Promise<…>`. */
function signatureOf(print, node) {
  return print(node).replace(/[;,]$/, '').trim();
}

function describeMember(ts, print, member, owner) {
  const kind = memberKind(ts, member);

  if (kind === null) {
    throw new Error(`export-help-slice: ${owner} has a public member this script cannot describe: ${print(member)}`);
  }

  return {
    name: memberName(ts, print, member),
    kind,
    static: has(ts, member, ts.SyntaxKind.StaticKeyword),
    optional: member.questionToken !== undefined,
    deprecated: tagged(ts, member, 'deprecated'),
    internal: tagged(ts, member, 'internal'),
    signature: signatureOf(print, member),
  };
}

/** `extends` / `implements` of a class or an interface, as written. */
function heritage(ts, print, node, token) {
  const clause = (node.heritageClauses ?? []).find((found) => found.token === token);

  return sorted((clause?.types ?? []).map(print));
}

/** The declaration without `export declare` and its keyword: `idempotencyKeyForJob(jobId: string, operation: string): string`, `CustomerStatus = 'active' | 'blocked'`. */
function declarationText(ts, print, kind, node) {
  if (kind === 'function') {
    const parameters = node.parameters.map(print).join(', ');
    const generics = node.typeParameters === undefined ? '' : `<${node.typeParameters.map(print).join(', ')}>`;
    const returns = node.type === undefined ? '' : `: ${print(node.type)}`;

    return `${node.name.text}${generics}(${parameters})${returns}`;
  }

  if (kind === 'type') {
    const generics = node.typeParameters === undefined ? '' : `<${node.typeParameters.map(print).join(', ')}>`;

    return `${node.name.text}${generics} = ${print(node.type)}`;
  }

  if (kind === 'const') {
    return print(node);
  }

  return null;
}

function describeSymbols(ts, { program, checker, declarations }, print) {
  const entry = program.getSourceFile(ENTRY);
  const module = entry === undefined ? undefined : checker.getSymbolAtLocation(entry);

  if (module === undefined) {
    throw new Error(`export-help-slice: ${relative(ENTRY)} exports nothing.`);
  }

  const exported = checker.getExportsOfModule(module);
  const names = new Set(exported.map((symbol) => symbol.name));

  return exported
    .map((symbol) => {
      const target = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
      const origin = target.declarations?.[0];

      if (origin === undefined) {
        throw new Error(`export-help-slice: the export ${symbol.name} resolves to no declaration.`);
      }

      const source = origin.getSourceFile();
      const found = declaredAs(ts, declarations(source), target.name);
      const kind = KINDS.find((candidate) => found.some((declared) => declared.kind === candidate));

      if (kind === undefined) {
        throw new Error(
          `export-help-slice: ${symbol.name} is exported from ${relative(source.fileName)}, whose declarations do not declare ${target.name}.`,
        );
      }

      const declared = found.filter((candidate) => candidate.kind === kind);
      const first = declared[0];
      // `/** @deprecated */ export { Slen as OldName } from …` — the tag sits on the export statement.
      const exportStatement = symbol.declarations?.map((node) => node.parent?.parent).find((node) => node !== undefined && ts.isExportDeclaration(node));
      const flags = {
        deprecated: tagged(ts, exportStatement, 'deprecated') || declared.some((one) => tagged(ts, one.documented, 'deprecated')),
        internal: tagged(ts, exportStatement, 'internal') || declared.some((one) => tagged(ts, one.documented, 'internal')),
      };

      if (symbol.name !== target.name) {
        // Another name for a symbol: it repeats nothing, the symbol it names says it all.
        if (!names.has(target.name)) {
          throw new Error(`export-help-slice: ${symbol.name} renames ${target.name}, which is not exported under its own name.`);
        }

        return {
          name: symbol.name,
          kind,
          source: relative(source.fileName),
          ...flags,
          alias_of: target.name,
          modifiers: [],
          type_parameters: [],
          extends: [],
          implements: [],
          signature: null,
          members: [],
        };
      }

      const shaped = kind === 'class' || kind === 'interface';

      return {
        name: symbol.name,
        kind,
        source: relative(source.fileName),
        ...flags,
        alias_of: null,
        modifiers: kind === 'class' && has(ts, first.node, ts.SyntaxKind.AbstractKeyword) ? ['abstract'] : [],
        type_parameters: shaped ? (first.node.typeParameters ?? []).map(print) : [],
        extends: shaped ? heritage(ts, print, first.node, ts.SyntaxKind.ExtendsKeyword) : [],
        implements: kind === 'class' ? heritage(ts, print, first.node, ts.SyntaxKind.ImplementsKeyword) : [],
        signature:
          shaped || kind === 'enum' ? null : declared.map((one) => declarationText(ts, print, kind, one.node)).join('; '),
        members:
          shaped || kind === 'enum'
            ? declared.flatMap((one) =>
                one.node.members
                  .filter((member) => isPublic(ts, member))
                  .map((member) => describeMember(ts, print, member, symbol.name)),
              )
            : [],
      };
    })
    .sort(byName);
}

// ---------------------------------------------------------------------------
// The options of the client.

/** `a ?? b ?? c` as `[a, b, c]`, parentheses dropped. */
function chain(ts, node) {
  const bare = ts.skipParentheses(node);

  if (ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return [...chain(ts, bare.left), ...chain(ts, bare.right)];
  }

  return [bare];
}

/** What a literal amounts to in JSON; `undefined` for anything that is not one. */
function literalValue(ts, node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }

  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }

  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }

  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return node.kind === ts.SyntaxKind.TrueKeyword;
  }

  if (ts.isObjectLiteralExpression(node) && node.properties.length === 0) {
    return {};
  }

  if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) {
    return [];
  }

  return undefined;
}

/**
 * What every option falls back to when the caller leaves it out, read off the
 * `??` chains of `src/` whose first operand is a member of a `SlenOptions`
 * value: `options.baseUrl ?? fromEnv('A', 'B') ?? 'http://…'`. A call of
 * `fromEnv` names environment variables, in the order they are read; the
 * operand after that is the default.
 */
function fallbacks(ts, { program, checker }) {
  const found = new Map();

  const bare = (node) => {
    let inner = node;

    while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)) {
      inner = inner.expression;
    }

    return inner;
  };

  /**
   * What a name stands for: `DEFAULT_TIMEOUT_MS` → the `65_000` it is declared
   * as. Only a `const` with an initializer is read through, here or in the
   * module it is imported from; anything else is answered as it is.
   */
  function standsFor(node) {
    let current = bare(node);
    const seen = new Set();

    while (ts.isIdentifier(current) && !seen.has(current)) {
      seen.add(current);

      const named = checker.getSymbolAtLocation(current);
      const symbol = named !== undefined && (named.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(named) : named;
      const declaration = symbol?.valueDeclaration;

      if (
        declaration === undefined ||
        !ts.isVariableDeclaration(declaration) ||
        declaration.initializer === undefined ||
        (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
      ) {
        break;
      }

      current = bare(declaration.initializer);
    }

    return current;
  }

  function record(option, operands, file) {
    const fallback = { env: [], default: null };

    for (const operand of operands) {
      if (ts.isCallExpression(operand) && ts.isIdentifier(operand.expression) && operand.expression.text === ENV_READER) {
        for (const argument of operand.arguments) {
          if (!ts.isStringLiteral(argument)) {
            throw new Error(`export-help-slice: ${ENV_READER}() is called with something other than a name, for ${option}.`);
          }

          fallback.env.push(argument.text);
        }

        continue;
      }

      const written = standsFor(operand);
      const value = literalValue(ts, written);

      // A default that is a literal is given as the literal, also when the source names it
      // (`DEFAULT_TIMEOUT_MS`); anything else is given as it is written (`globalThis.fetch`).
      fallback.default =
        value === undefined
          ? { code: operand.getText(file).replace(/\s+/g, ' ') }
          : { code: written.getText(written.getSourceFile()).replace(/\s+/g, ' '), value };

      break;
    }

    const known = found.get(option);

    if (known !== undefined && JSON.stringify(known) !== JSON.stringify(fallback)) {
      throw new Error(`export-help-slice: the option ${option} falls back to two different things in src/.`);
    }

    found.set(option, fallback);
  }

  const coalesces = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;

  /** True for `a ?? b` inside `(a ?? b) ?? c`: the chain is read once, from its top. */
  function isOperand(node) {
    let parent = node.parent;

    while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
      parent = parent.parent;
    }

    return parent !== undefined && coalesces(parent);
  }

  function visit(node, file) {
    if (coalesces(node) && !isOperand(node)) {
      const [head, ...rest] = chain(ts, node);

      if (ts.isPropertyAccessExpression(head) && checker.getTypeAtLocation(head.expression).symbol?.name === OPTIONS) {
        record(head.name.text, rest, file);
      }
    }

    ts.forEachChild(node, (child) => visit(child, file));
  }

  for (const file of program.getSourceFiles()) {
    if (!file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file)) {
      visit(file, file);
    }
  }

  return found;
}

function describeOptions(ts, source, print) {
  const { checker, declarations, program } = source;
  const symbol = checker
    .getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(ENTRY)))
    .find((candidate) => candidate.name === OPTIONS);
  const origin = symbol === undefined ? undefined : checker.getAliasedSymbol(symbol).declarations?.[0];

  if (origin === undefined) {
    throw new Error(`export-help-slice: ${OPTIONS} is not exported from ${relative(ENTRY)}.`);
  }

  const declared = declaredAs(ts, declarations(origin.getSourceFile()), OPTIONS).find((one) => one.kind === 'interface');

  if (declared === undefined) {
    throw new Error(`export-help-slice: ${OPTIONS} is not an interface any more — this script reads its members.`);
  }

  const read = fallbacks(ts, source);
  const options = declared.node.members.map((member) => {
    if (!ts.isPropertySignature(member) || member.type === undefined) {
      throw new Error(`export-help-slice: ${OPTIONS} has a member that is not a typed property: ${print(member)}`);
    }

    const name = print(member.name);
    const fallback = read.get(name);
    const required = member.questionToken === undefined;

    return {
      name,
      type: print(member.type),
      required,
      default: fallback?.default ?? null,
      // No `??` chain starts at the option: the client handles it some other way
      // (`spanRecorder` and `otlp` are built into one recorder), and what it does
      // when the option is left out is not read here. `default: null` then means
      // "not read", and a reader may not print it as "no default". An option the
      // type demands falls back to nothing, chain or no chain.
      default_known: fallback !== undefined || required,
      env: fallback?.env ?? [],
      description: described(ts, member),
    };
  });

  const unknown = [...read.keys()].filter((name) => !options.some((option) => option.name === name));

  if (unknown.length > 0) {
    throw new Error(`export-help-slice: src/ reads options ${OPTIONS} does not declare: ${unknown.join(', ')}.`);
  }

  return options;
}

// ---------------------------------------------------------------------------
// The calls a client offers.

/**
 * `operations.execute`, `run`, `reservations.get` — every public method that
 * can be reached from a client, named as a caller writes it after the client.
 * The classification is the contract test's (`publicCallsOfTheClient()` in
 * `test/contract.test.ts`): a public property typed as a class is a
 * resource and each of its public methods a call; a getter typed
 * `{ method(): … }` is a resource declared in place; a public method of the
 * client is a call, unless it answers a client (`withLogger`): that one builds
 * another client. A getter or a property of any other type is not a call.
 */
function describeCalls(ts, { program, checker, declarations }, print, exportedNames) {
  const symbol = checker
    .getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(ENTRY)))
    .find((candidate) => candidate.name === CLIENT);
  const origin = symbol === undefined ? undefined : checker.getAliasedSymbol(symbol).declarations?.find(ts.isClassDeclaration);

  if (origin === undefined) {
    throw new Error(`export-help-slice: ${CLIENT} is not a class exported from ${relative(ENTRY)}.`);
  }

  /** The published form of a class that is declared in the source. */
  function published(declaration) {
    const name = declaration.name?.text;
    const found = name === undefined ? undefined : declaredAs(ts, declarations(declaration.getSourceFile()), name).find((one) => one.kind === 'class');

    if (found === undefined) {
      throw new Error(`export-help-slice: the class ${name ?? '(anonymous)'} has no published declaration.`);
    }

    return found.node;
  }

  function call(name, owner, method) {
    return {
      name,
      symbol: exportedNames.has(owner.symbol) ? owner.symbol : null,
      member: owner.member ?? memberName(ts, print, method),
      deprecated: tagged(ts, method, 'deprecated'),
      internal: tagged(ts, method, 'internal'),
      signature: signatureOf(print, method),
    };
  }

  const client = published(origin);
  const calls = [];

  // The classes of the properties are resolved in the source; what is printed is the published form.
  const typesOfProperties = new Map(
    origin.members
      .filter((member) => ts.isPropertyDeclaration(member) && member.name !== undefined)
      .map((member) => [print(member.name), checker.getTypeAtLocation(member).symbol?.declarations?.find(ts.isClassDeclaration)]),
  );

  for (const member of client.members) {
    if (!isPublic(ts, member) || has(ts, member, ts.SyntaxKind.StaticKeyword)) {
      continue;
    }

    const name = member.name === undefined ? '' : print(member.name);

    if (ts.isMethodDeclaration(member) && answersTheClient(ts, member)) {
      continue;
    }

    if (ts.isMethodDeclaration(member)) {
      calls.push(call(name, { symbol: CLIENT }, member));
    } else if (ts.isPropertyDeclaration(member)) {
      const resource = typesOfProperties.get(name);

      if (resource !== undefined) {
        for (const method of published(resource).members) {
          if (ts.isMethodDeclaration(method) && isPublic(ts, method) && !has(ts, method, ts.SyntaxKind.StaticKeyword)) {
            calls.push(call(`${name}.${print(method.name)}`, { symbol: resource.name.text }, method));
          }
        }
      }
    } else if (ts.isGetAccessorDeclaration(member) && member.type !== undefined && ts.isTypeLiteralNode(member.type)) {
      for (const method of member.type.members) {
        if (ts.isMethodSignature(method)) {
          calls.push(call(`${name}.${print(method.name)}`, { symbol: CLIENT, member: name }, method));
        }
      }
    }
  }

  return calls.sort(byName);
}

/** A method of the client typed to answer the client itself: it builds another one. */
function answersTheClient(ts, method) {
  return method.type !== undefined && ts.isTypeReferenceNode(method.type) && ts.isIdentifier(method.type.typeName) && method.type.typeName.text === CLIENT;
}

/** The call table both SDKs read, and this SDK's name in it. */
const CALL_TABLE = path.join(CONTRACT, 'calls.json');
const TABLE_SDK = 'typescript';

/**
 * Every call with the HTTP operation it makes — its line in
 * `contract/calls.json` (`POST /v1/operations/execute`), or `null` for a call
 * that makes none (`webhooks.verify`, `flush`). The table is not built here: the
 * contract test holds it to the code (a line for every wire call, each call
 * driven to the method and the path of its line). What the exporter refuses is
 * a line for a call this client does not offer — the slice would then say less
 * than the table.
 */
function withOperations(calls) {
  let table;

  try {
    table = JSON.parse(readFileSync(CALL_TABLE, 'utf8')).calls;
  } catch (error) {
    throw new Error(`export-help-slice: ${relative(CALL_TABLE)} could not be read.`, { cause: error });
  }

  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    throw new Error(`export-help-slice: ${relative(CALL_TABLE)} has no \`calls\`.`);
  }

  const lines = new Map(
    Object.entries(table).filter(([, line]) => Array.isArray(line?.sdks) && line.sdks.includes(TABLE_SDK)),
  );
  const offered = new Set(calls.map((call) => call.name));
  const stray = sorted([...lines.keys()].filter((name) => !offered.has(name)));

  if (stray.length > 0) {
    throw new Error(`export-help-slice: ${relative(CALL_TABLE)} names calls of ${TABLE_SDK} the client does not offer: ${stray.join(', ')}.`);
  }

  return calls.map((call) => {
    const operation = lines.get(call.name)?.operation;

    return { ...call, operation: typeof operation === 'string' ? operation : null };
  });
}

// ---------------------------------------------------------------------------
// The slice.

let built = null;

/** The slice of the tree as it is now. Built once per process. */
export function buildSlice() {
  if (built !== null) {
    return built;
  }

  const ts = compiler();
  const source = read(ts);
  const print = printerOf(ts);
  const symbols = describeSymbols(ts, source, print);

  built = {
    schema: SCHEMA,
    language: 'node',
    package: describePackage(),
    client: { class: CLIENT, options: OPTIONS },
    options: describeOptions(ts, source, print),
    config_file: null,
    calls: withOperations(describeCalls(ts, source, print, new Set(symbols.map((symbol) => symbol.name)))),
    symbols,
  };

  return built;
}

/** The bytes of the file: two spaces, LF, one line break at the end. */
export function render(slice) {
  return `${JSON.stringify(slice, null, 2)}\n`;
}

/**
 * What differs between a committed slice and a fresh one, by entity:
 * `+ options: proxy`, `- calls: customers.balance`, `~ symbols: Slen`.
 * Empty when the two are the same bytes.
 */
export function differences(committed, fresh) {
  if (committed === fresh) {
    return [];
  }

  let before;

  try {
    before = JSON.parse(committed);
  } catch {
    return ['the committed slice is not JSON'];
  }

  const after = JSON.parse(fresh);
  const found = [];

  for (const key of sorted(new Set([...Object.keys(before ?? {}), ...Object.keys(after)]))) {
    const [was, is] = [before?.[key], after[key]];
    const named = (list) => Array.isArray(list) && list.every((item) => typeof item?.name === 'string');

    if (named(was) && named(is)) {
      const old = new Map(was.map((item) => [item.name, JSON.stringify(item)]));
      const now = new Map(is.map((item) => [item.name, JSON.stringify(item)]));

      for (const name of sorted(new Set([...old.keys(), ...now.keys()]))) {
        if (!old.has(name)) {
          found.push(`+ ${key}: ${name}`);
        } else if (!now.has(name)) {
          found.push(`- ${key}: ${name}`);
        } else if (old.get(name) !== now.get(name)) {
          found.push(`~ ${key}: ${name}`);
        }
      }

      if (found.length === 0 && JSON.stringify(was) !== JSON.stringify(is)) {
        found.push(`~ ${key}: the order`);
      }
    } else if (JSON.stringify(was) !== JSON.stringify(is)) {
      found.push(`~ ${key}`);
    }
  }

  return found.length === 0 ? ['the same facts, written differently (indentation, key order, line ends)'] : found;
}

/** True for a file that is there — not for a directory, a missing path, or one that cannot be looked at (as `is_file()` in the PHP exporter). */
function isFile(file) {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

const USAGE = `usage: node scripts/export-help-slice.mjs [--write | --check] [--out <file>]

  (nothing)   print the slice of the tree as it is now
  --write     write it to help-slice.json
  --check     compare it with the committed file: exit 1 and say what differs
  --out       another file to write or to check
`;

/**
 * The command line. Answers the exit code: 0 — done, or fresh; 1 — the
 * committed slice is stale, or not there; 2 — the command line is wrong, the
 * slice could not be built, or its file could not be written or read.
 */
export function main(argv, io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }) {
  let mode = 'print';
  let file = SLICE_FILE;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--write' || argument === '--check') {
      if (mode !== 'print') {
        io.err(USAGE);

        return 2;
      }

      mode = argument.slice(2);
    } else if (argument === '--out' && argv[index + 1] !== undefined) {
      file = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith('--out=') && argument.length > '--out='.length) {
      file = path.resolve(argument.slice('--out='.length));
    } else if (argument === '--help' || argument === '-h') {
      io.out(USAGE);

      return 0;
    } else {
      io.err(USAGE);

      return 2;
    }
  }

  let fresh;

  try {
    fresh = render(buildSlice());
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);

    return 2;
  }

  if (mode === 'print') {
    io.out(fresh);

    return 0;
  }

  // A file that cannot be written or read is 2, in one line: 1 is kept for "the slice is stale".
  if (mode === 'write') {
    try {
      writeFileSync(file, fresh);
    } catch {
      io.err(`export-help-slice: cannot write ${path.basename(file)}.\n`);

      return 2;
    }

    io.err(`wrote ${path.basename(file)}\n`);

    return 0;
  }

  if (!isFile(file)) {
    io.err(`${path.basename(file)} is not there — write it: node scripts/export-help-slice.mjs --write\n`);

    return 1;
  }

  let committed;

  try {
    committed = readFileSync(file, 'utf8');
  } catch {
    io.err(`export-help-slice: cannot read ${path.basename(file)}.\n`);

    return 2;
  }

  const found = differences(committed, fresh);

  if (found.length === 0) {
    return 0;
  }

  io.err(
    `${path.basename(file)} is not what the code says now:\n${found.map((line) => `  ${line}`).join('\n')}\n` +
      'Regenerate it (node scripts/export-help-slice.mjs --write), commit it with the change, and re-run help-sync in the console.\n',
  );

  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
