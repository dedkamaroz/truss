import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbookEngine } from '../../web/lib/formula/index.js';

const keys = (changes) => changes.map((c) => `${c.sheet}!${c.row},${c.col}`).sort();

function book(...names) {
  const e = createWorkbookEngine();
  for (const n of names) e.addSheet(n);
  return e;
}

describe('literal input', () => {
  test('numbers, dates, percentages, booleans, text', () => {
    const e = book('S');
    const cases = [
      ['14/05/2026', 46156],
      ['1,234.5', 1234.5],
      ['50%', 0.5],
      ['TRUE', true],
      ['false', false],
      ['007', 7],
      ["'007", '007'],
      ['-12.5', -12.5],
      ['$1,234.50', 1234.5],
      ['1/1/2000', 36526],
      ['31/02/2026', '31/02/2026'],
      ['1,23', '1,23'],
      ['hello', 'hello'],
      [42, 42],
      ['', null],
    ];
    cases.forEach(([raw, expected], i) => {
      e.setCell('S', i, 0, raw);
      assert.deepEqual(e.getValue('S', i, 0), expected, `raw ${JSON.stringify(raw)}`);
    });
    assert.equal(e.getRaw('S', 6, 0), "'007");
  });

  test('display formats', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '14/05/2026');
    e.setCell('S', 1, 0, '1234.5');
    e.setCell('S', 2, 0, '=A2*-1');
    e.setCell('S', 3, 0, '0.256');
    e.setCell('S', 4, 0, '14/05/2026 3:30 pm');
    e.setCell('S', 5, 0, 'text');
    assert.equal(e.getDisplay('S', 0, 0, 'date'), '14/05/2026');
    assert.equal(e.getDisplay('S', 0, 0), '14/05/2026', 'date literal keeps an inferred date format');
    assert.equal(e.getDisplay('S', 1, 0, 'currency'), '$1,234.50');
    assert.equal(e.getDisplay('S', 2, 0, 'currency'), '-$1,234.50');
    assert.equal(e.getDisplay('S', 1, 0, 'number'), '1,234.50');
    assert.equal(e.getDisplay('S', 1, 0, { type: 'number', decimals: 0, thousands: false }), '1235');
    assert.equal(e.getDisplay('S', 1, 0, 'general'), '1234.5');
    assert.equal(e.getDisplay('S', 3, 0, 'percent'), '25.6%');
    assert.equal(e.getDisplay('S', 3, 0, { type: 'percent', decimals: 1 }), '25.6%');
    assert.equal(e.getDisplay('S', 4, 0, 'datetime'), '14/05/2026 3:30 pm');
    assert.equal(e.getDisplay('S', 1, 0, 'text'), '1234.5');
    assert.equal(e.getDisplay('S', 5, 0, 'currency'), 'text');
    assert.equal(e.getDisplay('S', 1, 0, '#,##0.0'), '1,234.5');
    e.setCell('S', 6, 0, '=1/0');
    assert.equal(e.getDisplay('S', 6, 0), '#DIV/0!');
    e.setCell('S', 7, 0, '=0.1+0.2');
    assert.equal(e.getDisplay('S', 7, 0), '0.3');
    e.setCell('S', 8, 0, '=EOMONTH(A1, 0)');
    assert.equal(e.getDisplay('S', 8, 0), '31/05/2026');
    assert.equal(e.getDisplay('S', 8, 0, 'general'), '46173');
  });
});

