// Custom formula functions for Truss.
//
// Add your own functions here. Everything registered in this file is available in workbook cells,
// database formula properties and autocomplete (listFunctions) as soon as index.js is imported.
//
// registerFunction(name, impl, meta)
//   name  - case-insensitive function name used in formulas.
//   impl  - receives evaluated arguments: numbers, strings, booleans, null (empty cell) or a 2D array
//           for a range such as A1:B5. Return a value, or an error object such as { error: '#VALUE!' }.
//           Throwing an error object (for example err('#NUM!')) also works.
//   meta  - { minArgs, maxArgs, description, signature } used for argument checks and autocomplete.
import { registerFunction, err } from './index.js';

// Example: GST(amount, [rate]) returns the Australian GST component to add to an amount (default 10%).
//   =GST(100)        -> 10
//   =GST(A1, 0.15)   -> A1 * 0.15
registerFunction(
  'GST',
  (amount, rate) => {
    if (Array.isArray(amount) || typeof amount === 'string') return err('#VALUE!');
    const r = rate === undefined || rate === null ? 0.1 : rate;
    if (typeof r !== 'number' || r < 0) return err('#NUM!');
    return (Number(amount) || 0) * r;
  },
  { minArgs: 1, maxArgs: 2, description: 'GST component of an amount (default rate 10%).', signature: 'GST(amount, [rate])' },
);
