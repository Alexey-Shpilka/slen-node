/**
 * The types that ship, read by a consumer's TypeScript rather than ours.
 *
 *   npm ci && node scripts/consumer.mjs <typescript version>
 *
 * The package is packed as an install gets it and installed into an empty
 * project beside the TypeScript named; every help example
 * (`examples/help/<id>/node.ts`, the code a reader copies) is compiled there
 * against `dist/*.d.ts` with `skipLibCheck: false`, once with Node's
 * resolution and once with a bundler's. It needs the registry and
 * `node_modules`: packing runs `prepare`, the build. CI runs it on the oldest TypeScript 5 the package holds and on 7
 * (`typescript-consumer` in `.github/workflows/ci.yml`).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roots } from './paths.mjs';

const RESOLUTIONS = {
  NodeNext: { module: 'NodeNext', moduleResolution: 'NodeNext' },
  Bundler: { module: 'ESNext', moduleResolution: 'Bundler' },
};

const OPTIONS = {
  target: 'ES2022',
  lib: ['ES2022', 'DOM'],
  strict: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: false,
  noEmit: true,
};

function npm(args, cwd) {
  return execFileSync('npm', ['--no-audit', '--no-fund', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Every example as `<id>.ts` at the root of the project; the count, so an empty run cannot pass.
function copyExamples(examples, project) {
  const ids = readdirSync(new URL('help/', examples), { withFileTypes: true }).filter((entry) => entry.isDirectory());

  for (const { name } of ids) {
    copyFileSync(new URL(`help/${name}/node.ts`, examples), join(project, `${name}.ts`));
  }

  return ids.length;
}

function compile(project, resolution) {
  writeJson(join(project, `tsconfig.${resolution}.json`), {
    compilerOptions: { ...OPTIONS, ...RESOLUTIONS[resolution] },
    include: ['*.ts'],
  });

  try {
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `tsconfig.${resolution}.json`], { cwd: project, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const version = process.argv[2];

  if (version === undefined) {
    console.error('usage: node scripts/consumer.mjs <typescript version>');
    return 2;
  }

  const { PACKAGE, EXAMPLES } = roots();
  const project = mkdtempSync(join(tmpdir(), 'slen-consumer-'));

  try {
    // Packing runs `prepare` (the build) and prints it: the tarball is found on disk, not in the output.
    execFileSync('npm', ['pack', '--pack-destination', project], { cwd: fileURLToPath(PACKAGE), stdio: ['ignore', 'ignore', 'inherit'] });
    const tarball = readdirSync(project).find((name) => name.endsWith('.tgz'));

    writeJson(join(project, 'package.json'), { name: 'consumer', private: true, type: 'module' });
    npm(['install', '--ignore-scripts', `./${tarball}`, `typescript@${version}`], project);

    const examples = copyExamples(EXAMPLES, project);
    const compiler = execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--version'], { cwd: project, encoding: 'utf8' }).trim();
    const failed = Object.keys(RESOLUTIONS).filter((resolution) => compile(project, resolution) === false);

    console.log(`${tarball}, ${examples} examples, ${compiler}: ${failed.length === 0 ? 'NodeNext and Bundler compile' : `${failed.join(', ')} failed`}`);

    return failed.length === 0 && examples > 0 ? 0 : 1;
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

process.exitCode = main();
