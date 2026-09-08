/*
 * Pension Contribution Audit - letter composer
 *
 * Pure functions. Turns an analysis plus a few details only the user can know
 * into the text of an email. No DOM access, no employer-specific wording.
 *
 * The composer deliberately refuses to produce a complaint where the figures
 * match the basis the scheme states. There is nothing to raise in that case.
 */
(function (root, factory) {
  'use strict';
  var calc = (typeof module === 'object' && module.exports) ? require('./calculations.js') : root.PensionCalc;
  var api = factory(calc);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.PensionLetter = api; }
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var VARIANT = {
    SHORTFALL: 'shortfall',
    ENQUIRY: 'enquiry',
    UNMATCHED: 'unmatched',
    MISSED: 'missed',
    NOT_REMITTED: 'not-remitted'
  };

  var DEFAULT_OPTIONS = {
    recipientName: '',
    senderName: '',
    enrolmentPeriod: '',
    schemeQuote: '',
    contractEntity: '',
    providerEntity: '',
    responseBy: '',
    colleaguesCompared: false,
    colleaguesRaisingSeparately: false,
    noVariablePay: true,
    annualSalary: null
  };

  function normaliseOptions(raw) {
    var o = {};
    var input = (raw && typeof raw === 'object') ? raw : {};
    Object.keys(DEFAULT_OPTIONS).forEach(function (k) { o[k] = DEFAULT_OPTIONS[k]; });
    ['recipientName', 'senderName', 'enrolmentPeriod', 'schemeQuote', 'contractEntity',
     'providerEntity', 'responseBy'].forEach(function (k) {
      if (typeof input[k] === 'string') { o[k] = input[k].trim(); }
    });
    o.colleaguesCompared = input.colleaguesCompared === true;
    o.colleaguesRaisingSeparately = input.colleaguesRaisingSeparately === true;
    o.noVariablePay = input.noVariablePay !== false;
    o.annualSalary = C.toNumberOrNull(input.annualSalary);
    return o;
  }

  /** Fill a value in, or leave a bracketed marker the writer must complete. */
  function fieldOr(value, marker, collected) {
    if (value) { return value; }
    if (collected.indexOf(marker) < 0) { collected.push(marker); }
    return marker;
  }

  /* ------------------------------------------------------------------ *
   * Should a letter be produced at all?
   * ------------------------------------------------------------------ */

  function assess(analysis) {
    var v = analysis.verdict;
    switch (v.key) {
      case C.VERDICT.NO_DATA:
        return { canGenerate: false, variant: null,
          reason: 'There are no payslips to write about yet. Add your payslip figures first.' };
      case C.VERDICT.INSUFFICIENT:
        return { canGenerate: false, variant: null,
          reason: 'The actual employer contribution and employee deduction are missing from your payslips, so there is nothing to compare. Fill those in first.' };
      case C.VERDICT.AS_STATED:
        return { canGenerate: false, variant: null,
          reason: v.summary + ' No letter is needed.' };
      case C.VERDICT.BETTER_THAN_STATED:
        return { canGenerate: false, variant: null,
          reason: v.summary + ' No letter is needed.' };
      case C.VERDICT.UNMATCHED:
        return { canGenerate: true, variant: VARIANT.UNMATCHED,
          reason: 'Your figures match neither basis, so this asks for a breakdown rather than alleging a shortfall.' };
      case C.VERDICT.UNKNOWN_BASIS:
        if (!v.actionable) {
          return { canGenerate: false, variant: null,
            reason: 'Your contributions are calculated on your full base/pensionable pay. There is nothing to raise.' };
        }
        return { canGenerate: true, variant: VARIANT.ENQUIRY,
          reason: 'You have not recorded what basis your scheme states, so this asks them to confirm it rather than alleging a shortfall. If your scheme documentation states a basis, set it in Settings for a more direct letter.' };
      case C.VERDICT.MIXED:
        return { canGenerate: true, variant: VARIANT.ENQUIRY,
          reason: 'Your pay periods do not all use the same basis, so this asks for an explanation rather than alleging a consistent shortfall. Check the individual rows too.' };
      default:
        // Money deducted from pay that never reached the scheme is the most
        // serious finding and leads the letter.
        if (analysis.counts.notRemitted) {
          return { canGenerate: true, variant: VARIANT.NOT_REMITTED,
            reason: 'Contributions shown on your payslips were not received by the scheme. That is a different and more urgent matter than the earnings basis, so it leads the letter.' };
        }
        if (analysis.totals.totalShortfall <= analysis.settings.tolerance) {
          return { canGenerate: false, variant: null,
            reason: 'There is no material shortfall to raise.' };
        }
        // Where the basis itself is right, the complaint is only about the
        // periods in which nothing was paid.
        var contributing = analysis.rows.filter(function (r) { return r.countsTowardsBasis; });
        var basisIsWrong = C.dominantBasis(analysis.rows) !== null &&
          C.dominantBasis(analysis.rows) !== 'mixed' &&
          C.dominantBasis(analysis.rows) !== (analysis.settings.statedBasis === 'qualifying' ? C.BASIS.QE : C.BASIS.BASE);
        if (analysis.counts.missed && (!contributing.length || !basisIsWrong)) {
          return { canGenerate: true, variant: VARIANT.MISSED,
            reason: 'The earnings basis looks correct, so this is about the pay periods in which no contributions were made.' };
        }
        return { canGenerate: true, variant: VARIANT.SHORTFALL, reason: '' };
    }
  }

  /* ------------------------------------------------------------------ *
   * Composition
   * ------------------------------------------------------------------ */

  function compose(analysis, rawOptions) {
    var o = normaliseOptions(rawOptions);
    var decision = assess(analysis);
    if (!decision.canGenerate) {
      return { canGenerate: false, variant: null, reason: decision.reason,
        subject: '', body: '', placeholders: [] };
    }

    var s = analysis.settings;
    var t = analysis.totals;
    var th = analysis.thresholds;
    var allRows = C.sortAnalysedRows(analysis.rows, 'date', 'asc');
    var rows = allRows.filter(function (r) { return r.countsTowardsBasis; });
    var missedRows = allRows.filter(function (r) { return r.status === C.PERIOD_STATUS.MISSED; });
    var excludedCount = analysis.counts.excluded;
    if (!rows.length) { rows = allRows.filter(function (r) { return r.includedInTotals; }); }
    var placeholders = [];
    var money = function (v) { return C.formatCurrency(v, s.currency); };
    var provider = s.providerName || 'the pension scheme';
    var periodWord = th.frequencyLabel.toLowerCase();
    var out = [];

    var recipient = fieldOr(o.recipientName, '[HR CONTACT]', placeholders);
    var sender = fieldOr(o.senderName, '[YOUR NAME]', placeholders);
    var enrolled = fieldOr(o.enrolmentPeriod, '[MONTH YEAR]', placeholders);
    var responseBy = fieldOr(o.responseBy, '[DATE]', placeholders);

    var dated = allRows.filter(function (r) { return r.date && r.includedInTotals; });
    var firstDate = dated.length ? C.formatDateUK(dated[0].date) : '[FIRST DATE]';
    var lastDate = dated.length ? C.formatDateUK(dated[dated.length - 1].date) : '[LAST DATE]';
    if (!dated.length && placeholders.indexOf('[FIRST DATE]') < 0) {
      placeholders.push('[FIRST DATE]', '[LAST DATE]');
    }

    var isShortfall = decision.variant === VARIANT.SHORTFALL;
    var isUnmatched = decision.variant === VARIANT.UNMATCHED;
    var isMissed = decision.variant === VARIANT.MISSED;
    var isNotRemitted = decision.variant === VARIANT.NOT_REMITTED;
    var notRemittedRows = allRows.filter(function (r) { return r.providerCheck.notRemitted; });
    var hasComparison = rows.length > 0 && rows[0].expectedBase.available;

    /* ---- opening ---- */
    var opening = 'I\'m writing about the way my pension contributions have been calculated since I was enrolled in ' +
      provider + ' in ' + enrolled + '. Having looked into the figures, ';
    if (isShortfall) {
      opening += 'I believe the wrong earnings basis is being used' +
        (o.colleaguesCompared ? ', and it appears to affect other employees as well.' : '.');
    } else if (isNotRemitted) {
      opening += 'I can see pension contributions shown on my payslips that my pension provider has not received. I would be grateful if you could look into this as a priority.';
    } else if (isMissed) {
      opening += 'I can see pay periods in which no pension contributions were made at all, and I would be grateful if you could look into them.';
    } else if (isUnmatched) {
      opening += 'I am unable to reconcile the amounts being contributed with the contribution rates I was given, and I would be grateful for an explanation.';
    } else {
      opening += 'I would like to confirm which earnings basis is being used to calculate them.';
    }
    out.push('Dear ' + recipient + ',', '', opening);

    /* ---- contributions that never reached the scheme ---- */
    if (notRemittedRows.length) {
      out.push('');
      out.push('My payslips show pension contributions deducted and paid for the following pay period' +
        (notRemittedRows.length === 1 ? '' : 's') + ', but my ' + provider +
        ' contribution history records nothing received for ' +
        (notRemittedRows.length === 1 ? 'it' : 'them') + ':');
      out.push('');
      notRemittedRows.forEach(function (r) {
        var parts = [];
        if (r.providerCheck.employeeNotRemitted) { parts.push(money(r.actual.employeeNet) + ' deducted from my pay'); }
        if (r.providerCheck.employerNotRemitted) { parts.push(money(r.actual.employer) + ' employer contribution'); }
        out.push('    ' + (C.formatDateUK(r.date) || r.period || 'unnamed period') + ' - ' + parts.join(', '));
      });
      out.push('');
      out.push('That comes to ' + money(analysis.totals.notRemitted) +
        ' which appears on my payslips but is not in my pension pot.');
      out.push('');
      out.push('I understand that contributions deducted from pay have to be passed to the scheme within set time limits, so I would be grateful for an explanation of what has happened to these amounts and confirmation of when they will be paid across.');
    }

    /* ---- colleague comparison ---- */
    if (o.colleaguesCompared && !isMissed && !isNotRemitted) {
      var sameFigures = rows.length && rows[0].actual.hasEmployer && rows[0].actual.hasEmployee;
      out.push('');
      out.push('I\'ve compared my contributions with colleagues who are on different salaries. Despite that, the employer contribution is identical for each of us in every pay period at ' +
        (sameFigures ? money(rows[0].actual.employer) : '[EMPLOYER CONTRIBUTION]') +
        '. Our employee deductions are also identical at ' +
        (sameFigures ? money(rows[0].actual.employeeNet) : '[EMPLOYEE DEDUCTION]') + '.');
      if (!sameFigures) { placeholders.push('[EMPLOYER CONTRIBUTION]', '[EMPLOYEE DEDUCTION]'); }
      out.push('');
      out.push('That doesn\'t make sense if the contributions are being calculated as a percentage of our individual salaries.');
    }

    /* ---- what the scheme says ---- */
    if (s.statedBasis !== 'unstated' && !isMissed && !isNotRemitted) {
      out.push('', 'My ' + provider + ' enrolment documentation states:', '');
      out.push(o.schemeQuote
        ? indentQuote(o.schemeQuote)
        : indentQuote('[QUOTE THE WORDING FROM YOUR ENROLMENT LETTER OR SCHEME DOCUMENTATION HERE]'));
      if (!o.schemeQuote) { placeholders.push('[QUOTE FROM YOUR SCHEME DOCUMENTATION]'); }
      out.push('');
      out.push('On that basis I understand my contributions to be ' + s.employerPercent + '% employer and ' +
        s.employeePercent + '% employee, calculated on ' +
        (s.statedBasis === 'base' ? 'my base salary' : 'qualifying earnings') + '.');
      if (s.statedBasis === 'base') {
        out.push('');
        out.push('There is no reference in that documentation to qualifying earnings, banded earnings, or contributions being limited to the statutory minimum earnings band.');
      }
    }

    /* ---- what is actually happening ---- */
    if (isShortfall) {
      var qeRow = rows.find(function (r) { return r.expectedQE.available; }) || rows[0];
      out.push('', 'The figures actually being paid appear to be based on statutory qualifying earnings.', '');
      out.push('For a ' + periodWord + ' pay period, the qualifying earnings calculation is:', '');
      out.push('    ' + money(th.upper) + ' less ' + money(th.lower) + ' = ' + money(qeRow.expectedQE.qualifyingEarnings));
      out.push('    ' + s.employerPercent + '% of ' + money(qeRow.expectedQE.qualifyingEarnings) + ' = ' + money(qeRow.expectedQE.employer));
      out.push('    ' + s.employeePercent + '% of ' + money(qeRow.expectedQE.qualifyingEarnings) + ' = ' + money(qeRow.expectedQE.employeeGross));
      out.push('');
      out.push('With ' + s.rasReliefPercent + '% relief at source, the amount deducted from pay is ' +
        money(qeRow.expectedQE.employeeNet) + '.');
      out.push('');
      out.push('Those are exactly the figures shown on my payslips' +
        (analysis.counts.providerMatched ? ' and in my ' + provider + ' contribution history' : '') + ' each pay period.');

      var aboveCap = rows.every(function (r) { return r.grossPay !== null && r.grossPay > th.upper; });
      if (aboveCap && o.colleaguesCompared) {
        out.push('');
        out.push('Because qualifying earnings are capped at the upper threshold, anyone earning above that threshold ends up with the same contribution figures. That also explains why colleagues on different salaries are seeing exactly the same amounts.');
      } else if (aboveCap) {
        out.push('');
        out.push('Because qualifying earnings are capped at the upper threshold, the contribution stays the same regardless of salary above that point.');
      }
    }

    /* ---- periods with no contribution at all ---- */
    if (missedRows.length) {
      out.push('');
      out.push('No pension contributions were made at all in the following pay period' +
        (missedRows.length === 1 ? '' : 's') + ':');
      out.push('');
      missedRows.forEach(function (r) {
        out.push('    ' + (C.formatDateUK(r.date) || r.period || 'unnamed period') +
          (r.expectedBase.available ? ' - ' + money(r.expectedBase.total) + ' should have been contributed' : ''));
      });
      out.push('');
      out.push('My pay in ' + (missedRows.length === 1 ? 'that period was' : 'those periods was') +
        ' unaffected in every other respect, and I did not opt out or ask to stop contributing.');
    }

    /* ---- salary and the figures ---- */
    out.push('');
    out.push(salaryParagraph(o, analysis, money, placeholders));

    if (hasComparison && analysis.uniformity.uniform) {
      out.push('', comparisonBlock(rows[0], s, money, isShortfall));
    } else if (hasComparison) {
      out.push('', 'My pay has not been the same in every period, so the figures are set out period by period below.', '');
      out.push(perPeriodTable(rows, money));
    }

    if (hasComparison) {
    out.push('');
    out.push('The employee figures above are gross figures, including the basic rate tax relief claimed by ' + provider +
      '. The amount actually deducted from my pay has been ' +
      money(rows[0].actual.employeeNet) +
      (analysis.uniformity.uniform ? ' per pay period, compared with ' + money(rows[0].expectedBase.employeeNet) +
        ' if calculated on the stated basis.' : '.'));
    }

    /* ---- totals ---- */
    out.push('');
    out.push('Across the ' + analysis.counts.analysed + ' pay period' + (analysis.counts.analysed === 1 ? '' : 's') +
      ' from ' + firstDate + ' to ' + lastDate +
      (excludedCount ? ' in which contributions were due' : '') +
      ', I calculate that employer contributions are short by ' +
      money(t.employerShortfall) + ', with a further ' + money(t.employeeGrossShortfall) +
      ' of employee contributions missing from my pension pot.');
    out.push('');
    out.push('The total difference in pension funding is therefore ' + money(t.totalShortfall) +
      (analysis.uniformity.uniform
        ? ', and this increases by ' + money(rows[0].differencesVsBase.total) + ' for each pay period the current calculation continues.'
        : ', and it continues to increase each pay period while the current calculation continues.'));

    if (analysis.counts.providerMatched) {
      out.push('');
      out.push('I have cross-checked my payslips against my ' + provider + ' contribution history and the two agree.');
    }

    /* ---- the asks ---- */
    out.push('', 'Could you please:', '');
    if (isNotRemitted) {
      out.push('1. Confirm what has happened to the ' + money(analysis.totals.notRemitted) +
        ' shown as deducted or contributed on my payslips but not received by ' + provider + '.');
    } else {
      out.push('1. Confirm the earnings basis currently configured for the ' + provider + ' scheme' +
        (s.statedBasis === 'base' ? ', and whether this differs from the base salary basis stated in the enrolment documentation.' : '.'));
    }
    if (isShortfall) {
      out.push('');
      out.push('2. Arrange for future contributions to be calculated using the basis stated in the enrolment documentation.');
      out.push('');
      out.push('3. Arrange payment of the outstanding employer contributions of ' + money(t.employerShortfall) +
        ', together with any investment growth that would reasonably have arisen had those contributions been made at the correct time.');
      out.push('');
      out.push('4. Discuss the employee contribution shortfall with me before making any adjustment to my pay. This shortfall has arisen because of the calculation basis being used, rather than because I chose not to make the contributions. I would therefore like to understand the available options, including whether any correction can be phased or funded by the company, rather than having the full amount taken from one payroll.');
      out.push('');
      out.push('5. Confirm whether other employees are affected. The enrolment documentation appears to be a standard document, and the same issue would apply to anyone whose contributions have been calculated using qualifying earnings rather than the stated basis.');
      if (missedRows.length) {
        out.push('');
        out.push('6. Confirm separately why no contributions were made at all in the pay period' +
          (missedRows.length === 1 ? '' : 's') + ' listed above.');
      }
    } else if (isNotRemitted) {
      out.push('');
      out.push('2. Arrange for those amounts to be paid to the scheme without further delay, together with any investment growth that would reasonably have arisen had they been paid on time.');
      out.push('');
      out.push('3. Confirm whether other employees have been affected in the same pay period' +
        (notRemittedRows.length === 1 ? '' : 's') + ', and whether this has been reported to the scheme trustees.');
      if (analysis.totals.totalShortfall > s.tolerance && analysis.counts.qualifying) {
        out.push('');
        out.push('4. Separately, confirm the earnings basis being used. The contributions that have reached the scheme appear to be calculated on statutory qualifying earnings rather than the basis set out in my enrolment documentation, which is a further difference of ' +
          money(analysis.totals.totalShortfall) + ' across the period.');
      }
    } else if (isMissed) {
      out.push('');
      out.push('2. Confirm why no contributions were made in the pay period' + (missedRows.length === 1 ? '' : 's') +
        ' listed above, and arrange for the outstanding amounts to be paid, together with any investment growth that would reasonably have arisen had they been made at the correct time.');
      out.push('');
      out.push('3. Confirm whether other employees have been affected in the same pay period' +
        (missedRows.length === 1 ? '' : 's') + '.');
    } else if (isUnmatched) {
      out.push('');
      out.push('2. Provide a breakdown showing how the contribution figures on my payslips are arrived at, including the earnings figure used and the percentages applied.');
      out.push('');
      out.push('3. Confirm whether the same calculation applies to other employees.');
    } else {
      out.push('');
      out.push('2. Confirm the earnings figure that the percentages are applied to, and whether any lower or upper threshold is applied.');
      out.push('');
      out.push('3. Confirm whether the same basis applies to other employees.');
    }

    /* ---- entity mismatch ---- */
    if (o.contractEntity && o.providerEntity && o.contractEntity !== o.providerEntity) {
      out.push('');
      out.push('Separately, my employment contract is with ' + o.contractEntity + ', whereas my ' + provider +
        ' records show contributions from ' + o.providerEntity +
        '. I assume this may simply reflect a company name change or payroll arrangement, but please could you confirm this for my records.');
    }

    if (o.colleaguesRaisingSeparately) {
      out.push('');
      out.push('I understand that some colleagues are raising the same issue separately.');
    }

    out.push('');
    out.push('I\'m happy to provide my workings or go through the figures with you or payroll if useful.');
    out.push('');
    out.push('Please could you respond in writing by ' + responseBy + '.');
    out.push('', 'Regards,', '', sender);

    var subject = isShortfall
      ? 'Pension contributions - earnings basis used for calculation'
      : (isNotRemitted ? 'Pension contributions shown on payslips but not received by the scheme'
      : (isMissed ? 'Pension contributions - pay periods with no contributions'
      : (isUnmatched ? 'Pension contributions - request for a calculation breakdown'
                     : 'Pension contributions - confirmation of earnings basis')));

    return {
      canGenerate: true,
      variant: decision.variant,
      reason: decision.reason,
      subject: subject,
      body: out.join('\n'),
      placeholders: placeholders
    };
  }

  function indentQuote(text) {
    return String(text).split(/\n+/).map(function (l) {
      return l.trim() ? '    "' + l.trim().replace(/^"|"$/g, '') + '"' : '';
    }).filter(Boolean).join('\n\n');
  }

  function salaryParagraph(o, analysis, money, placeholders) {
    var rows = analysis.rows;
    var pensionable = rows.length ? rows[0].pensionablePay : null;
    var freq = analysis.thresholds.frequencyLabel.toLowerCase();
    var annual = o.annualSalary || analysis.settings.annualBaseSalary || null;
    // If no annual salary was recorded but pay is the same every period, the
    // annual figure follows from it and the writer can correct it if wrong.
    if (!annual && analysis.uniformity.pensionablePayUniform && pensionable) {
      annual = C.roundMoney(pensionable * analysis.thresholds.periodsPerYear);
    }

    var text = 'My contract states that my gross salary is ' +
      (annual ? money(annual) : fieldOr('', '[ANNUAL SALARY]', placeholders)) + ' per annum, paid ' + freq +
      ' in equal instalments';
    if (o.noVariablePay) { text += ', with no bonus, commission or other variable element'; }
    text += '. My ' + freq + ' base salary is therefore ' +
      (pensionable !== null ? money(pensionable) : fieldOr('', '[PERIOD SALARY]', placeholders)) + '.';
    return text;
  }

  function comparisonBlock(row, s, money, isShortfall) {
    var lines = [];
    lines.push(isShortfall
      ? 'Based on the pension terms I was given, my contributions for each pay period should be:'
      : 'For each pay period the figures are:');
    lines.push('');
    lines.push('    Employer contribution at ' + s.employerPercent + '%: ' + money(row.expectedBase.employer));
    lines.push('    Actually paid: ' + money(row.actual.employer));
    lines.push('    Difference: ' + money(row.differencesVsBase.employer));
    lines.push('');
    lines.push('    Employee gross contribution at ' + s.employeePercent + '%: ' + money(row.expectedBase.employeeGross));
    lines.push('    Actually contributed: ' + money(row.actual.employeeGross));
    lines.push('    Difference: ' + money(row.differencesVsBase.employeeGross));
    lines.push('');
    lines.push('    Total pension contribution: ' + money(row.expectedBase.total));
    lines.push('    Actually contributed: ' + money(row.actual.total));
    lines.push('    Difference: ' + money(row.differencesVsBase.total));
    return lines.join('\n');
  }

  function perPeriodTable(rows, money) {
    var lines = ['    Pay date      Should be      Actually paid   Difference'];
    rows.forEach(function (r) {
      lines.push('    ' + pad(C.formatDateUK(r.date) || '-', 14) +
        pad(money(r.expectedBase.total), 15) +
        pad(money(r.actual.total), 16) +
        money(r.differencesVsBase.total));
    });
    return lines.join('\n');
  }

  function pad(text, width) {
    var t = String(text);
    return t.length >= width ? t + ' ' : t + new Array(width - t.length + 1).join(' ');
  }

  return {
    VARIANT: VARIANT,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    normaliseOptions: normaliseOptions,
    assess: assess,
    compose: compose
  };
}));
