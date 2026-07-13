--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: __LAKE_SCHEMA__; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA __LAKE_SCHEMA__;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ducklake_column; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_column (
    column_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    table_id bigint,
    column_order bigint,
    column_name character varying,
    column_type character varying,
    initial_default character varying,
    default_value character varying,
    nulls_allowed boolean,
    parent_column bigint
);


--
-- Name: ducklake_column_mapping; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_column_mapping (
    mapping_id bigint,
    table_id bigint,
    type character varying
);


--
-- Name: ducklake_column_tag; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_column_tag (
    table_id bigint,
    column_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    key character varying,
    value character varying
);


--
-- Name: ducklake_data_file; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_data_file (
    data_file_id bigint NOT NULL,
    table_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    file_order bigint,
    path character varying,
    path_is_relative boolean,
    file_format character varying,
    record_count bigint,
    file_size_bytes bigint,
    footer_size bigint,
    row_id_start bigint,
    partition_id bigint,
    encryption_key character varying,
    partial_file_info character varying,
    mapping_id bigint
);


--
-- Name: ducklake_delete_file; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_delete_file (
    delete_file_id bigint NOT NULL,
    table_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    data_file_id bigint,
    path character varying,
    path_is_relative boolean,
    format character varying,
    delete_count bigint,
    file_size_bytes bigint,
    footer_size bigint,
    encryption_key character varying
);


--
-- Name: ducklake_file_column_stats; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_file_column_stats (
    data_file_id bigint,
    table_id bigint,
    column_id bigint,
    column_size_bytes bigint,
    value_count bigint,
    null_count bigint,
    min_value character varying,
    max_value character varying,
    contains_nan boolean,
    extra_stats character varying
);


--
-- Name: ducklake_file_partition_value; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_file_partition_value (
    data_file_id bigint,
    table_id bigint,
    partition_key_index bigint,
    partition_value character varying
);


--
-- Name: ducklake_files_scheduled_for_deletion; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_files_scheduled_for_deletion (
    data_file_id bigint,
    path character varying,
    path_is_relative boolean,
    schedule_start timestamp with time zone
);


--
-- Name: ducklake_inlined_data_tables; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_inlined_data_tables (
    table_id bigint,
    table_name character varying,
    schema_version bigint
);


--
-- Name: ducklake_metadata; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_metadata (
    key character varying NOT NULL,
    value character varying NOT NULL,
    scope character varying,
    scope_id bigint
);


--
-- Name: ducklake_name_mapping; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_name_mapping (
    mapping_id bigint,
    column_id bigint,
    source_name character varying,
    target_field_id bigint,
    parent_column bigint,
    is_partition boolean
);


--
-- Name: ducklake_partition_column; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_partition_column (
    partition_id bigint,
    table_id bigint,
    partition_key_index bigint,
    column_id bigint,
    transform character varying
);


--
-- Name: ducklake_partition_info; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_partition_info (
    partition_id bigint,
    table_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint
);


--
-- Name: ducklake_schema; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_schema (
    schema_id bigint NOT NULL,
    schema_uuid uuid,
    begin_snapshot bigint,
    end_snapshot bigint,
    schema_name character varying,
    path character varying,
    path_is_relative boolean
);


--
-- Name: ducklake_schema_versions; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_schema_versions (
    begin_snapshot bigint,
    schema_version bigint
);


--
-- Name: ducklake_snapshot; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_snapshot (
    snapshot_id bigint NOT NULL,
    snapshot_time timestamp with time zone,
    schema_version bigint,
    next_catalog_id bigint,
    next_file_id bigint
);


--
-- Name: ducklake_snapshot_changes; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_snapshot_changes (
    snapshot_id bigint NOT NULL,
    changes_made character varying,
    author character varying,
    commit_message character varying,
    commit_extra_info character varying
);


--
-- Name: ducklake_table; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_table (
    table_id bigint,
    table_uuid uuid,
    begin_snapshot bigint,
    end_snapshot bigint,
    schema_id bigint,
    table_name character varying,
    path character varying,
    path_is_relative boolean
);


--
-- Name: ducklake_table_column_stats; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_table_column_stats (
    table_id bigint,
    column_id bigint,
    contains_null boolean,
    contains_nan boolean,
    min_value character varying,
    max_value character varying,
    extra_stats character varying
);


--
-- Name: ducklake_table_stats; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_table_stats (
    table_id bigint,
    record_count bigint,
    next_row_id bigint,
    file_size_bytes bigint
);


--
-- Name: ducklake_tag; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_tag (
    object_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    key character varying,
    value character varying
);


--
-- Name: ducklake_view; Type: TABLE; Schema: __LAKE_SCHEMA__; Owner: -
--

CREATE TABLE __LAKE_SCHEMA__.ducklake_view (
    view_id bigint,
    view_uuid uuid,
    begin_snapshot bigint,
    end_snapshot bigint,
    schema_id bigint,
    view_name character varying,
    dialect character varying,
    sql character varying,
    column_aliases character varying
);


--
-- Data for Name: ducklake_column; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_column VALUES (1, 1, NULL, 1, 1, 'subject_key', 'varchar', NULL, NULL, true, NULL);
INSERT INTO __LAKE_SCHEMA__.ducklake_column VALUES (2, 1, NULL, 1, 2, 'value', 'int32', NULL, NULL, true, NULL);


