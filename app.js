/*
 * Pension Contribution Audit - user interface
 *
 * All arithmetic lives in calculations.js (window.PensionCalc). This file is
 * responsible for state, storage, rendering and events only.
 */
(function () {
  'use strict';

  var C = window.PensionCalc;
  var STORAGE_KEY = 'pensionContributionAudit.v1';
  var SAVE_DEBOUNCE_MS = 250;

  /* ================================================================== *
   * State
   * ================================================================== */

  var state = {
    schemaVersion: C.SCHEMA_VERSION,
    settings: C.normaliseSettings({}),
    payslips: [],
    ui: { sortKey: 'date', sortDirection: 'asc', expandAll: false }
  };

  var expandedRows = Object.create(null);
  var analysis = null;
  var pendingImport = null;

  /* ================================================================== *
   * Small DOM helpers
   * ================================================================== */

  function $(id) { return document.getElementById(id); }
  function qsa(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(value) {
    if (value === null || value === undefined) { return '—'; }
    return C.formatCurrency(value, state.settings.currency);
  }

  /** Money with an explicit sign, for difference columns. */
  function signedMoney(value) {
    if (value === null || value === undefined) { return '—'; }
    var rounded = C.roundMoney(value);
    if (rounded === 0) { return money(0); }
    return (rounded > 0 ? '+' : '−') + C.formatCurrency(Math.abs(rounded), state.settings.currency);
  }

  /** Percentages, trimmed of pointless trailing zeros, e.g. 4% and 2.35%. */
  function rate(value, dp) {
    if (value === null || value === undefined) { return '—'; }
    return String(parseFloat(Number(value).toFixed(dp === undefined ? 2 : dp))) + '%';
  }

  function currencySymbol() {
    try {
      return (0).toLocaleString('en-GB', { style: 'currency', currency: state.settings.currency })
        .replace(/[\d.,\s]/g, '') || '£';
    } catch (e) { return '£'; }
  }

  /**
   * Classify a difference for consistent colour + wording.
   * Never relies on colour alone: every use also renders the word.
   */
  function classifyDifference(value, tolerance) {
    if (value === null || value === undefined) {
      return { key: 'unknown', word: 'Not known', textClass: 'text-body-secondary', bgClass: 'text-bg-secondary', borderClass: 'border-secondary', icon: 'bi-dash-circle' };
    }
    var tol = tolerance === undefined ? state.settings.tolerance : tolerance;
    var v = C.roundMoney(value);
    if (Math.abs(v) <= tol) {
      return { key: 'match', word: 'Matches', textClass: 'text-success', bgClass: 'text-bg-success', borderClass: 'border-success', icon: 'bi-check-circle-fill' };
    }
    if (v < 0) {
      return { key: 'over', word: 'Overpayment', textClass: 'text-primary', bgClass: 'text-bg-primary', borderClass: 'border-primary', icon: 'bi-arrow-up-circle-fill' };
    }
    if (Math.abs(v) < 1) {
      return { key: 'minor', word: 'Small shortfall', textClass: 'text-warning-emphasis', bgClass: 'text-bg-warning', borderClass: 'border-warning', icon: 'bi-exclamation-circle-fill' };
    }
    return { key: 'short', word: 'Shortfall', textClass: 'text-danger', bgClass: 'text-bg-danger', borderClass: 'border-danger', icon: 'bi-exclamation-triangle-fill' };
  }

  var BASIS_STYLE = {};
  BASIS_STYLE[C.BASIS.BASE] = { bg: 'text-bg-success', icon: 'bi-check-circle-fill' };
  BASIS_STYLE[C.BASIS.QE] = { bg: 'text-bg-warning', icon: 'bi-exclamation-circle-fill' };
  BASIS_STYLE[C.BASIS.NEITHER] = { bg: 'text-bg-danger', icon: 'bi-x-circle-fill' };
  BASIS_STYLE[C.BASIS.INSUFFICIENT] = { bg: 'text-bg-secondary', icon: 'bi-dash-circle' };

  function basisBadge(detection) {
    var style = BASIS_STYLE[detection.basis];
    return '<span class="badge ' + style.bg + '"><i class="bi ' + style.icon + '" aria-hidden="true"></i> ' +
      escapeHtml(detection.label) + '</span>';
  }

  function showToast(message, variant) {
    var container = $('toast-container');
    var wrapper = document.createElement('div');
    wrapper.className = 'toast align-items-center text-bg-' + (variant || 'secondary') + ' border-0';
    wrapper.setAttribute('role', 'status');
    wrapper.innerHTML =
      '<div class="d-flex">' +
      '<div class="toast-body">' + escapeHtml(message) + '</div>' +
      '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>' +
      '</div>';
    container.appendChild(wrapper);
    var toast = new bootstrap.Toast(wrapper, { delay: 4000 });
    wrapper.addEventListener('hidden.bs.toast', function () { wrapper.remove(); });
    toast.show();
  }

  /* ================================================================== *
   * Storage
   * ================================================================== */

  var saveTimer = null;
  var storageAvailable = true;

  function save() {
    if (saveTimer) { clearTimeout(saveTimer); }
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (!storageAvailable) { return; }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          schemaVersion: C.SCHEMA_VERSION,
          savedAt: new Date().toISOString(),
          settings: state.settings,
          payslips: state.payslips,
          ui: state.ui
        }));
      } catch (e) {
        storageAvailable = false;
        showToast('This browser would not let the tool save your data locally. Export a JSON backup before closing the page.', 'danger');
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function load() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageAvailable = false;
      return;
    }
    if (!raw) { return; }
    try {
      var parsed = JSON.parse(raw);
      state.settings = C.normaliseSettings(parsed.settings);
      state.payslips = Array.isArray(parsed.payslips) ? parsed.payslips.map(C.normalisePayslip) : [];
      if (parsed.ui && typeof parsed.ui === 'object') {
        state.ui.sortKey = ['date', 'shortfall', 'basis'].indexOf(parsed.ui.sortKey) >= 0 ? parsed.ui.sortKey : 'date';
        state.ui.sortDirection = parsed.ui.sortDirection === 'desc' ? 'desc' : 'asc';
        state.ui.expandAll = parsed.ui.expandAll === true;
      }
    } catch (e) {
      showToast('The data stored in this browser could not be read and has been ignored.', 'danger');
    }
  }

  /* ================================================================== *
   * Payslip operations
   * ================================================================== */

  function newId() {
    return 'ps-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function chronological(payslips) {
    return payslips.slice().sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || ''));
    });
  }

  function lastPayslip() {
    var sorted = chronological(state.payslips.filter(function (p) { return p.date; }));
    if (sorted.length) { return sorted[sorted.length - 1]; }
    return state.payslips.length ? state.payslips[state.payslips.length - 1] : null;
  }

  function suggestedPeriodPay() {
    var freq = C.getFrequency(state.settings.payFrequency);
    if (!state.settings.annualBaseSalary) { return null; }
    return C.roundMoney(state.settings.annualBaseSalary / freq.periodsPerYear);
  }

  function addPayslip(options) {
    var opts = options || {};
    var previous = lastPayslip();
    var date = '';
    if (previous && previous.date) {
      date = C.addPayPeriod(previous.date, state.settings.payFrequency);
    } else {
      date = C.toIsoDate(new Date());
    }

    var row = {
      id: newId(),
      date: date,
      period: '',
      grossPay: null,
      pensionablePay: null,
      actualEmployeeNet: null,
      actualEmployer: null,
      notes: ''
    };

    if (opts.duplicate && previous) {
      row.period = previous.period;
      row.grossPay = previous.grossPay;
      row.pensionablePay = previous.pensionablePay;
      row.actualEmployeeNet = previous.actualEmployeeNet;
      row.actualEmployer = previous.actualEmployer;
      row.notes = previous.notes;
    } else if (previous) {
      // Carry the pay figures forward; leave the contribution fields blank.
      row.grossPay = previous.grossPay;
      row.pensionablePay = previous.pensionablePay;
    } else {
      row.grossPay = suggestedPeriodPay();
    }

    state.payslips.push(row);
    save();
    render();
    focusRow(row.id);
    return row;
  }

  function focusRow(id) {
    var input = document.querySelector('[data-row-id="' + id + '"][data-field="date"]');
    if (input) {
      input.focus();
      if (typeof input.scrollIntoView === 'function') {
        input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  function deleteRow(id) {
    var index = state.payslips.findIndex(function (p) { return p.id === id; });
    if (index < 0) { return; }
    var removed = state.payslips[index];
    var label = removed.date ? C.formatDateUK(removed.date) : (removed.period || 'this payslip');
    state.payslips.splice(index, 1);
    delete expandedRows[id];
    save();
    render();
    showToast('Deleted the payslip for ' + label + '.', 'secondary');
  }

  function duplicateRow(id) {
    var index = state.payslips.findIndex(function (p) { return p.id === id; });
    if (index < 0) { return; }
    var source = state.payslips[index];
    var copy = Object.assign({}, source, {
      id: newId(),
      date: source.date ? C.addPayPeriod(source.date, state.settings.payFrequency) : ''
    });
    state.payslips.splice(index + 1, 0, copy);
    save();
    render();
    focusRow(copy.id);
  }

  /* ================================================================== *
   * Rendering: summary
   * ================================================================== */

  function renderSummary() {
    var t = analysis.totals;
    var counts = analysis.counts;

    $('stat-gross').textContent = counts.total ? money(t.grossPay) : '—';
    $('stat-range').textContent = describeCoverage(counts.total);
    $('stat-pensionable').textContent = 'Pensionable pay: ' + (counts.total ? money(t.pensionablePay) : '—');
    $('stat-expected-employer').textContent = counts.total ? money(t.expectedEmployer) : '—';
    $('stat-actual-employer').textContent = counts.total ? money(t.actualEmployer) : '—';
    $('stat-expected-total').textContent = counts.total ? money(t.expectedTotal) : '—';
    $('stat-actual-total').textContent = counts.total ? money(t.actualTotal) : '—';

    $('stat-actual-employer-rate').textContent = describeEffectiveRate(
      t.effectiveEmployerRate, t.targetEmployerRate, 'As recorded on your payslips');
    $('stat-actual-total-rate').textContent = describeEffectiveRate(
      t.effectiveTotalRate, t.targetTotalRate, 'Employer + derived employee gross');

    renderDifferenceCard('employer-shortfall', t.employerShortfall, counts.total,
      'employer contributions');
    renderDifferenceCard('total-shortfall', t.totalShortfall, counts.total,
      'total pension funding');

    $('stat-payslip-count').textContent = 'Payslips analysed: ' + counts.total;
    $('stat-basis-counts').innerHTML = [
      basisCountLine('bi-check-circle-fill', 'text-success', 'Matches base salary', counts.base),
      basisCountLine('bi-exclamation-circle-fill', 'text-warning-emphasis', 'Matches qualifying earnings', counts.qualifying),
      basisCountLine('bi-x-circle-fill', 'text-danger', 'Does not match either', counts.neither),
      counts.insufficient ? basisCountLine('bi-dash-circle', 'text-body-secondary', 'Insufficient data', counts.insufficient) : ''
    ].join('');

    var badges = [];
    if (state.settings.employeeReference) {
      badges.push('<span class="badge text-bg-light border">' +
        '<i class="bi bi-person" aria-hidden="true"></i> ' + escapeHtml(state.settings.employeeReference) + '</span>');
    }
    badges.push('<span class="badge text-bg-light border">' +
      '<i class="bi bi-calendar3" aria-hidden="true"></i> ' + escapeHtml(analysis.thresholds.frequencyLabel) + ' pay</span>');
    if (counts.incomplete) {
      badges.push('<span class="badge text-bg-warning">' +
        '<i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i> ' + counts.incomplete +
        ' row' + (counts.incomplete === 1 ? '' : 's') + ' incomplete</span>');
    }
    $('summary-badges').innerHTML = badges.join('');
  }

  /**
   * Says how many pay periods the headline total covers, and over what dates,
   * so a total can always be reconciled against the number of payslips.
   */
  function describeCoverage(count) {
    if (!count) { return 'No payslips entered yet'; }
    var label = count + ' payslip' + (count === 1 ? '' : 's');
    var dated = analysis.rows.filter(function (r) { return r.date; });
    if (!dated.length) { return label; }
    var first = C.formatDateUK(dated[0].date);
    var last = C.formatDateUK(dated[dated.length - 1].date);
    return label + (first === last ? ' on ' + first : ' from ' + first + ' to ' + last);
  }

  /**
   * "Effectively 2% of pensionable pay · stated 4%" - the rate the money
   * actually paid works out at, next to the rate it is supposed to be.
   */
  function describeEffectiveRate(effective, target, fallback) {
    if (effective === null || effective === undefined) { return fallback; }
    return 'Effectively ' + rate(effective) + ' of pensionable pay · stated ' + rate(target);
  }

  function basisCountLine(icon, textClass, label, count) {
    return '<li class="' + (count ? textClass : 'text-body-secondary') + '">' +
      '<i class="bi ' + icon + '" aria-hidden="true"></i> ' + escapeHtml(label) + ': <strong>' + count + '</strong></li>';
  }

  function renderDifferenceCard(idSuffix, value, hasRows, what) {
    var card = $('card-' + idSuffix);
    var valueEl = $('stat-' + idSuffix);
    var labelEl = $('stat-' + idSuffix + '-label');
    var borderClasses = ['border-secondary', 'border-success', 'border-danger', 'border-warning', 'border-primary'];
    borderClasses.forEach(function (c) { card.classList.remove(c); });

    if (!hasRows) {
      valueEl.textContent = '—';
      valueEl.className = 'stat-value';
      labelEl.textContent = 'No payslips entered yet';
      card.classList.add('border-secondary');
      return;
    }

    var cls = classifyDifference(value);
    card.classList.add(cls.borderClass);
    valueEl.textContent = money(Math.abs(C.roundMoney(value)));
    valueEl.className = 'stat-value ' + cls.textClass;
    var wording = {
      match: 'Actual ' + what + ' match the base salary basis',
      over: 'Overpayment: more went in than the base salary basis gives',
      minor: 'Small shortfall in ' + what + ' against the base salary basis',
      short: 'Shortfall in ' + what + ' against the base salary basis',
      unknown: 'Not enough data'
    };
    labelEl.innerHTML = '<i class="bi ' + cls.icon + '" aria-hidden="true"></i> ' + escapeHtml(wording[cls.key]);
  }

  /* ================================================================== *
   * Rendering: settings summary strip
   * ================================================================== */

  function renderSettingsSummary() {
    var s = state.settings;
    var th = analysis.thresholds;
    var items = [
      { label: 'Pay frequency', value: th.frequencyLabel + ' (' + th.periodsPerYear + ' periods per year)' },
      { label: 'Contribution rates', value: 'Employer ' + s.employerPercent + '% · Employee ' + s.employeePercent + '% gross' },
      { label: 'Relief at Source', value: s.rasReliefPercent + '% basic-rate relief' },
      { label: 'Annual qualifying earnings band', value: money(th.annualLower) + ' to ' + money(th.annualUpper) },
      {
        label: 'Pay-period thresholds used',
        value: money(th.lower) + ' to ' + money(th.upper),
        note: th.source === 'custom'
          ? 'Published pay-period figures (derived would be ' + money(th.derivedLower) + ' to ' + money(th.derivedUpper) + ')'
          : 'Derived from the annual band ÷ ' + th.periodsPerYear
      },
      {
        label: 'Pensionable pay default',
        value: s.useGrossAsPensionable ? 'Gross pay, unless overridden' : 'Entered per payslip',
        note: 'Comparison tolerance ' + money(s.tolerance)
      }
    ];

    $('settings-summary').innerHTML = items.map(function (item) {
      return '<div class="col-6 col-lg-4 col-xl-2">' +
        '<div class="stat-label mb-1">' + escapeHtml(item.label) + '</div>' +
        '<div class="fw-semibold">' + escapeHtml(item.value) + '</div>' +
        (item.note ? '<div class="stat-sub">' + escapeHtml(item.note) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  /* ================================================================== *
   * Rendering: payslip entry table
   * ================================================================== */

  function moneyInput(row, field, placeholder, label) {
    var value = row[field];
    return '<input type="number" class="form-control form-control-sm num-input" step="0.01" min="0" inputmode="decimal"' +
      ' data-row-id="' + escapeHtml(row.id) + '" data-field="' + field + '"' +
      ' value="' + (value === null || value === undefined ? '' : escapeHtml(String(value))) + '"' +
      (placeholder ? ' placeholder="' + escapeHtml(placeholder) + '"' : '') +
      ' aria-label="' + escapeHtml(label) + '">';
  }

  function renderEntryTable() {
    var body = $('entry-body');
    var empty = $('entry-empty');

    if (!state.payslips.length) {
      body.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    body.innerHTML = state.payslips.map(function (row) {
      var dateLabel = row.date ? C.formatDateUK(row.date) : 'undated payslip';
      var inheritedPlaceholder = state.settings.useGrossAsPensionable && row.grossPay !== null && row.grossPay !== undefined
        ? Number(row.grossPay).toFixed(2) : '';

      return '<tr data-row="' + escapeHtml(row.id) + '">' +
        '<td><input type="date" class="form-control form-control-sm" data-row-id="' + escapeHtml(row.id) + '"' +
          ' data-field="date" value="' + escapeHtml(row.date || '') + '" aria-label="Pay date"></td>' +
        '<td><input type="text" class="form-control form-control-sm" data-row-id="' + escapeHtml(row.id) + '"' +
          ' data-field="period" value="' + escapeHtml(row.period || '') + '" maxlength="60"' +
          ' placeholder="e.g. August 2026" aria-label="Pay period or description"></td>' +
        '<td>' + moneyInput(row, 'grossPay', '0.00', 'Gross pay for ' + dateLabel) + '</td>' +
        '<td>' + moneyInput(row, 'pensionablePay', inheritedPlaceholder, 'Base or pensionable pay for ' + dateLabel) + '</td>' +
        '<td>' + moneyInput(row, 'actualEmployeeNet', '0.00', 'Actual employee pension deduction for ' + dateLabel) + '</td>' +
        '<td>' + moneyInput(row, 'actualEmployer', '0.00', 'Actual employer pension contribution for ' + dateLabel) + '</td>' +
        '<td><input type="text" class="form-control form-control-sm" data-row-id="' + escapeHtml(row.id) + '"' +
          ' data-field="notes" value="' + escapeHtml(row.notes || '') + '" maxlength="200"' +
          ' placeholder="Optional" aria-label="Notes for ' + escapeHtml(dateLabel) + '"></td>' +
        '<td class="text-end">' +
          '<div class="btn-group btn-group-sm" role="group" aria-label="Actions for ' + escapeHtml(dateLabel) + '">' +
          '<button type="button" class="btn btn-outline-secondary" data-action="duplicate" data-row-id="' + escapeHtml(row.id) + '"' +
            ' title="Duplicate this payslip" aria-label="Duplicate the payslip for ' + escapeHtml(dateLabel) + '">' +
            '<i class="bi bi-copy" aria-hidden="true"></i></button>' +
          '<button type="button" class="btn btn-outline-danger" data-action="delete" data-row-id="' + escapeHtml(row.id) + '"' +
            ' title="Delete this payslip" aria-label="Delete the payslip for ' + escapeHtml(dateLabel) + '">' +
            '<i class="bi bi-trash3" aria-hidden="true"></i></button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  /** Keep the inherited-value placeholder in step without redrawing the row. */
  function refreshInheritedPlaceholder(rowId) {
    var row = state.payslips.find(function (p) { return p.id === rowId; });
    var input = document.querySelector('[data-row-id="' + rowId + '"][data-field="pensionablePay"]');
    if (!row || !input) { return; }
    input.placeholder = state.settings.useGrossAsPensionable && row.grossPay !== null && row.grossPay !== undefined
      ? Number(row.grossPay).toFixed(2) : '0.00';
  }

  /* ================================================================== *
   * Rendering: analysis table
   * ================================================================== */

  function diffCell(value) {
    if (value === null || value === undefined) { return '<td class="num text-body-secondary">—</td>'; }
    var cls = classifyDifference(value);
    return '<td class="num ' + cls.textClass + '" title="' + escapeHtml(cls.word) + '">' +
      '<i class="bi ' + cls.icon + '" aria-hidden="true"></i> ' + signedMoney(value) +
      '<span class="visually-hidden"> (' + escapeHtml(cls.word) + ')</span></td>';
  }

  function renderAnalysisTable() {
    var body = $('analysis-body');
    var foot = $('analysis-foot');
    var empty = $('analysis-empty');

    if (!analysis.rows.length) {
      body.innerHTML = '';
      foot.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    var sorted = C.sortAnalysedRows(analysis.rows, state.ui.sortKey, state.ui.sortDirection);

    body.innerHTML = sorted.map(function (row) {
      var isOpen = state.ui.expandAll || expandedRows[row.id] === true;
      var dateLabel = row.date ? C.formatDateUK(row.date) : '(no date)';
      var detailId = 'detail-' + row.id;

      var summaryRow = '<tr>' +
        '<td class="pe-0">' +
          '<button type="button" class="btn btn-sm btn-link p-0 expand-btn" data-action="toggle-detail"' +
          ' data-row-id="' + escapeHtml(row.id) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '"' +
          ' aria-controls="' + detailId + '" aria-label="Show the full calculation for ' + escapeHtml(dateLabel) + '">' +
          '<i class="bi bi-chevron-right chevron" aria-hidden="true"></i></button>' +
        '</td>' +
        '<td><span class="fw-semibold">' + escapeHtml(dateLabel) + '</span>' +
          (row.period ? '<span class="d-block text-body-secondary">' + escapeHtml(row.period) + '</span>' : '') +
          (row.warnings.length ? '<span class="d-block small row-warning" title="' + escapeHtml(row.warnings.join(' ')) + '">' +
            '<i class="bi bi-exclamation-triangle" aria-hidden="true"></i> Incomplete</span>' : '') +
        '</td>' +
        '<td class="num">' + money(row.grossPay) + '</td>' +
        '<td class="num">' + money(row.pensionablePay) +
          (row.pensionableIsInherited ? '<span class="visually-hidden"> (taken from gross pay)</span>' : '') + '</td>' +
        '<td class="num">' + money(row.expectedBase.employer) + '</td>' +
        '<td class="num">' + money(row.actual.employer) + '</td>' +
        diffCell(row.differencesVsBase.employer) +
        '<td class="num">' + money(row.expectedBase.employeeGross) + '</td>' +
        '<td class="num">' + money(row.actual.employeeGross) + '</td>' +
        diffCell(row.differencesVsBase.employeeGross) +
        '<td class="num">' + money(row.expectedBase.total) + '</td>' +
        '<td class="num">' + money(row.actual.total) + '</td>' +
        diffCell(row.differencesVsBase.total) +
        '<td>' + basisBadge(row.detection) + '</td>' +
      '</tr>';

      var detailRow = '<tr class="detail-row' + (isOpen ? '' : ' d-none') + '" id="' + detailId + '" data-detail-for="' + escapeHtml(row.id) + '">' +
        '<td colspan="14">' + renderDetailPanel(row) + '</td></tr>';

      return summaryRow + detailRow;
    }).join('');

    var t = analysis.totals;
    foot.innerHTML = '<tr>' +
      '<td></td><td>Totals (' + analysis.counts.total + ')</td>' +
      '<td class="num">' + money(t.grossPay) + '</td>' +
      '<td class="num">' + money(t.pensionablePay) + '</td>' +
      '<td class="num">' + money(t.expectedEmployer) + '</td>' +
      '<td class="num">' + money(t.actualEmployer) + '</td>' +
      diffCell(t.employerShortfall) +
      '<td class="num">' + money(t.expectedEmployeeGross) + '</td>' +
      '<td class="num">' + money(t.actualEmployeeGross) + '</td>' +
      diffCell(t.employeeGrossShortfall) +
      '<td class="num">' + money(t.expectedTotal) + '</td>' +
      '<td class="num">' + money(t.actualTotal) + '</td>' +
      diffCell(t.totalShortfall) +
      '<td></td></tr>';
  }

  function line(label, value, extraClass) {
    return '<div class="detail-line' + (extraClass ? ' ' + extraClass : '') + '">' +
      '<span class="label">' + label + '</span>' +
      '<span class="value">' + value + '</span></div>';
  }

  function renderDetailPanel(row) {
    var s = state.settings;
    var th = row.thresholds;
    var base = row.expectedBase;
    var qe = row.expectedQE;
    var actual = row.actual;
    var d = row.differencesVsBase;
    var reliefRate = s.rasReliefPercent;

    var baseCard =
      '<div class="card"><div class="card-header py-2 bg-body">' +
        '<span class="fw-semibold">Expected if based on Base Salary</span>' +
        '<span class="d-block formula">' + (base.available
          ? 'Pensionable pay ' + money(base.earnings) + (row.pensionableIsInherited ? ' (taken from gross pay)' : '')
          : 'No base/pensionable pay entered') + '</span>' +
      '</div><div class="card-body py-2">' +
        (base.available ? (
          line('Employer &times; ' + s.employerPercent + '%', money(base.employer)) +
          line('Employee gross &times; ' + s.employeePercent + '%', money(base.employeeGross)) +
          line('&nbsp;&nbsp;of which deducted from pay', money(base.employeeNet)) +
          line('&nbsp;&nbsp;of which tax relief at ' + reliefRate + '%', money(base.taxRelief)) +
          line('Total into pension', money(base.total), 'total')
        ) : '<p class="small text-body-secondary mb-0">Enter a base/pensionable pay figure for this payslip, or switch on ' +
            '&ldquo;use gross pay as base/pensionable pay&rdquo; in Settings.</p>') +
      '</div></div>';

    var qeCard =
      '<div class="card"><div class="card-header py-2 bg-body">' +
        '<span class="fw-semibold">Expected if based on Qualifying Earnings</span>' +
        '<span class="d-block formula">' + (qe.available
          ? 'max(0, min(' + money(row.grossPay) + ', ' + money(th.upper) + ') &minus; ' + money(th.lower) + ') = ' +
            money(qe.qualifyingEarnings)
          : 'No gross pay entered') + '</span>' +
      '</div><div class="card-body py-2">' +
        (qe.available ? (
          line('Qualifying earnings', money(qe.qualifyingEarnings)) +
          line('Employer &times; ' + s.employerPercent + '%', money(qe.employer)) +
          line('Employee gross &times; ' + s.employeePercent + '%', money(qe.employeeGross)) +
          line('&nbsp;&nbsp;of which deducted from pay', money(qe.employeeNet)) +
          line('&nbsp;&nbsp;of which tax relief at ' + reliefRate + '%', money(qe.taxRelief)) +
          line('Total into pension', money(qe.total), 'total')
        ) : '<p class="small text-body-secondary mb-0">Enter a gross pay figure for this payslip.</p>') +
      '</div></div>';

    var actualCard =
      '<div class="card"><div class="card-header py-2 bg-body">' +
        '<span class="fw-semibold">Payslip actually shows</span>' +
        '<span class="d-block formula">Gross employee contribution = deduction &divide; (1 &minus; ' +
          (reliefRate / 100) + ')</span>' +
      '</div><div class="card-body py-2">' +
        line('Employer contribution', money(actual.employer)) +
        line('Employee deduction from pay', money(actual.employeeNet)) +
        line('Derived employee gross contribution', money(actual.employeeGross)) +
        line('&nbsp;&nbsp;of which relief claimed by the scheme', money(actual.taxRelief)) +
        line('Total into pension', money(actual.total), 'total') +
        (row.effectiveRates.available ? (
          '<p class="formula mt-2 mb-1">Effective rates against pensionable pay of ' +
            money(row.effectiveRates.earnings) + '</p>' +
          effectiveLine('Employer', row.effectiveRates.employer, row.effectiveRates.targetEmployer) +
          effectiveLine('Employee gross', row.effectiveRates.employeeGross, row.effectiveRates.targetEmployeeGross) +
          effectiveLine('Combined', row.effectiveRates.total, row.effectiveRates.targetTotal)
        ) : '') +
        (actual.isComplete ? '' :
          '<p class="small row-warning mt-2 mb-0"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> ' +
          'Missing payslip figures are treated as nil in the comparison.</p>') +
      '</div></div>';

    var detection = row.detection;
    var detectionStyle = BASIS_STYLE[detection.basis];
    var detectionText;
    if (detection.basis === C.BASIS.BASE) {
      detectionText = 'The payslip figures match a calculation on your base/pensionable pay' +
        (detection.ambiguous ? '. On this row both bases happen to produce identical figures.' : '.');
    } else if (detection.basis === C.BASIS.QE) {
      detectionText = 'The payslip appears to use statutory qualifying earnings (' + money(qe.qualifyingEarnings) +
        ') rather than your full pensionable pay.';
    } else if (detection.basis === C.BASIS.NEITHER) {
      detectionText = 'The payslip figures do not match either basis within the ' + money(s.tolerance) + ' tolerance.';
      var parts = [];
      if (detection.base.employerMatch || detection.qualifying.employerMatch) {
        parts.push('the employer contribution matches the ' +
          (detection.base.employerMatch ? 'base salary' : 'qualifying earnings') + ' basis');
      }
      if (detection.base.employeeMatch || detection.qualifying.employeeMatch) {
        parts.push('the employee deduction matches the ' +
          (detection.base.employeeMatch ? 'base salary' : 'qualifying earnings') + ' basis');
      }
      if (parts.length) { detectionText += ' However, ' + parts.join(', and ') + '.'; }
    } else {
      detectionText = 'Not enough information on this row to detect a basis. Enter the actual figures from the payslip.';
    }

    var differenceCard =
      '<div class="card"><div class="card-header py-2 bg-body">' +
        '<span class="fw-semibold">Difference against base salary terms</span>' +
        '<span class="d-block formula">Expected on base salary &minus; actual</span>' +
      '</div><div class="card-body py-2">' +
        (base.available ? (
          differenceLine('Employer', d.employer) +
          differenceLine('Employee gross contribution', d.employeeGross) +
          differenceLine('Employee deduction from pay', d.employeeNet) +
          differenceLine('Tax relief', d.taxRelief) +
          differenceLine('Overall pension funding', d.total, 'total') +
          '<div class="detail-line"><span class="label">Cumulative to this pay date</span>' +
            '<span class="value">' + signedMoney(row.cumulativeShortfall) + '</span></div>' +
          (qe.available
            ? '<div class="detail-line"><span class="label">For comparison, against the qualifying ' +
              'earnings basis</span><span class="value">' + signedMoney(row.differencesVsQE.total) + '</span></div>'
            : '')
        ) : '<p class="small text-body-secondary mb-0">A base salary comparison needs a pensionable pay figure.</p>') +
      '</div></div>';

    return '<div class="detail-panel">' +
      '<div class="alert alert-light border d-flex align-items-start gap-2 py-2 mb-3" role="note">' +
        '<span class="badge ' + detectionStyle.bg + ' flex-shrink-0"><i class="bi ' + detectionStyle.icon +
          '" aria-hidden="true"></i> ' + escapeHtml(detection.label) + '</span>' +
        '<span class="small">' + detectionText + ' Thresholds used for this pay period: ' +
          money(th.lower) + ' to ' + money(th.upper) + ' (' + (th.source === 'custom' ? 'published pay-period figures' :
          'derived from the annual band') + ').</span>' +
      '</div>' +
      '<div class="row g-3">' +
        '<div class="col-12 col-xl-3">' + baseCard + '</div>' +
        '<div class="col-12 col-xl-3">' + qeCard + '</div>' +
        '<div class="col-12 col-xl-3">' + actualCard + '</div>' +
        '<div class="col-12 col-xl-3">' + differenceCard + '</div>' +
      '</div>' +
      (row.notes ? '<p class="small text-body-secondary mt-3 mb-0"><i class="bi bi-sticky" aria-hidden="true"></i> ' +
        escapeHtml(row.notes) + '</p>' : '') +
    '</div>';
  }

  /** One "effective x% (stated y%)" line, worded as well as coloured. */
  function effectiveLine(label, effective, target) {
    if (effective === null || effective === undefined) {
      return line(label + ' rate', '<span class="text-body-secondary">—</span>');
    }
    var gap = C.roundMoney(target - effective);
    var cls = Math.abs(gap) <= 0.005 ? 'text-success' : (gap > 0 ? 'text-danger' : 'text-primary');
    var suffix = Math.abs(gap) <= 0.005
      ? ' <span class="fw-normal">as stated</span>'
      : ' <span class="fw-normal">vs ' + rate(target) + ' stated</span>';
    return line(label + ' rate', '<span class="' + cls + '">' + rate(effective) + suffix + '</span>');
  }

  function differenceLine(label, value, extraClass) {
    if (value === null || value === undefined) {
      return line(label, '<span class="text-body-secondary">—</span>', extraClass);
    }
    var cls = classifyDifference(value);
    var wording = cls.key === 'match' ? 'matches' : (cls.key === 'over' ? 'overpayment' : 'shortfall');
    return line(label,
      '<span class="' + cls.textClass + '"><i class="bi ' + cls.icon + '" aria-hidden="true"></i> ' +
      money(Math.abs(C.roundMoney(value))) + ' <span class="fw-normal">' + wording + '</span></span>',
      extraClass);
  }

  /* ================================================================== *
   * Rendering: charts (inline SVG, no chart library)
   * ================================================================== */

  var CHART_COLOURS = {
    base: '#0d6efd',
    qe: '#fd7e14',
    actual: '#6f42c1'
  };

  function niceCeiling(value) {
    if (value <= 0) { return 1; }
    var magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      var candidate = steps[i] * magnitude;
      if (value <= candidate) { return candidate; }
    }
    return 10 * magnitude;
  }

  function shortDate(row) {
    if (row.date) {
      var uk = C.formatDateUK(row.date);
      return uk.slice(0, 6) + uk.slice(8);
    }
    return row.period ? row.period.slice(0, 8) : '—';
  }

  function renderCharts() {
    var rows = C.sortAnalysedRows(analysis.rows, 'date', 'asc');
    $('chart-legend').innerHTML = [
      { colour: CHART_COLOURS.base, label: 'Expected — base salary' },
      { colour: CHART_COLOURS.qe, label: 'Expected — qualifying earnings' },
      { colour: CHART_COLOURS.actual, label: 'Actual from payslip' }
    ].map(function (item) {
      return '<span><span class="swatch" style="background:' + item.colour + '"></span>' + escapeHtml(item.label) + '</span>';
    }).join('');

    renderBarChart(rows);
    renderCumulativeChart(rows);
  }

  function chartWidth(containerId, needed) {
    var container = $(containerId);
    var available = container ? container.clientWidth : 0;
    if (!available) { available = 600; }
    return Math.max(available - 2, needed);
  }

  function renderBarChart(rows) {
    var host = $('chart-bars');
    if (!rows.length) {
      host.innerHTML = '<p class="chart-empty">Add payslips to see the comparison.</p>';
      return;
    }

    var padding = { top: 12, right: 12, bottom: 42, left: 68 };
    var barWidth = 14;
    var barGap = 4;
    var groupGap = 22;
    var groupWidth = barWidth * 3 + barGap * 2 + groupGap;
    var plotHeight = 190;
    var height = plotHeight + padding.top + padding.bottom;
    var neededWidth = padding.left + padding.right + groupWidth * rows.length;
    var width = chartWidth('chart-bars', neededWidth);
    var plotWidth = width - padding.left - padding.right;
    var slot = plotWidth / rows.length;

    var maxValue = 0;
    rows.forEach(function (r) {
      maxValue = Math.max(maxValue, r.expectedBase.total || 0, r.expectedQE.total || 0, r.actual.total || 0);
    });
    var top = niceCeiling(maxValue);

    function y(value) { return padding.top + plotHeight - (value / top) * plotHeight; }

    var parts = [];
    for (var i = 0; i <= 4; i++) {
      var value = top * i / 4;
      var yy = y(value);
      parts.push('<line class="chart-gridline" x1="' + padding.left + '" y1="' + yy + '" x2="' + (width - padding.right) + '" y2="' + yy + '"></line>');
      parts.push('<text class="chart-tick" x="' + (padding.left - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' +
        escapeHtml(money(value)) + '</text>');
    }

    rows.forEach(function (row, index) {
      var groupCentre = padding.left + slot * index + slot / 2;
      var startX = groupCentre - (barWidth * 3 + barGap * 2) / 2;
      var series = [
        { value: row.expectedBase.total, colour: CHART_COLOURS.base, name: 'Expected (base salary)' },
        { value: row.expectedQE.total, colour: CHART_COLOURS.qe, name: 'Expected (qualifying earnings)' },
        { value: row.actual.total, colour: CHART_COLOURS.actual, name: 'Actual' }
      ];
      series.forEach(function (item, s) {
        var value = item.value || 0;
        var barHeight = Math.max(value > 0 ? 1 : 0, padding.top + plotHeight - y(value));
        var x = startX + s * (barWidth + barGap);
        parts.push('<rect x="' + x + '" y="' + (padding.top + plotHeight - barHeight) + '" width="' + barWidth +
          '" height="' + barHeight + '" fill="' + item.colour + '" rx="2">' +
          '<title>' + escapeHtml(shortDate(row) + ' — ' + item.name + ': ' + money(item.value)) + '</title></rect>');
      });
      parts.push('<text class="chart-tick" x="' + groupCentre + '" y="' + (padding.top + plotHeight + 16) +
        '" text-anchor="middle">' + escapeHtml(shortDate(row)) + '</text>');
    });

    parts.push('<line class="chart-zeroline" x1="' + padding.left + '" y1="' + (padding.top + plotHeight) +
      '" x2="' + (width - padding.right) + '" y2="' + (padding.top + plotHeight) + '"></line>');

    var label = 'Bar chart comparing expected and actual total pension contributions for ' + rows.length +
      ' pay period' + (rows.length === 1 ? '' : 's') + '.';
    host.innerHTML = '<svg role="img" aria-label="' + escapeHtml(label) + '" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '">' + parts.join('') + '</svg>';
  }

  function renderCumulativeChart(rows) {
    var host = $('chart-cumulative');
    if (!rows.length) {
      host.innerHTML = '<p class="chart-empty">Add payslips to see the cumulative difference.</p>';
      return;
    }

    var padding = { top: 12, right: 16, bottom: 42, left: 68 };
    var plotHeight = 190;
    var height = plotHeight + padding.top + padding.bottom;
    var neededWidth = padding.left + padding.right + Math.max(1, rows.length - 1) * 48;
    var width = chartWidth('chart-cumulative', neededWidth);
    var plotWidth = width - padding.left - padding.right;

    var values = rows.map(function (r) { return r.cumulativeShortfall || 0; });
    var maxValue = Math.max.apply(null, values.concat([0]));
    var minValue = Math.min.apply(null, values.concat([0]));
    var top = niceCeiling(Math.max(Math.abs(maxValue), Math.abs(minValue)));
    var upper = maxValue > 0 ? top : 0;
    var lower = minValue < 0 ? -top : 0;
    if (upper === lower) { upper = 1; }

    function y(value) {
      return padding.top + plotHeight - ((value - lower) / (upper - lower)) * plotHeight;
    }
    function x(index) {
      return rows.length === 1 ? padding.left + plotWidth / 2 : padding.left + (plotWidth * index) / (rows.length - 1);
    }

    var parts = [];
    for (var i = 0; i <= 4; i++) {
      var value = lower + (upper - lower) * i / 4;
      var yy = y(value);
      parts.push('<line class="chart-gridline" x1="' + padding.left + '" y1="' + yy + '" x2="' + (width - padding.right) + '" y2="' + yy + '"></line>');
      parts.push('<text class="chart-tick" x="' + (padding.left - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' +
        escapeHtml(money(value)) + '</text>');
    }
    if (lower < 0) {
      parts.push('<line class="chart-zeroline" x1="' + padding.left + '" y1="' + y(0) + '" x2="' + (width - padding.right) + '" y2="' + y(0) + '"></line>');
    }

    var points = rows.map(function (row, index) { return x(index) + ',' + y(row.cumulativeShortfall || 0); });
    var areaPath = 'M' + x(0) + ',' + y(0) + ' L' + points.join(' L') + ' L' + x(rows.length - 1) + ',' + y(0) + ' Z';

    parts.push('<path d="' + areaPath + '" fill="rgba(220,53,69,0.12)"></path>');
    parts.push('<polyline points="' + points.join(' ') + '" fill="none" stroke="#dc3545" stroke-width="2" stroke-linejoin="round"></polyline>');

    rows.forEach(function (row, index) {
      parts.push('<circle cx="' + x(index) + '" cy="' + y(row.cumulativeShortfall || 0) + '" r="3.5" fill="#dc3545">' +
        '<title>' + escapeHtml(shortDate(row) + ' — cumulative ' + signedMoney(row.cumulativeShortfall)) + '</title></circle>');
      var showLabel = rows.length <= 12 || index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 8) === 0;
      if (showLabel) {
        parts.push('<text class="chart-tick" x="' + x(index) + '" y="' + (padding.top + plotHeight + 16) +
          '" text-anchor="middle">' + escapeHtml(shortDate(row)) + '</text>');
      }
    });

    var last = rows[rows.length - 1].cumulativeShortfall || 0;
    var label = 'Line chart of the cumulative difference between expected and actual pension funding, ending at ' +
      signedMoney(last) + '.';
    host.innerHTML = '<svg role="img" aria-label="' + escapeHtml(label) + '" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '">' + parts.join('') + '</svg>';
  }

  /* ================================================================== *
   * Rendering: higher-rate relief panel
   * ================================================================== */

  function renderHigherRate() {
    var toggle = $('toggle-higher-rate');
    var body = $('higher-rate-body');
    toggle.checked = state.settings.showHigherRatePanel;
    body.hidden = !state.settings.showHigherRatePanel;
    if (!state.settings.showHigherRatePanel) { return; }

    var rateInput = $('marginal-rate');
    if (document.activeElement !== rateInput) {
      rateInput.value = state.settings.marginalTaxRatePercent;
    }

    var out = $('higher-rate-output');
    var t = analysis.totals;
    if (!analysis.counts.total || !t.actualEmployeeGross) {
      out.innerHTML = '<p class="text-body-secondary mb-0">Enter payslip figures to see an estimate.</p>';
      return;
    }

    var actualRelief = C.calculateHigherRateRelief(t.actualEmployeeGross, state.settings);
    var expectedRelief = C.calculateHigherRateRelief(t.expectedEmployeeGross, state.settings);

    if (!actualRelief.applicable) {
      out.innerHTML = '<p class="mb-0"><i class="bi bi-info-circle" aria-hidden="true"></i> Your marginal rate of ' +
        state.settings.marginalTaxRatePercent + '% is not above the Relief at Source rate of ' +
        state.settings.rasReliefPercent + '%, so there is no additional personal tax relief to estimate.</p>';
      return;
    }

    out.innerHTML =
      '<div class="row g-3">' +
        '<div class="col-12 col-sm-6 col-lg-4">' +
          '<div class="border rounded p-2 h-100">' +
            '<div class="stat-label mb-1">Gross employee contributions made</div>' +
            '<div class="fw-semibold">' + money(t.actualEmployeeGross) + '</div>' +
            '<div class="stat-sub">Deductions ' + money(t.actualEmployeeNet) + ' plus scheme relief ' +
              money(t.actualTaxRelief) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="col-12 col-sm-6 col-lg-4">' +
          '<div class="border rounded p-2 h-100">' +
            '<div class="stat-label mb-1">Estimated further personal relief</div>' +
            '<div class="fw-semibold text-primary">' + money(actualRelief.amount) + '</div>' +
            '<div class="stat-sub">' + actualRelief.extraRatePercent + ' percentage points above the ' +
              state.settings.rasReliefPercent + '% already claimed by the scheme</div>' +
          '</div>' +
        '</div>' +
        '<div class="col-12 col-lg-4">' +
          '<div class="border rounded p-2 h-100">' +
            '<div class="stat-label mb-1">If contributions had been on base salary</div>' +
            '<div class="fw-semibold">' + money(expectedRelief.amount) + '</div>' +
            '<div class="stat-sub">On gross employee contributions of ' + money(t.expectedEmployeeGross) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  /* ================================================================== *
   * Master render
   * ================================================================== */

  function recalculate() {
    analysis = C.analyseAll(chronological(state.payslips), state.settings);
  }

  function render(options) {
    var opts = options || {};
    recalculate();
    if (opts.skipEntryTable !== true) { renderEntryTable(); }
    renderSummary();
    renderSettingsSummary();
    renderAnalysisTable();
    renderCharts();
    renderHigherRate();
    $('btn-duplicate-last').disabled = state.payslips.length === 0;
  }

  /* Tooltips are only used on static chrome, so they are initialised once.
     Dynamic table cells use plain title attributes instead. */
  function initTooltips() {
    qsa('[data-bs-toggle="tooltip"]').forEach(function (el) {
      new bootstrap.Tooltip(el, { container: 'body' });
    });
  }

  /* ================================================================== *
   * Settings form
   * ================================================================== */

  function populateSettingsForm() {
    var s = state.settings;
    var freqSelect = $('set-frequency');
    if (!freqSelect.options.length) {
      freqSelect.innerHTML = C.PAY_FREQUENCIES.map(function (f) {
        return '<option value="' + f.id + '">' + escapeHtml(f.label) + '</option>';
      }).join('');
    }
    $('set-reference').value = s.employeeReference;
    $('set-annual-salary').value = s.annualBaseSalary || '';
    freqSelect.value = s.payFrequency;
    $('set-employer-pct').value = s.employerPercent;
    $('set-employee-pct').value = s.employeePercent;
    $('set-ras-pct').value = s.rasReliefPercent;
    $('set-qe-lower').value = s.qeAnnualLower;
    $('set-qe-upper').value = s.qeAnnualUpper;
    $('set-custom-thresholds').checked = s.useCustomPeriodThresholds;
    $('set-period-lower').value = s.customPeriodLower;
    $('set-period-upper').value = s.customPeriodUpper;
    $('set-tolerance').value = s.tolerance;
    $('set-currency').value = s.currency;
    $('set-use-gross').checked = s.useGrossAsPensionable;
    updateSettingsFormState();
  }

  function updateSettingsFormState() {
    var thresholds = C.calculatePeriodThresholds(state.settings);
    $('derived-thresholds').textContent = money(thresholds.derivedLower) + ' to ' + money(thresholds.derivedUpper);
    var custom = $('set-custom-thresholds').checked;
    $('set-period-lower').disabled = !custom;
    $('set-period-upper').disabled = !custom;
    qsa('.currency-symbol').forEach(function (el) { el.textContent = currencySymbol(); });
    $('salary-symbol').textContent = currencySymbol();
  }

  function readSettingsForm() {
    state.settings = C.normaliseSettings({
      employeeReference: $('set-reference').value.trim(),
      annualBaseSalary: $('set-annual-salary').value,
      payFrequency: $('set-frequency').value,
      employerPercent: $('set-employer-pct').value,
      employeePercent: $('set-employee-pct').value,
      rasReliefPercent: $('set-ras-pct').value,
      qeAnnualLower: $('set-qe-lower').value,
      qeAnnualUpper: $('set-qe-upper').value,
      useCustomPeriodThresholds: $('set-custom-thresholds').checked,
      customPeriodLower: $('set-period-lower').value,
      customPeriodUpper: $('set-period-upper').value,
      tolerance: $('set-tolerance').value,
      currency: $('set-currency').value,
      useGrossAsPensionable: $('set-use-gross').checked,
      marginalTaxRatePercent: state.settings.marginalTaxRatePercent,
      showHigherRatePanel: state.settings.showHigherRatePanel
    });
    updateSettingsFormState();
    save();
    render();
  }

  /* ================================================================== *
   * Export / import
   * ================================================================== */

  function todayStamp() {
    return C.toIsoDate(new Date());
  }

  function downloadFile(filename, contents, mime) {
    var blob = new Blob([contents], { type: mime });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function buildExportPayload() {
    return {
      schemaVersion: C.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      application: 'Pension Contribution Audit',
      settings: state.settings,
      payslips: state.payslips.map(function (p) {
        return {
          id: p.id,
          date: p.date,
          period: p.period,
          grossPay: p.grossPay,
          pensionablePay: p.pensionablePay,
          actualEmployeeNet: p.actualEmployeeNet,
          actualEmployer: p.actualEmployer,
          notes: p.notes
        };
      })
    };
  }

  function exportJson() {
    downloadFile('pension-audit-' + todayStamp() + '.json',
      JSON.stringify(buildExportPayload(), null, 2), 'application/json');
    showToast('Exported ' + state.payslips.length + ' payslip' + (state.payslips.length === 1 ? '' : 's') + ' as JSON.', 'success');
  }

  function csvCell(value) {
    if (value === null || value === undefined) { return ''; }
    var text = String(value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function csvRate(value) {
    return value === null || value === undefined ? '' : Number(value).toFixed(4);
  }

  function csvMoney(value) {
    return value === null || value === undefined ? '' : C.roundMoney(value).toFixed(2);
  }

  function exportCsv() {
    var rows = C.sortAnalysedRows(analysis.rows, state.ui.sortKey, state.ui.sortDirection);
    var headers = [
      'Pay date', 'Pay period', 'Gross pay', 'Pensionable pay',
      'Period QE lower threshold', 'Period QE upper threshold', 'Qualifying earnings',
      'Expected employer (base)', 'Expected employee gross (base)', 'Expected employee deduction (base)',
      'Expected tax relief (base)', 'Expected total (base)',
      'Expected employer (QE)', 'Expected employee gross (QE)', 'Expected employee deduction (QE)', 'Expected total (QE)',
      'Actual employer', 'Actual employee deduction', 'Actual employee gross', 'Actual relief claimed', 'Actual total',
      'Employer difference', 'Employee gross difference', 'Employee deduction difference', 'Tax relief difference',
      'Total difference', 'Cumulative total difference', 'Difference type',
      'Effective employer %', 'Effective employee gross %', 'Effective combined %',
      'Stated employer %', 'Stated employee gross %',
      'Detected basis', 'Notes'
    ];

    var lines = [headers.map(csvCell).join(',')];
    rows.forEach(function (row) {
      var cls = classifyDifference(row.differencesVsBase.total);
      lines.push([
        C.formatDateUK(row.date), row.period,
        csvMoney(row.grossPay), csvMoney(row.pensionablePay),
        csvMoney(row.thresholds.lower), csvMoney(row.thresholds.upper), csvMoney(row.expectedQE.qualifyingEarnings),
        csvMoney(row.expectedBase.employer), csvMoney(row.expectedBase.employeeGross), csvMoney(row.expectedBase.employeeNet),
        csvMoney(row.expectedBase.taxRelief), csvMoney(row.expectedBase.total),
        csvMoney(row.expectedQE.employer), csvMoney(row.expectedQE.employeeGross), csvMoney(row.expectedQE.employeeNet),
        csvMoney(row.expectedQE.total),
        csvMoney(row.actual.employer), csvMoney(row.actual.employeeNet), csvMoney(row.actual.employeeGross),
        csvMoney(row.actual.taxRelief), csvMoney(row.actual.total),
        csvMoney(row.differencesVsBase.employer), csvMoney(row.differencesVsBase.employeeGross),
        csvMoney(row.differencesVsBase.employeeNet), csvMoney(row.differencesVsBase.taxRelief),
        csvMoney(row.differencesVsBase.total), csvMoney(row.cumulativeShortfall), cls.word,
        csvRate(row.effectiveRates.employer), csvRate(row.effectiveRates.employeeGross),
        csvRate(row.effectiveRates.total),
        csvRate(row.effectiveRates.targetEmployer), csvRate(row.effectiveRates.targetEmployeeGross),
        row.detection.label, row.notes
      ].map(csvCell).join(','));
    });

    var t = analysis.totals;
    lines.push([
      'Totals', analysis.counts.total + ' payslips',
      csvMoney(t.grossPay), csvMoney(t.pensionablePay), '', '', '',
      csvMoney(t.expectedEmployer), csvMoney(t.expectedEmployeeGross), csvMoney(t.expectedEmployeeNet),
      csvMoney(t.expectedTaxRelief), csvMoney(t.expectedTotal),
      csvMoney(t.qeEmployer), csvMoney(t.qeEmployeeGross), '', csvMoney(t.qeTotal),
      csvMoney(t.actualEmployer), csvMoney(t.actualEmployeeNet), csvMoney(t.actualEmployeeGross),
      csvMoney(t.actualTaxRelief), csvMoney(t.actualTotal),
      csvMoney(t.employerShortfall), csvMoney(t.employeeGrossShortfall), csvMoney(t.employeeNetShortfall),
      csvMoney(t.taxReliefShortfall), csvMoney(t.totalShortfall), '',
      classifyDifference(t.totalShortfall).word,
      csvRate(t.effectiveEmployerRate), csvRate(t.effectiveEmployeeGrossRate), csvRate(t.effectiveTotalRate),
      csvRate(t.targetEmployerRate), csvRate(t.targetEmployeeGrossRate),
      '', ''
    ].map(csvCell).join(','));

    // BOM so that spreadsheet software reads the currency text as UTF-8.
    downloadFile('pension-audit-' + todayStamp() + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    showToast('Exported the analysis as CSV. JSON remains the format to use for backups.', 'success');
  }

  function handleImportFile(file) {
    if (!file) { return; }
    var reader = new FileReader();
    reader.onerror = function () {
      showImportError(['The file could not be read.']);
    };
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        showImportError(['The file is not valid JSON. ' + e.message]);
        return;
      }
      var validation = C.validateImport(parsed);
      if (!validation.ok) {
        showImportError(validation.errors);
        return;
      }
      pendingImport = validation.data;
      showImportPreview(file.name, parsed);
    };
    reader.readAsText(file);
  }

  function showImportError(errors) {
    pendingImport = null;
    $('import-preview').innerHTML =
      '<dt class="col-12 text-danger mb-2"><i class="bi bi-x-octagon" aria-hidden="true"></i> This file cannot be imported</dt>' +
      '<dd class="col-12"><ul class="mb-0">' + errors.map(function (e) {
        return '<li>' + escapeHtml(e) + '</li>';
      }).join('') + '</ul></dd>';
    $('btn-confirm-import').disabled = true;
    bootstrap.Modal.getOrCreateInstance($('importModal')).show();
  }

  function showImportPreview(filename, parsed) {
    var payslips = pendingImport.payslips;
    var dates = payslips.map(function (p) { return p.date; }).filter(Boolean).sort();
    var rows = [
      ['File', filename],
      ['Schema version', String(parsed.schemaVersion)],
      ['Exported', parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString('en-GB') : 'Not recorded'],
      ['Payslips in file', String(payslips.length)],
      ['Date range', dates.length ? C.formatDateUK(dates[0]) + ' to ' + C.formatDateUK(dates[dates.length - 1]) : 'None recorded'],
      ['Currently in this browser', state.payslips.length + ' payslip' + (state.payslips.length === 1 ? '' : 's')]
    ];
    $('import-preview').innerHTML = rows.map(function (r) {
      return '<dt class="col-5 col-sm-4 text-body-secondary fw-normal">' + escapeHtml(r[0]) + '</dt>' +
        '<dd class="col-7 col-sm-8">' + escapeHtml(r[1]) + '</dd>';
    }).join('');
    $('btn-confirm-import').disabled = false;
    bootstrap.Modal.getOrCreateInstance($('importModal')).show();
  }

  function applyImport() {
    if (!pendingImport) { return; }
    state.settings = pendingImport.settings;
    state.payslips = pendingImport.payslips;
    expandedRows = Object.create(null);
    pendingImport = null;
    save();
    populateSettingsForm();
    render();
    bootstrap.Modal.getOrCreateInstance($('importModal')).hide();
    showToast('Imported ' + state.payslips.length + ' payslip' + (state.payslips.length === 1 ? '' : 's') + '.', 'success');
  }

  function clearAll() {
    state.settings = C.normaliseSettings({});
    state.payslips = [];
    state.ui = { sortKey: 'date', sortDirection: 'asc', expandAll: false };
    expandedRows = Object.create(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* storage unavailable */ }
    $('sort-key').value = state.ui.sortKey;
    $('sort-direction').value = state.ui.sortDirection;
    populateSettingsForm();
    render();
    bootstrap.Modal.getOrCreateInstance($('clearModal')).hide();
    showToast('All data has been deleted from this browser.', 'secondary');
  }

  /* ================================================================== *
   * Events
   * ================================================================== */

  function bindEvents() {
    /* --- payslip entry table --- */
    var entryBody = $('entry-body');

    entryBody.addEventListener('input', function (event) {
      var target = event.target;
      var id = target.getAttribute('data-row-id');
      var field = target.getAttribute('data-field');
      if (!id || !field) { return; }
      var row = state.payslips.find(function (p) { return p.id === id; });
      if (!row) { return; }

      if (field === 'date' || field === 'period' || field === 'notes') {
        row[field] = target.value;
      } else {
        row[field] = C.toNumberOrNull(target.value);
      }
      if (field === 'grossPay') { refreshInheritedPlaceholder(id); }

      save();
      // The entry table is deliberately left alone so that focus, caret
      // position and partially typed values survive the recalculation.
      render({ skipEntryTable: true });
    });

    entryBody.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-action]');
      if (!button) { return; }
      var id = button.getAttribute('data-row-id');
      if (button.getAttribute('data-action') === 'delete') {
        deleteRow(id);
      } else if (button.getAttribute('data-action') === 'duplicate') {
        duplicateRow(id);
      }
    });

    $('btn-add-payslip').addEventListener('click', function () { addPayslip(); });
    $('btn-add-first').addEventListener('click', function () { addPayslip(); });
    $('btn-duplicate-last').addEventListener('click', function () {
      if (!state.payslips.length) { return; }
      addPayslip({ duplicate: true });
    });

    /* --- analysis table --- */
    $('analysis-body').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-action="toggle-detail"]');
      if (!button) { return; }
      var id = button.getAttribute('data-row-id');
      var open = button.getAttribute('aria-expanded') === 'true';
      var detail = document.querySelector('[data-detail-for="' + id + '"]');
      if (state.ui.expandAll && open) {
        // Collapsing one row leaves the rest open, so remember them first.
        analysis.rows.forEach(function (r) { expandedRows[r.id] = true; });
        state.ui.expandAll = false;
        updateExpandAllButton();
        save();
      }
      button.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (detail) { detail.classList.toggle('d-none', open); }
      expandedRows[id] = !open;
    });

    $('sort-key').addEventListener('change', function () {
      state.ui.sortKey = this.value;
      save();
      render({ skipEntryTable: true });
    });
    $('sort-direction').addEventListener('change', function () {
      state.ui.sortDirection = this.value;
      save();
      render({ skipEntryTable: true });
    });

    $('btn-expand-all').addEventListener('click', function () {
      state.ui.expandAll = !state.ui.expandAll;
      if (!state.ui.expandAll) { expandedRows = Object.create(null); }
      updateExpandAllButton();
      save();
      render({ skipEntryTable: true });
    });

    /* --- settings --- */
    qsa('#settings-form input, #settings-form select').forEach(function (field) {
      field.addEventListener('change', readSettingsForm);
      if (field.type === 'text' || field.type === 'number') {
        field.addEventListener('input', readSettingsForm);
      }
    });

    $('btn-reset-settings').addEventListener('click', function () {
      state.settings = C.normaliseSettings({});
      populateSettingsForm();
      save();
      render();
      showToast('Settings restored to their defaults. Your payslips were not changed.', 'secondary');
    });

    /* --- higher-rate panel --- */
    $('toggle-higher-rate').addEventListener('change', function () {
      state.settings.showHigherRatePanel = this.checked;
      save();
      renderHigherRate();
    });
    $('marginal-rate').addEventListener('input', function () {
      state.settings.marginalTaxRatePercent = C.normaliseSettings(
        Object.assign({}, state.settings, { marginalTaxRatePercent: this.value })).marginalTaxRatePercent;
      save();
      renderHigherRate();
    });

    /* --- export / import / clear --- */
    $('btn-export-json').addEventListener('click', exportJson);
    $('btn-export-csv').addEventListener('click', exportCsv);
    $('btn-export-before-import').addEventListener('click', exportJson);
    $('btn-export-before-clear').addEventListener('click', exportJson);

    $('btn-import').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', function () {
      handleImportFile(this.files && this.files[0]);
      this.value = '';
    });
    $('btn-confirm-import').addEventListener('click', applyImport);

    $('clearModal').addEventListener('show.bs.modal', function () {
      $('clear-confirm-check').checked = false;
      $('btn-confirm-clear').disabled = true;
      $('clear-summary').textContent = 'This browser currently holds ' + state.payslips.length +
        ' payslip' + (state.payslips.length === 1 ? '' : 's') + ' and your saved settings.';
    });
    $('clear-confirm-check').addEventListener('change', function () {
      $('btn-confirm-clear').disabled = !this.checked;
    });
    $('btn-confirm-clear').addEventListener('click', clearAll);

    /* --- tests --- */
    $('btn-run-tests').addEventListener('click', runTests);

    /* --- charts respond to layout changes --- */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) { clearTimeout(resizeTimer); }
      resizeTimer = setTimeout(function () { renderCharts(); }, 150);
    });
  }

  function updateExpandAllButton() {
    var button = $('btn-expand-all');
    button.setAttribute('aria-pressed', state.ui.expandAll ? 'true' : 'false');
    button.innerHTML = state.ui.expandAll
      ? '<i class="bi bi-arrows-collapse" aria-hidden="true"></i> Collapse all'
      : '<i class="bi bi-arrows-expand" aria-hidden="true"></i> Expand all';
  }

  function runTests() {
    var output = $('test-output');
    if (typeof window.runPensionAuditTests !== 'function') {
      output.innerHTML = '<div class="alert alert-warning mb-0">The test file could not be loaded.</div>';
      return;
    }
    var result = window.runPensionAuditTests({ log: true });
    var failures = result.results.filter(function (r) { return !r.ok; });
    var header = failures.length
      ? '<div class="alert alert-danger mb-2"><i class="bi bi-x-octagon" aria-hidden="true"></i> ' +
        result.passed + ' passed, ' + result.failed + ' failed.</div>'
      : '<div class="alert alert-success mb-2"><i class="bi bi-check-circle" aria-hidden="true"></i> All ' +
        result.passed + ' calculation checks passed.</div>';
    var detail = '<details><summary class="small">Show all ' + result.total + ' checks</summary>' +
      '<ul class="small mt-2 mb-0">' + result.results.map(function (r) {
        return '<li class="' + (r.ok ? 'text-success' : 'text-danger') + '">' +
          (r.ok ? '✓ ' : '✗ ') + escapeHtml(r.name) +
          (r.detail ? ' <span class="text-body-secondary">— ' + escapeHtml(r.detail) + '</span>' : '') + '</li>';
      }).join('') + '</ul></details>';
    output.innerHTML = header + detail;
  }

  /* ================================================================== *
   * Start
   * ================================================================== */

  function init() {
    load();
    populateSettingsForm();
    $('sort-key').value = state.ui.sortKey;
    $('sort-direction').value = state.ui.sortDirection;
    updateExpandAllButton();
    bindEvents();
    render();
    initTooltips();
    if (!storageAvailable) {
      showToast('Local storage is not available in this browser context, so your work will not be saved between visits.', 'warning');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
