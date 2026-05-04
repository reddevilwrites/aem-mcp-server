import { randomUUID } from 'crypto';
import { config } from './config.js';
import { assessLongRunningJobHealth } from './tools/system-health.js';
import { logger } from './utils/logger.js';
import { jobTelemetry } from './job-telemetry.js';

export type JobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

export interface Job<T = unknown> {
  id: string;
  toolName: string;
  status: JobStatus;
  params: Record<string, unknown>;
  result?: T;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  estimatedDurationMs?: number;
  progressPercent?: number;
  progressMessage?: string;
  checkpoint?: unknown;
  pauseCount?: number;
  resumeAfter?: Date;
  lastHealthCheckAt?: Date;
  pauseReason?: string;
}

export interface JobStartResult {
  jobId: string;
  message: string;
  checkAfterMs: number;
}

export interface JobExecutionContext {
  jobId: string;
  toolName: string;
  getCheckpoint<T = unknown>(): T | undefined;
  saveCheckpoint(data: unknown): void;
  setProgress(progressPercent: number, message?: string): void;
  heartbeat(options?: {
    checkpoint?: unknown;
    progressPercent?: number;
    message?: string;
    force?: boolean;
  }): Promise<void>;
}

class PauseJobError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'PauseJobError';
  }
}

/**
 * In-memory async job manager.
 *
 * MCP tool calls must return quickly. For long-running operations, tools call
 * jobManager.start() to register a background job and return the job ID to the user.
 * The user (via the LLM) calls aem_job_status to poll for results.
 *
 * Completed jobs are retained for TTL (default 1 hour) then cleaned up.
 */
