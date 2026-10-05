// 零额外依赖的 TS ESM 加载器：用项目内的 TypeScript 把 .ts 转成 ESM 跑测试。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export async function load(url, context, nextLoad) {
  const cleanUrl = url.split('?')[0].split('#')[0];
  if (cleanUrl.endsWith('.ts')) {
    const result = await nextLoad(url, { ...context, format: 'module' });
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source ?? '').toString('utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
        verbatimModuleSyntax: false,
        sourceMap: false
      },
      fileName: fileURLToPath(cleanUrl)
    });
    return { format: 'module', shortCircuit: true, source: outputText };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  // 允许测试里写无扩展名的相对导入（./planner 形式）
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/.test(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      const full = resolvePath(dirname(parentPath), candidate);
      if (existsSync(full)) return { url: pathToFileURL(full).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
