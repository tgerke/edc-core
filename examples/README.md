# Examples

## demo-study.xml — CDASH-aligned demo study (SC-03)

A small but complete protocol in CDISC ODM v2.0 exercising every core
capability:

- **Events**: Screening (Demographics + Vital Signs), Baseline (Vital Signs),
  and repeating Adverse Events and Concomitant Medications logs.
- **Forms**: CDASH-aligned items and OIDs (`IT.DM.BRTHDTC`, `IT.VS.SYSBP`,
  `IT.AE.AETERM`, …) with coded values (sex, ethnicity, race, AE severity,
  relatedness). `IT.AE.AETERM` and `IT.CM.CMTRT` are flagged as medical-coding
  targets (`edc:CodingDictionary`).
- **Edit checks**: JSONata ConditionDefs (ADR-0007) — systolic BP plausible
  range, systolic > diastolic, AE end date ≥ start date — which raise system
  queries automatically during entry, plus a cross-form check (ADR-0015)
  comparing each AE's onset date against the informed consent date on
  Demographics.

### Use it two ways

**Import into an existing study**: open a study in the web UI and click
*Import ODM*, or `POST /studies/:id/study-builds` with the file content.

**Seed a full demo environment** (study + sites + one user per clinical role
+ enrolled subjects, one with an open system query):

```sh
pnpm --filter @edc-core/api db:seed-demo
```

Demo logins (`demo-admin`, `demo-dm`, `demo-inv`, `demo-coord`, `demo-cra`)
share the password printed by the script; set `EDC_DEMO_PASSWORD` to
override. The script is idempotent — it exits if `ST.CDASH.DEMO` exists.

Suggested five-minute tour: sign in as `demo-coord` and finish DEMO-002's
vitals (the systolic value has an open query — correct it and watch the
query auto-close), as `demo-cra` verify the form, as `demo-inv` sign it
(Part 11 re-authentication), as `demo-dm` publish a snapshot on the
*analytics* page, run SQL/R against it, and download the study archive.

## dictionaries/ — synthetic coding dictionary samples

`meddra-sample.csv` and `whodrug-sample.csv` show the normalized CSV layout
the dictionary upload expects (see the medical coding guide). **They are
small synthetic samples with made-up codes — not MedDRA or WHODrug
content.** The real dictionaries are licensed products: obtain MedDRA from
the MSSO and WHODrug from the Uppsala Monitoring Centre, and convert your
licensed distribution to this layout. The seed script loads both samples and
binds them to the demo study so the coding page works out of the box.

Official CDISC ODM v2.0 example files: https://github.com/cdisc-org/DataExchange-ODM
