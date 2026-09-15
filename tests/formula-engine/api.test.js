import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  toA1, fromA1, colToLetters, lettersToCol, parse, tokenize, refToString, rewriteRefs,
  evaluateExpression, registerFunction, listFunctions, createWorkbookEngine, parseLiteral, formatText,
} from '../../web/lib/formula/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const formulaDir = path.resolve(here, '../../web/lib/formula');

describe('A1 helpers', () => {
  test('round trips', () => {
    assert.equal(toA1(0, 0), 'A1');
    assert.equal(toA1(2, 1), 'B3');
    assert.deepEqual(fromA1('B3'), { row: 2, col: 1 });
    assert.deepEqual(fromA1('$AA$10'), { row: 9, col: 26 });
    assert.equal(fromA1('nope'), null);
    assert.equal(colToLetters(25), 'Z');
    assert.equal(colToLetters(26), 'AA');
    assert.equal(colToLetters(16383), 'XFD');
    assert.equal(lettersToCol('XFD'), 16383);
    for (const c of [0, 1, 25, 26, 51, 52, 701, 702, 12345]) assert.equal(lettersToCol(colToLetters(c)), c);
  });
});

describe('parser', () => {
  test('precedence: unary minus over ^, left-assoc ^, % postfix, & below +', () => {
    const shape = (n) => (n.type === 'binary' ? `(${shape(n.left)}${n.op}${shape(n.right)})` : n.type === 'unary' ? `(${n.op}${shape(n.arg)})` : n.type === 'percent' ? `(${shape(n.arg)}%)` : String(n.v));
    assert.equal(shape(parse('-2^2')), '((-2)^2)');
    assert.equal(shape(parse('2^3^2')), '((2^3)^2)');
    assert.equal(shape(parse('1+2*3')), '(1+(2*3))');
    assert.equal(shape(parse('1&2+3')), '(1&(2+3))');
    assert.equal(shape(parse('1+2=3')), '((1+2)=3)');
    assert.equal(shape(parse('50%*2')), '((50%)*2)');
    assert.equal(shape(parse('2^-1')), '(2^(-1))');
  });

  test('reference forms', () => {
    const ref = (src) => parse(src).ref;
    assert.deepEqual(ref('$B$3'), { wb: null, sheet: null, kind: 'cell', r1: 2, c1: 1, r2: 2, c2: 1, ar1: true, ac1: true, ar2: true, ac2: true });
    assert.equal(ref('A1:B9').kind, 'range');
    assert.deepEqual([ref('B9:A1').r1, ref('B9:A1').c2], [0, 1]);
    assert.equal(ref('A:A').kind, 'cols');
    assert.equal(ref('1:1').kind, 'rows');
    assert.equal(ref('Sheet2!A1').sheet, 'Sheet2');
    const q = ref("'My Sheet'!A1:B2");
    assert.equal(q.sheet, 'My Sheet');
    assert.equal(q.kind, 'range');
    const x = ref('[Workbook Name]Sheet1!A1');
    assert.equal(x.wb, 'Workbook Name');
    assert.equal(x.sheet, 'Sheet1');
    assert.equal(ref("'It''s'!C4").sheet, "It's");
  });

  test('function calls, strings, errors, names', () => {
    const call = parse('IF(A1, "say ""hi""", )');
    assert.equal(call.type, 'call');
    assert.equal(call.name, 'IF');
    assert.equal(call.args.length, 3);
    assert.equal(call.args[1].v, 'say "hi"');
    assert.equal(call.args[2].type, 'missing');
    assert.equal(parse('LOG10(1)').type, 'call'); // looks like a cell ref but is a function
    assert.equal(parse('#REF!').type, 'err');
    assert.equal(parse('myName').type, 'name');
    assert.throws(() => parse('1+'));
    assert.throws(() => parse('"open'));
    assert.throws(() => parse('SUM(1'));
  });

  test('refToString quotes when needed and rewriteRefs preserves formatting', () => {
    assert.equal(refToString({ wb: null, sheet: 'My Sheet', kind: 'cell', r1: 0, c1: 0, r2: 0, c2: 0, ar1: false, ac1: true }), "'My Sheet'!$A1");
    assert.equal(refToString({ wb: 'Budget', sheet: 'Sheet1', kind: 'range', r1: 0, c1: 0, r2: 4, c2: 2, ar1: false, ac1: false, ar2: true, ac2: true }), '[Budget]Sheet1!A1:$C$5');
    assert.equal(refToString({ wb: null, sheet: 'A1', kind: 'cols', r1: 0, c1: 1, r2: 0, c2: 1 }), "'A1'!B:B");
    const out = rewriteRefs(' sum( A1 , b2 )+"A1"', (r) => ({ ...r, r1: r.r1 + 1, r2: r.r2 + 1 }));
    assert.equal(out, ' sum( A2 , B3 )+"A1"');
    assert.equal(tokenize('A1+1').length, 3);
  });
});

