# eTMF filing

edc-core can file the study-level artifacts it generates into an eTMF, so the
trial master file stays contemporaneous without anyone re-uploading documents
by hand. The reference target is [ctms-core](https://github.com/tgerke/ctms-core)
(see its ADR-0011), edc-core's AGPL sibling on the regulatory-document side;
any system exposing the same multipart upload-with-provenance interface works.

## What gets filed

| Trigger | Artifact filed | Content |
|---|---|---|
| Study build imported (`POST /studies/:id/metadata-versions`) | The study definition as ODM v2.0 XML | Metadata only: forms, items, codelists — the blank CRF |
| Snapshot published (`POST /studies/:id/snapshots`) | The snapshot manifest as JSON | Dataset names, row counts, DuckLake version — the point-in-time record |

**Boundary:** only study-level artifacts. Subject-level clinical data
(casebooks, captured values) never leaves edc-core through this path — the
eTMF holds documents *about* the trial, the EDC remains the system of record
for data *in* the trial.

Filing is best-effort and asynchronous. The triggering operation never waits
on the eTMF and never fails because of it; a missed filing is a `warn` line in
the API log, and re-importing the build (or re-publishing the snapshot) files
again.

## Configuration

Unset `EDC_ETMF_URL` (the default) disables the integration entirely.

```sh
EDC_ETMF_URL=http://ctms.example.com:8787   # the eTMF API base URL
EDC_ETMF_TOKEN=...                          # bearer token for the machine identity
EDC_ETMF_STUDY_ID=...                       # the eTMF's uuid for this study

# TMF artifact ids from the eTMF's live taxonomy — deployment configuration.
# Unmapped kinds are skipped (logged at info).
EDC_ETMF_ARTIFACT_STUDY_BUILD=9             # e.g. "Case Report Form (blank)"
EDC_ETMF_ARTIFACT_SNAPSHOT=                 # map when your taxonomy has a fit
```

On the ctms-core side, provision the machine identity: a `person` row for the
filing worker plus an `access_grant` with role `ingest` (read + upload, never
sign) scoped to the study, and either a dev token or an
`API_SERVICE_SUBJECTS=<client-id>:<email>` mapping for OIDC client-credentials.
Every filed document lands as `pending_review` with `source_system=edc-core`
and a `source_ref` naming the build or snapshot it came from — a human still
reviews and approves in the eTMF, and the eTMF's audit trail attributes the
upload to the machine identity.

## Trying it locally

With both stacks running (ctms-core seeds the machine identity and grant):

```sh
export EDC_ETMF_URL=http://localhost:8787
export EDC_ETMF_TOKEN=dev-service-token
export EDC_ETMF_STUDY_ID=$(curl -s http://localhost:8787/studies \
  -H "Authorization: Bearer dev-service-token" | jq -r '.[0].id')
export EDC_ETMF_ARTIFACT_STUDY_BUILD=9
```

then import a study build (e.g. `examples/` via the designer or API) and watch
the document appear in the ctms-core dashboard as pending review, provenance
attached.