describe('formulas and recalculation', () => {
  test('SUM over a range updates when inputs change', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '1');
    e.setCell('S', 1, 0, '2');
    e.setCell('S', 2, 0, '3');
    e.setCell('S', 0, 2, '=SUM(A1:A3)');
    assert.equal(e.getValue('S', 0, 2), 6);
    assert.deepEqual(keys(e.setCell('S', 1, 0, '20')), ['S!0,2', 'S!1,0']);
    assert.equal(e.getValue('S', 0, 2), 24);
    assert.equal(e.getRaw('S', 0, 2), '=SUM(A1:A3)');
  });

  test('diamond dependency returns exactly the changed cells', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '1'); // A1
    e.setCell('S', 0, 1, '=A1+1'); // B1
    e.setCell('S', 0, 2, '=A1*2'); // C1
    e.setCell('S', 0, 3, '=B1+C1'); // D1
    assert.equal(e.getValue('S', 0, 3), 4);
    const changed = e.setCell('S', 0, 0, '2');
    assert.equal(changed.length, 4);
    assert.deepEqual(keys(changed), ['S!0,0', 'S!0,1', 'S!0,2', 'S!0,3']);
    assert.equal(e.getValue('S', 0, 3), 7);
    // Setting the same value changes nothing.
    assert.deepEqual(e.setCell('S', 0, 0, '2'), []);
    // A change that does not alter a dependent's value stops there.
    e.setCell('S', 0, 1, '=IF(A1>0, 1, 0)');
    const c2 = e.setCell('S', 0, 0, '3');
    assert.deepEqual(keys(c2), ['S!0,0', 'S!0,2', 'S!0,3']);
    assert.equal(e.getValue('S', 0, 3), 7);
  });

  test('empty references are 0 in arithmetic and cleared cells propagate', () => {
    const e = book('S');
    e.setCell('S', 0, 1, '=A1+5');
    assert.equal(e.getValue('S', 0, 1), 5);
    e.setCell('S', 0, 0, '10');
    assert.equal(e.getValue('S', 0, 1), 15);
    assert.deepEqual(keys(e.setCell('S', 0, 0, '')), ['S!0,0', 'S!0,1']);
    assert.equal(e.getValue('S', 0, 1), 5);
    assert.equal(e.getValue('S', 0, 0), null);
  });

  test('whole column and row references', () => {
    const e = book('S');
    e.setCell('S', 0, 3, '=SUM(A:A)');
    e.setCell('S', 1, 3, '=COUNTA(5:5)');
    e.setCell('S', 0, 0, '1');
    e.setCell('S', 900, 0, '2');
    assert.equal(e.getValue('S', 0, 3), 3);
    e.setCell('S', 4, 0, 'x');
    e.setCell('S', 4, 7, 'y');
    assert.equal(e.getValue('S', 1, 3), 2);
  });

  test('absolute references and operator semantics in cells', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '2');
    e.setCell('S', 0, 1, '=$A$1^3^2');
    e.setCell('S', 0, 2, '=-$A1^2');
    e.setCell('S', 0, 3, '="a"="A"');
    e.setCell('S', 0, 4, '="abc"&A1');
    e.setCell('S', 0, 5, '=A1%');
    assert.equal(e.getValue('S', 0, 1), 64);
    assert.equal(e.getValue('S', 0, 2), 4);
    assert.equal(e.getValue('S', 0, 3), true);
    assert.equal(e.getValue('S', 0, 4), 'abc2');
    assert.equal(e.getValue('S', 0, 5), 0.02);
    e.setCell('S', 1, 0, '=0.1+0.2=0.3');
    e.setCell('S', 1, 1, '=1<"a"');
    e.setCell('S', 1, 2, '="b">"A"');
    assert.equal(e.getValue('S', 1, 0), true);
    assert.equal(e.getValue('S', 1, 1), true, 'numbers sort before text');
    assert.equal(e.getValue('S', 1, 2), true, 'text comparison is case-insensitive');
  });

  test('syntax errors do not throw', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '=SUM(');
    assert.deepEqual(e.getValue('S', 0, 0), { error: '#VALUE!' });
    assert.equal(e.getRaw('S', 0, 0), '=SUM(');
  });

  test('volatile functions recalculate on any edit', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '=RAND()');
    const seen = new Set([e.getValue('S', 0, 0)]);
    for (let i = 0; i < 5; i++) {
      const changed = e.setCell('S', 5, 5, String(i));
      assert.ok(keys(changed).includes('S!0,0'));
      seen.add(e.getValue('S', 0, 0));
    }
    assert.ok(seen.size > 1);
  });
});

