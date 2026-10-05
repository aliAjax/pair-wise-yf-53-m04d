# pair-wise-yf-53 开源项目发布列车窗口排期台

## 源提示词摘要
发布窗口每天可发的仓库名额有限。系统按仓库门禁的依赖自动排出每个窗口的批次：被依赖的上游先进前面的批次，窗口容量满时仓库顺延到下一窗并保留依赖关系；窗口容量改动后已排批次自动重算；有未关闭阻断问题的仓库不进批次；互相依赖时拦下发布并点名环上仓库；远端排期确认失败后保留已定批次、只重试未定仓库；浏览器旧稿升级后可继续使用。

## 技术栈
React Router 7（SPA 模式）+ TypeScript + Mantine + Redux Toolkit（含 RTK Query、createAsyncThunk）+ React Hook Form + Zod + Lingui。

## 排期规则（`app/lib/planner.ts`，纯函数、零依赖）
- Tarjan SCC 找环：发现互相依赖时 `plan.ok=false`，整列发布拦下，给出 `a → b → a` 的环路径点名。
- Kahn 稳定拓扑序（平局按 id 字典序），保证重算结果与输入顺序无关。
- 上游必须落在**严格更早**的窗口；同窗口按拓扑序排列。
- 每个窗口容量有限，满员顺延下一窗。
- 有未关闭阻断问题（`blocked`）的仓库不进批次，阻断沿依赖边向下游传播并点名直接原因仓库；缺失依赖单独标记。
- 已与远端确认（confirmed）的仓库视为**锁定**：容量/依赖改动后保留原窗，只重算未定仓库；锁定顶爆容量标 `overflow`，锁定不再早于上游时标 `lockConflicts`，由负责人撤回确认后重排。

## 远端确认与失败恢复（`app/store/index.ts`、`app/lib/remote.ts`）
- 待确认清单在 dispatch 前计算（RTK 的 pending reducer 先于 payloadCreator 执行），只提交 `unconfirmed/failed` 的仓库。
- 单仓库失败只影响自己：成功的锁定原窗，失败的标 `failed` 并保留远端错误信息；负责人处理完再点一次，只重试失败仓库，已锁定的绝不重复提交。
- 阻断关闭、容量调整后下一轮自动纳入新可排仓库。
- “模拟下轮远端失败”开关只放倒本轮第一个请求，便于演示恢复流程。

## 旧稿迁移（`app/lib/storage.ts`）
- 持久化带 `version`：当前为 v2，key `yf53-release-state-v2`。
- 无版本号的 v1 旧稿（单个 `dependency: "repo@ver"` 字符串）自动按仓库名解析为依赖 id 数组，补齐容量与确认字段，写入迁移审计；损坏 JSON 安全回退种子数据。

## 测试
零额外依赖：`scripts/ts-loader.mjs` 用项目内 TypeScript 转译，`scripts/harness.mjs` 提供串行断言框架。

```bash
npm test       # 31 个用例：排期引擎 / v1 迁移 / 确认与失败重试（含成环拦截、容量重算）
npm run typecheck
npm run build
```

## 启动
```bash
npm install
npm run dev
```
开发端口：62018
