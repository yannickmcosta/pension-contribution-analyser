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
  var letter = (typeof module === 'object' && module.exports)
    ? require('./letter.js')
    : root.PensionLetter;
  var api = factory(calc, letter);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    if (require.main === module) {
      var result = api.run();
      process.exit(result.failed === 0 ? 0 : 1);
    }
  } else {
    root.runPensionAuditTests = api.run;
  }
}(typeof self !== 'undefined' ? self : this, function (C, L) {
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

    /* ---- Provider reconciliation -------------------------------- */
    var recActual = C.deriveActualContribution(48, 40, baseSettings);
    var recGood = C.reconcileProviderData(
      { providerEmployeeNet: 48, providerEmployer: 40, providerTaxRelief: 12 }, recActual, 0.02);
    assertEqual('Provider data: matching figures reconcile', recGood.allMatch, true);
    assertEqual('Provider data: relief confirms the derived gross', recGood.taxRelief.matches, true);
    assertEqual('Provider data: no mismatches counted', recGood.mismatches, 0);

    var recBad = C.reconcileProviderData(
      { providerEmployeeNet: 48, providerEmployer: 55, providerTaxRelief: 12 }, recActual, 0.02);
    assertEqual('Provider data: a differing employer amount is flagged', recBad.allMatch, false);
    assertMoney('Provider data: the difference is reported', recBad.employer.difference, 15);

    var recPending = C.reconcileProviderData(
      { providerEmployeeNet: 48, providerEmployer: 40 }, recActual, 0.02);
    assertEqual('Provider data: missing relief is treated as pending, not a mismatch', recPending.reliefPending, true);
    assertEqual('Provider data: pending relief still reconciles', recPending.allMatch, true);

    var recNone = C.reconcileProviderData({}, recActual, 0.02);
    assertEqual('Provider data: absent entirely', recNone.hasData, false);

    /* ---- Verdict ------------------------------------------------- */
    function verdictFor(stated, net, employer) {
      return C.analyseAll([
        { id: 'v1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: net, actualEmployer: employer }
      ], Object.assign({}, baseSettings, { statedBasis: stated })).verdict;
    }
    assertEqual('Verdict: told base salary, paid qualifying earnings -> shortfall',
      verdictFor('base', 48, 40).key, C.VERDICT.SHORTFALL);
    assertEqual('Verdict: a shortfall is actionable', verdictFor('base', 48, 40).actionable, true);
    assertEqual('Verdict: told qualifying earnings, paid qualifying earnings -> as stated',
      verdictFor('qualifying', 48, 40).key, C.VERDICT.AS_STATED);
    assertEqual('Verdict: as stated is not actionable', verdictFor('qualifying', 48, 40).actionable, false);
    assertEqual('Verdict: told base salary, paid base salary -> as stated',
      verdictFor('base', 96, 80).key, C.VERDICT.AS_STATED);
    assertEqual('Verdict: told qualifying earnings but paid on salary -> better than stated',
      verdictFor('qualifying', 96, 80).key, C.VERDICT.BETTER_THAN_STATED);
    assertEqual('Verdict: matches neither basis',
      verdictFor('base', 11.11, 7.77).key, C.VERDICT.UNMATCHED);
    assertEqual('Verdict: basis not recorded',
      verdictFor('unstated', 48, 40).key, C.VERDICT.UNKNOWN_BASIS);
    assertEqual('Verdict: no actual figures at all',
      verdictFor('base', null, null).key, C.VERDICT.INSUFFICIENT);
    assertEqual('Verdict: no payslips',
      C.analyseAll([], baseSettings).verdict.key, C.VERDICT.NO_DATA);

    var mixedVerdict = C.analyseAll([
      { id: 'm1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 },
      { id: 'm2', date: '2026-02-28', grossPay: 2000, actualEmployeeNet: 96, actualEmployer: 80 }
    ], baseSettings).verdict;
    assertEqual('Verdict: periods on different bases are reported as mixed', mixedVerdict.key, C.VERDICT.MIXED);

    /* ---- Uniformity ---------------------------------------------- */
    var uniform = C.analyseAll([
      { id: 'u1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 },
      { id: 'u2', date: '2026-02-28', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 }
    ], baseSettings).uniformity;
    assertEqual('Uniformity: identical periods are uniform', uniform.uniform, true);
    var varied = C.analyseAll([
      { id: 'u1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 },
      { id: 'u2', date: '2026-02-28', grossPay: 2500, actualEmployeeNet: 48, actualEmployer: 40 }
    ], baseSettings).uniformity;
    assertEqual('Uniformity: a pay change is detected', varied.uniform, false);
    assertEqual('Uniformity: distinct pay figures counted', varied.distinctPensionablePay, 2);

    /* ---- Letter composer ------------------------------------------ */
    function analysisFor(stated, net, employer) {
      return C.analyseAll([
        { id: 'l1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: net, actualEmployer: employer },
        { id: 'l2', date: '2026-02-28', grossPay: 2000, actualEmployeeNet: net, actualEmployer: employer }
      ], Object.assign({}, baseSettings, { statedBasis: stated }));
    }

    assertEqual('Letter: refused when contributions match the stated basis',
      L.compose(analysisFor('qualifying', 48, 40), {}).canGenerate, false);
    assertEqual('Letter: refused when paid on the stated salary basis',
      L.compose(analysisFor('base', 96, 80), {}).canGenerate, false);
    assertEqual('Letter: refused when there are no payslips',
      L.compose(C.analyseAll([], baseSettings), {}).canGenerate, false);
    assertEqual('Letter: refused when actual figures are missing',
      L.compose(analysisFor('base', null, null), {}).canGenerate, false);
    assertEqual('Letter: a refusal explains why',
      L.compose(analysisFor('qualifying', 48, 40), {}).reason.length > 0, true);

    var shortfallLetter = L.compose(analysisFor('base', 48, 40), {
      recipientName: 'A Person', senderName: 'B Person', enrolmentPeriod: 'January 2026',
      schemeQuote: 'Contributions are calculated on your base salary.', responseBy: '01/02/2026'
    });
    assertEqual('Letter: generated for a shortfall', shortfallLetter.canGenerate, true);
    assertEqual('Letter: shortfall variant', shortfallLetter.variant, L.VARIANT.SHORTFALL);
    assertEqual('Letter: no placeholders left when everything is supplied',
      shortfallLetter.placeholders.length, 0);
    assertEqual('Letter: addressed to the named recipient',
      shortfallLetter.body.indexOf('Dear A Person,') === 0, true);
    assertEqual('Letter: quotes the scheme wording',
      shortfallLetter.body.indexOf('Contributions are calculated on your base salary.') > 0, true);
    assertEqual('Letter: states the employer arrears',
      shortfallLetter.body.indexOf('80.00') > 0, true);
    assertEqual('Letter: signed off by the sender',
      shortfallLetter.body.indexOf('B Person') > 0, true);
    assertEqual('Letter: subject line set', shortfallLetter.subject.length > 0, true);

    var bare = L.compose(analysisFor('base', 48, 40), {});
    assertEqual('Letter: missing details are flagged as placeholders', bare.placeholders.length > 0, true);
    assertEqual('Letter: recipient placeholder used', bare.body.indexOf('[HR CONTACT]') > 0, true);

    assertEqual('Letter: enquiry variant when the stated basis is unknown',
      L.compose(analysisFor('unstated', 48, 40), {}).variant, L.VARIANT.ENQUIRY);
    assertEqual('Letter: unmatched variant when neither basis fits',
      L.compose(analysisFor('base', 11.11, 7.77), {}).variant, L.VARIANT.UNMATCHED);

    var withColleagues = L.compose(analysisFor('base', 48, 40), { colleaguesCompared: true });
    assertEqual('Letter: colleague comparison included on request',
      withColleagues.body.indexOf('colleagues who are on different salaries') > 0, true);
    assertEqual('Letter: colleague comparison omitted by default',
      bare.body.indexOf('colleagues who are on different salaries'), -1);

    var entities = L.compose(analysisFor('base', 48, 40),
      { contractEntity: 'Company A', providerEntity: 'Company B' });
    assertEqual('Letter: entity mismatch mentioned when the names differ',
      entities.body.indexOf('Company A') > 0 && entities.body.indexOf('Company B') > 0, true);
    var sameEntity = L.compose(analysisFor('base', 48, 40),
      { contractEntity: 'Company A', providerEntity: 'Company A' });
    assertEqual('Letter: entity paragraph omitted when the names match',
      sameEntity.body.indexOf('whereas my'), -1);

    var variedPay = C.analyseAll([
      { id: 'p1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 },
      { id: 'p2', date: '2026-02-28', grossPay: 2400, actualEmployeeNet: 48, actualEmployer: 40 }
    ], Object.assign({}, baseSettings, { statedBasis: 'base' }));
    var variedLetter = L.compose(variedPay, {});
    assertEqual('Letter: a pay change produces a period-by-period table instead of one monthly figure',
      variedLetter.body.indexOf('period by period') > 0, true);

    /* ---- Pay periods with no contributions ------------------------ */
    var contributing = { grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 };
    function withStatuses(statuses) {
      return C.analyseAll(statuses.map(function (st, i) {
        var row = { id: 's' + i, date: '2026-0' + (i + 1) + '-28' };
        if (st === null) { return Object.assign(row, contributing); }
        return Object.assign(row, { grossPay: 2000, actualEmployeeNet: 0, actualEmployer: 0, status: st });
      }), Object.assign({}, baseSettings, { statedBasis: 'base' }));
    }

    var clean = withStatuses([null, null, null]);
    assertEqual('Zero periods: three contributing periods analysed', clean.counts.analysed, 3);
    assertEqual('Zero periods: verdict is a shortfall', clean.verdict.key, C.VERDICT.SHORTFALL);

    var unmarked = withStatuses([null, null, null, 'normal', 'normal']);
    assertEqual('Zero periods: unmarked zero periods are read as matching no basis',
      unmarked.counts.neither, 2);
    assertEqual('Zero periods: and they drag the verdict to mixed', unmarked.verdict.key, C.VERDICT.MIXED);

    var excluded = withStatuses([null, null, null, 'excluded', 'excluded']);
    assertEqual('Excluded periods: counted separately', excluded.counts.excluded, 2);
    assertEqual('Excluded periods: not analysed', excluded.counts.analysed, 3);
    assertEqual('Excluded periods: total still counts every row entered', excluded.counts.total, 5);
    assertEqual('Excluded periods: the verdict is no longer mixed', excluded.verdict.key, C.VERDICT.SHORTFALL);
    assertMoney('Excluded periods: excluded from the shortfall',
      excluded.totals.totalShortfall, clean.totals.totalShortfall);
    assertMoney('Excluded periods: excluded from gross pay analysed',
      excluded.totals.grossPay, clean.totals.grossPay);
    assertEqual('Excluded periods: excluded from the basis count', excluded.counts.qualifying, 3);

    var missed = withStatuses([null, null, null, 'missed', 'missed']);
    assertEqual('Missed periods: counted separately', missed.counts.missed, 2);
    assertEqual('Missed periods: included in the analysed count', missed.counts.analysed, 5);
    assertEqual('Missed periods: do not count towards the detected basis', missed.counts.qualifying, 3);
    assertEqual('Missed periods: verdict stays a shortfall', missed.verdict.key, C.VERDICT.SHORTFALL);
    assertEqual('Missed periods: the verdict says so', missed.verdict.missedPeriods, 2);
    assertMoney('Missed periods: the full expected amount counts as a shortfall',
      C.roundMoney(missed.totals.totalShortfall - clean.totals.totalShortfall), 400.00);

    var onBasisButMissed = C.analyseAll([
      { id: 'b1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: 96, actualEmployer: 80 },
      { id: 'b2', date: '2026-02-28', grossPay: 2000, actualEmployeeNet: 0, actualEmployer: 0, status: 'missed' }
    ], Object.assign({}, baseSettings, { statedBasis: 'base' }));
    assertEqual('Missed periods: still actionable even when the basis is right',
      onBasisButMissed.verdict.key, C.VERDICT.SHORTFALL);
    assertEqual('Missed periods: and the letter is about the missing periods',
      L.compose(onBasisButMissed, {}).variant, L.VARIANT.MISSED);

    var allExcluded = withStatuses(['excluded', 'excluded']);
    assertEqual('Excluded periods: nothing left to analyse', allExcluded.verdict.key, C.VERDICT.NO_DATA);
    assertEqual('Excluded periods: no letter when every period is excluded',
      L.compose(allExcluded, {}).canGenerate, false);

    var missedLetter = L.compose(missed, { recipientName: 'A', senderName: 'B',
      enrolmentPeriod: 'January 2026', schemeQuote: 'Base salary.', responseBy: '01/06/2026' });
    assertEqual('Letter: lists the periods where nothing was paid',
      missedLetter.body.indexOf('No pension contributions were made at all') > 0, true);
    assertEqual('Letter: asks about them separately',
      missedLetter.body.indexOf('why no contributions were made') > 0, true);
    assertEqual('Letter: counts only the periods where contributions were due',
      missedLetter.body.indexOf('Across the 5 pay periods') > 0, true);

    var excludedLetter = L.compose(excluded, { recipientName: 'A', senderName: 'B',
      enrolmentPeriod: 'January 2026', schemeQuote: 'Base salary.', responseBy: '01/06/2026' });
    assertEqual('Letter: excluded periods are left out of the period count',
      excludedLetter.body.indexOf('Across the 3 pay periods') > 0, true);
    assertEqual('Letter: and it says the count is of periods where contributions were due',
      excludedLetter.body.indexOf('in which contributions were due') > 0, true);
    assertEqual('Letter: no missing-contribution paragraph when there are none',
      excludedLetter.body.indexOf('No pension contributions were made at all'), -1);

    /* ---- Prompt to classify an unmarked empty period --------------- */
    var emptyRow = C.analysePayslip(
      { id: 'e1', grossPay: 2000, actualEmployeeNet: 0, actualEmployer: 0 }, baseSettings);
    assertEqual('An unmarked zero period is flagged for classification', emptyRow.looksEmpty, true);
    assertEqual('...with a warning explaining what to do',
      emptyRow.warnings.some(function (w) { return w.indexOf('Set its status') >= 0; }), true);
    var normalRow = C.analysePayslip(
      { id: 'e2', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 }, baseSettings);
    assertEqual('A contributing period is not flagged', normalRow.looksEmpty, false);
    assertEqual('An excluded period does not warn about missing figures',
      C.analysePayslip({ id: 'e3', grossPay: 2000, status: 'excluded' }, baseSettings).warnings.length, 0);

    /* ---- Deducted from pay but never received by the scheme ------- */
    function remittance(providerEmployee, providerEmployer) {
      var row = { id: 'nr', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 };
      if (providerEmployee !== undefined) { row.providerEmployeeNet = providerEmployee; }
      if (providerEmployer !== undefined) { row.providerEmployer = providerEmployer; }
      return C.analyseAll([row], Object.assign({}, baseSettings, { statedBasis: 'qualifying' }));
    }

    var notPaid = remittance(0, 0);
    assertEqual('Remittance: a nil provider figure against a payslip deduction is flagged',
      notPaid.counts.notRemitted, 1);
    assertMoney('Remittance: the amount that never arrived', notPaid.totals.notRemitted, 88.00);
    assertEqual('Remittance: the row is marked', notPaid.rows[0].notRemitted, true);
    assertEqual('Remittance: it warns in plain words',
      notPaid.rows[0].warnings.some(function (w) { return w.indexOf('not received by the scheme') >= 0; }), true);

    var employeeOnly = remittance(0, 40);
    assertEqual('Remittance: employee money missing is detected on its own',
      employeeOnly.rows[0].providerCheck.employeeNotRemitted, true);
    assertEqual('Remittance: employer money present is not flagged',
      employeeOnly.rows[0].providerCheck.employerNotRemitted, false);
    assertMoney('Remittance: only the missing part is counted', employeeOnly.totals.notRemitted, 48.00);

    var pendingProvider = remittance(undefined, undefined);
    assertEqual('Remittance: a blank provider figure is not treated as money missing',
      pendingProvider.counts.notRemitted, 0);

    var arrived = remittance(48, 40);
    assertEqual('Remittance: matching provider figures raise nothing', arrived.counts.notRemitted, 0);

    // Even where the basis matches what the scheme states, missing money is actionable.
    assertEqual('Remittance: outranks a correct earnings basis',
      notPaid.verdict.key, C.VERDICT.SHORTFALL);
    assertEqual('Remittance: and is actionable', notPaid.verdict.actionable, true);
    assertEqual('Remittance: the verdict counts the periods', notPaid.verdict.notRemittedPeriods, 1);
    assertEqual('Remittance: a correct basis alone raises nothing',
      arrived.verdict.key, C.VERDICT.AS_STATED);

    var nrLetter = L.compose(notPaid, { recipientName: 'A', senderName: 'B',
      enrolmentPeriod: 'January 2026', responseBy: '01/03/2026' });
    assertEqual('Letter: unremitted contributions produce their own variant',
      nrLetter.variant, L.VARIANT.NOT_REMITTED);
    assertEqual('Letter: the subject names the problem',
      nrLetter.subject.indexOf('not received by the scheme') > 0, true);
    assertEqual('Letter: it leads with the missing money',
      nrLetter.body.indexOf('has not received') > 0, true);
    assertEqual('Letter: it lists the amounts and the period',
      nrLetter.body.indexOf('31/01/2026') > 0, true);
    assertEqual('Letter: it mentions the time limits for passing contributions on',
      nrLetter.body.indexOf('within set time limits') > 0, true);
    assertEqual('Letter: it asks where the money went first',
      nrLetter.body.indexOf('1. Confirm what has happened to') > 0, true);
    assertEqual('Letter: it asks whether colleagues are affected and whether trustees were told',
      nrLetter.body.indexOf('reported to the scheme trustees') > 0, true);

    // A basis discrepancy alongside missing money is raised as a secondary point.
    var both = C.analyseAll([
      { id: 'b1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40,
        providerEmployeeNet: 48, providerEmployer: 40 },
      { id: 'b2', date: '2026-02-28', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40,
        providerEmployeeNet: 0, providerEmployer: 0 }
    ], Object.assign({}, baseSettings, { statedBasis: 'base' }));
    var bothLetter = L.compose(both, { recipientName: 'A', senderName: 'B' });
    assertEqual('Letter: missing money leads even when the basis is also wrong',
      bothLetter.variant, L.VARIANT.NOT_REMITTED);
    assertEqual('Letter: the basis point is still made, as a secondary item',
      bothLetter.body.indexOf('Separately, confirm the earnings basis') > 0, true);
    assertEqual('Letter: the earnings basis is not asked about twice',
      bothLetter.body.indexOf('1. Confirm the earnings basis'), -1);

    /* ---- Guided help setting -------------------------------------- */
    assertEqual('Guided help is on by default', C.normaliseSettings({}).guidedHelp, true);
    assertEqual('Guided help can be turned off', C.normaliseSettings({ guidedHelp: false }).guidedHelp, false);
    assertEqual('Guided help survives a round trip through import',
      C.validateImport({ schemaVersion: 1, payslips: [], settings: { guidedHelp: false } }).data.settings.guidedHelp,
      false);

    /* ---- Tax relief must never be presented as money you paid ------ */
    var clarityAnalysis = C.analyseAll([
      { id: 'c1', date: '2026-01-31', grossPay: 2000, actualEmployeeNet: 48, actualEmployer: 40 }
    ], Object.assign({}, baseSettings, { statedBasis: 'base', providerName: 'The Provider' }));
    var clarity = L.compose(clarityAnalysis, { recipientName: 'A', senderName: 'B',
      enrolmentPeriod: 'January 2026', schemeQuote: 'Base salary.', responseBy: '01/03/2026' });

    assertEqual('Letter: explains relief at source before quoting any employee figure',
      clarity.body.indexOf('only part of my contribution') <
      clarity.body.indexOf('Total reaching my pension'), true);
    assertEqual('Letter: leads the employee section with the payslip figure',
      clarity.body.indexOf('Taken from my pay') < clarity.body.indexOf('Total reaching my pension'), true);
    assertEqual('Letter: shows the relief as a separate line',
      clarity.body.indexOf('Tax relief added by The Provider') > 0, true);
    assertEqual('Letter: no longer claims the grossed-up figure was "actually contributed"',
      clarity.body.indexOf('Actually contributed'), -1);
    assertEqual('Letter: distinguishes the two employee shortfalls in the totals',
      clarity.body.indexOf('the shortfall in what is deducted from my pay is') > 0, true);
    assertEqual('Letter: names the provider as the one reclaiming the relief',
      clarity.body.indexOf('The Provider reclaims basic rate tax relief') > 0, true);

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
