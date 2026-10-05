import { summary } from './harness.mjs';

await import('../app/lib/planner.test.ts');
await import('../app/lib/storage.test.ts');
await import('../app/store/confirm.test.ts');

await summary();
