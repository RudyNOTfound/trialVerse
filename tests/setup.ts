import { EventEmitter } from 'node:events';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

// supertest opens an ephemeral server per request; many requests per file trip the default warning.
EventEmitter.defaultMaxListeners = 100;