class JobManager {
  private jobs = new Map<string, Job>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Periodic cleanup every 10 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 600_000);
    // Allow process to exit even with timer active
    this.cleanupTimer.unref();
  }

  /**
   * Start an async job.
   *
   * @param toolName     Name of the tool starting this job
   * @param params       Input parameters (for display)
   * @param executor     Async function that does the actual work
   * @param estimatedMs  Rough estimate of how long this will take
   */
  start<T>(
    toolName: string,
    params: Record<string, unknown>,
    executor: (ctx: JobExecutionContext) => Promise<T>,
    estimatedMs = 30_000,
  ): JobStartResult {
    const id = randomUUID();
    const job: Job<T> = {
      id,
      toolName,
      status: 'pending',
      params,
      createdAt: new Date(),
      estimatedDurationMs: estimatedMs,
    };

    this.jobs.set(id, job);
    jobTelemetry.record({
      type: 'job.started',
      jobId: id,
      toolName,
      status: job.status,
    });
    logger.info(`Job started: ${id} (${toolName})`);

    // Fire-and-forget — do NOT await
    void this.run(id, executor);

    const checkAfterMs = Math.max(estimatedMs, 5_000);
    return {
      jobId: id,
      message:
        `Job queued successfully. ` +
        `Use the \`aem_job_status\` tool with jobId="${id}" to check progress. ` +
        `Estimated completion: ~${Math.round(checkAfterMs / 1000)}s.`,
      checkAfterMs,
    };
  }

  private async run<T>(id: string, executor: (ctx: JobExecutionContext) => Promise<T>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;

    const wasPaused = job.status === 'paused';
    job.status = 'running';
    job.startedAt ??= new Date();
    job.progressMessage = 'Job is running.';
    if (wasPaused) {
      jobTelemetry.record({
        type: 'job.resumed',
        jobId: id,
        toolName: job.toolName,
        status: job.status,
        progressPercent: job.progressPercent,
        progressMessage: job.progressMessage,
        checkpoint: job.checkpoint,
      });
    }
    jobTelemetry.record({
      type: 'job.running',
      jobId: id,
      toolName: job.toolName,
      status: job.status,
      progressPercent: job.progressPercent,
      progressMessage: job.progressMessage,
      checkpoint: job.checkpoint,
    });

    try {
      const result = await executor(this.createContext(job));
      job.status = 'completed';
      job.result = result;
      job.completedAt = new Date();
      job.progressPercent = 100;
      job.progressMessage = 'Job completed successfully.';
      jobTelemetry.record({
        type: 'job.completed',
        jobId: id,
        toolName: job.toolName,
        status: job.status,
        progressPercent: job.progressPercent,
        progressMessage: job.progressMessage,
        checkpoint: job.checkpoint,
      });
      logger.info(`Job completed: ${id} (${job.toolName}) in ${Date.now() - job.startedAt.getTime()}ms`);
    } catch (err) {
      if (err instanceof PauseJobError) {
        job.status = 'paused';
        job.pauseCount = (job.pauseCount ?? 0) + 1;
        job.pauseReason = err.message;
        job.resumeAfter = new Date(Date.now() + err.retryAfterMs);
        job.progressMessage = err.message;
        jobTelemetry.record({
          type: 'job.paused',
          jobId: id,
          toolName: job.toolName,
          status: job.status,
          progressPercent: job.progressPercent,
          progressMessage: job.progressMessage,
          checkpoint: job.checkpoint,
          reason: err.message,
        });
        logger.warn(`Job paused: ${id} (${job.toolName})`, err.message);
        this.scheduleResume(id, executor, err.retryAfterMs);
        return;
      }

      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = new Date();
      job.progressMessage = 'Job failed.';
      jobTelemetry.record({
        type: 'job.failed',
        jobId: id,
        toolName: job.toolName,
        status: job.status,
        progressPercent: job.progressPercent,
        progressMessage: job.progressMessage,
        checkpoint: job.checkpoint,
        reason: job.error,
      });
      logger.error(`Job failed: ${id} (${job.toolName})`, err);
    }
  }

  private scheduleResume<T>(id: string, executor: (ctx: JobExecutionContext) => Promise<T>, retryAfterMs: number): void {
    const timer = setTimeout(() => {
      void this.run(id, executor);
    }, retryAfterMs);
    timer.unref();
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getStatus(id: string): object {
    const job = this.jobs.get(id);
    if (!job) {
      return { found: false, error: `No job found with id "${id}". Jobs expire after 1 hour.` };
    }

    const base = {
      jobId: job.id,
      toolName: job.toolName,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString(),
      completedAt: job.completedAt?.toISOString(),
      resumeAfter: job.resumeAfter?.toISOString(),
      progressPercent: job.progressPercent,
      progressMessage: job.progressMessage,
    };

    if (job.status === 'pending' || job.status === 'running') {
      const elapsed = Date.now() - job.createdAt.getTime();
      const estimated = job.estimatedDurationMs ?? 30_000;
      const pct = Math.min(Math.round((elapsed / estimated) * 100), 95);
      return {
        ...base,
        progressPercent: job.progressPercent ?? pct,
        message: job.progressMessage ?? 'Job is still running. Check again shortly.',
      };
    }

    if (job.status === 'paused') {
      return {
        ...base,
        checkpointSaved: job.checkpoint !== undefined,
        pauseCount: job.pauseCount ?? 0,
        message: job.pauseReason ?? 'Job is paused and will retry automatically.',
      };
    }

    if (job.status === 'failed') {
      return { ...base, error: job.error };
    }

    // completed
    return { ...base, result: job.result };
  }

  private cleanup(): void {
    const now = Date.now();
    const ttl = config.jobs.ttlMs;
    // Paused jobs use a longer ceiling so a genuinely-recoverable pause isn't
    // culled mid-retry, but stuck pauses (executor closure GC'd, healthcheck
    // permanently degraded, etc.) don't accumulate forever.
    const pausedTtlMs = Math.max(ttl, 6 * 60 * 60_000);
    let removed = 0;

    for (const [id, job] of this.jobs) {
      const isCompletedExpired =
        (job.status === 'completed' || job.status === 'failed') &&
        job.completedAt !== undefined &&
        now - job.completedAt.getTime() > ttl;

      // For paused jobs we measure age from createdAt — pauseCount tracks how
      // many times we've retried, so a long-paused job with no progress is the
      // signal that something is wedged.
      const isPausedExpired =
        job.status === 'paused' &&
        now - job.createdAt.getTime() > pausedTtlMs;

      if (isCompletedExpired || isPausedExpired) {
        jobTelemetry.record({
          type: 'job.cleaned_up',
          jobId: id,
          toolName: job.toolName,
          status: job.status,
          progressPercent: job.progressPercent,
          progressMessage: job.progressMessage,
          checkpoint: job.checkpoint,
          reason: isPausedExpired ? 'stale paused job' : 'expired terminal job',
        });
        this.jobs.delete(id);
        removed++;
        if (isPausedExpired) {
          logger.warn(
            `Job cleanup: evicting stale paused job ${id} (${job.toolName}) ` +
            `pauseCount=${job.pauseCount ?? 0} reason="${job.pauseReason ?? 'unknown'}"`,
          );
        }
      }
    }

    if (removed > 0) logger.debug(`Job cleanup: removed ${removed} expired jobs`);
  }

  private createContext(job: Job): JobExecutionContext {
    return {
      jobId: job.id,
      toolName: job.toolName,
      getCheckpoint: <T = unknown>() => job.checkpoint as T | undefined,
      saveCheckpoint: (data: unknown) => {
        job.checkpoint = data;
        jobTelemetry.record({
          type: 'job.checkpoint.saved',
          jobId: job.id,
          toolName: job.toolName,
          status: job.status,
          progressPercent: job.progressPercent,
          progressMessage: job.progressMessage,
          checkpoint: data,
        });
      },
      setProgress: (progressPercent: number, message?: string) => {
        job.progressPercent = Math.max(0, Math.min(100, Math.round(progressPercent)));
        if (message) job.progressMessage = message;
      },
      heartbeat: async (options = {}) => {
        if (options.checkpoint !== undefined) {
          job.checkpoint = options.checkpoint;
          jobTelemetry.record({
            type: 'job.checkpoint.saved',
            jobId: job.id,
            toolName: job.toolName,
            status: job.status,
            progressPercent: job.progressPercent,
            progressMessage: job.progressMessage,
            checkpoint: options.checkpoint,
          });
        }
        if (options.progressPercent !== undefined) {
          job.progressPercent = Math.max(0, Math.min(100, Math.round(options.progressPercent)));
        }
        if (options.message) {
          job.progressMessage = options.message;
        }
        jobTelemetry.record({
          type: 'job.heartbeat',
          jobId: job.id,
          toolName: job.toolName,
          status: job.status,
          progressPercent: job.progressPercent,
          progressMessage: job.progressMessage,
          checkpoint: job.checkpoint,
        });

        const now = new Date();
        const last = job.lastHealthCheckAt?.getTime() ?? 0;
        if (!options.force && now.getTime() - last < config.jobs.healthPollIntervalMs) {
          return;
        }

        job.lastHealthCheckAt = now;
        const decision = await assessLongRunningJobHealth();
        if (decision.action === 'pause') {
          throw new PauseJobError(decision.reason, decision.retryAfterMs);
        }
      },
    };
  }
}

export const jobManager = new JobManager();
