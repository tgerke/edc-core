FROM docker.io/rocker/r-ver:4.5.1

# Posit Package Manager (configured by rocker) serves binary packages where available.
RUN R -q -e 'install.packages(c("plumber", "jsonlite", "DBI", "callr"))' \
  && R -q -e 'stopifnot( \
       requireNamespace("plumber", quietly = TRUE), \
       requireNamespace("callr", quietly = TRUE))'

# duckdb is version-paired with the API's @duckdb/node-api (1.4.5-r.1): both
# attach the same DuckLake catalogs, whose spec version is fixed by the side
# that writes them. The API writes spec 0.3 (DuckDB 1.4.x); duckdb >= 1.5
# requires spec 1.0 and fails every READ_ONLY attach in runner.R with
# "DuckLake catalog version mismatch" (#62). The dated P3M snapshot pins
# 1.4.4, the last 1.4.x release. Upgrade only in lockstep with
# @duckdb/node-api, migrating every study's catalog as part of the upgrade.
RUN R -q -e 'install.packages("duckdb", \
       repos = "https://packagemanager.posit.co/cran/__linux__/noble/2026-03-01")' \
  && R -q -e 'v <- utils::packageVersion("duckdb"); \
       stopifnot("duckdb must stay 1.4.x until upgraded in lockstep with @duckdb/node-api (#62)" = \
         v >= "1.4.0" && v < "1.5.0")'

# Bake the DuckDB extensions into the image so executions need no network.
RUN R -q -e 'con <- DBI::dbConnect(duckdb::duckdb()); \
             DBI::dbExecute(con, "INSTALL ducklake"); \
             DBI::dbExecute(con, "INSTALL postgres"); \
             DBI::dbDisconnect(con, shutdown = TRUE)'

WORKDIR /srv/r-engine
COPY plumber.R runner.R ./

EXPOSE 8000
CMD ["R", "-q", "-e", "plumber::pr_run(plumber::pr('plumber.R'), host = '0.0.0.0', port = 8000)"]