describe('cycles', () => {
  test('A1=B1, B1=A1 yields #CYCLE! and recovers', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '=B1');
    const changed = e.setCell('S', 0, 1, '=A1');
    assert.deepEqual(e.getValue('S', 0, 0), { error: '#CYCLE!' });
    assert.deepEqual(e.getValue('S', 0, 1), { error: '#CYCLE!' });
    assert.deepEqual(keys(changed), ['S!0,0', 'S!0,1']);
    e.setCell('S', 0, 2, '=A1+1');
    assert.deepEqual(e.getValue('S', 0, 2), { error: '#CYCLE!' });
    e.setCell('S', 0, 1, '7');
    assert.equal(e.getValue('S', 0, 0), 7);
    assert.equal(e.getValue('S', 0, 1), 7);
    assert.equal(e.getValue('S', 0, 2), 8);
  });

  test('self reference and long cycles through ranges', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '=A1+1');
    assert.deepEqual(e.getValue('S', 0, 0), { error: '#CYCLE!' });
    e.setCell('S', 1, 0, '1');
    e.setCell('S', 2, 0, '=SUM(A2:A4)');
    assert.deepEqual(e.getValue('S', 2, 0), { error: '#CYCLE!' });
    e.setCell('S', 2, 0, '=SUM(A2)');
    assert.equal(e.getValue('S', 2, 0), 1);
    // 3-cycle with a dependent that uses IFERROR outside the cycle
    e.setCell('S', 0, 5, '=G1');
    e.setCell('S', 0, 6, '=H1');
    e.setCell('S', 0, 8, '=IFERROR(F1, "cyc")');
    e.setCell('S', 0, 7, '=F1');
    assert.deepEqual(e.getValue('S', 0, 7), { error: '#CYCLE!' });
    assert.equal(e.getValue('S', 0, 8), 'cyc');
  });
});

describe('cross-sheet references', () => {
  test('Sheet2!A1 and quoted sheet ranges update on change', () => {
    const e = book('Sheet1', 'Sheet2', 'My Sheet');
    e.setCell('Sheet2', 0, 0, '5');
    e.setCell('My Sheet', 0, 0, '1');
    e.setCell('My Sheet', 1, 1, '2');
    e.setCell('Sheet1', 0, 0, '=Sheet2!A1*2');
    e.setCell('Sheet1', 1, 0, "=SUM('My Sheet'!A1:B2)");
    assert.equal(e.getValue('Sheet1', 0, 0), 10);
    assert.equal(e.getValue('Sheet1', 1, 0), 3);
    assert.deepEqual(keys(e.setCell('Sheet2', 0, 0, '6')), ['Sheet1!0,0', 'Sheet2!0,0']);
    assert.equal(e.getValue('Sheet1', 0, 0), 12);
    e.setCell('My Sheet', 1, 0, '10');
    assert.equal(e.getValue('Sheet1', 1, 0), 13);
  });

  test('renameSheet rewrites formulas, removeSheet makes dependents #REF!', () => {
    const e = book('Sheet1', 'Data');
    e.setCell('Data', 0, 0, '4');
    e.setCell('Sheet1', 0, 0, '=Data!A1+1');
    e.setCell('Sheet1', 1, 0, '=SUM(data!A1:A2)');
    e.renameSheet('Data', 'Budget 2026');
    assert.equal(e.getRaw('Sheet1', 0, 0), "='Budget 2026'!A1+1");
    assert.equal(e.getRaw('Sheet1', 1, 0), "=SUM('Budget 2026'!A1:A2)");
    assert.equal(e.getValue('Sheet1', 0, 0), 5);
    e.setCell('Budget 2026', 0, 0, '9');
    assert.equal(e.getValue('Sheet1', 0, 0), 10);
    assert.deepEqual(e.sheetNames(), ['Sheet1', 'Budget 2026']);

    const changed = e.removeSheet('Budget 2026');
    assert.deepEqual(e.getValue('Sheet1', 0, 0), { error: '#REF!' });
    assert.deepEqual(e.getValue('Sheet1', 1, 0), { error: '#REF!' });
    assert.ok(keys(changed).includes('Sheet1!0,0'));
    assert.equal(e.hasSheet('Budget 2026'), false);
  });

  test('references to a sheet added later resolve when it appears', () => {
    const e = book('Sheet1');
    e.setCell('Sheet1', 0, 0, '=Later!B2');
    assert.deepEqual(e.getValue('Sheet1', 0, 0), { error: '#REF!' });
    e.addSheet('Later');
    e.setCell('Later', 1, 1, '3');
    assert.equal(e.getValue('Sheet1', 0, 0), 3);
  });
});

