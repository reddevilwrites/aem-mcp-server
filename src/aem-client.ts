import { config, basicAuth } from './config.js';
import { logger } from './utils/logger.js';

type MinimalFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export class AemError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'AemError';
  }
}

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: string | URLSearchParams;
  headers?: Record<string, string>;
  raw?: boolean;
}

/**
 * Central AEM HTTP client.
 * All requests go through here for consistent auth, error handling, and logging.
 */
export class AemClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor() {
    this.baseUrl = config.aem.host;
    this.authHeader = basicAuth();
  }

  async fetch<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const { method = 'GET', body, headers = {} } = options;

    logger.debug(`AEM ${method} ${url}`);

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...headers,
      },
      body: body instanceof URLSearchParams ? body : body,
    }) as MinimalFetchResponse;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.error(`AEM request failed: ${response.status} ${url}`, text.slice(0, 200));
      throw new AemError(
        `AEM returned ${response.status} for ${path}`,
        response.status,
        url,
      );
    }

    if (options.raw) return response as unknown as T;

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async get<T = unknown>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const fullPath = params
      ? `${path}?${new URLSearchParams(
          Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
        ).toString()}`
      : path;
    return this.fetch<T>(fullPath);
  }

  async post<T = unknown>(path: string, formData: Record<string, string>): Promise<T> {
    return this.fetch<T>(path, {
      method: 'POST',
      body: new URLSearchParams(formData),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async pathExists(jcrPath: string): Promise<boolean> {
    try {
      await this.fetch(`${jcrPath}.json`, { method: 'GET' });
      return true;
    } catch (e) {
      if (e instanceof AemError && (e.statusCode === 404 || e.statusCode === 403)) {
        return false;
      }
      throw e;
    }
  }

  async getNode<T = Record<string, unknown>>(
    jcrPath: string,
    depth = 0,
  ): Promise<T> {
    const suffix = depth > 0 ? `.${depth}.json` : '.json';
    return this.fetch<T>(`${jcrPath}${suffix}`);
  }
}

export const aemClient = new AemClient();
