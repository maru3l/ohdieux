FROM eclipse-temurin:21-jdk-alpine AS build

# hadolint ignore=DL3018
RUN apk add --no-cache bash curl \
  && curl -fL https://github.com/coursier/coursier/releases/download/v2.1.24/coursier -o /usr/local/bin/cs \
  && chmod +x /usr/local/bin/cs \
  && cs install --dir /usr/local/bin scalac:3.5.1 sbt:1.10.2

WORKDIR /app
COPY build.sbt ./
COPY project ./project
RUN sbt -batch update

COPY src ./src
RUN sbt -batch playUpdateSecret >/dev/null \
  && sbt -batch stage

FROM eclipse-temurin:21-jre-alpine

# hadolint ignore=DL3018
RUN apk add --no-cache bash ffmpeg \
  && addgroup -S -g 2000 ohdieux \
  && adduser -S -D -H -u 2000 -G ohdieux ohdieux

WORKDIR /app
COPY --from=build --chown=ohdieux:ohdieux /app/target/universal/stage /app/ohdieux
RUN mkdir -p /tmp/ohdieux /data \
  && chown -R ohdieux:ohdieux /tmp/ohdieux /data

ENV PORT=8080 \
    HTTP_ADDRESS=0.0.0.0 \
    DATA_DIR=/data/ \
    ARCHIVE_TEMP_DIR=/tmp/ohdieux

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["sh", "-c", "wget -q --spider \"http://127.0.0.1:${PORT}/health\""]

USER 2000:2000
WORKDIR /data

CMD ["/app/ohdieux/bin/ohdieux", \
  "-Dpidfile.path=/tmp/ohdieux.pid", \
  "-Dlogger.resource=prod-logback.xml"]
