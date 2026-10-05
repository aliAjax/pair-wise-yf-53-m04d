// 极简断言框架：无外部依赖
let passed = 0;
const failures = [];
const queue = [];
let currentSuite = '';

export function describe(name, fn) {
  const prev = currentSuite;
  currentSuite = prev ? `${prev} > ${name}` : name;
  fn();
  currentSuite = prev;
}

export function it(name, fn) {
  const label = `${currentSuite} :: ${name}`;
  queue.push(() => {
    try {
      fn();
      passed += 1;
    } catch (error) {
      failures.push({ label, error });
    }
  });
}

// 异步入队，summary 时按注册顺序串行执行，避免共享全局状态的用例互相串扰
export function itAsync(name, fn) {
  const label = `${currentSuite} :: ${name}`;
  queue.push(async () => {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push({ label, error });
    }
  });
}

export function assert(condition, message) {
  if (!condition) throw new Error(message ?? '断言失败');
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message ?? '值不一致'}\n  期望: ${e}\n  实际: ${a}`);
  }
}

export async function summary() {
  for (const run of queue) await run();
  if (failures.length) {
    for (const failure of failures) {
      console.error(`✗ ${failure.label}`);
      console.error(`  ${failure.error?.stack?.split('\n').slice(0, 4).join('\n  ') ?? failure.error}`);
    }
    console.error(`\n${passed} 通过，${failures.length} 失败`);
    process.exitCode = 1;
  } else {
    console.log(`全部通过：${passed} 个用例`);
  }
}
