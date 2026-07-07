FROM docker.io/rocker/r-ver:4.5.1

# Posit Package Manager (configured by rocker) serves binary packages where available.
RUN R -q -e 'install.packages(c("plumber", "jsonlite", "DBI", "duckdb", "callr"))' \
  && R -q -e 'stopifnot( \
       requireNamespace("plumber", quietly = TRUE), \
       requireNamespace("duckdb", quietly = TRUE), \
       requireNamespace("callr", quietly = TRUE))'

# Bake the DuckDB extensions into the image so executions need no network.
RUN R -q -e 'con <- DBI::dbConnect(duckdb::duckdb()); \
             DBI::dbExecute(con, "INSTALL ducklake"); \
             DBI::dbExecute(con, "INSTALL postgres"); \
             DBI::dbDisconnect(con, shutdown = TRUE)'

WORKDIR /srv/r-engine
COPY plumber.R runner.R ./

EXPOSE 8000
CMD ["R", "-q", "-e", "plumber::pr_run(plumber::pr('plumber.R'), host = '0.0.0.0', port = 8000)"]
