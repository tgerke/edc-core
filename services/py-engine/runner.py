# Executes one workbench script in a fresh Python subprocess (spawned per
# request by server.py; payload on stdin, result JSON to the file named in
# argv[1]). Mirrors the SQL workbench containment exactly (see
# apps/api/src/services/workbench.ts): one study's lake attached READ_ONLY,
# views pinned to the snapshot's lake version, then the DuckDB session is
# locked down before any user code runs.

import ast
import io
import json
import sys
from contextlib import redirect_stderr, redirect_stdout

import duckdb
import pandas as pd


def esc(x):
    return x.replace("'", "''")


def qid(x):
    return '"' + x.replace('"', '""') + '"'


def run_script(payload):
    con = duckdb.connect()
    con.execute("LOAD ducklake; LOAD postgres;")
    # OVERRIDE_DATA_PATH: the catalog stores the API's view of the Parquet
    # directory; this container mounts the same files at its own path.
    con.execute(
        "ATTACH 'ducklake:postgres:%s' AS lake "
        "(DATA_PATH '%s', METADATA_SCHEMA '%s', READ_ONLY, OVERRIDE_DATA_PATH TRUE)"
        % (esc(payload["catalogUri"]), esc(payload["dataPath"]), esc(payload["metadataSchema"]))
    )
    for t in payload["tables"]:
        con.execute(
            "CREATE VIEW %s AS SELECT * FROM lake.main.%s AT (VERSION => %d)"
            % (qid(t), qid(t), int(payload["version"]))
        )
    con.execute("SET allowed_directories=['%s']" % esc(payload["dataPath"]))
    con.execute("SET enable_external_access=false")
    con.execute("SET lock_configuration=true")

    # The script sees the snapshot through `con` plus two convenience helpers.
    env = {
        "con": con,
        "lake_read": lambda table: con.execute("SELECT * FROM %s" % qid(table)).df(),
        "lake_query": lambda sql: con.execute(sql).df(),
    }

    ok = True
    err = None
    last = None
    buf = io.StringIO()
    try:
        with redirect_stdout(buf), redirect_stderr(buf):
            # REPL semantics, the counterpart of R's autoprint: top-level
            # expression statements echo their repr and set the candidate
            # result value; all other statements just execute.
            for node in ast.parse(payload["script"]).body:
                if isinstance(node, ast.Expr):
                    last = eval(compile(ast.Expression(node.value), "<script>", "eval"), env)
                    if last is not None:
                        print(repr(last))
                else:
                    exec(compile(ast.Module([node], type_ignores=[]), "<script>", "exec"), env)
                    last = None
    except BaseException as e:  # includes SystemExit: report it, don't die silently
        ok = False
        err = "%s: %s" % (type(e).__name__, e)

    # If the script ends in a DataFrame expression, ship it in the same
    # {columns, rows} shape the SQL workbench uses so the UI renders both
    # identically.
    result_columns = None
    result_json = None
    if ok and isinstance(last, pd.DataFrame):
        df = last.head(1000)
        try:
            result_json = df.to_json(orient="values", date_format="iso")
            result_columns = [str(c) for c in df.columns]
        except Exception as e:  # unserializable cells: keep the run, drop the grid
            buf.write("\n[result not serializable: %s]" % e)

    return {
        "ok": ok,
        "stdout": buf.getvalue(),
        "error": err,
        "resultColumns": result_columns,
        "resultJson": result_json,
    }


def main():
    payload = json.load(sys.stdin)
    try:
        out = run_script(payload)
    except Exception as e:  # attach/serialization failures, not user-code errors
        out = {
            "ok": False,
            "stdout": "",
            "error": "%s: %s" % (type(e).__name__, e),
            "resultColumns": None,
            "resultJson": None,
        }
    with open(sys.argv[1], "w") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
