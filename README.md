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

**6. Detected basis** — the actual employer contribution and employee deduction are compared,
within the configured tolerance (default £0.02), against both bases, giving
*Matches Base Salary*, *Matches Qualifying Earnings*, *Does Not Match Either* or
*Insufficient Data*. Only the components actually entered are tested, and the row detail says
which component matched what.

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

The calculation engine has a test suite covering the worked examples above, threshold banding
edges, rounding, RAS derivation, basis detection and tolerance, import validation and sorting.

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
tests.js          calculation tests (Node and in-browser)
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
