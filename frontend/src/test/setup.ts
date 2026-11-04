import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { setUnauthorizedHandler, tokenStore } from '@/api/client';

// jsdom has no layout engine: Recharts' ResponsiveContainer needs ResizeObserver, Radix needs pointer-capture and scrollIntoView stubs.
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
}

afterEach(() => {
  cleanup();
  tokenStore.clear();
  setUnauthorizedHandler(null);
});
