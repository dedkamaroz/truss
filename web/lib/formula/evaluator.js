// AST evaluator with Excel operator semantics.
import { E, err, isError, toNumber, toText, compareValues } from './values.js';
import { getFunction } from './functions.js';

/** Unwrap a 1x1 range to its value; larger ranges in scalar context are #VALUE!. */
export function scalarOf(v) {
  if (!Array.isArray(v)) return v;
  return v.length === 1 && v[0].length === 1 ? v[0][0] : E.VALUE;
}

function finite(n) {
  return Number.isFinite(n) ? (n === 0 ? 0 : n) : E.NUM;
}

function arith(op, a, b) {
  a = scalarOf(a);
  b = scalarOf(b);
  if (isError(a)) return a;
  if (isError(b)) return b;
  try {
    if (op === '&') return toText(a) + toText(b);
    if (op.length > 1 || op === '=' || op === '<' || op === '>') {
      const c = compareValues(a, b);
      switch (op) {
        case '=': return c === 0;
        case '<>': return c !== 0;
        case '<': return c < 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        default: return c >= 0;
      }
    }
    const x = toNumber(a), y = toNumber(b);
    switch (op) {
      case '+': return finite(x + y);
      case '-': return finite(x - y);
      case '*': return finite(x * y);
      case '/': return y === 0 ? E.DIV0 : finite(x / y);
      case '^':
        if (x === 0 && y === 0) return E.NUM;
        if (x === 0 && y < 0) return E.DIV0;
        return finite(Math.pow(x, y));
    }
  } catch (e) {
    if (isError(e)) return e;
    throw e;
  }
  return E.VALUE;
}

/**
 * Evaluate an AST. cx = { ref(refObj) -> value | 2D array | error, functions?: Map(UPPER -> impl) }.
 * Recursion depth is bounded by formula nesting, not by dependency chain length.
 */
export function evaluate(node, cx) {
  switch (node.type) {
    case 'num': case 'str': case 'bool': return node.v;
    case 'err': return err(node.v);
    case 'missing': return null;
    case 'name': return E.NAME;
    case 'ref': return cx.ref(node.ref);
    case 'unary': {
      const v = scalarOf(evaluate(node.arg, cx));
      if (isError(v)) return v;
      try {
        const n = toNumber(v);
        return node.op === '-' ? finite(-n) : n;
      } catch (e) {
        if (isError(e)) return e;
        throw e;
      }
    }
    case 'percent': return arith('/', evaluate(node.arg, cx), 100);
    case 'binary': return arith(node.op, evaluate(node.left, cx), evaluate(node.right, cx));
    case 'call': return callFunction(node, cx);
  }
  return E.VALUE;
}

function callFunction(node, cx) {
  const injected = cx.functions && cx.functions.get(node.name);
  const def = injected ? { impl: injected, meta: {} } : getFunction(node.name);
  if (!def) return E.NAME;
  const { impl, meta } = def;
  const argc = node.args.length;
  if ((meta.minArgs !== undefined && argc < meta.minArgs) || (meta.maxArgs !== undefined && argc > meta.maxArgs)) return E.VALUE;
  let args;
  if (meta.lazy) {
    args = node.args.map((a) => () => evaluate(a, cx));
  } else {
    args = new Array(argc);
    for (let i = 0; i < argc; i++) {
      const v = evaluate(node.args[i], cx);
      if (!meta.acceptErrors && isError(v)) return v;
      args[i] = v;
    }
  }
  try {
    const r = impl(...args);
    if (r === undefined) return null;
    if (typeof r === 'number') return finite(r);
    return r;
  } catch (e) {
    if (isError(e)) return e;
    return E.VALUE; // a bug in a custom function must not break the sheet
  }
}
