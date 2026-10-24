# VehicleFactbook

Recalls, complaint counts, investigations, EPA fuel economy, and NHTSA star ratings for a passenger vehicle's model year. The figures come from U.S. government files. Complaint counts are not sales-adjusted, and the site does not label a vehicle avoid, best, worst, or reliable.

Operated by Three Pines Company LLC. Not affiliated with any government agency or automaker. There are no affiliate links and no ads.

## Build

Node 22, Python 3 (standard library only).

```bash
npm ci
npm test
npm run build
npm run check:links
npm run check:html
npm run check:third-party
```

`npm run build` copies `data/site/lookup.json` and `data/site/configs.json` into `public/data/` for the calculators, then builds the static site. The published site is `https://vehiclefactbook.com` with a trailing slash on every URL.

Refresh the government files locally only when you intend to replace `data/`:

```bash
bash scripts/fetch.sh
python3 scripts/guard.py          # last line is unchanged or changed
python3 scripts/ncap.py --latest 3
python3 scripts/build_data.py
npm run validate:data
```

The weekly workflow does this on its own. It commits only when the zip hashes differ from `data/sources.json` and the aggregated JSON actually changes.

## Counts in this build

Taken from the files dated 2026-10-23 (NHTSA) and 2026-09-29 (EPA):

| Figure | Count |
|---|---|
| EPA rows, model year 2000 and newer | 32,430 |
| EPA make names / models / model years | 87 / 1,025 / 8,158 |
| Published makes / models / model years | 86 / 1,016 / 8,158 |
| Model years matched to an NHTSA name | 6,815 |
| Model years with no NHTSA name match | 1,343 |
| By-year pages (at least 3 matched years) | 640 |
| Vehicle campaigns, 2010 and later | 13,712 |
| Vehicle campaigns in the pre-2010 file | 12,721 |
| Complaint rows / distinct vehicle complaints | 2,259,403 / 1,608,391 |
| Investigation rows / actions with no close date | 154,439 / 224 |
| Do-not-drive / park-outside / Takata wording | 205 / 103 / 31 |

Mini and MINI share one make page. Nine model spellings share a page with another spelling of the same name, including Nissan LEAF and Leaf. That is the difference between 87 and 86, and between 1,025 and 1,016.

## Not in this version

- Component pages, campaign pages, and investigation pages. Campaign numbers link to NHTSA. Investigation action numbers are printed as text.
- A VIN lookup. The site links to NHTSA's tool.
- Manufacturer communications (TSBs). The zip names were not verified.
- Static compare-pair pages. `/compare/` is one page.
- A separate "mpg by year" template. That table is a section on the model page.
- Sales-adjusted rates, prices, reviews, or a label telling someone to avoid a vehicle.
- The 1,343 unmatched model years still need a better name crosswalk. Their pages exist and say the name did not match.

## Go live

Do these in the GitHub repo and at Hostinger. This repository's workflows do not change those settings.

1. Repo **Settings → Pages → Build and deployment → Source**: **GitHub Actions**.
2. **Custom domain**: `vehiclefactbook.com`. `public/CNAME` already contains that name. GitHub does not apply the CNAME file when Pages is deployed by Actions, so the setting has to be saved in the UI (or with `gh api -X PUT repos/jvlachos122/vehiclefactbook/pages -f cname=vehiclefactbook.com -f build_type=workflow`).
3. After GitHub issues the certificate, turn on **Enforce HTTPS**.

At Hostinger (hPanel → Domains → vehiclefactbook.com → DNS), delete the default parking `A` record for `@` and the default `CNAME` for `www`, then add:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | @ | 185.199.108.153 | 3600 |
| A | @ | 185.199.109.153 | 3600 |
| A | @ | 185.199.110.153 | 3600 |
| A | @ | 185.199.111.153 | 3600 |
| AAAA | @ | 2606:50c0:8000::153 | 3600 |
| AAAA | @ | 2606:50c0:8001::153 | 3600 |
| AAAA | @ | 2606:50c0:8002::153 | 3600 |
| AAAA | @ | 2606:50c0:8003::153 | 3600 |
| CNAME | www | jvlachos122.github.io | 3600 |

Recommended: GitHub profile **Settings → Pages → Add a verified domain** for `vehiclefactbook.com`. Add the TXT record GitHub shows (`_github-pages-challenge-jvlachos122`) at Hostinger, then click Verify.

Check with `dig vehiclefactbook.com +short` (four `185.199.x.153` addresses) and `dig www.vehiclefactbook.com CNAME +short` (`jvlachos122.github.io.`).
