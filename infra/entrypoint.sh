#!/bin/sh
set -eu
umask 077
# JAVA_OPTS is administrator-controlled JVM configuration, intentionally split into arguments.
exec java ${JAVA_OPTS:--XX:MaxRAMPercentage=65 -XX:InitialRAMPercentage=10} -jar /app/app.jar "$@"
