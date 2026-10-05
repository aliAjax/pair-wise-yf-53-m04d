import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  MultiSelect,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title
} from '@mantine/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  addGate,
  confirmSchedule,
  createTrain,
  activateTrain,
  removeGate,
  resolveGateBlocker,
  selectActiveTrain,
  selectPendingConfirmations,
  selectPlan,
  setCapacity,
  setFreeze,
  setRemoteFaultInjected,
  unconfirmGate,
  updateGate,
  useAppDispatch,
  useAppSelector,
  useGetTrainHealthQuery,
  type Confirmation,
  type RepositoryGate
} from '../store';
import type { UnscheduledGate } from '../lib/types';

const trainSchema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const gateSchema = z.object({
  repository: z.string().min(2, '仓库名至少2个字符'),
  owner: z.string().min(1, '请填写负责人'),
  version: z.string().min(1, '请填写版本')
});

const REASON_TEXT: Record<UnscheduledGate['reason'], string> = {
  'open-blocker': '有未关闭的阻断问题',
  'upstream-blocked': '上游仓库存在未关闭阻断',
  'upstream-missing': '依赖的仓库不在本列车',
  'upstream-cycle': '依赖链成环，发布已拦下'
};

function StatusBadge({ confirmation }: { confirmation?: Confirmation }) {
  switch (confirmation?.status) {
    case 'confirmed':
      return <Badge color="green">远端已锁定 · 第 {confirmation.windowIndex! + 1} 窗</Badge>;
    case 'confirming':
      return <Badge color="blue">远端确认中…</Badge>;
    case 'failed':
      return <Badge color="red">确认失败 · 待重试</Badge>;
    default:
      return <Badge color="gray">未定</Badge>;
  }
}

function GateLine({ gate, gateById, plan, confirmation, dispatch }: {
  gate: RepositoryGate;
  gateById: Map<string, RepositoryGate>;
  plan: ReturnType<typeof selectPlan>;
  confirmation?: Confirmation;
  dispatch: ReturnType<typeof useAppDispatch>;
}) {
  const windowOfDep = (id: string): number | undefined =>
    plan.windows.find((win) => win.assignments.some((a) => a.gateId === id))?.index;
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <div style={{ minWidth: 0 }}>
        <Group gap="xs">
          <Text fw={600}>{gate.repository}</Text>
          <Text size="xs" c="dimmed">v{gate.version} · {gate.owner}</Text>
        </Group>
        {gate.dependsOn.length > 0 && (
          <Text size="xs" c="dimmed">
            依赖上游：
            {gate.dependsOn.map((id) => {
              const index = windowOfDep(id);
              return `${gateById.get(id)?.repository ?? id}${index === undefined ? '' : `@窗${index + 1}`}`;
            }).join('、')}
          </Text>
        )}
        {confirmation?.status === 'failed' && <Text size="xs" c="red">{confirmation.message}</Text>}
      </div>
      <Group gap="xs" wrap="nowrap">
        <StatusBadge confirmation={confirmation} />
        {confirmation?.status === 'confirmed' && (
          <Button size="xs" variant="subtle" color="gray" onClick={() => dispatch(unconfirmGate(gate.id))}>撤回锁定</Button>
        )}
      </Group>
    </Group>
  );
}

