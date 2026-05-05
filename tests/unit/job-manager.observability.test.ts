import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assessLongRunningJobHealth: vi.fn(),
}));

vi.mock('../../src/tools/system-health.js', () => ({
  assessLongRunningJobHealth: mocks.assessLongRunningJobHealth,
}));

import { jobManager, JobManager } from '../../src/job-manager.js';
import { jobTelemetry } from '../../src/job-telemetry.js';

function waitForStatus(jobId: string, status: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const poll = (): void => {
      const result = jobManager.getStatus(jobId) as { status?: string; error?: string };
      if (result.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${status}; last status=${result.status ?? result.error}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  jobTelemetry.clear();
  mocks.assessLongRunningJobHealth.mockResolvedValue({
    action: 'continue',
    reason: 'ok',
    retryAfterMs: 1,
    snapshot: {},
  });
});

describe('jobManager observability', () => {
  it('defers execution and respects the configured concurrency limit', async () => {
    const manager = new JobManager(2);
    const releases = [deferred(), deferred(), deferred()];
    const startedIds: string[] = [];
    let active = 0;
    let maxActive = 0;

    const jobs = releases.map((release, index) => manager.start(
      'unit_queued_job',
      { index },
      async () => {
        startedIds.push(String(index));
        active++;
        maxActive = Math.max(maxActive, active);
        await release.promise;
        active--;
        return { index };
      },
      5,
    ));

    expect(active).toBe(0);

    await waitForCondition(() => active === 2, 'first two jobs to start');
    expect(maxActive).toBe(2);
    expect((manager.getStatus(jobs[2]!.jobId) as { status?: string }).status).toBe('pending');

    releases[0]!.resolve();
    await waitForCondition(() => startedIds.includes('2'), 'queued third job to start');
    expect(maxActive).toBe(2);

    releases[1]!.resolve();
    releases[2]!.resolve();
    await waitForCondition(
      () => jobs.every(job => (manager.getStatus(job.jobId) as { status?: string }).status === 'completed'),
      'all queued jobs to complete',
    );
  });

  it('records start, heartbeat, checkpoint, and completion for a successful job', async () => {
    const started = jobManager.start(
      'unit_observed_success',
      {},
      async (ctx) => {
        ctx.saveCheckpoint({ phase: 'initial', secret: 'hidden' });
        await ctx.heartbeat({
          checkpoint: { phase: 'scan', paths: ['/content/private'] },
          progressPercent: 40,
          message: 'scanning',
          force: true,
        });
        return { ok: true };
      },
      5,
    );

    await waitForStatus(started.jobId, 'completed');

    const snapshot = jobTelemetry.snapshot({ jobId: started.jobId, includeEvents: true });
    expect(snapshot.jobs[0]).toEqual(expect.objectContaining({
      jobId: started.jobId,
      toolName: 'unit_observed_success',
      status: 'completed',
      heartbeatCount: 1,
      checkpointSaveCount: 2,
      hasCheckpoint: true,
      checkpointPhase: 'scan',
      lastProgressPercent: 100,
    }));
    expect(snapshot.events?.map(e => e.type)).toEqual([
      'job.started',
      'job.running',
      'job.checkpoint.saved',
      'job.checkpoint.saved',
      'job.heartbeat',
      'job.completed',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('hidden');
    expect(JSON.stringify(snapshot)).not.toContain('/content/private');
  });

  it('records failure telemetry for a failed job', async () => {
    const started = jobManager.start(
      'unit_observed_failure',
      {},
      async () => {
        throw new Error('planned failure');
      },
      5,
    );

    await waitForStatus(started.jobId, 'failed');

    const snapshot = jobTelemetry.snapshot({ jobId: started.jobId, includeEvents: true });
    expect(snapshot.jobs[0]).toEqual(expect.objectContaining({
      status: 'failed',
    }));
    expect(snapshot.events?.map(e => e.type)).toContain('job.failed');
    expect(snapshot.events?.find(e => e.type === 'job.failed')?.reason).toBe('planned failure');
  });

  it('records pause and resume telemetry when the health guard pauses once', async () => {
    mocks.assessLongRunningJobHealth
      .mockResolvedValueOnce({
        action: 'pause',
        reason: 'health guard pause',
        retryAfterMs: 50,
        snapshot: {},
      })
      .mockResolvedValue({
        action: 'continue',
        reason: 'ok',
        retryAfterMs: 1,
        snapshot: {},
      });

    const started = jobManager.start(
      'unit_observed_pause_resume',
      {},
      async (ctx) => {
        const checkpoint = ctx.getCheckpoint<{ phase?: string }>();
        if (checkpoint?.phase === 'paused-once') {
          ctx.saveCheckpoint({ phase: 'resumed' });
          return { resumed: true };
        }
        await ctx.heartbeat({
          checkpoint: { phase: 'paused-once' },
          progressPercent: 10,
          message: 'before pause',
          force: true,
        });
        return { shouldNotReach: true };
      },
      5,
    );

    await waitForStatus(started.jobId, 'paused');
    await waitForStatus(started.jobId, 'completed');
    const completedStatus = jobManager.getStatus(started.jobId) as { resumeAfter?: string };
    expect(completedStatus.resumeAfter).toBeUndefined();

    const snapshot = jobTelemetry.snapshot({ jobId: started.jobId, includeEvents: true });
    expect(snapshot.jobs[0]).toEqual(expect.objectContaining({
      status: 'completed',
      checkpointSaveCount: 2,
      pauseCount: 1,
      resumeCount: 1,
      hasCheckpoint: true,
      checkpointPhase: 'resumed',
    }));
    expect(snapshot.events?.map(e => e.type)).toEqual([
      'job.started',
      'job.running',
      'job.checkpoint.saved',
      'job.heartbeat',
      'job.paused',
      'job.resumed',
      'job.running',
      'job.checkpoint.saved',
      'job.completed',
    ]);
  });
});