--
-- Data for Name: ducklake_column_mapping; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_column_tag; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_data_file; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_data_file VALUES (0, 1, 2, NULL, NULL, 'ducklake-019f589e-19bd-71e5-9d2a-30af81d6c344.parquet', true, 'parquet', 2, 354, 260, 0, NULL, NULL, NULL, NULL);


--
-- Data for Name: ducklake_delete_file; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_file_column_stats; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_file_column_stats VALUES (0, 1, 1, 49, 2, 0, 'SUBJ-001', 'SUBJ-002', NULL, NULL);
INSERT INTO __LAKE_SCHEMA__.ducklake_file_column_stats VALUES (0, 1, 2, 33, 2, 0, '7', '42', NULL, NULL);


--
-- Data for Name: ducklake_file_partition_value; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_files_scheduled_for_deletion; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_inlined_data_tables; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_metadata; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_metadata VALUES ('version', '0.3', NULL, NULL);
INSERT INTO __LAKE_SCHEMA__.ducklake_metadata VALUES ('created_by', 'DuckDB f31be57c18', NULL, NULL);
INSERT INTO __LAKE_SCHEMA__.ducklake_metadata VALUES ('data_path', '__LAKE_DATA_DIR__/', NULL, NULL);
INSERT INTO __LAKE_SCHEMA__.ducklake_metadata VALUES ('encrypted', 'false', NULL, NULL);


--
-- Data for Name: ducklake_name_mapping; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_partition_column; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_partition_info; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_schema; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_schema VALUES (0, 'c8a565e4-43a8-481e-aac8-3bc49c9e8ca1', 0, NULL, 'main', 'main/', true);


--
-- Data for Name: ducklake_schema_versions; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_schema_versions VALUES (0, 0);
INSERT INTO __LAKE_SCHEMA__.ducklake_schema_versions VALUES (1, 1);


--
-- Data for Name: ducklake_snapshot; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_snapshot VALUES (0, '2026-07-12 23:16:23.955712+00', 0, 1, 0);
INSERT INTO __LAKE_SCHEMA__.ducklake_snapshot VALUES (1, '2026-07-12 23:16:24.121258+00', 1, 2, 0);
INSERT INTO __LAKE_SCHEMA__.ducklake_snapshot VALUES (2, '2026-07-12 23:16:24.134445+00', 1, 2, 1);


--
-- Data for Name: ducklake_snapshot_changes; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_snapshot_changes VALUES (0, 'created_schema:"main"', NULL, NULL, NULL);
INSERT INTO __LAKE_SCHEMA__.ducklake_snapshot_changes VALUES (1, 'created_table:"main"."fixture_items"', NULL, NULL, NULL);
INSERT INTO __LAKE_SCHEMA__.ducklake_snapshot_changes VALUES (2, 'inserted_into_table:1', NULL, NULL, NULL);


--
-- Data for Name: ducklake_table; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_table VALUES (1, '019f589e-19ae-79dd-a7df-652d5e7da8ff', 1, NULL, 0, 'fixture_items', 'fixture_items/', true);


--
-- Data for Name: ducklake_table_column_stats; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_table_column_stats VALUES (1, 1, false, NULL, 'SUBJ-001', 'SUBJ-002', NULL);
INSERT INTO __LAKE_SCHEMA__.ducklake_table_column_stats VALUES (1, 2, false, NULL, '7', '42', NULL);


--
-- Data for Name: ducklake_table_stats; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--

INSERT INTO __LAKE_SCHEMA__.ducklake_table_stats VALUES (1, 2, 2, 354);


--
-- Data for Name: ducklake_tag; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Data for Name: ducklake_view; Type: TABLE DATA; Schema: __LAKE_SCHEMA__; Owner: -
--



--
-- Name: ducklake_data_file ducklake_data_file_pkey; Type: CONSTRAINT; Schema: __LAKE_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __LAKE_SCHEMA__.ducklake_data_file
    ADD CONSTRAINT ducklake_data_file_pkey PRIMARY KEY (data_file_id);


--
-- Name: ducklake_delete_file ducklake_delete_file_pkey; Type: CONSTRAINT; Schema: __LAKE_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __LAKE_SCHEMA__.ducklake_delete_file
    ADD CONSTRAINT ducklake_delete_file_pkey PRIMARY KEY (delete_file_id);


--
-- Name: ducklake_schema ducklake_schema_pkey; Type: CONSTRAINT; Schema: __LAKE_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __LAKE_SCHEMA__.ducklake_schema
    ADD CONSTRAINT ducklake_schema_pkey PRIMARY KEY (schema_id);


--
-- Name: ducklake_snapshot_changes ducklake_snapshot_changes_pkey; Type: CONSTRAINT; Schema: __LAKE_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __LAKE_SCHEMA__.ducklake_snapshot_changes
    ADD CONSTRAINT ducklake_snapshot_changes_pkey PRIMARY KEY (snapshot_id);


--
-- Name: ducklake_snapshot ducklake_snapshot_pkey; Type: CONSTRAINT; Schema: __LAKE_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __LAKE_SCHEMA__.ducklake_snapshot
    ADD CONSTRAINT ducklake_snapshot_pkey PRIMARY KEY (snapshot_id);


--
-- PostgreSQL database dump complete
--