export default function Home() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.train);
  const train = selectActiveTrain(state);
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const [confirming, setConfirming] = useState(false);
  const [lastResult, setLastResult] = useState<{ confirmed: number; failed: string[] } | null>(null);
  const trainForm = useForm<z.infer<typeof trainSchema>>({
    resolver: zodResolver(trainSchema),
    defaultValues: { name: '', freezeAt: '2026-10-10 18:00' }
  });
  const gateForm = useForm<z.infer<typeof gateSchema>>({ resolver: zodResolver(gateSchema), defaultValues: { repository: '', owner: '', version: '' } });
  const [pickedDeps, setPickedDeps] = useState<string[]>([]);

  if (!train) return null;
  const plan = selectPlan(train);
  const gateById = new Map(train.gates.map((gate) => [gate.id, gate]));
  const pendingCount = plan.windows.reduce(
    (n, win) => n + win.assignments.filter((a) => {
      const s = train.confirmations[a.gateId]?.status ?? 'unconfirmed';
      return s === 'unconfirmed' || s === 'failed';
    }).length,
    0
  );
  const confirmedCount = train.gates.filter((gate) => train.confirmations[gate.id]?.status === 'confirmed').length;
  const blockedCount = train.gates.filter((gate) => gate.blocked).length;

  async function runConfirm() {
    if (!train || !plan.ok || confirming) return;
    const { items } = selectPendingConfirmations(train);
    if (items.length === 0) return;
    setConfirming(true);
    try {
      const result = await dispatch(confirmSchedule({ trainId: train.id, items })).unwrap();
      setLastResult({
        confirmed: result.confirmed.length,
        failed: result.failed.map((item) => gateById.get(item.gateId)?.repository ?? item.gateId)
      });
    } finally {
      setConfirming(false);
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>发布列车窗口排期台</Title>
          <Text>按仓库门禁依赖自动分批：上游先进前面的窗口，窗口满员顺延，批次可与远端锁定。</Text>
        </div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 5 }} mb="xl">
        <Card withBorder><Text size="xs">窗口容量</Text><Title order={3}>{train.capacity} 仓/窗</Title></Card>
        <Card withBorder><Text size="xs">批次窗口</Text><Title order={3}>{plan.ok ? plan.windows.length : '—'}</Title></Card>
        <Card withBorder><Text size="xs">远端已定</Text><Title order={3}>{confirmedCount}/{train.gates.length}</Title>
          <Progress mt="sm" value={confirmedCount / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">阻断中仓库</Text><Title order={3} c={blockedCount ? 'red' : 'green'}>{blockedCount}</Title></Card>
        <Card withBorder><Text size="xs">远端健康</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      {!plan.ok && (
        <Alert color="red" title="检测到互相依赖，整列发布已拦下" mb="lg">
          {plan.cycles.map((cycle) => (
            <Stack key={cycle.nodes.join('|')} gap={4} mb="sm">
              <Text>环上仓库：<b>{cycle.nodes.map((id) => gateById.get(id)?.repository ?? id).join('、')}</b></Text>
              <Text size="sm">依赖闭环：{cycle.path.map((id) => gateById.get(id)?.repository ?? id).join(' → ')}</Text>
            </Stack>
          ))}
          <Text size="sm">请先打断环（删除其中一条依赖），解除后批次会自动重算。</Text>
        </Alert>
      )}

      {plan.lockConflicts.length > 0 && (
        <Alert color="orange" title="已锁定批次与当前依赖冲突（锁定已保留）" mb="lg">
          {plan.lockConflicts.map((conflict) => (
            <Text key={`${conflict.gateId}-${conflict.upstream}`} size="sm">
              {gateById.get(conflict.gateId)?.repository} 锁在第 {conflict.windowIndex + 1} 窗，
              但其上游 {gateById.get(conflict.upstream)?.repository} 现在落在第 {conflict.upstreamWindow + 1} 窗。
              请撤回其中之一的锁定后重算。
            </Text>
          ))}
        </Alert>
      )}

      {lastResult && (
        <Alert color={lastResult.failed.length ? 'orange' : 'teal'} title="远端排期确认结果" mb="lg">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Text size="sm">
              本轮新锁定 {lastResult.confirmed} 个仓库；
              {lastResult.failed.length
                ? <>失败 {lastResult.failed.join('、')}，已定批次未受影响，处理完点“重试未定仓库”即可。</>
                : '无失败。'}
            </Text>
            <Button size="xs" variant="subtle" onClick={() => setLastResult(null)}>知道了</Button>
          </Group>
        </Alert>
      )}

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>窗口批次</Title>
              <Group gap="xs">
                <NumberInput
                  label="每窗容量" size="xs" w={110} min={1} max={20}
                  value={train.capacity}
                  onChange={(value) => typeof value === 'number' && dispatch(setCapacity(value))}
                />
                <Switch
                  label="模拟下轮远端失败" size="xs" mt={18}
                  checked={state.remoteFaultInjected}
                  onChange={(event) => dispatch(setRemoteFaultInjected(event.currentTarget.checked))}
                />
              </Group>
            </Group>
            <Button
              fullWidth mb="md"
              disabled={!plan.ok || pendingCount === 0 || confirming}
              loading={confirming}
              onClick={runConfirm}
            >
              {confirming ? '正在向远端确认…' : pendingCount === 0 ? '全部批次已定' : `向远端确认 / 重试未定仓库（${pendingCount}）`}
            </Button>

            {plan.ok && plan.windows.length === 0 && (
              <Text c="dimmed" size="sm">当前没有可排期的仓库：全部被阻断或依赖未满足。</Text>
            )}

            <Stack gap="sm">
              {plan.windows.map((win) => (
                <Card key={win.index} withBorder padding="sm" className={win.overflow ? 'window-overflow' : undefined}>
                  <Group justify="space-between" mb={6}>
                    <Text fw={700}>窗口 {win.index + 1}</Text>
                    <Group gap="xs">
                      <Badge variant="light">{win.assignments.length}/{win.capacity}</Badge>
                      {win.overflow && <Badge color="red">锁定仓库顶爆容量</Badge>}
                    </Group>
                  </Group>
                  <Stack gap={6}>
                    {win.assignments.map((assignment) => {
                      const gate = gateById.get(assignment.gateId);
                      if (!gate) return null;
                      return (
                        <Card key={assignment.gateId} padding="xs" withBorder bg={gate.blocked ? undefined : 'gray.0'}>
                          <GateLine gate={gate} gateById={gateById} plan={plan} confirmation={train.confirmations[gate.id]} dispatch={dispatch} />
                        </Card>
                      );
                    })}
                  </Stack>
                </Card>
              ))}
            </Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="sm">未进批次的仓库</Title>
            {plan.unscheduled.length === 0
              ? <Text size="sm" c="dimmed">没有遗留仓库。</Text>
              : <Stack gap="xs">
                  {plan.unscheduled.map((item) => {
                    const gate = gateById.get(item.gateId);
                    return (
                      <Card key={item.gateId} padding="sm" withBorder>
                        <Group justify="space-between" align="flex-start">
                          <div>
                            <Group gap="xs">
                              <Text fw={600}>{gate?.repository ?? item.gateId}</Text>
                              <Badge color={item.reason === 'upstream-cycle' ? 'red' : 'orange'} variant="light">
                                {REASON_TEXT[item.reason]}
                              </Badge>
                            </Group>
                            <Text size="xs" c="dimmed" mt={4}>
                              {item.causedBy?.length ? `直接原因：${item.causedBy.map((id) => gateById.get(id)?.repository ?? id).join('、')}` : null}
                              {gate?.blockerReason ? `　阻断说明：${gate.blockerReason}` : null}
                            </Text>
                          </div>
                          {gate?.blocked && (
                            <Button size="xs" variant="light" color="green" onClick={() => dispatch(resolveGateBlocker(gate.id))}>
                              负责人已处理，放行
                            </Button>
                          )}
                        </Group>
                      </Card>
                    );
                  })}
                </Stack>}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3} mb="md">发布控制</Title>
            <Group grow>
              <Button onClick={() => dispatch(setFreeze('frozen'))} disabled={!plan.ok}>冻结列车</Button>
              <Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button>
              <Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button>
            </Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">加入仓库门禁</Title>
            <form onSubmit={gateForm.handleSubmit((values) => {
              dispatch(addGate({ ...values, dependsOn: pickedDeps, blocked: false }));
              gateForm.reset();
              setPickedDeps([]);
            })}>
              <Stack gap="sm">
                <TextInput label="仓库名" {...gateForm.register('repository')} error={gateForm.formState.errors.repository?.message} />
                <TextInput label="负责人" {...gateForm.register('owner')} error={gateForm.formState.errors.owner?.message} />
                <TextInput label="版本" {...gateForm.register('version')} error={gateForm.formState.errors.version?.message} />
                <MultiSelect
                  label="依赖的上游（可多选，留空表示无依赖）"
                  placeholder="选择上游仓库"
                  data={train.gates.map((gate) => ({ value: gate.id, label: `${gate.repository} v${gate.version}` }))}
                  value={pickedDeps}
                  onChange={setPickedDeps}
                  searchable
                  clearable
                />
                <Button type="submit">加入列车</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">仓库与阻断管理（{train.gates.length}）</Title>
            <Stack gap="xs">
              {train.gates.map((gate) => (
                <Card key={gate.id} padding="xs" withBorder>
                  <Group justify="space-between" align="flex-start">
                    <div>
                      <Text size="sm" fw={600}>{gate.repository} <Text component="span" c="dimmed" size="xs">v{gate.version} · {gate.owner}</Text></Text>
                      {gate.dependsOn.length > 0 && (
                        <Text size="xs" c="dimmed">上游：{gate.dependsOn.map((id) => gateById.get(id)?.repository ?? id).join('、')}</Text>
                      )}
                    </div>
                    <Group gap="xs">
                      <Select
                        size="xs" w={150} placeholder="加依赖"
                        data={train.gates.filter((g) => g.id !== gate.id && !gate.dependsOn.includes(g.id)).map((g) => ({ value: g.id, label: g.repository }))}
                        value={null}
                        onChange={(value) => value && dispatch(updateGate({ id: gate.id, patch: { dependsOn: [...gate.dependsOn, value] } }))}
                        clearable
                      />
                      <Button size="xs" variant="subtle" color="red" onClick={() => dispatch(removeGate(gate.id))}>移除</Button>
                    </Group>
                  </Group>
                  <Checkbox
                    mt={6} size="xs"
                    label={gate.blocked ? `阻断未关闭：${gate.blockerReason ?? '见负责人说明'}` : '标记为存在未关闭阻断问题'}
                    checked={gate.blocked}
                    onChange={(event) => dispatch(updateGate({
                      id: gate.id,
                      patch: event.currentTarget.checked
                        ? { blocked: true, blockerReason: '负责人手动标记的阻断问题' }
                        : { blocked: false, blockerReason: undefined }
                    }))}
                  />
                  {gate.dependsOn.length > 0 && (
                    <Group gap={4} mt={4}>
                      {gate.dependsOn.map((dep) => (
                        <Button
                          key={dep} size="xs" variant="white" color="gray"
                          onClick={() => dispatch(updateGate({ id: gate.id, patch: { dependsOn: gate.dependsOn.filter((d) => d !== dep) } }))}
                        >
                          去掉上游 {gateById.get(dep)?.repository ?? dep} ✕
                        </Button>
                      ))}
                    </Group>
                  )}
                </Card>
              ))}
            </Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={trainForm.handleSubmit((values) => { dispatch(createTrain(values)); trainForm.reset(); })}>
              <Stack gap="sm">
                <TextInput label="列车名称" {...trainForm.register('name')} error={trainForm.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...trainForm.register('freezeAt')} error={trainForm.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 10).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => (
              <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>
            ))}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
