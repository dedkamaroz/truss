// Truss formula engine - public entry. Pure ES modules: no DOM, no Node built-ins.
import { E, isError } from './values.js';
import { parse } from './parser.js';
import { evaluate, scalarOf } from './evaluator.js';

export {
  isError, err, toA1, fromA1, colToLetters, lettersToCol, parseLiteral, dateToSerial, serialToParts, MAX_ROW, MAX_COL,
} from './values.js';
export { tokenize, parse, refToString, rewriteRefs, FormulaSyntaxError } from './parser.js';
export { registerFunction, listFunctions } from './functions.js';
export { formatValue, formatText } from './format.js';
export { createWorkbookEngine } from './engine.js';
import './custom.js';

/**
 * Evaluate a standalone formula (leading "=" optional).
 * options.functions: { name: (...args) => value } injected functions (case-insensitive), e.g. prop("Price").
 * options.resolveRef: ({ workbook, sheet, row, col }) => value, for any cell references in the expression.
 */
export function evaluateExpression(src, { functions, resolveRef } = {}) {
  let ast;
  try {
    ast = parse(String(src).replace(/^\s*=/, ''));
  } catch {
    return E.VALUE;
  }
  const fnMap = new Map(Object.entries(functions || {}).map(([k, v]) => [k.toUpperCase(), v]));
  const get = (ref, row, col) => {
    const v = resolveRef({ workbook: ref.wb, sheet: ref.sheet, row, col });
    return v === undefined ? null : v;
  };
  const cx = {
    functions: fnMap,
    ref(ref) {
      if (!resolveRef || ref.kind === 'cols' || ref.kind === 'rows') return E.REF;
      try {
        if (ref.kind === 'cell') return get(ref, ref.r1, ref.c1);
        const out = [];
        for (let r = ref.r1; r <= ref.r2; r++) {
          const row = [];
          for (let c = ref.c1; c <= ref.c2; c++) row.push(get(ref, r, c));
          out.push(row);
        }
        return out;
      } catch {
        return E.REF;
      }
    },
  };
  const v = evaluate(ast, cx);
  return Array.isArray(v) ? scalarOf(v) : v;
}
