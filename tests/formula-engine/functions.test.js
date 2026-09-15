import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbookEngine, evaluateExpression, isError, listFunctions } from '../../web/lib/formula/index.js';

const SPEC_BUILTINS = `SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, PRODUCT, MEDIAN, STDEV, ROUND, ROUNDUP, ROUNDDOWN, INT, ABS, SQRT, POWER, MOD, CEILING, FLOOR, IF, IFS, IFERROR, IFNA, AND, OR, NOT, XOR, SWITCH, SUMIF, SUMIFS, COUNTIF, COUNTIFS, AVERAGEIF, AVERAGEIFS, VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, CHOOSE, CONCAT, CONCATENATE, TEXTJOIN, LEFT, RIGHT, MID, LEN, UPPER, LOWER, PROPER, TRIM, SUBSTITUTE, REPLACE, FIND, SEARCH, TEXT, VALUE, REPT, EXACT, TODAY, NOW, DATE, YEAR, MONTH, DAY, HOUR, MINUTE, WEEKDAY, EDATE, EOMONTH, DATEDIF, NETWORKDAYS, DAYS, ISBLANK, ISNUMBER, ISTEXT, ISERROR, ISNA, ISLOGICAL, NA, PMT, FV, PV, NPV, RAND, RANDBETWEEN`.split(/,\s*/);

// Fixture workbook for range-based functions.
const eng = createWorkbookEngine();
eng.addSheet('Data');
const rows = [
  // A      B          C     D (blank in row 5)  E    F         G
  [1, 'apple', 'x', 'Red', 10, 'ten', 'Alice'],
  [2, 'banana', 'y', 'Blue', 20, 'twenty', 'Bob'],
  [3, 'cherry', 'x', 'Red', 30, 'thirty', 'Carol'],
  [4, 'apricot', 'y', 'Green', 40, 'forty', 'Dave'],
  [5, '', 'x', '', null, null, null],
];
rows.forEach((row, r) => row.forEach((v, c) => { if (v !== null && v !== '') eng.setCell('Data', r, c, v); }));

