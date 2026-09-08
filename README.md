# Pension Contribution Audit

A single-page tool for checking UK workplace pension contributions — in particular NEST-style
schemes using **Relief at Source (RAS)** — against the pay figures they are supposed to be
calculated on.

For each payslip it shows, side by side:

1. what the contributions **should** have been if calculated on your stated base/pensionable pay;
2. what was **actually** deducted and contributed according to the payslip;
3. what the figures would have been on **statutory qualifying earnings**; and
4. the resulting monthly and cumulative shortfall or overpayment.

It then tells you which of those two bases your payslip appears to be using.

---

## Privacy and data storage

**Your data stays in this browser. Nothing entered into this application is uploaded or
transmitted anywhere.**

- There is no backend, no database server, no analytics and no telemetry.
- Everything you type is held in the browser's `localStorage` under the key
  `pensionContributionAudit.v1`, on the machine and browser profile you are using.
- The only network requests the page makes at all are for the Bootstrap stylesheet, icon font and
  JavaScript bundle from a public CDN. No data of yours is sent with them.
- Clearing your browser's site data, or using **Clear All Data**, deletes everything permanently.
- Different browsers, profiles and devices each keep their own separate copy. Use
  **Export JSON** / **Import JSON** to move data between them.

Because storage is per-browser, private/incognito windows will usually discard the data when
closed, and some corporate policies block local storage entirely. If storage is unavailable the
tool warns you and continues to work for the current session only.

## How to run it

No build step, no package installation, no server-side code.

**Simplest:** double-click `index.html`, or open it in a browser via *File → Open*.

Everything works from `file://` — entering data, calculating, charts, local storage, JSON and CSV
export and import. Two caveats worth knowing:

- Some browsers treat each `file://` page as its own origin, so local storage may not persist
  between visits as reliably as it does over HTTP. Serving the folder is more predictable.
- You need an internet connection the first time so the browser can fetch Bootstrap from the CDN.
  Once cached it will work offline. To make it fully self-contained, download
  `bootstrap.min.css`, `bootstrap.bundle.min.js` and the `bootstrap-icons` font files into the
  project folder and repoint the `<link>` and `<script>` tags in `index.html` at the local copies
  (remove the `integrity`/`crossorigin` attributes if you do).

**Serving it locally** (recommended), from the project folder:

```sh
python3 -m http.server 8000     # then open http://localhost:8000
# or
npx serve .
```

## How to deploy it as a static site

Copy `index.html`, `app.js`, `calculations.js`, `styles.css` (and optionally `tests.js`) to any
static host. There is nothing to configure and nothing to run server-side.

- **nginx** — put the files in the site root, e.g. `root /var/www/pension-audit;` with
  `index index.html;`.
- **Apache** — drop the files into the `DocumentRoot`.
- **GitHub Pages** — commit them to the repository, then enable Pages for the branch and folder.
- **S3-style object storage** — upload the files, enable static website hosting and set
  `index.html` as the index document.

Serve it over HTTPS if you host it anywhere shared. The application itself is stateless, so
caching and CDNs are safe; there is no session or user data on the server at any point.

`tests.js` is only needed for the "Run calculation self-tests" button. The application works
without it, and the button reports politely if it is missing.

## Backup and restore (JSON)

