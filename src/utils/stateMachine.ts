import { AppError } from './errors';

export type TransitionMap<S extends string> = Record<S, readonly S[]>;

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return map[from]?.includes(to) ?? false;
}

/** Throws 409 INVALID_STATE_TRANSITION unless `from -> to` is declared in the map. */
export function assertTransition<S extends string>(entity: string, map: TransitionMap<S>, from: S, to: S): void {
  if (!canTransition(map, from, to)) throw AppError.invalidTransition(entity, from, to);
}
