# edc-core R engine
#
# Executes versioned, audited R transformations against read-only DuckLake
# snapshots (Phase 5). Currently exposes only a health endpoint.

#* @get /health
function() {
  list(
    status = "ok",
    service = "edc-core-r-engine",
    r_version = paste(R.version$major, R.version$minor, sep = "."),
    time = format(Sys.time(), "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC")
  )
}
