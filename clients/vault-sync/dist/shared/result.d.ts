import type { ApiError, Result } from '../shared/types';
export declare function ok<T>(value: T): Result<T>;
export declare function err<E = ApiError>(error: E): Result<never, E>;
export declare function isOk<T, E>(result: Result<T, E>): result is {
    ok: true;
    value: T;
};
export declare function isErr<T, E>(result: Result<T, E>): result is {
    ok: false;
    error: E;
};
export declare function unwrap<T>(result: Result<T>): T;
//# sourceMappingURL=result.d.ts.map