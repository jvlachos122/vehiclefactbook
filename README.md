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

Bump the `requested:` line in `.github/refresh-request` and merge it to `main` to start the same refresh. An empty `force` is treated as false, and the workflow's `GITHUB_TOKEN` data commit leaves that file unchanged, so it does not start another run.

Deploy site ignores that file, and a queued push to main checks out the latest main.

## Counts in this build

Taken from the files dated 2026-10-26 (NHTSA recalls), 2026-10-25 (NHTSA complaints and investigations), and 2026-09-29 (EPA):

| Figure | Count |
|---|---|
| EPA rows, model year 2000 and newer | 32,430 |
| EPA make names / models / model years | 87 / 1,025 / 8,158 |
| Published makes / models / model years | 86 / 1,016 / 8,158 |
| Model years matched to an NHTSA name | 7,108 |
| Model years with no NHTSA name match | 1,050 |
| By-year pages (at least 3 matched years) | 671 |
| Vehicle campaigns, 2010 and later | 13,717 |
| Vehicle campaigns in the pre-2010 file | 12,721 |
| Complaint rows / distinct vehicle complaints | 2,259,830 / 1,608,672 |
| Investigation rows / actions with no close date | 154,439 / 222 |
| Do-not-drive / park-outside / Takata wording | 205 / 103 / 31 |

Mini and MINI share one make page. Nine model spellings share a page with another spelling of the same name, including Nissan LEAF and Leaf. That is the difference between 87 and 86, and between 1,025 and 1,016.

## Example comparisons

`/compare/` links to static pages at `/compare/<make>-<model>-vs-<make>-<model>/`. The site has no sales figures, so the pages are example comparisons, not a popularity list.

The set is chosen only from the committed files in `data/site/`:

1. An EPA class family is the `vclass` value with a trailing `2WD` or `4WD` label removed.
2. A model year uses the family with the most configuration rows that year. A tie uses the alphabetically first family.
3. A model's anchor is its newest model year with an EPA configuration and an NHTSA name match (`match` other than `none`).
4. A pair is two models from different makes with the same anchor year, the same anchor class, the same make tier (volume, luxury, or specialty), and the same fuel type (gasoline, diesel, electric, hydrogen, or natural gas). Regular, midgrade, premium, and flex-fuel count as gasoline.
5. Pairs are ordered by the sum of EPA configuration rows, then by the sum of published model years on the two make hubs.
6. Each model is used once. Each class family keeps at most four pairs. The first 30 pairs are published.
7. A pair the older class-only rule would have published, and this rule drops, stays at the old URL as a noindex refresh to the replacement. Those URLs are not in the sitemap.

`/compare/hybrid/` lists same-model gasoline vs hybrid (and plug-in hybrid) pages. The year is the newest overlap from model year 2020 on. Figures are EPA mpg and fuelCost08. A calculated cost is added only when both sides are regular gasoline or diesel and the committed EIA snapshot has that price.

Each page shows EPA city, highway, and combined mpg (kWh/100 mi and range on electric rows), EPA annual fuel cost, NCAP overall stars for model year 2011 and newer, recall campaign counts, and distinct complaint counts received so far.

## Component pages

`/{make}/{model}/{year}/{component}/` is published when the component list on that model year has at least 50 distinct complaints. The list is the top ten components stored for the headline NHTSA name. When the EPA name is not an NHTSA name, the list is the top ten for the matched name with the most complaints, the same list the model year page shows. A component outside that stored top ten is not given a page. The page states the count and the complaint file date. It does not state a rate. Crash, fire, injury, and death figures stay on the model year page.

## Investigation pages

`/investigations/` lists actions that are attached to a published model year and have no close date on any stored row. Each action has a page at `/investigations/<action>/`. The investigations file also counts actions that are not attached to a published model year; those actions do not get a page. The page says "no close date in the NHTSA file." It does not describe the investigation as open. The summary is not copied. Action numbers are not given a per-action NHTSA URL. A model year page links the action number when a page exists.

A recall campaign page is published at `/recalls/<campaign>/` when the campaign number is from 2015 or later and at least one model year page lists it. Older campaign numbers still link to NHTSA.

## Not in this version

- A VIN lookup. The site links to NHTSA's tool.
- Manufacturer communications (TSBs). The zip names were not verified.
- A sales ranking. `/compare/` lists example pairs chosen from EPA configuration counts and make size. See "Example comparisons" below.
- A separate "mpg by year" template. That table is a section on the model page.
- Sales-adjusted rates, prices, reviews, or a label telling someone to avoid a vehicle.
- 1,050 model years stay unmatched. A reviewed crosswalk in `data/model-crosswalk.csv`, plus suffix and slash rules, attaches an NHTSA name only when it is the same vehicle. Cargo and passenger splits, coupe and roadster splits, and a shared prefix such as BMW M stay unmatched. Those pages still show EPA fuel economy and say the name did not match.

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
