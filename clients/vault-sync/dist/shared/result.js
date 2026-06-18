"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.err = err;
exports.isOk = isOk;
exports.isErr = isErr;
exports.unwrap = unwrap;
function ok(value) {
    return { ok: true, value };
}
function err(error) {
    return { ok: false, error };
}
function isOk(result) {
    return result.ok;
}
function isErr(result) {
    return !result.ok;
}
function unwrap(result) {
    if (result.ok)
        return result.value;
    throw new Error(typeof result.error === 'string' ? result.error : result.error.message);
}
//# sourceMappingURL=result.js.map