describe('structural rewrites', () => {
  test('insertRows expands ranges and shifts cells', () => {
    const e = book('S');
    for (let r = 0; r < 10; r++) e.setCell('S', r, 0, String(r + 1));
    e.setCell('S', 0, 2, '=SUM(A1:A10)');
    e.setCell('S', 1, 2, '=A6*2');
    e.insertRows('S', 4, 1);
    assert.equal(e.getRaw('S', 0, 2), '=SUM(A1:A11)');
    assert.equal(e.getRaw('S', 1, 2), '=A7*2');
    assert.equal(e.getValue('S', 5, 0), 5);
    assert.equal(e.getValue('S', 4, 0), null);
    e.setCell('S', 4, 0, '100');
    assert.equal(e.getValue('S', 0, 2), 155);
    assert.equal(e.getValue('S', 1, 2), 12);
  });

  test('deleteRows removing a referenced cell yields #REF!', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '1');
    e.setCell('S', 1, 0, '2');
    e.setCell('S', 2, 0, '3');
    e.setCell('S', 3, 0, '4');
    e.setCell('S', 0, 1, '=A2+A4');
    e.setCell('S', 1, 1, '=SUM(A1:A4)');
    const changed = e.deleteRows('S', 1, 1);
    assert.equal(e.getRaw('S', 0, 1), '=#REF!+A3');
    assert.deepEqual(e.getValue('S', 0, 1), { error: '#REF!' });
    assert.equal(e.getRaw('S', 1, 1), '', 'formula in the deleted row is gone');
    // SUM formula was in the deleted row 2; its row is gone. Check range shrink with a new formula.
    e.setCell('S', 5, 1, '=SUM(A1:A3)');
    e.deleteRows('S', 0, 1);
    assert.equal(e.getRaw('S', 4, 1), '=SUM(A1:A2)');
    assert.equal(e.getValue('S', 4, 1), 7);
    assert.ok(changed.length > 0);
  });

  test('deleting every row of a range makes it #REF!', () => {
    const e = book('S');
    e.setCell('S', 0, 3, '=SUM(A2:A3)');
    e.deleteRows('S', 1, 2);
    assert.equal(e.getRaw('S', 0, 3), '=SUM(#REF!)');
    assert.deepEqual(e.getValue('S', 0, 3), { error: '#REF!' });
  });

  test('insertCols shifts relative and absolute references, including other sheets', () => {
    const e = book('S', 'Other');
    e.setCell('S', 0, 1, '5'); // B1
    e.setCell('S', 1, 0, '=B1+$B$1');
    e.setCell('S', 2, 0, '=SUM(A1:B1)');
    e.setCell('Other', 0, 0, '=S!B1*10');
    e.setCell('Other', 1, 0, '=B1'); // same-sheet ref on Other must NOT shift
    e.insertCols('S', 1, 1);
    assert.equal(e.getRaw('S', 1, 0), '=C1+$C$1');
    assert.equal(e.getRaw('S', 2, 0), '=SUM(A1:C1)');
    assert.equal(e.getRaw('Other', 0, 0), '=S!C1*10');
    assert.equal(e.getRaw('Other', 1, 0), '=B1');
    assert.equal(e.getValue('S', 0, 2), 5);
    assert.equal(e.getValue('S', 1, 0), 10);
    assert.equal(e.getValue('Other', 0, 0), 50);
  });

  test('deleteCols and row inserts on referenced sheets from other sheets', () => {
    const e = book('S', 'Other');
    e.setCell('S', 0, 0, '1');
    e.setCell('S', 0, 2, '3');
    e.setCell('S', 5, 0, '8');
    e.setCell('Other', 0, 0, '=S!C1');
    e.setCell('Other', 1, 0, '=S!A1');
    e.setCell('Other', 2, 0, '=S!A6');
    e.deleteCols('S', 0, 1);
    assert.equal(e.getRaw('Other', 0, 0), '=S!B1');
    assert.equal(e.getValue('Other', 0, 0), 3);
    assert.equal(e.getRaw('Other', 1, 0), '=#REF!');
    assert.deepEqual(e.getValue('Other', 1, 0), { error: '#REF!' });
    e.setCell('Other', 2, 0, '=S!B6');
    e.insertRows('S', 0, 2);
    assert.equal(e.getRaw('Other', 2, 0), '=S!B8');
  });
});

