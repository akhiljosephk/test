#!/usr/bin/env bash
# Reproducible build setup for this restricted Codex workspace; ordinary development uses ./mvnw verify.
set -euo pipefail
cd /workspace/test
setup_root=/workspace/.setup
mkdir -p "$setup_root/tools"
if [ ! -x "$setup_root/tools/jdk-21.0.12.1+1/bin/javac" ]; then
  jdk_url=https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz
  curl -fsSL "$jdk_url" -o "$setup_root/tools/jdk21.tar.gz"
  curl -fsSL "$jdk_url.sha256.txt" -o "$setup_root/tools/jdk21.tar.gz.sha256"
  python3 - <<'PY'
from pathlib import Path
import hashlib
p=Path('/workspace/.setup/tools/jdk21.tar.gz')
assert hashlib.sha256(p.read_bytes()).hexdigest()==Path(str(p)+'.sha256').read_text().split()[0]
PY
  tar -xzf "$setup_root/tools/jdk21.tar.gz" -C "$setup_root/tools"
fi
export JAVA_HOME="$setup_root/tools/jdk-21.0.12.1+1"
export PATH="$JAVA_HOME/bin:$PATH"
export MAVEN_USER_HOME="$setup_root/maven-home"
if [ -f /etc/ssl/certs/java/cacerts ]; then
  export MAVEN_OPTS="${MAVEN_OPTS:-} -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts"
fi
python3 - <<'PY'
import os,urllib.parse,xml.etree.ElementTree as E
proxy=urllib.parse.urlsplit(os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy',''))
root=E.Element('settings')
if proxy.hostname:
 p=E.SubElement(E.SubElement(root,'proxies'),'proxy')
 for k,v in [('id','environment'),('active','true'),('protocol','http'),('host',proxy.hostname),('port',str(proxy.port or 80))]:E.SubElement(p,k).text=v
 if proxy.username:E.SubElement(p,'username').text=urllib.parse.unquote(proxy.username)
 if proxy.password:E.SubElement(p,'password').text=urllib.parse.unquote(proxy.password)
path='/workspace/.setup/maven-settings.xml'
E.ElementTree(root).write(path)
os.chmod(path,0o600)
PY
./mvnw -B -ntp -s "$setup_root/maven-settings.xml" -Dmaven.repo.local="$setup_root/m2" verify
