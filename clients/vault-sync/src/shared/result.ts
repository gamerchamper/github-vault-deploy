import type { ApiError, Result } from '../shared/types';

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<E = ApiError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(typeof result.error === 'string' ? result.error : (result.error as any).message);
}
