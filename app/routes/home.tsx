import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import { computeSchedule } from '../lib/schedule';
import {
  activateTrain,
  addWindow,
  confirmGate,
  createTrain,
  removeWindow,
  resolveBlocker,
  setFreeze,
  updateWindow,
  useConfirmScheduleMutation,
  useGetTrainHealthQuery,
  type GateRemoteState,
  type ReleaseTrain
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

function RemoteBadge({ state }: { state: GateRemoteState }) {
  if (state === 'confirmed') return <Badge color="green">排期已确认</Badge>;
  if (state === 'failed') return <Badge color="red">确认失败</Badge>;
  return <Badge color="gray">未确认</Badge>;
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: { train: ReturnType<typeof import('../store').store.getState>['train'] }) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const [confirmSchedule] = useConfirmScheduleMutation();
  const [confirming, setConfirming] = useState(false);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });

  const schedule = useMemo(() => (train ? computeSchedule(train) : null), [train]);
  const gatesById = useMemo(() => new Map((train?.gates ?? []).map((g) => [g.id, g])), [train]);
  const scheduledIds = useMemo(() => new Set((schedule?.batches ?? []).flatMap((b) => b.gateIds)), [schedule]);

  if (!train || !schedule) return null;

  const unresolved = train.blockers.filter((item) => !item.resolved).length;
  const confirmed = train.gates.filter((item) => item.status === 'confirmed').length;
  const pendingRemote = train.gates.filter((g) => scheduledIds.has(g.id) && g.remoteState !== 'confirmed');
  const failedRemote = train.gates.filter((g) => scheduledIds.has(g.id) && g.remoteState === 'failed');
  const cycleNames = schedule.cycle ?? [];

  async function runConfirm(ids: string[]) {
    if (!train || ids.length === 0) return;
    setConfirming(true);
    for (const id of ids) {
      // 单个仓库失败时 mutation 已记录失败状态；其余仓库继续，已确认批次不受影响。
      try {
        await confirmSchedule({ trainId: train.id, gateId: id }).unwrap();
      } catch {
        /* 失败已落库，继续处理下一个 */
      }
    }
    setConfirming(false);
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>开源项目发布列车准备台</Title>
          <Text>按仓库门禁依赖自动排布发布窗口批次：被依赖的上游进前窗，满窗顺延下一窗；阻断未关闭的仓库不进批次，循环依赖直接拦下。</Text>
        </div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder><Text size="xs">远端检查</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>发布窗口与批次</Title>
              <Group>
                <Button size="xs" variant="light" loading={confirming} disabled={!!schedule.cycle || pendingRemote.length === 0} onClick={() => runConfirm(pendingRemote.map((g) => g.id))}>
                  确认排期（{pendingRemote.length}）
                </Button>
                <Button size="xs" variant="default" loading={confirming} disabled={failedRemote.length === 0} onClick={() => runConfirm(failedRemote.map((g) => g.id))}>
                  重试失败项（{failedRemote.length}）
                </Button>
                <Button size="xs" variant="subtle" onClick={() => dispatch(addWindow({ trainId: train.id }))}>新增窗口</Button>
              </Group>
            </Group>
            <Text size="sm" c="dimmed" mb="md">批次按依赖自动重算，无需手工拖拽：上游仓库排在前面的窗口，当前窗口容量满后排队顺延到下一窗。</Text>

            {schedule.cycle && (
              <Alert color="red" title="检测到循环依赖，发布已拦下" mb="md">
                环上的仓库：<b>{cycleNames.join(' → ')}</b>。请先解开环上仓库的互相依赖，再重新排期。
              </Alert>
            )}

            {!schedule.cycle && train.windows.map((win) => {
              const batch = schedule.batches.find((b) => b.windowId === win.id);
              const allConfirmed = !!batch && batch.gateIds.every((id) => gatesById.get(id)?.remoteState === 'confirmed');
              return (
                <Card key={win.id} withBorder mb="sm" className="window-card">
                  <Group justify="space-between" mb="xs">
                    <Group>
                      <Text fw={700}>{win.label}</Text>
                      <Text size="sm" c="dimmed">容量</Text>
                      <NumberInput
                        size="xs"
                        w={84}
                        min={1}
                        step={1}
                        value={win.capacity}
                        onChange={(value) => dispatch(updateWindow({ trainId: train.id, windowId: win.id, capacity: Number(value) || 1 }))}
                      />
                      <Text size="sm" c="dimmed">{batch?.gateIds.length ?? 0}/{win.capacity}</Text>
                    </Group>
                    <Group>
                      {batch && <Badge color={allConfirmed ? 'green' : 'gray'}>{allConfirmed ? '本窗排期已确认' : '本窗未确认'}</Badge>}
                      <Button size="xs" variant="subtle" color="red" onClick={() => dispatch(removeWindow({ trainId: train.id, windowId: win.id }))}>移除窗口</Button>
                    </Group>
                  </Group>
                  {batch ? (
                    <Stack gap="xs">
                      {batch.gateIds.map((id, index) => {
                        const gate = gatesById.get(id);
                        if (!gate) return null;
                        return (
                          <Group key={id} justify="space-between" className="batch-row">
                            <div>
                              <Text size="sm"><b>{index + 1}.</b> {gate.repository}</Text>
                              <Text size="xs" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
                              {gate.remoteState === 'failed' && gate.remoteError && <Text size="xs" c="red">远端确认失败：{gate.remoteError}</Text>}
                            </div>
                            <Group>
                              <RemoteBadge state={gate.remoteState} />
                              {gate.remoteState === 'failed' && (
                                <Button size="xs" variant="light" loading={confirming} onClick={() => runConfirm([gate.id])}>重试本仓库</Button>
                              )}
                            </Group>
                          </Group>
                        );
                      })}
                    </Stack>
                  ) : (
                    <Text size="sm" c="dimmed">空窗 —— 调大容量或新增仓库后批次会自动排进来。</Text>
                  )}
                </Card>
              );
            })}

            {!schedule.cycle && schedule.queued.length > 0 && (
              <Card withBorder mb="sm" className="queue-card">
                <Text fw={700} mb="xs">排队顺延（窗口容量不足）</Text>
                <Stack gap="xs">
                  {schedule.queued.map((id) => {
                    const gate = gatesById.get(id);
                    if (!gate) return null;
                    return (
                      <Group key={id} justify="space-between">
                        <div>
                          <Text size="sm">{gate.repository}</Text>
                          <Text size="xs" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency}</Text>
                        </div>
                        <Text size="xs" c="dimmed">等待新增窗口或调大容量</Text>
                      </Group>
                    );
                  })}
                </Stack>
              </Card>
            )}

            {schedule.held.length > 0 && (
              <Card withBorder className="held-card">
                <Text fw={700} mb="xs">暂缓入批（阻断未关闭，不进任何窗口）</Text>
                <Stack gap="xs">
                  {schedule.held.map((held) => {
                    const gate = gatesById.get(held.gateId);
                    if (!gate) return null;
                    return (
                      <Group key={held.gateId} justify="space-between">
                        <div>
                          <Text size="sm">{gate.repository}</Text>
                          <Text size="xs" c="dimmed">{held.reason}</Text>
                        </div>
                        <Badge color="red">held</Badge>
                      </Group>
                    );
                  })}
                </Stack>
              </Card>
            )}
          </Card>

          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>仓库门禁</Title>
              <Text size="sm" c="dimmed">顺序由依赖自动决定，无需手工拖拽</Text>
            </Group>
            <Stack gap="xs">
              {train.gates.map((gate) => (
                <Card key={gate.id} withBorder>
                  <Group justify="space-between">
                    <div>
                      <Text fw={700}>{gate.repository}</Text>
                      <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
                    </div>
                    <Group>
                      <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
                      <Button size="xs" variant="light" onClick={() => dispatch(confirmGate(gate.id))} disabled={gate.status === 'confirmed'}>确认门禁</Button>
                    </Group>
                  </Group>
                </Card>
              ))}
            </Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div>
                  <Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge>
                  <Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text>
                  {item.repository && <Text size="xs" c="dimmed" ml="sm">关联仓库 {item.repository}</Text>}
                </div>
                <Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
              </Group>
            ))}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">门禁未全部确认时仍可模拟冻结，审计会记录强制决定。</Text>
            <Group>
              <Button onClick={() => dispatch(setFreeze('frozen'))}>冻结列车</Button>
              <Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button>
              <Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button>
            </Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
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
