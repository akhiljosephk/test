FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml ./
COPY src ./src
COPY mockups/MapleDesk-Interactive.html ./mockups/MapleDesk-Interactive.html
RUN --mount=type=secret,id=maven_settings,required=false --mount=type=secret,id=java_truststore,required=false \
    set -eu; \
    if [ -f /run/secrets/maven_settings ]; then set -- -s /run/secrets/maven_settings; else set --; fi; \
    if [ -f /run/secrets/java_truststore ]; then export MAVEN_OPTS="${MAVEN_OPTS:-} -Djavax.net.ssl.trustStore=/run/secrets/java_truststore"; fi; \
    mvn -B -ntp "$@" -DskipTests package; \
    mkdir -p /build/native; \
    case "$(uname -m)" in x86_64) sqlite_arch=x86_64;; aarch64) sqlite_arch=aarch64;; *) exit 1;; esac; \
    cd /build/native; \
    jar xf /root/.m2/repository/org/xerial/sqlite-jdbc/3.53.4.0/sqlite-jdbc-3.53.4.0.jar "org/sqlite/native/Linux/$sqlite_arch/libsqlitejdbc.so"; \
    mv "org/sqlite/native/Linux/$sqlite_arch/libsqlitejdbc.so" .; \
    rm -r org

FROM eclipse-temurin:21-jre-jammy
ENV PORT=3000 APP_ENV=production DB_PATH=/data/mapledesk.sqlite JAVA_TOOL_OPTIONS=-Dorg.sqlite.lib.path=/app/native
WORKDIR /app
RUN groupadd -r -g 10001 mapledesk && useradd -r -u 10001 -g mapledesk mapledesk && mkdir /data && chown mapledesk:mapledesk /app /data
COPY --from=build --chown=mapledesk:mapledesk /build/target/mapledesk-1.0.0.jar /app/app.jar
COPY --from=build /build/native/libsqlitejdbc.so /app/native/libsqlitejdbc.so
COPY --from=build --chown=mapledesk:mapledesk /build/target/classes/com/mapledesk/HealthProbe.class /app/health/com/mapledesk/HealthProbe.class
COPY --chmod=755 infra/entrypoint.sh /app/entrypoint.sh
USER mapledesk
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s CMD ["java", "-Xmx32m", "-cp", "/app/health", "com.mapledesk.HealthProbe"]
ENTRYPOINT ["/app/entrypoint.sh"]
