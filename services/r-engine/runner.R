# Executes one workbench script in a fresh R subprocess (via callr from
# plumber.R). Mirrors the SQL workbench containment exactly (see
# apps/api/src/services/workbench.ts): one study's lake attached READ_ONLY,
# views pinned to the snapshot's lake version, then the DuckDB session is
# locked down before any user code runs.
run_script <- function(payload) {
  esc <- function(x) gsub("'", "''", x)
  qid <- function(x) sprintf('"%s"', gsub('"', '""', x))

  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  DBI::dbExecute(con, "LOAD ducklake; LOAD postgres;")
  # OVERRIDE_DATA_PATH: the catalog stores the API's view of the Parquet
  # directory; this container mounts the same files at its own path.
  DBI::dbExecute(con, sprintf(
    paste0(
      "ATTACH 'ducklake:postgres:%s' AS lake ",
      "(DATA_PATH '%s', METADATA_SCHEMA '%s', READ_ONLY, OVERRIDE_DATA_PATH TRUE)"
    ),
    esc(payload$catalogUri), esc(payload$dataPath), esc(payload$metadataSchema)
  ))
  for (t in payload$tables) {
    DBI::dbExecute(con, sprintf(
      "CREATE VIEW %s AS SELECT * FROM lake.main.%s AT (VERSION => %d)",
      qid(t), qid(t), as.integer(payload$version)
    ))
  }
  DBI::dbExecute(con, sprintf("SET allowed_directories=['%s']", esc(payload$dataPath)))
  DBI::dbExecute(con, "SET enable_external_access=false")
  DBI::dbExecute(con, "SET lock_configuration=true")

  # The script sees the snapshot through `con` plus two convenience helpers.
  env <- new.env(parent = globalenv())
  env$con <- con
  env$lake_read <- function(table) DBI::dbGetQuery(con, sprintf("SELECT * FROM %s", qid(table)))
  env$lake_query <- function(sql) DBI::dbGetQuery(con, sql)

  ok <- TRUE
  err <- NULL
  last <- NULL
  captured <- character()
  out_con <- textConnection("captured", "w", local = TRUE)
  sink(out_con)
  sink(out_con, type = "message")
  tryCatch(
    {
      exprs <- parse(text = payload$script)
      for (e in exprs) {
        r <- withVisible(eval(e, envir = env))
        if (r$visible) print(r$value)
        last <- r$value
      }
    },
    error = function(cond) {
      ok <<- FALSE
      err <<- conditionMessage(cond)
    }
  )
  sink(type = "message")
  sink()
  close(out_con)

  # If the script ends in a data.frame, ship it in the same {columns, rows}
  # shape the SQL workbench uses so the UI renders both identically.
  result_columns <- NULL
  result_json <- NULL
  if (ok && inherits(last, "data.frame")) {
    df <- utils::head(as.data.frame(last), 1000)
    result_columns <- names(df)
    result_json <- as.character(
      jsonlite::toJSON(df, dataframe = "values", na = "null", digits = NA, POSIXt = "ISO8601")
    )
  }

  list(
    ok = ok,
    stdout = paste(captured, collapse = "\n"),
    error = err,
    resultColumns = result_columns,
    resultJson = result_json
  )
}
