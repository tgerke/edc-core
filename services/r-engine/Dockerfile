FROM docker.io/rocker/r-ver:4.5.1

# Posit Package Manager (configured by rocker) serves binary packages where available.
RUN R -q -e 'install.packages(c("plumber", "jsonlite", "DBI", "callr"))' \
  && R -q -e 'stopifnot( \
       requireNamespace("plumber", quietly = TRUE), \
       requireNamespace("callr", quietly = TRUE))'

# duckdb is version-paired with the API's @duckdb/node-api (1.5.4-r.1): both
# attach the same DuckLake catalogs, so both must speak the same catalog
# spec — DuckDB 1.5.x writes and reads spec 1.0. The API migrates older
# catalogs at boot (migrateAllLakeCatalogs); this side only ever attaches
# READ_ONLY, which cannot migrate, so a minor-version drift here fails every
# attach in runner.R with "DuckLake catalog version mismatch" (#62, #64).
# Bump only in lockstep with @duckdb/node-api. The dated snapshot is needed
# because the base image freezes CRAN at its own release date (currently
# serving duckdb 1.4.x); it also keeps image builds reproducible.
RUN R -q -e 'install.packages("duckdb", \
       repos = "https://packagemanager.posit.co/cran/__linux__/noble/2026-07-01")' \
  && R -q -e 'v <- utils::packageVersion("duckdb"); \
       stopifnot("duckdb must stay 1.5.x, in lockstep with @duckdb/node-api (#64)" = \
         v >= "1.5.0" && v < "1.6.0")'

# Bake the DuckDB extensions into the image so executions need no network.
RUN R -q -e 'con <- DBI::dbConnect(duckdb::duckdb()); \
             DBI::dbExecute(con, "INSTALL ducklake"); \
             DBI::dbExecute(con, "INSTALL postgres"); \
             DBI::dbDisconnect(con, shutdown = TRUE)'

WORKDIR /srv/r-engine
COPY plumber.R runner.R ./

EXPOSE 8000
CMD ["R", "-q", "-e", "plumber::pr_run(plumber::pr('plumber.R'), host = '0.0.0.0', port = 8000)"]
