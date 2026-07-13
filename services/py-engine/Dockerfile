FROM docker.io/library/python:3.13-slim

# duckdb is version-paired with the API's @duckdb/node-api (1.5.4-r.1): both
# attach the same DuckLake catalogs, so both must speak the same catalog
# spec — DuckDB 1.5.x writes and reads spec 1.0. The API migrates older
# catalogs at boot (migrateAllLakeCatalogs); this side only ever attaches
# READ_ONLY, which cannot migrate, so a minor-version drift here fails every
# attach in runner.py with "DuckLake catalog version mismatch" (#62, #64).
# Bump only in lockstep with @duckdb/node-api.
RUN pip install --no-cache-dir "duckdb>=1.5,<1.6" pandas \
  && python -c "import duckdb, pandas"

# Bake the DuckDB extensions into the image so executions need no network.
RUN python -c "import duckdb; con = duckdb.connect(); \
  con.execute('INSTALL ducklake'); con.execute('INSTALL postgres')"

WORKDIR /srv/py-engine
COPY server.py runner.py ./

EXPOSE 8000
CMD ["python", "server.py"]
