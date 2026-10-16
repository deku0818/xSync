#!/usr/bin/env python3
"""Prepare a fresh Linux deployment from the owner's public initialization file."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--init", required=True, type=Path)
    parser.add_argument("--tls-cert", required=True, type=Path)
    parser.add_argument("--tls-key", required=True, type=Path)
    parser.add_argument("--directory", default=".", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run on the Linux server as root to set container file ownership.")
    root = args.directory.resolve()
    config = json.loads(args.init.read_text(encoding="utf-8"))
    required = ("vaultId", "epoch", "keyPackage", "enrollmentPublicKey")
    allowed = set(required) | {"listen", "objectDir", "devices"}
    if not all(config.get(field) for field in required) or set(config) - allowed or config.get("devices"):
        parser.error("Expected a fresh npm run server:init bundle, without devices or private key fields.")
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
    config["listen"] = "0.0.0.0:8873"
    config["objectDir"] = "/data/objects"
    config["dsn"] = "postgres://xsync:" + password + "@postgres:5432/xsync?sslmode=disable"
    destination = private / "server.json"
    destination.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
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
    print("The vault sync key is not needed on this server and must remain on the owner's device.")


if __name__ == "__main__":
    main()
