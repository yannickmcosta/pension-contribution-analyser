/*
 * Pension Contribution Audit - calculation engine
 *
 * Pure functions only. No DOM access, no storage access, no side effects.
 * Loaded in the browser as `window.PensionCalc` and usable in Node via require().
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PensionCalc = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  var SCHEMA_VERSION = 1;

  var PAY_FREQUENCIES = [
    { id: 'monthly', label: 'Monthly', periodsPerYear: 12, days: null, months: 1 },
    { id: 'fourWeekly', label: 'Four-weekly', periodsPerYear: 13, days: 28, months: 0 },
    { id: 'fortnightly', label: 'Fortnightly', periodsPerYear: 26, days: 14, months: 0 },
    { id: 'weekly', label: 'Weekly', periodsPerYear: 52, days: 7, months: 0 }
  ];

  var BASIS = {
    BASE: 'base',
    QE: 'qualifying',
    NEITHER: 'neither',
    INSUFFICIENT: 'insufficient'
  };

  var BASIS_LABELS = {};
  BASIS_LABELS[BASIS.BASE] = 'Matches Base Salary';
  BASIS_LABELS[BASIS.QE] = 'Matches Qualifying Earnings';
  BASIS_LABELS[BASIS.NEITHER] = 'Does Not Match Either';
  BASIS_LABELS[BASIS.INSUFFICIENT] = 'Insufficient Data';

  var DEFAULT_SETTINGS = {
    employeeReference: '',
    annualBaseSalary: 0,
    payFrequency: 'monthly',
    employerPercent: 3,
    employeePercent: 5,
    rasReliefPercent: 20,
    qeAnnualLower: 6240,
    qeAnnualUpper: 50270,
    useCustomPeriodThresholds: true,
    customPeriodLower: 520,
    customPeriodUpper: 4189,
    tolerance: 0.02,
    currency: 'GBP',
    useGrossAsPensionable: true,
    marginalTaxRatePercent: 40,
    showHigherRatePanel: false
  };

  /* ------------------------------------------------------------------ *
   * Primitive helpers
   * ------------------------------------------------------------------ */

  /**
   * Round to whole pence, half away from zero, with a small epsilon
   * correction so that binary floating point artefacts such as
   * 4.35 * 100 = 434.99999999999994 do not round the wrong way.
   */
  function roundMoney(value) {
    var n = Number(value);
    if (!isFinite(n)) { return 0; }
    var scaled = Math.abs(n) * 100;
    var rounded = Math.round(scaled + 1e-9) / 100;
    return n < 0 ? -rounded : rounded;
  }

  /** Round a percentage-style rate to 6dp to avoid drift in intermediate maths. */
  function roundRate(value) {
    var n = Number(value);
    if (!isFinite(n)) { return 0; }
    return Math.round(n * 1e6) / 1e6;
  }

  /**
   * Parse user input into a number. Blank / null / non-numeric returns null so
   * that "not supplied" can be distinguished from "supplied as zero".
   */
  function toNumberOrNull(value) {
    if (value === null || value === undefined) { return null; }
    if (typeof value === 'number') { return isFinite(value) ? value : null; }
    var cleaned = String(value).replace(/[£$€,\s]/g, '').trim();
    if (cleaned === '') { return null; }
    var n = Number(cleaned);
    return isFinite(n) ? n : null;
  }

  /** Parse user input into a number, falling back to a default. */
  function toNumber(value, fallback) {
    var n = toNumberOrNull(value);
    return n === null ? (fallback === undefined ? 0 : fallback) : n;
  }

  function getFrequency(id) {
    for (var i = 0; i < PAY_FREQUENCIES.length; i++) {
      if (PAY_FREQUENCIES[i].id === id) { return PAY_FREQUENCIES[i]; }
    }
    return PAY_FREQUENCIES[0];
  }

  function formatCurrency(value, currency) {
    var n = Number(value);
    if (!isFinite(n)) { return '—'; }
    try {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: currency || 'GBP',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(n);
    } catch (e) {
      return (n < 0 ? '-' : '') + '£' + Math.abs(n).toFixed(2);
    }
  }

  /** ISO yyyy-mm-dd -> dd/mm/yyyy. Returns '' for anything unparseable. */
  function formatDateUK(iso) {
    if (!iso || typeof iso !== 'string') { return ''; }
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (!m) { return iso; }
    return m[3] + '/' + m[2] + '/' + m[1];
  }

  function isLastDayOfMonth(year, monthIndex, day) {
    return day === new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  /**
   * Advance an ISO date by one pay period. Monthly keeps end-of-month
   * alignment (31/01 -> 28/02), other frequencies add whole days.
   */
  function addPayPeriod(iso, frequencyId) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) { return ''; }
    var year = Number(m[1]);
    var monthIndex = Number(m[2]) - 1;
    var day = Number(m[3]);
    var freq = getFrequency(frequencyId);

    if (freq.days) {
      var d = new Date(Date.UTC(year, monthIndex, day));
      d.setUTCDate(d.getUTCDate() + freq.days);
      return toIsoDate(d);
    }

    var wasMonthEnd = isLastDayOfMonth(year, monthIndex, day);
    var nextMonthLastDay = new Date(Date.UTC(year, monthIndex + 2, 0)).getUTCDate();
    var nextDay = wasMonthEnd ? nextMonthLastDay : Math.min(day, nextMonthLastDay);
    return toIsoDate(new Date(Date.UTC(year, monthIndex + 1, nextDay)));
  }

  function toIsoDate(date) {
    var y = date.getUTCFullYear();
    var mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    var d = String(date.getUTCDate()).padStart(2, '0');
    return y + '-' + mo + '-' + d;
  }

  /* ------------------------------------------------------------------ *
   * Settings normalisation
   * ------------------------------------------------------------------ */

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Coerce a settings object from storage / import into a complete, safe
   * settings object. Never throws.
   */
  function normaliseSettings(raw) {
    var s = {};
    var input = (raw && typeof raw === 'object') ? raw : {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
      s[key] = DEFAULT_SETTINGS[key];
    });

    s.employeeReference = typeof input.employeeReference === 'string' ? input.employeeReference : '';
    s.annualBaseSalary = Math.max(0, toNumber(input.annualBaseSalary, 0));
    s.payFrequency = getFrequency(input.payFrequency).id;
    s.employerPercent = clamp(toNumber(input.employerPercent, DEFAULT_SETTINGS.employerPercent), 0, 100);
    s.employeePercent = clamp(toNumber(input.employeePercent, DEFAULT_SETTINGS.employeePercent), 0, 100);
    // A 100% relief rate would make the net -> gross derivation undefined.
    s.rasReliefPercent = clamp(toNumber(input.rasReliefPercent, DEFAULT_SETTINGS.rasReliefPercent), 0, 99);
    s.qeAnnualLower = Math.max(0, toNumber(input.qeAnnualLower, DEFAULT_SETTINGS.qeAnnualLower));
    s.qeAnnualUpper = Math.max(0, toNumber(input.qeAnnualUpper, DEFAULT_SETTINGS.qeAnnualUpper));
    if (s.qeAnnualUpper < s.qeAnnualLower) { s.qeAnnualUpper = s.qeAnnualLower; }
    s.useCustomPeriodThresholds = input.useCustomPeriodThresholds !== false;
    s.customPeriodLower = Math.max(0, toNumber(input.customPeriodLower, DEFAULT_SETTINGS.customPeriodLower));
    s.customPeriodUpper = Math.max(0, toNumber(input.customPeriodUpper, DEFAULT_SETTINGS.customPeriodUpper));
    if (s.customPeriodUpper < s.customPeriodLower) { s.customPeriodUpper = s.customPeriodLower; }
    s.tolerance = Math.max(0, toNumber(input.tolerance, DEFAULT_SETTINGS.tolerance));
    s.currency = typeof input.currency === 'string' && input.currency.length === 3
      ? input.currency.toUpperCase() : 'GBP';
    s.useGrossAsPensionable = input.useGrossAsPensionable !== false;
    s.marginalTaxRatePercent = clamp(toNumber(input.marginalTaxRatePercent, DEFAULT_SETTINGS.marginalTaxRatePercent), 0, 100);
    s.showHigherRatePanel = input.showHigherRatePanel === true;
    return s;
  }

  /* ------------------------------------------------------------------ *
   * Pay-period thresholds
   * ------------------------------------------------------------------ */

  /**
   * Work out the qualifying earnings thresholds for a single pay period.
   * Returns both the derived (annual / periods) values and the values that
   * will actually be used, so the UI can show exactly what was applied.
   */
  function calculatePeriodThresholds(settings) {
    var s = normaliseSettings(settings);
    var freq = getFrequency(s.payFrequency);
    var derivedLower = roundMoney(s.qeAnnualLower / freq.periodsPerYear);
    var derivedUpper = roundMoney(s.qeAnnualUpper / freq.periodsPerYear);
    var useCustom = !!s.useCustomPeriodThresholds;

    return {
      frequencyId: freq.id,
      frequencyLabel: freq.label,
      periodsPerYear: freq.periodsPerYear,
      annualLower: roundMoney(s.qeAnnualLower),
      annualUpper: roundMoney(s.qeAnnualUpper),
      derivedLower: derivedLower,
      derivedUpper: derivedUpper,
      lower: useCustom ? roundMoney(s.customPeriodLower) : derivedLower,
      upper: useCustom ? roundMoney(s.customPeriodUpper) : derivedUpper,
      source: useCustom ? 'custom' : 'derived'
    };
  }

  /* ------------------------------------------------------------------ *
   * Core contribution maths
   * ------------------------------------------------------------------ */

  /**
   * Contributions for a given earnings figure, using the configured
   * percentages and Relief at Source rate.
   */
  function contributionsFromEarnings(earnings, settings) {
    var s = normaliseSettings(settings);
    var base = roundMoney(Math.max(0, toNumber(earnings, 0)));
    var reliefRate = roundRate(s.rasReliefPercent / 100);

    var employer = roundMoney(base * (s.employerPercent / 100));
    var employeeGross = roundMoney(base * (s.employeePercent / 100));
    var employeeNet = roundMoney(employeeGross * (1 - reliefRate));
    var taxRelief = roundMoney(employeeGross - employeeNet);

    return {
      earnings: base,
      employer: employer,
      employeeGross: employeeGross,
      employeeNet: employeeNet,
      taxRelief: taxRelief,
      total: roundMoney(employer + employeeGross)
    };
  }

  /**
   * A. Expected contributions if calculated on base / pensionable pay.
   * Returns available:false when no pensionable pay figure is known.
   */
  function calculateExpectedBaseContribution(pensionablePay, settings) {
    var p = toNumberOrNull(pensionablePay);
    if (p === null) {
      return { basis: BASIS.BASE, available: false, earnings: null,
        employer: null, employeeGross: null, employeeNet: null, taxRelief: null, total: null };
    }
    var c = contributionsFromEarnings(p, settings);
    c.basis = BASIS.BASE;
    c.available = true;
    return c;
  }

  /**
   * C1. Qualifying earnings for one pay period:
   *     max(0, min(gross, upper) - lower)
   */
  function calculateQualifyingEarnings(grossPay, lowerThreshold, upperThreshold) {
    var gross = toNumberOrNull(grossPay);
    if (gross === null) { return null; }
    var lower = roundMoney(toNumber(lowerThreshold, 0));
    var upper = roundMoney(toNumber(upperThreshold, 0));
    if (upper < lower) { upper = lower; }
    var capped = Math.min(roundMoney(gross), upper);
    return roundMoney(Math.max(0, capped - lower));
  }

  /**
   * C2. Expected contributions if calculated on statutory qualifying earnings.
   */
  function calculateExpectedQEContribution(grossPay, thresholds, settings) {
    var qe = calculateQualifyingEarnings(grossPay, thresholds.lower, thresholds.upper);
    if (qe === null) {
      return { basis: BASIS.QE, available: false, earnings: null, qualifyingEarnings: null,
        employer: null, employeeGross: null, employeeNet: null, taxRelief: null, total: null,
        thresholds: thresholds };
    }
    var c = contributionsFromEarnings(qe, settings);
    c.basis = BASIS.QE;
    c.available = true;
    c.qualifyingEarnings = qe;
    c.thresholds = thresholds;
    return c;
  }

  /**
   * B. Work back from the payslip figures.
   *    gross employee contribution = net deduction / (1 - relief rate)
   */
  function deriveActualContribution(actualEmployeeNet, actualEmployer, settings) {
    var s = normaliseSettings(settings);
    var reliefRate = roundRate(s.rasReliefPercent / 100);
    var net = toNumberOrNull(actualEmployeeNet);
    var employer = toNumberOrNull(actualEmployer);

    var hasEmployee = net !== null;
    var hasEmployer = employer !== null;

    var employeeNet = hasEmployee ? roundMoney(net) : null;
    var employeeGross = hasEmployee ? roundMoney(employeeNet / (1 - reliefRate)) : null;
    var taxRelief = hasEmployee ? roundMoney(employeeGross - employeeNet) : null;
    var employerValue = hasEmployer ? roundMoney(employer) : null;

    return {
      hasEmployee: hasEmployee,
      hasEmployer: hasEmployer,
      hasAnyData: hasEmployee || hasEmployer,
      isComplete: hasEmployee && hasEmployer,
      employer: employerValue,
      employeeNet: employeeNet,
      employeeGross: employeeGross,
      taxRelief: taxRelief,
      // Missing components are treated as nil contributions for totalling.
      total: roundMoney((employerValue || 0) + (employeeGross || 0))
    };
  }

  /**
   * What percentage of the earnings figure a contribution actually represents.
   * Returns null when there is nothing meaningful to divide by.
   */
  function calculateEffectiveRate(amount, earnings) {
    var a = toNumberOrNull(amount);
    var e = toNumberOrNull(earnings);
    if (a === null || e === null || e <= 0) { return null; }
    return roundRate((a / e) * 100);
  }

  /**
   * The contribution rates the payslip figures actually work out at, expressed
   * against the given earnings figure, alongside the configured rates they are
   * supposed to be. Percentage-point gaps are positive when short.
   */
  function calculateEffectiveRates(earnings, actual, settings) {
    var s = normaliseSettings(settings);
    var employer = calculateEffectiveRate(actual.employer, earnings);
    var employeeGross = calculateEffectiveRate(actual.employeeGross, earnings);
    var employeeNet = calculateEffectiveRate(actual.employeeNet, earnings);
    var total = calculateEffectiveRate(actual.total, earnings);
    var targetTotal = roundRate(s.employerPercent + s.employeePercent);

    return {
      available: employer !== null || employeeGross !== null,
      earnings: toNumberOrNull(earnings),
      employer: employer,
      employeeGross: employeeGross,
      employeeNet: employeeNet,
      total: total,
      targetEmployer: s.employerPercent,
      targetEmployeeGross: s.employeePercent,
      targetTotal: targetTotal,
      employerGap: employer === null ? null : roundRate(s.employerPercent - employer),
      employeeGrossGap: employeeGross === null ? null : roundRate(s.employeePercent - employeeGross),
      totalGap: total === null ? null : roundRate(targetTotal - total)
    };
  }

  /**
   * D. Differences between an expected set of figures and the actual ones.
   * Positive = shortfall (expected more than was paid).
   * Negative = overpayment.
   */
  function calculateDifferences(expected, actual) {
    function diff(exp, act) {
      if (exp === null || exp === undefined) { return null; }
      return roundMoney(exp - (act === null || act === undefined ? 0 : act));
    }
    return {
      employer: diff(expected.employer, actual.employer),
      employeeGross: diff(expected.employeeGross, actual.employeeGross),
      employeeNet: diff(expected.employeeNet, actual.employeeNet),
      taxRelief: diff(expected.taxRelief, actual.taxRelief),
      total: diff(expected.total, actual.total)
    };
  }

  /**
   * E. Which basis do the payslip figures appear to have been calculated on?
   * Only the components actually present on the payslip are tested.
   */
  function detectContributionBasis(actual, expectedBase, expectedQE, tolerance) {
    var tol = Math.max(0, toNumber(tolerance, 0.02));

    function assess(candidate) {
      var result = { available: !!candidate.available, employerMatch: null, employeeMatch: null, matches: false };
      if (!candidate.available || !actual.hasAnyData) { return result; }
      var checks = 0;
      var ok = true;
      if (actual.hasEmployer) {
        checks++;
        result.employerMatch = Math.abs(actual.employer - candidate.employer) <= tol;
        if (!result.employerMatch) { ok = false; }
      }
      if (actual.hasEmployee) {
        checks++;
        result.employeeMatch = Math.abs(actual.employeeNet - candidate.employeeNet) <= tol;
        if (!result.employeeMatch) { ok = false; }
      }
      result.matches = checks > 0 && ok;
      return result;
    }

    var baseAssessment = assess(expectedBase);
    var qeAssessment = assess(expectedQE);

    var basis;
    if (!actual.hasAnyData || (!expectedBase.available && !expectedQE.available)) {
      basis = BASIS.INSUFFICIENT;
    } else if (baseAssessment.matches && qeAssessment.matches) {
      // Both bases produce the same figures (e.g. all-zero, or pensionable
      // pay happens to equal qualifying earnings) - report the base salary
      // reading and flag the ambiguity for the detail view.
      basis = BASIS.BASE;
    } else if (baseAssessment.matches) {
      basis = BASIS.BASE;
    } else if (qeAssessment.matches) {
      basis = BASIS.QE;
    } else {
      basis = BASIS.NEITHER;
    }

    return {
      basis: basis,
      label: BASIS_LABELS[basis],
      ambiguous: baseAssessment.matches && qeAssessment.matches,
      partial: !actual.isComplete && actual.hasAnyData,
      tolerance: tol,
      base: baseAssessment,
      qualifying: qeAssessment
    };
  }

  /**
   * Optional, informational only: extra personal tax relief a higher or
   * additional rate taxpayer may be able to claim on top of the basic-rate
   * relief already claimed by the scheme under Relief at Source.
   */
  function calculateHigherRateRelief(employeeGrossContribution, settings) {
    var s = normaliseSettings(settings);
    var gross = toNumberOrNull(employeeGrossContribution);
    var extraRate = roundRate((s.marginalTaxRatePercent - s.rasReliefPercent) / 100);
    if (gross === null || extraRate <= 0) {
      return { applicable: false, extraRatePercent: 0, amount: 0, basicRateRelief: 0 };
    }
    return {
      applicable: true,
      extraRatePercent: roundRate(s.marginalTaxRatePercent - s.rasReliefPercent),
      amount: roundMoney(gross * extraRate),
      basicRateRelief: roundMoney(gross * roundRate(s.rasReliefPercent / 100))
    };
  }

  /* ------------------------------------------------------------------ *
   * Payslip analysis
   * ------------------------------------------------------------------ */

  /** Effective pensionable pay for a row, honouring the "use gross" setting. */
  function resolvePensionablePay(payslip, settings) {
    var explicit = toNumberOrNull(payslip.pensionablePay);
    if (explicit !== null) { return explicit; }
    if (settings.useGrossAsPensionable) { return toNumberOrNull(payslip.grossPay); }
    return null;
  }

  /**
   * Full analysis of a single payslip row.
   */
  function analysePayslip(payslip, settings, thresholds) {
    var s = normaliseSettings(settings);
    var t = thresholds || calculatePeriodThresholds(s);
    var gross = toNumberOrNull(payslip.grossPay);
    var pensionable = resolvePensionablePay(payslip, s);

    var expectedBase = calculateExpectedBaseContribution(pensionable, s);
    var expectedQE = calculateExpectedQEContribution(gross, t, s);
    var actual = deriveActualContribution(payslip.actualEmployeeNet, payslip.actualEmployer, s);

    var effectiveRates = calculateEffectiveRates(pensionable, actual, s);
    var differencesVsBase = calculateDifferences(expectedBase, actual);
    var differencesVsQE = calculateDifferences(expectedQE, actual);
    var detection = detectContributionBasis(actual, expectedBase, expectedQE, s.tolerance);

    var warnings = [];
    if (gross === null) { warnings.push('No gross pay entered.'); }
    if (pensionable === null) { warnings.push('No base/pensionable pay entered.'); }
    if (!actual.hasEmployer) { warnings.push('No actual employer contribution entered.'); }
    if (!actual.hasEmployee) { warnings.push('No actual employee deduction entered.'); }

    return {
      id: payslip.id,
      date: payslip.date || '',
      period: payslip.period || '',
      notes: payslip.notes || '',
      grossPay: gross,
      pensionablePay: pensionable,
      pensionableIsInherited: toNumberOrNull(payslip.pensionablePay) === null && s.useGrossAsPensionable && gross !== null,
      thresholds: t,
      expectedBase: expectedBase,
      expectedQE: expectedQE,
      actual: actual,
      effectiveRates: effectiveRates,
      differencesVsBase: differencesVsBase,
      differencesVsQE: differencesVsQE,
      detection: detection,
      warnings: warnings,
      hasCompleteData: gross !== null && pensionable !== null && actual.isComplete
    };
  }

  function addTo(totals, key, value) {
    if (value === null || value === undefined) { return; }
    totals[key] = roundMoney(totals[key] + value);
  }

  /**
   * Analyse a whole set of payslips and produce dashboard totals.
   * Rows are analysed in the order supplied; cumulative figures follow that
   * order, so callers should sort chronologically before calling.
   */
  function analyseAll(payslips, settings) {
    var s = normaliseSettings(settings);
    var thresholds = calculatePeriodThresholds(s);
    var list = Array.isArray(payslips) ? payslips : [];

    var totals = {
      grossPay: 0,
      pensionablePay: 0,
      expectedEmployer: 0,
      expectedEmployeeGross: 0,
      expectedEmployeeNet: 0,
      expectedTaxRelief: 0,
      expectedTotal: 0,
      qeEmployer: 0,
      qeEmployeeGross: 0,
      qeTotal: 0,
      actualEmployer: 0,
      actualEmployeeNet: 0,
      actualEmployeeGross: 0,
      actualTaxRelief: 0,
      actualTotal: 0,
      employerShortfall: 0,
      employeeGrossShortfall: 0,
      employeeNetShortfall: 0,
      taxReliefShortfall: 0,
      totalShortfall: 0
    };

    var counts = { total: 0, base: 0, qualifying: 0, neither: 0, insufficient: 0, incomplete: 0 };
    var cumulative = 0;
    var rows = list.map(function (p) {
      var row = analysePayslip(p, s, thresholds);

      addTo(totals, 'grossPay', row.grossPay);
      addTo(totals, 'pensionablePay', row.pensionablePay);
      addTo(totals, 'expectedEmployer', row.expectedBase.employer);
      addTo(totals, 'expectedEmployeeGross', row.expectedBase.employeeGross);
      addTo(totals, 'expectedEmployeeNet', row.expectedBase.employeeNet);
      addTo(totals, 'expectedTaxRelief', row.expectedBase.taxRelief);
      addTo(totals, 'expectedTotal', row.expectedBase.total);
      addTo(totals, 'qeEmployer', row.expectedQE.employer);
      addTo(totals, 'qeEmployeeGross', row.expectedQE.employeeGross);
      addTo(totals, 'qeTotal', row.expectedQE.total);
      addTo(totals, 'actualEmployer', row.actual.employer);
      addTo(totals, 'actualEmployeeNet', row.actual.employeeNet);
      addTo(totals, 'actualEmployeeGross', row.actual.employeeGross);
      addTo(totals, 'actualTaxRelief', row.actual.taxRelief);
      addTo(totals, 'actualTotal', row.actual.total);
      addTo(totals, 'employerShortfall', row.differencesVsBase.employer);
      addTo(totals, 'employeeGrossShortfall', row.differencesVsBase.employeeGross);
      addTo(totals, 'employeeNetShortfall', row.differencesVsBase.employeeNet);
      addTo(totals, 'taxReliefShortfall', row.differencesVsBase.taxRelief);
      addTo(totals, 'totalShortfall', row.differencesVsBase.total);

      cumulative = roundMoney(cumulative + (row.differencesVsBase.total || 0));
      row.cumulativeShortfall = cumulative;

      counts.total++;
      if (row.detection.basis === BASIS.BASE) { counts.base++; }
      else if (row.detection.basis === BASIS.QE) { counts.qualifying++; }
      else if (row.detection.basis === BASIS.NEITHER) { counts.neither++; }
      else { counts.insufficient++; }
      if (!row.hasCompleteData) { counts.incomplete++; }

      return row;
    });

    // Effective rates across the whole period, measured against the
    // pensionable pay that was actually available to measure against.
    totals.effectiveEmployerRate = calculateEffectiveRate(totals.actualEmployer, totals.pensionablePay);
    totals.effectiveEmployeeGrossRate = calculateEffectiveRate(totals.actualEmployeeGross, totals.pensionablePay);
    totals.effectiveEmployeeNetRate = calculateEffectiveRate(totals.actualEmployeeNet, totals.pensionablePay);
    totals.effectiveTotalRate = calculateEffectiveRate(totals.actualTotal, totals.pensionablePay);
    totals.targetEmployerRate = s.employerPercent;
    totals.targetEmployeeGrossRate = s.employeePercent;
    totals.targetTotalRate = roundMoney(s.employerPercent + s.employeePercent);

    return {
      rows: rows,
      totals: totals,
      counts: counts,
      thresholds: thresholds,
      settings: s,
      higherRate: calculateHigherRateRelief(totals.actualEmployeeGross, s)
    };
  }

  /* ------------------------------------------------------------------ *
   * Sorting
   * ------------------------------------------------------------------ */

  var BASIS_SORT_ORDER = {};
  BASIS_SORT_ORDER[BASIS.BASE] = 0;
  BASIS_SORT_ORDER[BASIS.QE] = 1;
  BASIS_SORT_ORDER[BASIS.NEITHER] = 2;
  BASIS_SORT_ORDER[BASIS.INSUFFICIENT] = 3;

  /**
   * Sort analysed rows. Returns a new array; ties fall back to date order so
   * the ordering is stable and predictable.
   */
  function sortAnalysedRows(rows, key, direction) {
    var dir = direction === 'desc' ? -1 : 1;
    var copy = rows.slice();
    copy.sort(function (a, b) {
      var result = 0;
      if (key === 'shortfall') {
        result = (a.differencesVsBase.total || 0) - (b.differencesVsBase.total || 0);
      } else if (key === 'basis') {
        result = BASIS_SORT_ORDER[a.detection.basis] - BASIS_SORT_ORDER[b.detection.basis];
      } else {
        result = String(a.date).localeCompare(String(b.date));
      }
      if (result === 0) { result = String(a.date).localeCompare(String(b.date)); }
      return result * dir;
    });
    return copy;
  }

  /* ------------------------------------------------------------------ *
   * Payslip normalisation and import validation
   * ------------------------------------------------------------------ */

  function normalisePayslip(raw, index) {
    var p = (raw && typeof raw === 'object') ? raw : {};
    var date = typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date.trim()) ? p.date.trim() : '';
    return {
      id: typeof p.id === 'string' && p.id ? p.id : 'ps-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2, 8),
      date: date,
      period: typeof p.period === 'string' ? p.period : '',
      grossPay: toNumberOrNull(p.grossPay),
      pensionablePay: toNumberOrNull(p.pensionablePay),
      actualEmployeeNet: toNumberOrNull(p.actualEmployeeNet),
      actualEmployer: toNumberOrNull(p.actualEmployer),
      notes: typeof p.notes === 'string' ? p.notes : ''
    };
  }

  /**
   * Validate an imported file structure. Returns { ok, errors, data }.
   * Numeric fields that are present but not numeric are reported rather than
   * silently discarded.
   */
  function validateImport(parsed) {
    var errors = [];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, errors: ['The file does not contain a pension audit backup object.'], data: null };
    }
    var version = parsed.schemaVersion;
    if (version === undefined || version === null) {
      errors.push('The file is missing "schemaVersion".');
    } else if (typeof version !== 'number' || !isFinite(version)) {
      errors.push('"schemaVersion" must be a number.');
    } else if (version > SCHEMA_VERSION) {
      errors.push('This file was created by a newer version of the tool (schema ' + version +
        '). This version understands schema ' + SCHEMA_VERSION + ' or earlier.');
    }
    if (parsed.settings !== undefined && (typeof parsed.settings !== 'object' || parsed.settings === null || Array.isArray(parsed.settings))) {
      errors.push('"settings" must be an object.');
    }
    if (parsed.payslips === undefined) {
      errors.push('The file is missing a "payslips" array.');
    } else if (!Array.isArray(parsed.payslips)) {
      errors.push('"payslips" must be an array.');
    }

    if (Array.isArray(parsed.payslips)) {
      var numericFields = ['grossPay', 'pensionablePay', 'actualEmployeeNet', 'actualEmployer'];
      parsed.payslips.forEach(function (p, i) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          errors.push('Payslip ' + (i + 1) + ' is not an object.');
          return;
        }
        if (p.date !== undefined && p.date !== null && p.date !== '' &&
            !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date).trim())) {
          errors.push('Payslip ' + (i + 1) + ' has an invalid date "' + p.date + '" (expected YYYY-MM-DD).');
        }
        numericFields.forEach(function (f) {
          var v = p[f];
          if (v === undefined || v === null || v === '') { return; }
          if (toNumberOrNull(v) === null) {
            errors.push('Payslip ' + (i + 1) + ' has a non-numeric value for "' + f + '".');
          }
        });
      });
      if (errors.length === 0 && parsed.payslips.length === 0) {
        // Not an error; an empty backup is valid.
        void 0;
      }
    }

    if (errors.length) { return { ok: false, errors: errors, data: null }; }

    return {
      ok: true,
      errors: [],
      data: {
        schemaVersion: SCHEMA_VERSION,
        settings: normaliseSettings(parsed.settings),
        payslips: parsed.payslips.map(normalisePayslip)
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PAY_FREQUENCIES: PAY_FREQUENCIES,
    BASIS: BASIS,
    BASIS_LABELS: BASIS_LABELS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,

    roundMoney: roundMoney,
    toNumber: toNumber,
    toNumberOrNull: toNumberOrNull,
    formatCurrency: formatCurrency,
    formatDateUK: formatDateUK,
    getFrequency: getFrequency,
    addPayPeriod: addPayPeriod,
    toIsoDate: toIsoDate,

    normaliseSettings: normaliseSettings,
    normalisePayslip: normalisePayslip,
    calculatePeriodThresholds: calculatePeriodThresholds,
    contributionsFromEarnings: contributionsFromEarnings,
    calculateExpectedBaseContribution: calculateExpectedBaseContribution,
    calculateQualifyingEarnings: calculateQualifyingEarnings,
    calculateExpectedQEContribution: calculateExpectedQEContribution,
    deriveActualContribution: deriveActualContribution,
    calculateDifferences: calculateDifferences,
    calculateEffectiveRate: calculateEffectiveRate,
    calculateEffectiveRates: calculateEffectiveRates,
    detectContributionBasis: detectContributionBasis,
    calculateHigherRateRelief: calculateHigherRateRelief,
    resolvePensionablePay: resolvePensionablePay,
    analysePayslip: analysePayslip,
    analyseAll: analyseAll,
    sortAnalysedRows: sortAnalysedRows,
    validateImport: validateImport
  };
}));