const covered = new Set();
function calc(formula) {
  for (const m of formula.matchAll(/([A-Z][A-Z0-9.]*)\(/g)) covered.add(m[1]);
  eng.setCell('Data', 99, 25, '=' + formula);
  return eng.getValue('Data', 99, 25);
}
const is = (formula, expected) => assert.deepEqual(calc(formula), expected, formula);
const near = (formula, expected, eps = 1e-9) => {
  const v = calc(formula);
  assert.equal(typeof v, 'number', `${formula} -> ${JSON.stringify(v)}`);
  assert.ok(Math.abs(v - expected) < eps, `${formula}: ${v} != ${expected}`);
};
const errIs = (formula, code) => assert.deepEqual(calc(formula), { error: code }, formula);

describe('maths and statistics', () => {
  test('SUM / AVERAGE / MIN / MAX / PRODUCT', () => {
    is('SUM(A1:A3)', 6);
    is('SUM(A1:A5, 10, TRUE)', 26);
    is('SUM(B1:B5)', 0); // text in ranges ignored
    errIs('SUM("abc")', '#VALUE!');
    is('AVERAGE(A1:A5)', 3);
    errIs('AVERAGE(B1:B5)', '#DIV/0!');
    is('MIN(A1:A5, 0.5)', 0.5);
    is('MAX(A1:A5)', 5);
    is('MAX(B1:B2)', 0);
    is('PRODUCT(A1:A4)', 24);
  });
  test('COUNT / COUNTA / COUNTBLANK', () => {
    is('COUNT(A1:C5)', 5);
    is('COUNT(1, "2", "x", TRUE)', 3);
    is('COUNTA(B1:B5)', 4);
    is('COUNTBLANK(B1:B5)', 1);
    is('COUNTBLANK(D1:D6)', 2);
  });
  test('MEDIAN / STDEV', () => {
    is('MEDIAN(A1:A4)', 2.5);
    is('MEDIAN(3, 1, 2)', 2);
    near('STDEV(A1:A5)', 1.5811388300841898);
    errIs('STDEV(1)', '#DIV/0!');
  });
  test('ROUND family and INT/ABS', () => {
    is('ROUND(2.5, 0)', 3);
    is('ROUND(-2.5, 0)', -3);
    is('ROUND(2.675, 2)', 2.68);
    is('ROUND(1234.5678, -2)', 1200);
    is('ROUNDUP(3.141, 2)', 3.15);
    is('ROUNDUP(-3.141, 1)', -3.2);
    is('ROUNDDOWN(3.149, 2)', 3.14);
    is('ROUNDDOWN(-3.149, 1)', -3.1);
    is('INT(-2.5)', -3);
    is('INT(2.9)', 2);
    is('ABS(-7)', 7);
  });
  test('SQRT / POWER / MOD / CEILING / FLOOR', () => {
    is('SQRT(16)', 4);
    errIs('SQRT(-1)', '#NUM!');
    is('POWER(2, 10)', 1024);
    errIs('POWER(0, -1)', '#DIV/0!');
    is('MOD(10, 3)', 1);
    is('MOD(-3, 2)', 1);
    errIs('MOD(1, 0)', '#DIV/0!');
    is('CEILING(2.1, 0.5)', 2.5);
    is('CEILING(-2.5, 2)', -2);
    errIs('CEILING(2.5, -2)', '#NUM!');
    is('FLOOR(2.9, 1)', 2);
    is('FLOOR(-2.5, 2)', -4);
  });
  test('RAND / RANDBETWEEN', () => {
    for (let i = 0; i < 20; i++) {
      const r = calc('RAND()');
      assert.ok(r >= 0 && r < 1);
      const b = calc('RANDBETWEEN(3, 5)');
      assert.ok(Number.isInteger(b) && b >= 3 && b <= 5, String(b));
    }
    errIs('RANDBETWEEN(5, 3)', '#NUM!');
  });
});

describe('logic', () => {
  test('IF is lazy and defaults', () => {
    is('IF(A1=1, "one", 1/0)', 'one');
    is('IF(A1=2, 1/0, "else")', 'else');
    is('IF(FALSE, 1)', false);
    errIs('IF("maybe", 1, 2)', '#VALUE!');
  });
  test('IFS / IFERROR / IFNA / SWITCH', () => {
    is('IFS(A2=1, "a", A2=2, "b")', 'b');
    errIs('IFS(FALSE, 1)', '#N/A');
    is('IFERROR(1/0, "safe")', 'safe');
    is('IFERROR(5, "safe")', 5);
    is('IFNA(NA(), "missing")', 'missing');
    errIs('IFNA(1/0, "missing")', '#DIV/0!');
    is('SWITCH(C2, "x", "ex", "y", "why", "other")', 'why');
    is('SWITCH(9, 1, "a", "fallback")', 'fallback');
    errIs('SWITCH(9, 1, "a")', '#N/A');
  });
  test('AND / OR / NOT / XOR', () => {
    is('AND(TRUE, A1=1)', true);
    is('AND(TRUE, 0)', false);
    is('OR(FALSE, A1:A2)', true);
    is('NOT(FALSE)', true);
    is('XOR(TRUE, TRUE)', false);
    is('XOR(TRUE, FALSE, FALSE)', true);
    errIs('AND("nope")', '#VALUE!');
  });
});

describe('conditional aggregation', () => {
  test('SUMIF / SUMIFS with operators and wildcards', () => {
    is('SUMIF(A1:A5, ">2")', 12);
    is('SUMIF(C1:C5, "x", A1:A5)', 9);
    is('SUMIF(B1:B5, "ap*", E1:E5)', 50);
    is('SUMIFS(E1:E5, A1:A5, ">=2", C1:C5, "y")', 60);
    is('SUMIFS(A1:A5, B1:B5, "?????")', 1); // apple only
    errIs('SUMIFS(A1:A5, B1:B3, "x")', '#VALUE!');
  });
  test('COUNTIF / COUNTIFS', () => {
    is('COUNTIF(A1:A5, ">5")', 0);
    is('COUNTIF(A1:A5, "<=3")', 3);
    is('COUNTIF(B1:B5, "*an*")', 1);
    is('COUNTIF(D1:D5, "red")', 2);
    is('COUNTIF(D1:D5, "<>Red")', 3);
    is('COUNTIF(A1:A5, 3)', 1);
    is('COUNTIFS(C1:C5, "x", A1:A5, ">1")', 2);
    is('COUNTIFS(B1:B5, "a*", D1:D5, "<>Red")', 1);
  });
  test('AVERAGEIF / AVERAGEIFS', () => {
    is('AVERAGEIF(C1:C5, "x", A1:A5)', 3);
    is('AVERAGEIF(A1:A5, ">3")', 4.5);
    errIs('AVERAGEIF(A1:A5, ">100")', '#DIV/0!');
    is('AVERAGEIFS(E1:E5, C1:C5, "y", A1:A5, "<5")', 30);
  });
});

describe('lookup', () => {
  test('VLOOKUP exact and approximate', () => {
    is('VLOOKUP(30, E1:G4, 3, FALSE)', 'Carol');
    is('VLOOKUP("TWENTY", F1:G4, 2, FALSE)', 'Bob');
    is('VLOOKUP(25, E1:G4, 2, TRUE)', 'twenty');
    is('VLOOKUP(99, E1:G4, 3)', 'Dave');
    errIs('VLOOKUP(25, E1:G4, 2, FALSE)', '#N/A');
    errIs('VLOOKUP(5, E1:G4, 2, TRUE)', '#N/A');
    errIs('VLOOKUP(10, E1:G4, 9, FALSE)', '#REF!');
  });
  test('HLOOKUP', () => {
    is('HLOOKUP("banana", B2:C4, 2, FALSE)', 'cherry');
    is('HLOOKUP(2.5, A1:E1, 1, TRUE)', 1);
    errIs('HLOOKUP("zzz", B1:C1, 1, FALSE)', '#N/A');
  });
  test('XLOOKUP exact, not-found default, match and search modes', () => {
    is('XLOOKUP("Carol", G1:G4, E1:E4)', 30);
    is('XLOOKUP("Zed", G1:G4, E1:E4, "not found")', 'not found');
    errIs('XLOOKUP("Zed", G1:G4, E1:E4)', '#N/A');
    is('XLOOKUP(25, E1:E4, F1:F4, , -1)', 'twenty');
    is('XLOOKUP(25, E1:E4, F1:F4, , 1)', 'thirty');
    is('XLOOKUP("x", C1:C5, A1:A5, , 0, -1)', 5);
    is('XLOOKUP("ch*", B1:B5, A1:A5, , 2)', 3);
  });
  test('INDEX / MATCH / CHOOSE', () => {
    is('INDEX(E1:G4, 2, 3)', 'Bob');
    is('INDEX(A1:A5, 4)', 4);
    errIs('INDEX(A1:A5, 9)', '#REF!');
    is('MATCH("cherry", B1:B5, 0)', 3);
    is('MATCH(35, E1:E4, 1)', 3);
    errIs('MATCH("zzz", B1:B5, 0)', '#N/A');
    is('INDEX(G1:G4, MATCH(40, E1:E4, 0))', 'Dave');
    is('CHOOSE(2, "a", "b", "c")', 'b');
    errIs('CHOOSE(5, "a")', '#VALUE!');
  });
});

describe('text', () => {
  test('joining', () => {
    is('CONCAT(B1:B2, "-", 1)', 'applebanana-1');
    is('CONCATENATE("a", 1, TRUE)', 'a1TRUE');
    is('TEXTJOIN(", ", TRUE, B1:B5)', 'apple, banana, cherry, apricot');
    is('TEXTJOIN("|", FALSE, "a", "", "b")', 'a||b');
  });
  test('slicing and case', () => {
    is('LEFT("Truss", 2)', 'Tr');
    is('LEFT("Truss")', 'T');
    is('RIGHT("Truss", 3)', 'uss');
    is('MID("Notebook", 5, 4)', 'book');
    errIs('MID("abc", 0, 1)', '#VALUE!');
    is('LEN("colour")', 6);
    is('UPPER("abc")', 'ABC');
    is('LOWER("AbC")', 'abc');
    is('PROPER("hello wORLD-wide")', 'Hello World-Wide');
    is('TRIM("  a   b  ")', 'a b');
  });
  test('replace and search', () => {
    is('SUBSTITUTE("a-b-c", "-", "+")', 'a+b+c');
    is('SUBSTITUTE("a-b-c", "-", "+", 2)', 'a-b+c');
    is('REPLACE("abcdef", 2, 3, "XY")', 'aXYef');
    is('FIND("b", "abcb", 3)', 4);
    errIs('FIND("B", "abc")', '#VALUE!');
    is('SEARCH("B", "abc")', 2);
    is('SEARCH("c?e", "abcdef")', 3);
    is('REPT("ab", 3)', 'ababab');
    is('EXACT("Abc", "Abc")', true);
    is('EXACT("Abc", "abc")', false);
  });
  test('TEXT and VALUE', () => {
    is('TEXT(1234.5, "$#,##0.00")', '$1,234.50');
    is('TEXT(0.256, "0.0%")', '25.6%');
    is('TEXT(DATE(2026,5,14), "dd/mm/yyyy")', '14/05/2026');
    is('TEXT(DATE(2026,5,14), "ddd d mmm yy")', 'Thu 14 May 26');
    is('TEXT(-5, "0;(0)")', '(5)');
    is('TEXT(7, "000")', '007');
    is('VALUE("1,234.5")', 1234.5);
    is('VALUE("50%")', 0.5);
    errIs('VALUE("abc")', '#VALUE!');
  });
});

describe('dates', () => {
  test('DATE serials incl. 1900 quirk', () => {
    is('DATE(2026, 5, 14)', 46156);
    is('DATE(2000, 1, 1)', 36526);
    is('DATE(1900, 3, 1)', 61);
    is('DATE(1900, 1, 1)', 1);
    is('DATE(1900, 2, 29)', 60);
    is('DATE(2026, 13, 1)', calc('DATE(2027, 1, 1)'));
  });
  test('parts', () => {
    is('YEAR(46156)', 2026);
    is('MONTH(46156)', 5);
    is('DAY(46156)', 14);
    is('HOUR(46156.75)', 18);
    is('MINUTE(46156.5 + 1/1440 * 7)', 7);
    is('WEEKDAY(46156)', 5); // Thursday
    is('WEEKDAY(46156, 2)', 4);
    is('YEAR("14/05/2026")', 2026);
  });
  test('TODAY / NOW', () => {
    const d = new Date();
    const today = calc('TODAY()');
    assert.equal(calc(`TEXT(TODAY(), "dd/mm/yyyy")`), `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`);
    const now = calc('NOW()');
    assert.ok(now >= today && now < today + 1, `${now} vs ${today}`);
  });
  test('EDATE / EOMONTH / DATEDIF / NETWORKDAYS / DAYS', () => {
    is('EDATE(DATE(2026,1,31), 1)', calc('DATE(2026,2,28)'));
    is('EDATE(DATE(2026,5,14), -12)', calc('DATE(2025,5,14)'));
    is('EOMONTH(DATE(2026,1,15), 1)', calc('DATE(2026,2,28)'));
    is('EOMONTH(DATE(2024,3,10), -1)', calc('DATE(2024,2,29)'));
    is('DATEDIF(DATE(2026,1,31), DATE(2026,5,14), "m")', 3);
    is('DATEDIF(DATE(2000,6,15), DATE(2026,5,14), "Y")', 25);
    is('DATEDIF(DATE(2026,5,1), DATE(2026,5,14), "D")', 13);
    is('DATEDIF(DATE(2025,3,20), DATE(2026,5,14), "YM")', 1);
    errIs('DATEDIF(DATE(2026,5,14), DATE(2026,1,1), "D")', '#NUM!');
    is('NETWORKDAYS(DATE(2026,5,11), DATE(2026,5,22))', 10);
    is('NETWORKDAYS(DATE(2026,5,11), DATE(2026,5,22), DATE(2026,5,13))', 9);
    is('NETWORKDAYS(DATE(2026,5,16), DATE(2026,5,17))', 0);
    is('DAYS(DATE(2026,5,14), DATE(2026,1,1))', 133);
  });
});

describe('information', () => {
  test('IS functions and NA', () => {
    is('ISBLANK(D5)', true);
    is('ISBLANK(A1)', false);
    is('ISNUMBER(A1)', true);
    is('ISNUMBER(B1)', false);
    is('ISTEXT(B1)', true);
    is('ISLOGICAL(TRUE)', true);
    is('ISLOGICAL(1)', false);
    is('ISERROR(1/0)', true);
    is('ISERROR(1)', false);
    is('ISNA(NA())', true);
    is('ISNA(1/0)', false);
    errIs('NA()', '#N/A');
  });
});

describe('financial', () => {
  test('PMT / FV / PV / NPV', () => {
    is('ROUND(PMT(0.05/12, 360, -200000), 2)', 1073.64);
    is('PMT(0, 10, -1000)', 100);
    near('FV(0.06/12, 10, -200, -500, 1)', 2581.4033740601, 1e-6);
    near('PV(0.08/12, 12*20, 500)', -59777.1458511878, 1e-6);
    near('NPV(0.1, -10000, 3000, 4200, 6800)', 1188.4434123352, 1e-6);
  });
});

describe('errors and coercion', () => {
  test('each error code is produced', () => {
    errIs('1/0', '#DIV/0!');
    errIs('FOO()', '#NAME?');
    errIs('unknownName + 1', '#NAME?');
    errIs('"a" + 1', '#VALUE!');
    errIs('NA()', '#N/A');
    errIs('SQRT(-4)', '#NUM!');
    errIs('INDEX(A1:A2, 3)', '#REF!');
    errIs('Nowhere!A1', '#REF!');
  });
  test('errors propagate through operators and functions', () => {
    errIs('1 + (1/0)', '#DIV/0!');
    errIs('SUM(A1, NA())', '#N/A');
    errIs('LEN(1/0)', '#DIV/0!');
  });
  test('isError helper', () => {
    assert.equal(isError({ error: '#N/A' }), true);
    assert.equal(isError('#N/A'), false);
    assert.equal(isError(null), false);
  });
  test('evaluateExpression agrees with the engine for scalar formulas', () => {
    assert.equal(evaluateExpression('=ROUND(10/3, 2)'), 3.33);
  });
});

after(() => {
  const missing = SPEC_BUILTINS.filter((n) => !covered.has(n));
  assert.deepEqual(missing, [], `built-ins without assertions: ${missing.join(', ')}`);
  const registered = new Set(listFunctions().map((f) => f.name));
  assert.deepEqual(SPEC_BUILTINS.filter((n) => !registered.has(n)), []);
});
