#!/usr/bin/env python3
"""Prepare a fresh managed xSync deployment with PostgreSQL and TLS."""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admin-password-file", required=True, type=Path)
    parser.add_argument("--tls-cert", required=True, type=Path)
    parser.add_argument("--tls-key", required=True, type=Path)
    parser.add_argument("--directory", default=".", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run on the Linux server as root to set container file ownership.")
    root = args.directory.resolve()
    admin_password = args.admin_password_file.read_text(encoding="utf-8").rstrip("\r\n")
    if len(admin_password) < 12 or any(c in admin_password for c in "\r\n\0"):
        parser.error("The administrator password must contain at least 12 characters on one line.")
    private = root / "secrets"
    if private.exists():
        parser.error("secrets/ already exists; refusing to replace deployment identity or credentials.")
    if (root / "data" / "objects").exists() or (root / "data" / "postgres").exists():
        parser.error("Persistent data already exists; use the original identity and recovery procedure.")
    # Check certificate expiry and the public-key match before writing credentials.
    subprocess.run(["openssl", "x509", "-in", str(args.tls_cert), "-noout", "-checkend", "604800"], check=True)
    cert_public = subprocess.check_output(["openssl", "x509", "-in", str(args.tls_cert), "-noout", "-pubkey"])
    key_public = subprocess.check_output(["openssl", "pkey", "-in", str(args.tls_key), "-pubout"])
    if cert_public != key_public:
        parser.error("TLS certificate and private key do not match.")
    os.umask(0o077)
    root.mkdir(parents=True, exist_ok=True)
    private.mkdir(mode=0o700)
    password = secrets.token_hex(32)
    (private / "postgres-password.txt").write_text(password + "\n", encoding="ascii")
    (private / "server.env").write_text(
        "XSYNC_DATABASE_URL=postgres://xsync:" + password + "@postgres:5432/xsync?sslmode=disable\n",
        encoding="ascii",
    )
    destination = private / "admin-password.txt"
    destination.write_text(admin_password + "\n", encoding="utf-8")
    os.chown(str(destination), 65532, 65532)
    destination.chmod(0o400)
    tls = private / "tls"
    tls.mkdir(mode=0o700)
    for source, filename in ((args.tls_cert, "fullchain.pem"), (args.tls_key, "privkey.pem")):
        destination = tls / filename
        shutil.copyfile(str(source), str(destination))
        os.chown(str(destination), 65532, 65532)
        destination.chmod(0o400)
    os.chown(str(tls), 65532, 65532)
    tls.chmod(0o500)
    objects = root / "data" / "objects"
    objects.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chown(str(objects), 65532, 65532)
    print("Prepared private runtime configuration, TLS files and persistent objects directory.")
    print("Open /admin/ to create users. Users create encrypted vaults in the plugin.")


if __name__ == "__main__":
    main()
