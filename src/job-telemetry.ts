import { config } from './config.js';
import type { JobStatus } from './job-manager.js';

export type JobTelemetryEventType =
  | 'job.started'
  | 'job.running'
  | 'job.heartbeat'
  | 'job.checkpoint.saved'
  | 'job.paused'
  | 'job.resumed'
  | 'job.completed'
  | 'job.failed'
  | 'job.cleaned_up';

export interface JobTelemetryEvent {
  sequence: number;
  timestamp: string;
  type: JobTelemetryEventType;
  jobId: string;
  toolName: string;
  status?: JobStatus;
  progressPercent?: number;
  progressMessage?: string;
  checkpointPhase?: string;
  reason?: string;
}

export interface JobTelemetrySummary {
  jobId: string;
  toolName: string;
  status?: JobStatus;
  heartbeatCount: number;
  checkpointSaveCount: number;
  pauseCount: number;
  resumeCount: number;
  startedAt?: string;
  lastHeartbeatAt?: string;
  lastCheckpointAt?: string;
  completedAt?: string;
  lastProgressPercent?: number;
  lastProgressMessage?: string;
  hasCheckpoint: boolean;
  checkpointPhase?: string;
}

export interface JobTelemetrySnapshot {
  enabled: boolean;
  totalJobsObserved: number;
  totalEventsRetained: number;
  eventLimit: number;
  jobs: JobTelemetrySummary[];
  events?: JobTelemetryEvent[];
}

export interface JobTelemetryFilters {
  jobId?: string;
  toolName?: string;
  includeEvents?: boolean;
  limit?: number;
}

interface RecordEventInput {
  type: JobTelemetryEventType;
  jobId: string;
  toolName: string;
  status?: JobStatus;
  progressPercent?: number;
  progressMessage?: string;
  checkpoint?: unknown;
  reason?: string;
}

export class JobTelemetry {
  private readonly jobs = new Map<string, JobTelemetrySummary>();
  private events: JobTelemetryEvent[] = [];
  private sequence = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly eventLimit: number,
  ) {}

  record(input: RecordEventInput): void {
    if (!this.enabled) return;

    const now = new Date().toISOString();
    const summary = this.getOrCreateSummary(input.jobId, input.toolName);
    const checkpointPhase = extractCheckpointPhase(input.checkpoint);

    summary.status = input.status ?? summary.status;
    if (input.progressPercent !== undefined) {
      summary.lastProgressPercent = input.progressPercent;
    }
    if (input.progressMessage !== undefined) {
      summary.lastProgressMessage = input.progressMessage;
    }
    if (checkpointPhase !== undefined) {
      summary.checkpointPhase = checkpointPhase;
    }

    switch (input.type) {
      case 'job.started':
        summary.startedAt = now;
        break;
      case 'job.heartbeat':
        summary.heartbeatCount++;
        summary.lastHeartbeatAt = now;
        break;
      case 'job.checkpoint.saved':
        summary.checkpointSaveCount++;
        summary.lastCheckpointAt = now;
        summary.hasCheckpoint = true;
        break;
      case 'job.paused':
        summary.pauseCount++;
        break;
      case 'job.resumed':
        summary.resumeCount++;
        break;
      case 'job.completed':
      case 'job.failed':
      case 'job.cleaned_up':
        summary.completedAt = now;
        break;
      case 'job.running':
        break;
    }

    const event: JobTelemetryEvent = {
      sequence: ++this.sequence,
      timestamp: now,
      type: input.type,
      jobId: input.jobId,
      toolName: input.toolName,
      status: input.status,
      progressPercent: input.progressPercent,
      progressMessage: input.progressMessage,
      checkpointPhase,
      reason: input.reason,
    };
    this.events.push(stripUndefined(event));
    if (this.events.length > this.eventLimit) {
      this.events = this.events.slice(this.events.length - this.eventLimit);
    }
  }

  snapshot(filters: JobTelemetryFilters = {}): JobTelemetrySnapshot {
    const limit = resolveLimit(filters.limit, this.eventLimit);
    const jobs = [...this.jobs.values()]
      .filter(job => matchesFilters(job, filters))
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

    const snapshot: JobTelemetrySnapshot = {
      enabled: this.enabled,
      totalJobsObserved: jobs.length,
      totalEventsRetained: this.events.length,
      eventLimit: this.eventLimit,
      jobs,
    };

    if (filters.includeEvents) {
      snapshot.events = this.events
        .filter(event => matchesFilters(event, filters))
        .slice(-limit);
    }

    return snapshot;
  }

  clear(): void {
    this.jobs.clear();
    this.events = [];
    this.sequence = 0;
  }

  private getOrCreateSummary(jobId: string, toolName: string): JobTelemetrySummary {
    const existing = this.jobs.get(jobId);
    if (existing) return existing;

    const summary: JobTelemetrySummary = {
      jobId,
      toolName,
      heartbeatCount: 0,
      checkpointSaveCount: 0,
      pauseCount: 0,
      resumeCount: 0,
      hasCheckpoint: false,
    };
    this.jobs.set(jobId, summary);
    return summary;
  }
}

function extractCheckpointPhase(checkpoint: unknown): string | undefined {
  if (!checkpoint || typeof checkpoint !== 'object') return undefined;
  const phase = (checkpoint as { phase?: unknown }).phase;
  return typeof phase === 'string' ? phase : undefined;
}

function matchesFilters(
  item: Pick<JobTelemetrySummary, 'jobId' | 'toolName'>,
  filters: JobTelemetryFilters,
): boolean {
  if (filters.jobId && item.jobId !== filters.jobId) return false;
  if (filters.toolName && item.toolName !== filters.toolName) return false;
  return true;
}

function resolveLimit(limit: number | undefined, defaultLimit: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return defaultLimit;
  }
  return Math.min(Math.floor(limit), defaultLimit);
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

export const jobTelemetry = new JobTelemetry(
  config.jobs.observabilityEnabled,
  Math.max(1, config.jobs.observabilityEventsLimit),
);
