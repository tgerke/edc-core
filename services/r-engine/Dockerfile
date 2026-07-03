FROM docker.io/rocker/r-ver:4.5.1

# Posit Package Manager (configured by rocker) serves binary packages where available.
RUN R -q -e 'install.packages(c("plumber"))' \
  && R -q -e 'stopifnot(requireNamespace("plumber", quietly = TRUE))'

WORKDIR /srv/r-engine
COPY plumber.R .

EXPOSE 8000
CMD ["R", "-q", "-e", "plumber::pr_run(plumber::pr('plumber.R'), host = '0.0.0.0', port = 8000)"]