describe('external references', () => {
  test('resolveExternal is called and invalidateExternal recalculates dependents', () => {
    const calls = [];
    let budget = 100;
    const e = createWorkbookEngine({
      resolveExternal(wb, sheet, row, col) {
        calls.push([wb, sheet, row, col]);
        return wb === 'Budget' && sheet === 'Sheet1' && row === 0 && col === 0 ? budget : null;
      },
    });
    e.addSheet('S');
    e.setCell('S', 0, 0, '=[Budget]Sheet1!A1*2');
    e.setCell('S', 0, 1, '=A1+1');
    e.setCell('S', 1, 0, "=SUM('[Budget]Sheet1'!A1:A2)");
    assert.deepEqual(calls[0], ['Budget', 'Sheet1', 0, 0]);
    assert.equal(e.getValue('S', 0, 0), 200);
    assert.equal(e.getValue('S', 1, 0), 100);
    budget = 150;
    const changed = e.invalidateExternal('Budget');
    assert.deepEqual(keys(changed), ['S!0,0', 'S!0,1', 'S!1,0']);
    assert.equal(e.getValue('S', 0, 1), 301);
    assert.deepEqual(e.invalidateExternal('Other'), []);
  });

  test('without a resolver external references are #REF!', () => {
    const e = book('S');
    e.setCell('S', 0, 0, '=[Nope]Sheet1!A1');
    assert.deepEqual(e.getValue('S', 0, 0), { error: '#REF!' });
  });
});

describe('performance', () => {
  test('50,000-long chain loads, computes and re-computes quickly without stack overflow', () => {
    const e = book('S');
    let t = performance.now();
    e.setCell('S', 0, 0, '1');
    for (let r = 1; r < 50000; r++) e.setCell('S', r, 0, `=A${r}+1`);
    const load = performance.now() - t;
    assert.equal(e.getValue('S', 49999, 0), 50000);
    assert.ok(load < 3000, `load took ${load}ms`);
    t = performance.now();
    const changed = e.setCell('S', 0, 0, '10');
    const edit = performance.now() - t;
    assert.equal(e.getValue('S', 49999, 0), 50009);
    assert.equal(changed.length, 50000);
    assert.ok(edit < 1000, `edit took ${edit}ms`);
  });

  test('batch load of a chain in reverse order via setCells', () => {
    const e = book('S');
    const entries = [];
    for (let r = 49999; r >= 1; r--) entries.push({ sheet: 'S', row: r, col: 0, raw: `=A${r}+1` });
    entries.push({ sheet: 'S', row: 0, col: 0, raw: '1' });
    const t = performance.now();
    e.setCells(entries);
    assert.ok(performance.now() - t < 3000);
    assert.equal(e.getValue('S', 49999, 0), 50000);
  });

  test('editing an isolated cell in a 100,000-cell sheet takes under 5 ms', () => {
    const e = book('S');
    for (let r = 0; r < 1000; r++) for (let c = 0; c < 100; c++) e.setCell('S', r, c, String(r + c));
    e.setCell('S', 0, 100, '=SUM(A1:J10)');
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      e.setCell('S', 700, 70, String(i * 3));
      worst = Math.max(worst, performance.now() - t);
    }
    assert.ok(worst < 5, `worst edit ${worst}ms`);
    assert.equal(e.getValue('S', 700, 70), 57);
  });

  test('many range formulas load without quadratic listener scans', () => {
    const e = book('S');
    const t = performance.now();
    for (let r = 0; r < 50000; r++) {
      e.setCell('S', r, 0, String(r));
      e.setCell('S', r, 1, `=SUM(A${r + 1}:A${r + 2})`);
    }
    e.setCell('S', 0, 5, '=SUM(B:B)');
    const load = performance.now() - t;
    assert.ok(load < 3000, `load took ${load}ms`);
    assert.equal(e.getValue('S', 10, 1), 21);
    const changed = e.setCell('S', 10, 0, '0');
    assert.deepEqual(keys(changed), ['S!0,5', 'S!10,0', 'S!10,1', 'S!9,1']);
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      const t2 = performance.now();
      e.setCell('S', 60000 + i, 30, 'x');
      worst = Math.max(worst, performance.now() - t2);
    }
    assert.ok(worst < 5, `worst isolated edit ${worst}ms`);
  });
});
