/*
 * Pension Contribution Audit - calculation tests
 *
 * Runs in two places:
 *   Node:    node tests.js
 *   Browser: open the app and call runPensionAuditTests() in the console,
 *            or press the "Run calculation self-tests" button in the
 *            "How the calculations work" section.
 */
(function (root, factory) {
  'use strict';
  var calc = (typeof module === 'object' && module.exports)
    ? require('./calculations.js')
    : root.PensionCalc;
  var api = factory(calc);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (require.main === module) {
      var result = api.run();
      process.exit(result.failed === 0 ? 0 : 1);
    }
  } else {
    root.runPensionAuditTests = api.run;
  }
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  function run(options) {
    var opts = options || {};
    var log = opts.log !== false;
    var results = [];
    var passed = 0;
    var failed = 0;

    function record(name, ok, detail) {
      results.push({ name: name, ok: ok, detail: detail || '' });
      if (ok) { passed++; } else { failed++; }
    }

    function assertEqual(name, actual, expected) {
      var ok = actual === expected;
      record(name, ok, ok ? String(actual) : 'expected ' + expected + ', got ' + actual);
    }

    function assertMoney(name, actual, expected) {
      var ok = typeof actual === 'number' && Math.abs(actual - expected) < 0.0000001;
      record(name, ok, ok ? actual.toFixed(2) : 'expected ' + expected + ', got ' + actual);
    }

    var baseSettings = C.normaliseSettings({
      annualBaseSalary: 24000,
      payFrequency: 'monthly',
      employerPercent: 4,
      employeePercent: 6,
      rasReliefPercent: 20,
      qeAnnualLower: 6000,
      qeAnnualUpper: 18010,
      useCustomPeriodThresholds: true,
      customPeriodLower: 500,
      customPeriodUpper: 1500,
      tolerance: 0.02,
      currency: 'GBP',
      useGrossAsPensionable: true
    });

    /* ---- Rounding helper ---------------------------------------- */
    assertMoney('roundMoney: 434.99999999999994 -> 435.00', C.roundMoney(4.35 * 100), 435.00);
    assertMoney('roundMoney: half up at 0.005', C.roundMoney(1.005), 1.01);
    assertMoney('roundMoney: negative half away from zero', C.roundMoney(-1.005), -1.01);
    assertMoney('roundMoney: 2.675 -> 2.68', C.roundMoney(2.675), 2.68);

    /* ---- Case 1: contributions on base / pensionable pay --------- */
    var case1 = C.calculateExpectedBaseContribution(2000, baseSettings);
    assertMoney('Case 1 employer (4% of 2,000)', case1.employer, 80.00);
    assertMoney('Case 1 employee gross (6% of 2,000)', case1.employeeGross, 120.00);
    assertMoney('Case 1 employee net deduction (80%)', case1.employeeNet, 96.00);
    assertMoney('Case 1 basic-rate tax relief (20%)', case1.taxRelief, 24.00);
    assertMoney('Case 1 total into pension', case1.total, 200.00);

    /* ---- Case 2: qualifying earnings ---------------------------- */
    var thresholds = C.calculatePeriodThresholds(baseSettings);
    assertMoney('Case 2 monthly lower threshold used', thresholds.lower, 500.00);
    assertMoney('Case 2 monthly upper threshold used', thresholds.upper, 1500.00);
    assertEqual('Case 2 threshold source is the custom override', thresholds.source, 'custom');
    assertMoney('Case 2 derived lower (annual band / 12)', thresholds.derivedLower, 500.00);
    assertMoney('Case 2 derived upper rounds to the penny', thresholds.derivedUpper, 1500.83);

    var qe = C.calculateQualifyingEarnings(2000, thresholds.lower, thresholds.upper);
    assertMoney('Case 2 qualifying earnings (1,500 - 500), pay above the cap', qe, 1000.00);

    var case2 = C.calculateExpectedQEContribution(2000, thresholds, baseSettings);
    assertMoney('Case 2 employer (4% of 1,000)', case2.employer, 40.00);
    assertMoney('Case 2 employee gross (6% of 1,000)', case2.employeeGross, 60.00);
    assertMoney('Case 2 employee net RAS deduction', case2.employeeNet, 48.00);
    assertMoney('Case 2 tax relief', case2.taxRelief, 12.00);
    assertMoney('Case 2 total into pension', case2.total, 100.00);

    /* ---- Qualifying earnings banding edges ---------------------- */
    assertMoney('QE: pay below lower threshold gives zero', C.calculateQualifyingEarnings(400, 500, 1500), 0);
    assertMoney('QE: pay exactly at lower threshold gives zero', C.calculateQualifyingEarnings(500, 500, 1500), 0);
    assertMoney('QE: pay within the band', C.calculateQualifyingEarnings(900, 500, 1500), 400);
    assertMoney('QE: pay above upper threshold is capped', C.calculateQualifyingEarnings(99999, 500, 1500), 1000);
    assertEqual('QE: missing gross pay returns null', C.calculateQualifyingEarnings(null, 500, 1500), null);

    /* ---- Deriving actual figures from the payslip --------------- */
    var actual = C.deriveActualContribution(48, 40, baseSettings);
    assertMoney('Actual employee net from payslip', actual.employeeNet, 48.00);
    assertMoney('Actual employee gross (48 / 0.8)', actual.employeeGross, 60.00);
    assertMoney('Actual basic-rate relief claimed', actual.taxRelief, 12.00);
    assertMoney('Actual total entering pension', actual.total, 100.00);
    assertEqual('Actual row is flagged complete', actual.isComplete, true);

    var partial = C.deriveActualContribution(null, 40, baseSettings);
    assertEqual('Partial row: employee data absent', partial.hasEmployee, false);
    assertEqual('Partial row: employer data present', partial.hasEmployer, true);
    assertEqual('Partial row: not complete', partial.isComplete, false);

    /* ---- Differences -------------------------------------------- */
    var diffs = C.calculateDifferences(case1, actual);
    assertMoney('Employer shortfall vs base salary', diffs.employer, 40.00);
    assertMoney('Employee gross shortfall vs base salary', diffs.employeeGross, 60.00);
    assertMoney('Employee net deduction difference', diffs.employeeNet, 48.00);
    assertMoney('Tax relief difference', diffs.taxRelief, 12.00);
    assertMoney('Overall pension funding shortfall', diffs.total, 100.00);

    var overpaid = C.calculateDifferences(case2, C.deriveActualContribution(200, 150, baseSettings));
    assertEqual('Overpayment produces a negative difference', overpaid.employer < 0, true);

    /* ---- Detection ---------------------------------------------- */
    var detection = C.detectContributionBasis(actual, case1, case2, 0.02);
    assertEqual('Detection: qualifying earnings identified', detection.basis, C.BASIS.QE);
    assertEqual('Detection: label', detection.label, 'Matches Qualifying Earnings');

    var baseActual = C.deriveActualContribution(96, 80, baseSettings);
    var baseDetection = C.detectContributionBasis(baseActual, case1, case2, 0.02);
    assertEqual('Detection: base salary identified', baseDetection.basis, C.BASIS.BASE);

    var oddActual = C.deriveActualContribution(11.11, 7.77, baseSettings);
    var oddDetection = C.detectContributionBasis(oddActual, case1, case2, 0.02);
    assertEqual('Detection: neither basis identified', oddDetection.basis, C.BASIS.NEITHER);

    var emptyDetection = C.detectContributionBasis(
      C.deriveActualContribution(null, null, baseSettings), case1, case2, 0.02);
    assertEqual('Detection: insufficient data', emptyDetection.basis, C.BASIS.INSUFFICIENT);

    var withinTolerance = C.deriveActualContribution(48.01, 40.01, baseSettings);
    assertEqual('Detection: 1p variance is inside the 2p tolerance',
      C.detectContributionBasis(withinTolerance, case1, case2, 0.02).basis, C.BASIS.QE);

    var outsideTolerance = C.deriveActualContribution(48.40, 40.40, baseSettings);
    assertEqual('Detection: 9p variance is outside the 2p tolerance',
      C.detectContributionBasis(outsideTolerance, case1, case2, 0.02).basis, C.BASIS.NEITHER);

    var mixed = C.deriveActualContribution(96, 40, baseSettings);
    var mixedDetection = C.detectContributionBasis(mixed, case1, case2, 0.02);
    assertEqual('Detection: mixed employer/employee bases match neither', mixedDetection.basis, C.BASIS.NEITHER);
    assertEqual('Detection: employer component matched qualifying earnings',
      mixedDetection.qualifying.employerMatch, true);
    assertEqual('Detection: employee component matched base salary',
      mixedDetection.base.employeeMatch, true);

    /* ---- Full row analysis and totals --------------------------- */
    var analysis = C.analyseAll([
      { id: 'a', date: '2026-06-30', grossPay: 2000, pensionablePay: null, actualEmployeeNet: 48, actualEmployer: 40 },
      { id: 'b', date: '2026-07-31', grossPay: 2000, pensionablePay: null, actualEmployeeNet: 48, actualEmployer: 40 }
    ], baseSettings);

    assertEqual('Analysis: two rows analysed', analysis.counts.total, 2);
    assertEqual('Analysis: both matched qualifying earnings', analysis.counts.qualifying, 2);
    assertMoney('Analysis: pensionable pay inherited from gross pay', analysis.rows[0].pensionablePay, 2000);
    assertMoney('Analysis: total expected employer', analysis.totals.expectedEmployer, 160.00);
    assertMoney('Analysis: total actual employer', analysis.totals.actualEmployer, 80.00);
    assertMoney('Analysis: total employer shortfall', analysis.totals.employerShortfall, 80.00);
    assertMoney('Analysis: total expected pension funding', analysis.totals.expectedTotal, 400.00);
    assertMoney('Analysis: total actual pension funding', analysis.totals.actualTotal, 200.00);
    assertMoney('Analysis: overall shortfall', analysis.totals.totalShortfall, 200.00);
    assertMoney('Analysis: cumulative shortfall after row 2', analysis.rows[1].cumulativeShortfall, 200.00);

    var noInherit = C.analyseAll([
      { id: 'c', date: '2026-06-30', grossPay: 2000, pensionablePay: null, actualEmployeeNet: 48, actualEmployer: 40 }
    ], Object.assign({}, baseSettings, { useGrossAsPensionable: false }));
    assertEqual('Analysis: without the gross-pay default, base salary figures are unavailable',
      noInherit.rows[0].expectedBase.available, false);
    assertEqual('Analysis: qualifying earnings still detected without pensionable pay',
      noInherit.rows[0].detection.basis, C.BASIS.QE);

    /* ---- Derived (non-overridden) thresholds -------------------- */
    var derivedSettings = C.normaliseSettings(Object.assign({}, baseSettings, { useCustomPeriodThresholds: false }));
    var derivedThresholds = C.calculatePeriodThresholds(derivedSettings);
    assertMoney('Derived monthly upper threshold keeps the rounded penny', derivedThresholds.upper, 1500.83);
    assertMoney('Derived monthly qualifying earnings',
      C.calculateQualifyingEarnings(2000, derivedThresholds.lower, derivedThresholds.upper), 1000.83);

    var weekly = C.calculatePeriodThresholds(C.normaliseSettings(
      { payFrequency: 'weekly', qeAnnualLower: 5200, qeAnnualUpper: 26000, useCustomPeriodThresholds: false }));
    assertMoney('Weekly lower threshold (annual / 52)', weekly.lower, 100.00);
    assertMoney('Weekly upper threshold (annual / 52)', weekly.upper, 500.00);

    var fourWeekly = C.calculatePeriodThresholds(C.normaliseSettings(
      { payFrequency: 'fourWeekly', qeAnnualLower: 1300, qeAnnualUpper: 6500, useCustomPeriodThresholds: false }));
    assertMoney('Four-weekly lower threshold (annual / 13)', fourWeekly.lower, 100.00);

    /* ---- Effective contribution rates --------------------------- */
    var effective = C.calculateEffectiveRates(2000, actual, baseSettings);
    assertMoney('Effective employer rate (40 of 2,000)', effective.employer, 2);
    assertMoney('Effective employee gross rate (60 of 2,000)', effective.employeeGross, 3);
    assertMoney('Effective employee deduction rate', effective.employeeNet, 2.4);
    assertMoney('Effective combined rate', effective.total, 5);
    assertEqual('Effective rates report the stated employer rate', effective.targetEmployer, 4);
    assertEqual('Effective rates report the stated combined rate', effective.targetTotal, 10);
    assertMoney('Employer rate gap in percentage points', effective.employerGap, 2);
    assertMoney('Employee gross rate gap in percentage points', effective.employeeGrossGap, 3);

    var onBasis = C.calculateEffectiveRates(2000, C.deriveActualContribution(96, 80, baseSettings), baseSettings);
    assertMoney('A base salary payslip works out at exactly the stated employer rate', onBasis.employer, 4);
    assertMoney('A base salary payslip works out at exactly the stated employee rate', onBasis.employeeGross, 6);
    assertMoney('A base salary payslip has no employer rate gap', onBasis.employerGap, 0);

    assertEqual('Effective rate is null when there is no pensionable pay',
      C.calculateEffectiveRate(40, null), null);
    assertEqual('Effective rate is null rather than dividing by zero',
      C.calculateEffectiveRate(40, 0), null);

    var rateAnalysis = C.analyseAll([
      { id: 'r1', date: '2026-06-30', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 },
      { id: 'r2', date: '2026-07-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 }
    ], baseSettings);
    assertMoney('Aggregate effective employer rate across the period',
      rateAnalysis.totals.effectiveEmployerRate, 2);
    assertMoney('Aggregate effective combined rate across the period',
      rateAnalysis.totals.effectiveTotalRate, 5);
    assertEqual('Aggregate totals carry the stated combined rate',
      rateAnalysis.totals.targetTotalRate, 10);
    assertMoney('Per-row effective rate is attached to the analysis',
      rateAnalysis.rows[0].effectiveRates.employer, 2);

    /* ---- Higher-rate relief (informational only) ---------------- */
    var hr = C.calculateHigherRateRelief(60, Object.assign({}, baseSettings, { marginalTaxRatePercent: 40 }));
    assertEqual('Higher rate: applicable at 40%', hr.applicable, true);
    assertMoney('Higher rate: extra relief at 20 percentage points', hr.amount, 12.00);
    var hrBasic = C.calculateHigherRateRelief(60, Object.assign({}, baseSettings, { marginalTaxRatePercent: 20 }));
    assertEqual('Higher rate: not applicable at basic rate', hrBasic.applicable, false);

    /* ---- Dates --------------------------------------------------- */
    assertEqual('UK date formatting', C.formatDateUK('2026-08-31'), '31/08/2026');
    assertEqual('Add a month keeps month-end alignment', C.addPayPeriod('2026-01-31', 'monthly'), '2026-02-28');
    assertEqual('Add a month mid-month', C.addPayPeriod('2026-06-15', 'monthly'), '2026-07-15');
    assertEqual('Add a weekly period', C.addPayPeriod('2026-06-15', 'weekly'), '2026-06-22');
    assertEqual('Add a four-weekly period', C.addPayPeriod('2026-06-15', 'fourWeekly'), '2026-07-13');

    /* ---- Input parsing ------------------------------------------ */
    assertMoney('Parsing strips currency symbols and separators', C.toNumberOrNull('£1,234.50'), 1234.5);
    assertEqual('Blank input parses to null', C.toNumberOrNull(''), null);
    assertEqual('Zero is preserved, not treated as blank', C.toNumberOrNull('0'), 0);
    assertEqual('Nonsense input parses to null', C.toNumberOrNull('abc'), null);

    /* ---- Import validation --------------------------------------- */
    var goodImport = C.validateImport({
      schemaVersion: 1,
      payslips: [{ date: '2026-06-30', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 }],
      settings: { employerPercent: 4 }
    });
    assertEqual('Import: a valid file is accepted', goodImport.ok, true);
    assertEqual('Import: payslip ids are assigned', typeof goodImport.data.payslips[0].id, 'string');

    assertEqual('Import: a non-object file is rejected', C.validateImport('nope').ok, false);
    assertEqual('Import: a missing payslips array is rejected',
      C.validateImport({ schemaVersion: 1 }).ok, false);
    assertEqual('Import: a future schema version is rejected',
      C.validateImport({ schemaVersion: 99, payslips: [] }).ok, false);
    assertEqual('Import: a non-numeric amount is rejected',
      C.validateImport({ schemaVersion: 1, payslips: [{ grossPay: 'lots' }] }).ok, false);
    assertEqual('Import: a bad date is rejected',
      C.validateImport({ schemaVersion: 1, payslips: [{ date: '31/08/2026' }] }).ok, false);
    assertEqual('Import: an empty payslip list is accepted',
      C.validateImport({ schemaVersion: 1, payslips: [] }).ok, true);

    /* ---- Settings guards ----------------------------------------- */
    var guarded = C.normaliseSettings({ rasReliefPercent: 100, employerPercent: -5, qeAnnualUpper: 1, qeAnnualLower: 900 });
    assertEqual('Settings: relief rate capped below 100%', guarded.rasReliefPercent, 99);
    assertEqual('Settings: negative percentage clamped to zero', guarded.employerPercent, 0);
    assertEqual('Settings: upper threshold cannot fall below the lower one',
      guarded.qeAnnualUpper, guarded.qeAnnualLower);

    /* ---- Sorting -------------------------------------------------- */
    var sortRows = C.analyseAll([
      { id: '1', date: '2026-07-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 },
      { id: '2', date: '2026-06-30', grossPay: 2000, actualEmployeeNet: 96, actualEmployer: 80 }
    ], baseSettings).rows;
    assertEqual('Sort: by date ascending', C.sortAnalysedRows(sortRows, 'date', 'asc')[0].id, '2');
    assertEqual('Sort: by date descending', C.sortAnalysedRows(sortRows, 'date', 'desc')[0].id, '1');
    assertEqual('Sort: by shortfall descending puts the biggest shortfall first',
      C.sortAnalysedRows(sortRows, 'shortfall', 'desc')[0].id, '1');
    assertEqual('Sort: by basis puts base-salary matches first',
      C.sortAnalysedRows(sortRows, 'basis', 'asc')[0].id, '2');

    if (log && typeof console !== 'undefined') {
      results.forEach(function (r) {
        if (!r.ok) { console.error('FAIL  ' + r.name + '  (' + r.detail + ')'); }
      });
      console.log('Pension Contribution Audit tests: ' + passed + ' passed, ' + failed + ' failed.');
    }

    return { passed: passed, failed: failed, total: results.length, results: results };
  }

  return { run: run };
}));
