import type { Paginated } from '@/types/api';

/** The API caps pageSize at 100; this walks pages until everything is loaded (bounded to avoid runaway loops). */
export async function fetchAll<T>(fetchPage: (page: number) => Promise<Paginated<T>>, maxPages = 20): Promise<T[]> {
  const first = await fetchPage(1);
  const items = [...first.items];
  for (let p = 2; p <= Math.min(first.meta.totalPages, maxPages); p++) items.push(...(await fetchPage(p)).items);
  return items;
}