**Export JSON** downloads a file named `pension-audit-YYYY-MM-DD.json` containing:

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-09-04T09:15:00.000Z",
  "application": "Pension Contribution Audit",
  "settings": { "...": "..." },
  "payslips": [ { "id": "...", "date": "2026-08-31", "period": "August 2026",
                  "grossPay": 0, "pensionablePay": null,
                  "actualEmployeeNet": 0, "actualEmployer": 0, "notes": "" } ]
}
```

Only **raw inputs and settings** are stored. Every calculated figure is recomputed on import, so a
backup stays valid if the calculation model or your settings change.

**Import JSON** validates the file before touching anything: JSON syntax, schema version,
the presence of a `payslips` array, date format (`YYYY-MM-DD`) and every numeric field. If the
file is unusable you get a plain-English list of what is wrong and nothing is changed. If it is
valid you get a preview (file name, export date, number of payslips, date range) and an explicit
warning that importing **replaces the data currently stored in this browser**, with the option to
export your current data first. Nothing is overwritten silently.

**Export CSV** produces one row per payslip with all inputs and calculated values plus a totals
row, for use in a spreadsheet. JSON remains the authoritative backup format — CSV is not
importable.

## The calculation model

All arithmetic lives in `calculations.js` as pure functions with no DOM access, so it can be read,
tested and reused independently. Money is rounded to whole pence, half away from zero, at each
step, via a single `roundMoney()` helper.

Let **P** = base/pensionable pay for the period, **G** = gross pay for the period, and let the
configured rates be employer `e%`, employee `c%`, and RAS relief `r%`.

**1. Expected on base salary**

```
employer            = P × e%
employee gross      = P × c%
employee deduction  = employee gross × (1 − r)
tax relief          = employee gross − employee deduction
total into pension  = employer + employee gross
```

**2. Actual, derived from the payslip**

The payslip gives the employer contribution and the *net* employee deduction. Under Relief at
Source the deduction comes out of taxed pay and the provider reclaims basic-rate relief, so:

```
employee gross      = deduction ÷ (1 − r)
relief claimed      = employee gross − deduction
total into pension  = employer + employee gross
```

At 20% relief, **£40 deducted from pay is a £50 gross pension contribution**, the £10 difference
being the relief the provider reclaims.

**3. Expected on qualifying earnings**

```
qualifying earnings = max(0, min(G, upper threshold) − lower threshold)
```

Pay below the lower threshold produces zero; pay above the upper threshold is capped. The same
percentages and relief rate are then applied to that banded figure.

**4. Differences** — calculated as *expected on base salary* − *actual*, separately for the
employer contribution, employee gross contribution, employee deduction, tax relief and overall
pension funding. A positive figure is a **shortfall**; a negative figure is labelled an
**overpayment**, never shown as a negative shortfall.

**5. Effective contribution rates** — what was actually paid, restated as a percentage of
base/pensionable pay, alongside the rates the scheme states:

```
effective rate = actual contribution ÷ pensionable pay × 100
```

Shown for the whole period on the summary cards, per payslip in the row detail, and as columns in
the CSV export. Where a scheme calculates on the qualifying earnings band while the stated rates
are expressed against salary, the effective rate is materially lower than the headline one for
anyone paid above the upper threshold.

**6. Verdict** — the detected basis is compared with the basis your scheme *says* it uses, which
you set in **Settings → What does your scheme say contributions are calculated on?** This is what
turns "which basis is this?" into "is this right?". If the figures match what you were told, the
tool says so plainly and offers nothing further to do.

**7. Detected basis** — the actual employer contribution and employee deduction are compared,
within the configured tolerance (default £0.02), against both bases, giving
*Matches Base Salary*, *Matches Qualifying Earnings*, *Does Not Match Either* or
*Insufficient Data*. Only the components actually entered are tested, and the row detail says
which component matched what.

## Guided help

The tool is meant to be usable by someone who has never looked at a pension calculation before.
**Settings → Show guided help and tooltips** is on by default and adds:

- A question mark beside every field and column, explaining in plain English what to type and where
  to find it on a payslip.
- A four-step "new to this?" panel before any payslips have been entered.
- A "what this means and what to do next" note under the overall finding, which changes with the
  result — including telling you plainly when there is nothing to do.

Turn it off for a cleaner screen once you no longer need it. It changes nothing about the
calculations, and the setting is remembered.

## Pay periods with no contributions

Not every pay period is part of an audit. Each row has a **Status**:

- **Contributing** (the default) — a normal period, compared against the stated basis and counted
  towards the detected basis.
- **None due** — no contribution was due: before you were enrolled, during a postponement period,
  after opting out, during a contribution break, or a period of unpaid leave. These are left out of
  the totals and the detected basis entirely, and shown greyed out.
- **Missed** — a contribution *was* due and nothing was paid. The full expected amount counts as a
  shortfall, but the period is excluded from basis detection, because a nil contribution is not
  evidence of any earnings basis.

This distinction matters more than it looks. A zero period left as "contributing" matches neither
basis, which drags the overall finding to "pay periods use different bases" and inflates the
shortfall — turning a clear result into a muddled one. The tool flags any period with no
contributions and asks you to classify it rather than guessing, because only you know whether it was
an opt-out or an error.

Where periods are marked as missed, the generated email lists them by date and asks about them
separately from the earnings basis, since a missing contribution is a different problem from one
calculated on the wrong figure.

## Cross-checking against your pension provider

Switch on **Settings → Record pension provider figures for cross-checking** to add three optional
columns: the employee amount, employer amount and tax relief your provider says it received. Each
row's detail then reports whether they agree with your payslip, within the same tolerance.

The tax relief column is the useful one. The tool derives your gross employee contribution from the
net deduction, and the relief your provider reclaimed from HMRC should equal the difference. If it
does, the derived figure is confirmed by a second, independent source. Relief is normally claimed a
month or two after the contribution, so leaving it blank for recent periods is treated as pending
rather than as a mismatch.

### Contributions deducted but never received

There is a difference the tool draws automatically, because it changes what you are dealing with:

- **Nothing was deducted from your pay and nothing reached the scheme.** Mark the period **Missed**.
  A contribution that was due was not made.
- **Your payslip shows a deduction, but the scheme records nothing received.** Enter `0` in the
  provider columns for that period. The tool flags this separately as money shown on your payslip
  that is not in your pension pot, reports the total, and leads the generated email with it.

A blank provider figure means "not recorded yet" and is treated as pending. An explicit `0` means
nothing arrived. That distinction is what makes the detection possible, so enter the zero deliberately.

The second case is the more serious one. Contributions taken from an employee's pay have to be passed
to the scheme within statutory time limits, and a material failure to do so is something scheme
trustees are expected to report. Where the tool detects it, it takes precedence over any question
about the earnings basis: the verdict leads with it, the email leads with it, and any basis
discrepancy is raised afterwards as a secondary point.

## Drafting an email to your employer

Where the figures do not match the basis your scheme states, the tool can draft an email setting out
what you were told, what is actually being paid, the arithmetic behind it, the totals, and what you
are asking for. It is generated in your browser from your own figures; nothing is transmitted.

It is deliberately conservative:

- **It refuses to write a complaint when there isn't one.** If your contributions match the basis
  your scheme states — including where that basis is qualifying earnings — it says so and generates
  nothing. The same applies if you are being paid more than your scheme states, or if the actual
  figures are missing.
- **It changes what it writes to fit the finding.** A clear shortfall produces a letter setting out
  the discrepancy and asking for correction and arrears. Figures matching neither basis produce a
  request for a breakdown. An unrecorded scheme basis produces a request to confirm which basis
  applies. None of them allege more than the figures support.
- **It adapts to changing pay.** If your pay was not the same in every period it sets the figures out
  period by period rather than quoting a single monthly figure that would be wrong.
- **It names no employer or provider you have not entered**, and marks anything it cannot know with
  a bracketed placeholder, listing what is still outstanding.

Fill in the recipient, your name, when you were enrolled, the wording from your own scheme
documentation, and a response date. Then copy it to the clipboard or download it as a text file.

Read it and put it in your own words before sending. It sets out the figures; the judgement about
whether and how to raise them is yours.

## Changing the qualifying earnings thresholds

Open **Settings → Qualifying earnings thresholds**. Nothing is hard-coded as permanent.

- **Annual lower / upper threshold** — default £6,240 and £50,270. Edit these for the tax year you
  are auditing.
- **Use published pay-period thresholds** — when on, the pay-period figures you enter are used
  directly instead of dividing the annual band by the number of pay periods. This is on by default
  with the monthly figures £520.00 and £4,189.00, because payroll and pension systems normally use
  the published rounded pay-period thresholds rather than annual ÷ 12 (which gives £4,189.17).
  Switch it off to derive the thresholds from the annual band instead.

The thresholds actually used are always displayed in the "Calculation settings in use" panel and
repeated inside each row's detail, so it is never ambiguous which figures produced a result.

The contribution percentages, the Relief at Source rate, the pay frequency, the comparison
tolerance and the currency are all editable in the same place.

## Higher-rate tax relief

The optional higher-rate panel is **informational only** and is deliberately excluded from every
shortfall figure. Under Relief at Source the scheme normally claims basic-rate relief only; if you
pay tax above the basic rate, further relief is personal tax relief you generally have to claim
yourself. It is not contributed by your employer and does not offset any employer shortfall.

## Tests

The calculation engine has a test suite covering threshold banding edges, rounding, RAS derivation,
basis detection and tolerance, effective rates, provider reconciliation, the verdict logic, import
validation, sorting, and the letter composer — including that it refuses to generate a complaint
when the figures match the stated basis.

```sh
node tests.js
```

Or press **Run calculation self-tests** in the "How the calculations work" section of the page,
which runs exactly the same suite in the browser.

## Project structure

```
index.html        markup, Bootstrap layout, modals, help text
app.js            state, storage, rendering, events (no formulae)
calculations.js   pure calculation engine (also usable in Node)
letter.js         pure letter composer (also usable in Node)
tests.js          calculation and letter tests (Node and in-browser)
styles.css        presentation on top of Bootstrap
README.md         this file
```

## Disclaimer

This tool is intended to assist with checking pension contribution calculations. It does not
provide legal, financial or tax advice. Pension scheme rules, earnings definitions and tax
treatment can vary. Check your employment terms, pension scheme documentation, payroll records and
current statutory guidance.

A difference between the figures shown here and your payslip does not automatically mean anything
has gone wrong, and does not in itself amount to an unlawful deduction or a breach of contract.
Employers and schemes may legitimately use a different definition of pensionable pay, a different
earnings basis, salary sacrifice, a different tax relief method, or contribution caps. The purpose
of this tool is to make the basis being used visible so that you can ask an informed question.

Statutory thresholds, contribution minimums and tax rates change from time to time. Every figure
used here is editable in Settings and should be checked against current guidance before you rely
on it.
