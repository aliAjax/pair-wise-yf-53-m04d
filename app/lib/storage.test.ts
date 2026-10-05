import { describe, it, assert, assertEqual } from '../../scripts/harness.mjs';
import { loadDraft, migrateV1, saveDraft, STORAGE_KEY, DEFAULT_CAPACITY } from './storage.ts';

// storage.ts 引用 window，测试里用极简 stub 模拟 localStorage
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

function installWindow() {
  const localStorage = new MemoryStorage();
  globalThis.window = { localStorage };
  return localStorage;
}

describe('旧稿迁移', () => {
  it('无 version 的 v1 草稿升级为 v2，dependency 字符串按仓库名解析为 id', () => {
    const v1 = {
      activeId: 't1',
      trains: [{
        id: 't1', name: '旧列车', freezeAt: '2026-09-01', status: 'preparing',
        gates: [
          { id: 'g1', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'confirmed', version: '2.12' },
          { id: 'g2', repository: 'auth-sdk', owner: '韩梅', dependency: '', status: 'pending', version: '2.1' },
          { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9' }
        ],
        blockers: [],
        audit: [{ id: 'a1', at: '10:00', text: '旧审计' }]
      }]
    };
    const v2 = migrateV1(v1);
    assertEqual(v2.version, 2);
    const train = v2.trains[0];
    assertEqual(train.capacity, DEFAULT_CAPACITY);
    const byId = new Map(train.gates.map((g) => [g.id, g]));
    assertEqual(byId.get('g1').dependsOn, ['g2']);
    assertEqual(byId.get('g2').dependsOn, []);
    assertEqual(byId.get('g3').dependsOn, ['g1']);
    assertEqual(byId.get('g3').blocked, true);
    assertEqual(byId.get('g1').blocked, false); // v1 的 confirmed 不意味着阻断
    assert(train.audit[0].text.includes('v1 升级'));
    // 历史确认不自动当成锁定，避免旧稿套错批次
    assertEqual(train.confirmations, {});
  });

  it('dependency 指向不存在的仓库时安全降级为无依赖', () => {
    const v2 = migrateV1({
      activeId: 't',
      trains: [{
        id: 't', name: 'x', freezeAt: 'x', status: 'preparing',
        gates: [{ id: 'g1', repository: 'solo', owner: 'o', dependency: 'ghost@1', status: 'pending', version: '1' }],
        blockers: [], audit: []
      }]
    });
    assertEqual(v2.trains[0].gates[0].dependsOn, []);
  });

  it('loadDraft 从旧 key 读到 v1 并自动迁移，随后 saveDraft 写新 key', () => {
    const storage = installWindow();
    storage.setItem('yf53-release-state', JSON.stringify({
      activeId: 't',
      trains: [{
        id: 't', name: 'x', freezeAt: 'x', status: 'preparing',
        gates: [{ id: 'g1', repository: 'a', owner: 'o', dependency: '', status: 'pending', version: '1' }],
        blockers: [], audit: []
      }]
    }));
    const fallback = { version: 2, activeId: 'fb', trains: [] };
    const loaded = loadDraft(fallback);
    assertEqual(loaded.version, 2);
    assertEqual(loaded.trains[0].capacity, DEFAULT_CAPACITY);
    saveDraft(loaded);
    assert(storage.getItem(STORAGE_KEY).includes('"version":2'));
  });

  it('损坏 JSON 与无法识别结构回退初始数据', () => {
    const storage = installWindow();
    storage.setItem(STORAGE_KEY, '{not json');
    const fallback = { version: 2, activeId: 'fb', trains: [] };
    assertEqual(loadDraft(fallback), fallback);

    storage.setItem(STORAGE_KEY, JSON.stringify({ hello: 'world' }));
    assertEqual(loadDraft(fallback), fallback);
  });

  it('normalizeV2 补齐缺失字段，去重依赖', () => {
    const storage = installWindow();
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2, activeId: 't',
      trains: [{
        id: 't', name: 'x', freezeAt: 'x', status: 'preparing',
        gates: [{ id: 'g1', repository: 'a', owner: 'o', dependsOn: ['g2', 'g2'], blocked: false, version: '1' }],
        // 缺 capacity / confirmations
        audit: []
      }]
    }));
    const loaded = loadDraft({ version: 2, activeId: 'fb', trains: [] });
    assertEqual(loaded.trains[0].capacity, DEFAULT_CAPACITY);
    assertEqual(loaded.trains[0].confirmations, {});
    assertEqual(loaded.trains[0].gates[0].dependsOn, ['g2']);
  });
});
