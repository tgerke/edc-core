# edc-core R engine
#
# Executes workbench R scripts against read-only, version-pinned DuckLake
# snapshots. Stateless: every request runs in a fresh R subprocess (callr)
# with the same containment as the SQL workbench; script storage,
# versioning, and audit live in the API (E6-04).

`%||%` <- function(a, b) if (is.null(a)) b else a

# plumber runs with the working directory set to this file's directory.
source("runner.R", local = FALSE)

#* @get /health
function() {
  list(
    status = "ok",
    service = "edc-core-r-engine",
    r_version = paste(R.version$major, R.version$minor, sep = "."),
    time = format(Sys.time(), "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC")
  )
}

#* @post /execute
#* @serializer unboxedJSON
function(req, res) {
  payload <- tryCatch(
    jsonlite::fromJSON(req$postBody, simplifyVector = TRUE),
    error = function(e) NULL
  )
  required <- c("script", "catalogUri", "dataPath", "metadataSchema", "version", "tables")
  if (is.null(payload) || !all(required %in% names(payload))) {
    res$status <- 400
    return(list(ok = FALSE, error = "invalid payload", stdout = ""))
  }
  timeout_s <- (payload$timeoutMs %||% 60000) / 1000
  started <- Sys.time()
  out <- tryCatch(
    callr::r(run_script, args = list(payload), timeout = timeout_s),
    callr_timeout_error = function(e) {
      list(ok = FALSE, stdout = "", error = sprintf("execution cancelled after %ss", timeout_s))
    },
    error = function(e) list(ok = FALSE, stdout = "", error = conditionMessage(e))
  )
  out$elapsedMs <- round(as.numeric(difftime(Sys.time(), started, units = "secs")) * 1000)
  out
}