describe('literal parsing and TEXT formats', () => {
  test('parseLiteral', () => {
    assert.deepEqual(parseLiteral('14/05/2026'), { value: 46156, format: 'date' });
    assert.deepEqual(parseLiteral('50%'), { value: 0.5, format: 'percent' });
    assert.equal(parseLiteral('1,234.5').value, 1234.5);
    assert.equal(parseLiteral('TRUE').value, true);
    assert.equal(parseLiteral('007').value, 7);
    assert.equal(parseLiteral("'007").value, '007');
    assert.equal(parseLiteral('2026-05-14').value, 46156);
    assert.equal(parseLiteral('14/05/26').value, 46156);
    assert.equal(parseLiteral('1e3').value, 1000);
    assert.equal(parseLiteral('12 apples').value, '12 apples');
  });
  test('formatText', () => {
    assert.equal(formatText(1234.5, '$#,##0.00'), '$1,234.50');
    assert.equal(formatText(1234567, '#,##0,"k"'), '1,235k');
    assert.equal(formatText(0.5, 'h:mm am/pm'), '12:00 pm');
    assert.equal(formatText(46156.25, 'dd/mm/yyyy hh:mm'), '14/05/2026 06:00');
    assert.equal(formatText(3.14159, '0.00'), '3.14');
    assert.equal(formatText(0, '0;-0;"zero"'), 'zero');
    assert.equal(formatText('abc', '"<"@">"'), '<abc>');
  });
});

describe('evaluateExpression and custom functions', () => {
  test('injected prop() function', () => {
    const row = { Price: 12.5, Name: 'Widget', Qty: 3 };
    const functions = { prop: (name) => row[name] };
    assert.equal(evaluateExpression('prop("Price") * 2', { functions }), 25);
    assert.equal(evaluateExpression('=UPPER(prop("Name")) & " x" & prop("Qty")', { functions }), 'WIDGET x3');
    assert.equal(evaluateExpression('IF(prop("Qty") > 2, "bulk", "single")', { functions }), 'bulk');
    assert.deepEqual(evaluateExpression('prop("Name") + 1', { functions }), { error: '#VALUE!' });
    assert.deepEqual(evaluateExpression('nothere("x")'), { error: '#NAME?' });
    assert.deepEqual(evaluateExpression('1 +'), { error: '#VALUE!' });
  });

  test('resolveRef for standalone references', () => {
    const grid = { '0,0': 2, '1,0': 3 };
    const resolveRef = ({ row, col }) => grid[`${row},${col}`] ?? null;
    assert.equal(evaluateExpression('SUM(A1:A2) * A1', { resolveRef }), 10);
    assert.deepEqual(evaluateExpression('A1'), { error: '#REF!' });
  });

  test('registerFunction adds a function usable in cells and listed with metadata', () => {
    registerFunction('DOUBLEIT', (x) => x * 2, { minArgs: 1, maxArgs: 1, description: 'Doubles a number.', signature: 'DOUBLEIT(number)' });
    const info = listFunctions().find((f) => f.name === 'DOUBLEIT');
    assert.equal(info.description, 'Doubles a number.');
    assert.equal(info.signature, 'DOUBLEIT(number)');
    const e = createWorkbookEngine();
    e.addSheet('S');
    e.setCell('S', 0, 0, '21');
    e.setCell('S', 0, 1, '=doubleit(A1)');
    assert.equal(e.getValue('S', 0, 1), 42);
    e.setCell('S', 0, 2, '=DOUBLEIT()');
    assert.deepEqual(e.getValue('S', 0, 2), { error: '#VALUE!' });
    assert.equal(evaluateExpression('DOUBLEIT(4)'), 8);
  });

  test('listFunctions covers built-ins with signatures and descriptions', () => {
    const all = listFunctions();
    assert.ok(all.length >= 88);
    for (const f of all) {
      assert.ok(f.signature.startsWith(f.name + '('), f.name);
      assert.ok(f.description.length > 0, f.name);
    }
    const names = all.map((f) => f.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });

  test('custom.js exists, documents an example, and it is registered on import of index.js', () => {
    const src = readFileSync(path.join(formulaDir, 'custom.js'), 'utf8');
    assert.match(src, /import \{[^}]*registerFunction[^}]*\} from '\.\/index\.js'/);
    assert.match(src, /\/\/ Example:/);
    const gst = listFunctions().find((f) => f.name === 'GST');
    assert.ok(gst && gst.description);
    assert.equal(evaluateExpression('GST(250)'), 25);
    assert.equal(evaluateExpression('GST(100, 0.15)'), 15);
  });
});

describe('portability', () => {
  test('no DOM, Node globals or node: imports in web/lib/formula', () => {
    for (const file of readdirSync(formulaDir)) {
      const src = readFileSync(path.join(formulaDir, file), 'utf8');
      for (const bad of [/\bdocument\b/, /\bwindow\b/, /\brequire\(/, /\bprocess\./, /node:/]) {
        assert.doesNotMatch(src, bad, `${file} contains ${bad}`);
      }
    }
  });

  test('imports cleanly via a file:// dynamic import', async () => {
    const mod = await import(pathToFileURL(path.join(formulaDir, 'index.js')).href + '?fresh');
    assert.equal(typeof mod.createWorkbookEngine, 'function');
    assert.equal(mod.evaluateExpression('1+1'), 2);
  });
});
