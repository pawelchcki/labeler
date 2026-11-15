#!/usr/bin/env python3
"""Create a private local Play upload key once; never print its password."""
from pathlib import Path
import os
import secrets
import subprocess

root = Path(__file__).resolve().parents[1]
private = root / ".signing"
if private.exists():
    raise SystemExit(".signing already exists; preserve the existing upload key.")
os.umask(0o077)
private.mkdir(mode=0o700)
password_file = private / "password.txt"
password = secrets.token_urlsafe(48)
password_file.write_text(password)
java_home = os.environ.get("JAVA_HOME")
keytool = str(Path(java_home) / "bin/keytool") if java_home else "keytool"
subprocess.run([
    keytool, "-genkeypair", "-keystore", str(private / "upload.keystore"),
    "-storetype", "PKCS12", "-alias", "upload", "-keyalg", "RSA",
    "-keysize", "3072", "-validity", "10000", "-dname", "CN=Labeler Upload",
    "-storepass:file", str(password_file), "-keypass:file", str(password_file),
], check=True)
(private / "upload.properties").write_text("storePassword=" + password + "\n")
password_file.unlink()
print("Upload key created in ignored .signing/; keep a secure backup of this directory.")
