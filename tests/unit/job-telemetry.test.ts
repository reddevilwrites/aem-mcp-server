import { describe, expect, it } from 'vitest';
import { JobTelemetry } from '../../src/job-telemetry.js';

describe('JobTelemetry', () => {
  it('records summaries and lifecycle events without exposing checkpoint payloads', () => {
    const telemetry = new JobTelemetry(true, 10);

    telemetry.record({
      type: 'job.started',
      jobId: 'job-1',
      toolName: 'test_tool',
      status: 'pending',
    });
    telemetry.record({
      type: 'job.heartbeat',
      jobId: 'job-1',
      toolName: 'test_tool',
      status: 'running',
      progressPercent: 25,
      progressMessage: 'batch 1',
      checkpoint: { phase: 'scan', secret: 'do-not-expose' },
    });
    telemetry.record({
      type: 'job.checkpoint.saved',
      jobId: 'job-1',
      toolName: 'test_tool',
      status: 'running',
      checkpoint: { phase: 'scan', pagePaths: ['/content/private'] },
    });
    telemetry.record({
      type: 'job.completed',
      jobId: 'job-1',
      toolName: 'test_tool',
      status: 'completed',
      progressPercent: 100,
    });

    const snapshot = telemetry.snapshot({ jobId: 'job-1', includeEvents: true });

    expect(snapshot.jobs).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        toolName: 'test_tool',
        status: 'completed',
        heartbeatCount: 1,
        checkpointSaveCount: 1,
        hasCheckpoint: true,
        checkpointPhase: 'scan',
        lastProgressPercent: 100,
      }),
    ]);
    expect(snapshot.events?.map(e => e.type)).toEqual([
      'job.started',
      'job.heartbeat',
      'job.checkpoint.saved',
      'job.completed',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('do-not-expose');
    expect(JSON.stringify(snapshot)).not.toContain('/content/private');
  });

  it('tracks pause and resume counters', () => {
    const telemetry = new JobTelemetry(true, 10);

    telemetry.record({
      type: 'job.paused',
      jobId: 'job-2',
      toolName: 'test_tool',
      status: 'paused',
      reason: 'health degraded',
    });
    telemetry.record({
      type: 'job.resumed',
      jobId: 'job-2',
      toolName: 'test_tool',
      status: 'running',
    });

    const snapshot = telemetry.snapshot({ jobId: 'job-2', includeEvents: true });

    expect(snapshot.jobs[0]).toEqual(expect.objectContaining({
      pauseCount: 1,
      resumeCount: 1,
    }));
    expect(snapshot.events?.map(e => e.type)).toEqual(['job.paused', 'job.resumed']);
  });

  it('evicts oldest events when the ring buffer limit is reached', () => {
    const telemetry = new JobTelemetry(true, 3);

    for (let i = 0; i < 5; i++) {
      telemetry.record({
        type: 'job.heartbeat',
        jobId: `job-${i}`,
        toolName: 'test_tool',
        status: 'running',
      });
    }

    const snapshot = telemetry.snapshot({ includeEvents: true });

    expect(snapshot.totalEventsRetained).toBe(3);
    expect(snapshot.events?.map(e => e.jobId)).toEqual(['job-2', 'job-3', 'job-4']);
  });

  it('returns disabled snapshots without recording data', () => {
    const telemetry = new JobTelemetry(false, 10);

    telemetry.record({
      type: 'job.started',
      jobId: 'job-disabled',
      toolName: 'test_tool',
    });

    expect(telemetry.snapshot({ includeEvents: true })).toEqual({
      enabled: false,
      totalJobsObserved: 0,
      totalEventsRetained: 0,
      eventLimit: 10,
      jobs: [],
      events: [],
    });
  });
});
