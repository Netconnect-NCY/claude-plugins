#!/usr/bin/env python3
"""Offline catalog integrity checks; never authenticate or fetch private sources."""

import argparse
import json
import re
from pathlib import Path, PurePosixPath


CATALOG_URL = "https://github.com/Netconnect-NCY/claude-plugins.git"
REQUIRED_PRODUCTS = {"swarm2", "sunday", "ssh-fleet", "ssh-fleet-connect", "golden-path", "odoo", "netconnect"}
CATALOGS = {
    "claude_code": ("netconnect", ".claude-plugin/marketplace.json"),
    "codex": ("netconnect-claude-plugins", ".agents/plugins/marketplace.json"),
}
MANIFESTS = ("plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json")
PACKAGE_STATES = {"compatible", "repairs_pending", "blocked", "not_packaged"}
SENSITIVE_NAMES = {"credentials.json", "tokens.json", "token.json", "session.json", "cookies.json", "journal.md"}
SENSITIVE_DIRECTORIES = {".git", "node_modules", "tenant-data", "private", "ops-notes", "private-operations"}
SENSITIVE_KEYS = {"clientsecret", "client_secret", "access_token", "refresh_token", "password", "privatekey", "private_key", "tenant_id", "user_id"}
PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")
APP_ID = re.compile(r"(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*")
PLACEHOLDER = re.compile(r"(?:\$\{[^}]+\}|<[^>]+>|REPLACE_ME|YOUR_[A-Z_]+|example(?:[-_].*)?)", re.IGNORECASE)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def normalized_url(value):
    return value.rstrip("/").removesuffix(".git") if isinstance(value, str) else None


def normalized_path(value):
    if not isinstance(value, str) or not value or "\\" in value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        return None
    return path.as_posix()


def contained_path(root, relative):
    """Reject traversal and symlinks before reading any package contents."""
    path = normalized_path(relative)
    if path is None:
        return None
    target = root / path
    current = root
    for part in PurePosixPath(path).parts:
        current = current / part
        if current.is_symlink():
            return None
    return target if target.resolve().is_relative_to(root.resolve()) else None


def sensitive_json(value):
    if isinstance(value, dict):
        # Schema definitions and explicit example placeholders are not stored credentials.
        # This is a mistake detector, not a complete secret/content scanner.
        def material(child):
            if isinstance(child, str):
                return bool(child.strip()) and not PLACEHOLDER.fullmatch(child.strip())
            return type(child) in (int, float)
        return any((key.lower() in SENSITIVE_KEYS and material(child)) or sensitive_json(child)
                   for key, child in value.items())
    if isinstance(value, list):
        return any(sensitive_json(child) for child in value)
    return False


def check_app_references(document, relative, errors):
    """Validate supported non-secret app references, never invent or resolve IDs."""
    apps = document.get("apps") if isinstance(document, dict) else None
    if not isinstance(apps, dict):
        errors.append(f"{relative}: app reference manifest needs an apps object")
        return
    for entry in apps.values():
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not APP_ID.fullmatch(entry["id"]):
            errors.append(f"{relative}: app reference needs a supported registered app ID")
            continue
        if any(flag in entry and type(entry[flag]) is not bool for flag in ("required", "optional")):
            errors.append(f"{relative}: app reference required/optional flags must be booleans")


def check_manifest_references(root, package, manifest, relative, errors):
    """Resolve known file/directory declarations without importing or executing code."""
    if not isinstance(manifest, dict):
        errors.append(f"{relative}: package manifest must be an object")
        return
    layers = [manifest]
    extension = manifest.get("extensions", {}).get("com.openai") if isinstance(manifest.get("extensions", {}), dict) else None
    if isinstance(extension, dict):
        layers.append(extension)
    for layer in layers:
        references = [(key, layer[key]) for key in ("skills", "mcpServers", "apps", "hooks", "types", "onboardingSkill") if key in layer]
        interface = layer.get("interface")
        if isinstance(interface, dict):
            references += [(key, interface[key]) for key in ("composerIcon", "logo") if key in interface]
        for key, value in references:
            # Inline MCP/hook configurations are also valid; this check is for paths.
            values = value if isinstance(value, list) else [value]
            for item in values:
                if not isinstance(item, str):
                    continue
                target = contained_path(package, item)
                if target is None or not target.exists():
                    errors.append(f"{relative}: {key} references a missing or unsafe package path")


def check_package_privacy(root, package, errors):
    # This detects risky artifacts, not all possible confidential prose. Source review remains required.
    for path in package.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            errors.append(f"{relative}: symlinks are not allowed in public packages")
            continue
        if any(part.lower() in SENSITIVE_DIRECTORIES for part in path.relative_to(package).parts):
            errors.append(f"{relative}: private/runtime artifact is not allowed in a public package")
            continue
        if not path.is_file():
            continue
        name = path.name.lower()
        if name in SENSITIVE_NAMES or name.startswith(".env") or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".sqlite", ".db"}:
            errors.append(f"{relative}: private/runtime artifact is not allowed in a public package")
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue  # Binary assets are permitted; filenames are still checked.
        if PRIVATE_KEY.search(content):
            errors.append(f"{relative}: private key material is not allowed")
        if path.suffix == ".json":
            try:
                document = json.loads(content)
            except json.JSONDecodeError:
                errors.append(f"{relative}: invalid package JSON")
                continue
            if sensitive_json(document):
                errors.append(f"{relative}: embedded credentials or tenant/user data are not allowed")
            if name == ".app.json":
                check_app_references(document, relative, errors)


def expected_source(distribution, client):
    kind = distribution.get("kind")
    if kind == "local":
        path = normalized_path(distribution.get("path"))
        return ("local", path) if client == "claude_code" else ("git-subdir", normalized_url(CATALOG_URL), path)
    if kind == "url":
        return ("url", normalized_url(distribution.get("url")))
    if kind == "git-subdir":
        return ("git-subdir", normalized_url(distribution.get("url")), normalized_path(distribution.get("path")))
    return None


def actual_source(source):
    if isinstance(source, str):
        return ("local", normalized_path(source))
    if not isinstance(source, dict):
        return None
    kind = source.get("source")
    if kind == "url":
        return (kind, normalized_url(source.get("url")))
    if kind == "git-subdir":
        return (kind, normalized_url(source.get("url")), normalized_path(source.get("path")))
    return None


def validate(root):
    root = Path(root).resolve()
    errors = []

    def load(relative):
        path = contained_path(root, relative)
        if path is None or not path.is_file():
            errors.append(f"{relative}: missing or unsafe local file")
            return None
        try:
            return read_json(path)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            errors.append(f"{relative}: cannot read valid JSON")
            return None

    inventory = load("catalog/plugin-readiness.json")
    if not isinstance(inventory, dict):
        return errors or ["inventory must be an object"]
    if inventory.get("schema_version") != 1:
        errors.append("inventory: unsupported schema_version")
    if sensitive_json(inventory):
        errors.append("inventory: embedded credentials or tenant/user data are not allowed")
    records = inventory.get("plugins")
    if not isinstance(records, list):
        return errors + ["inventory: plugins must be an array"]
    by_name = {}
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("name"), str):
            errors.append("inventory: every product needs a name")
            continue
        name = record["name"]
        if name in by_name:
            errors.append(f"inventory: duplicate product {name}")
        by_name[name] = record
    missing = REQUIRED_PRODUCTS - by_name.keys()
    if missing:
        errors.append("inventory: missing required products: " + ", ".join(sorted(missing)))

    packages = {}
    for name, record in by_name.items():
        distribution = record.get("distribution")
        clients = record.get("clients")
        if not isinstance(distribution, dict) or not isinstance(clients, dict):
            errors.append(f"{name}: distribution and clients must be objects")
            continue
        kind = distribution.get("kind")
        if kind == "none" and record.get("canonical_source") != {"status": "private_mapping_not_published"}:
            errors.append(f"{name}: keep private implementation mappings out of an unpackaged product record")
        if kind not in {"local", "url", "git-subdir", "none"}:
            errors.append(f"{name}: unsupported distribution kind")
        if kind in {"url", "git-subdir"}:
            url = distribution.get("url", "")
            if not isinstance(url, str) or not re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+(?:\.git)?", url):
                errors.append(f"{name}: external source must be a public-safe GitHub repository URL")
            if distribution.get("access") != "github_repository_permission_required":
                errors.append(f"{name}: external private source must declare GitHub repository access")
            if distribution.get("privacy") != "private_source_do_not_copy_into_public_catalog":
                errors.append(f"{name}: external private source must retain its publication boundary")
        if kind == "local":
            rel = distribution.get("path")
            package = contained_path(root, rel)
            if package is None or not package.is_dir() or not normalized_path(rel).startswith("plugins/"):
                errors.append(f"{name}: local package path is missing or unsafe")
            else:
                packages[name] = package
                check_package_privacy(root, package, errors)
                config = distribution.get("mcp_config")
                if config is not None:
                    path = contained_path(package, config)
                    if path is None:
                        errors.append(f"{name}: MCP configuration path is unsafe")
                    else:
                        document = load(path.relative_to(root).as_posix())
                        if not isinstance(document, dict) or not isinstance(document.get("mcpServers"), dict) or not document["mcpServers"]:
                            errors.append(f"{name}: declared MCP configuration must contain a server")
        for client in CATALOGS:
            state = clients.get(client)
            if not isinstance(state, dict) or type(state.get("listed")) is not bool or state.get("package_status") not in PACKAGE_STATES:
                errors.append(f"{name}/{client}: invalid client readiness")
                continue
            if state["package_status"] == "compatible" and not state["listed"]:
                errors.append(f"{name}/{client}: compatible package must be listed")
            if state["listed"] and kind == "none":
                errors.append(f"{name}/{client}: cannot list a package that does not exist")
            if state["package_status"] != "compatible" and not state.get("reason"):
                errors.append(f"{name}/{client}: non-ready state needs a reason")
            if state["listed"] and name in packages:
                manifest = state.get("manifest")
                if manifest not in MANIFESTS:
                    errors.append(f"{name}/{client}: no supported manifest declared")
                else:
                    content = load((packages[name].relative_to(root) / manifest).as_posix())
                    if isinstance(content, dict) and content.get("name") != name:
                        errors.append(f"{name}/{client}: manifest name disagrees with inventory")
        if not isinstance(record.get("live_checks"), dict) or not isinstance(record.get("cloud"), dict):
            errors.append(f"{name}: keep live checks and cloud availability explicit")

    plugins_dir = root / "plugins"
    registered = {package.relative_to(root).as_posix() for package in packages.values()}
    if plugins_dir.is_dir():
        for path in plugins_dir.iterdir():
            if path.relative_to(root).as_posix() not in registered:
                errors.append(f"{path.relative_to(root)}: undeclared package; do not copy private source into this public repository")

    for client, (catalog_name, relative) in CATALOGS.items():
        declared = inventory.get("catalogs", {}).get(client, {})
        if declared != {"name": catalog_name, "path": relative}:
            errors.append(f"inventory: {client} catalog identity/path changed unexpectedly")
        catalog = load(relative)
        if not isinstance(catalog, dict):
            continue
        if catalog.get("name") != catalog_name:
            errors.append(f"{relative}: catalog name must remain {catalog_name}")
        entries = catalog.get("plugins")
        if not isinstance(entries, list):
            errors.append(f"{relative}: plugins must be an array")
            continue
        seen = set()
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
                errors.append(f"{relative}: every entry needs a name")
                continue
            name = entry["name"]
            if name in seen:
                errors.append(f"{relative}: duplicate plugin {name}")
            seen.add(name)
            record = by_name.get(name)
            if record is None:
                errors.append(f"{relative}: {name} is missing from the inventory")
                continue
            state = record.get("clients", {}).get(client, {})
            if not state.get("listed"):
                errors.append(f"{relative}: {name} is listed before it is ready for this catalog")
            distribution = record.get("distribution", {})
            if actual_source(entry.get("source")) != expected_source(distribution, client):
                errors.append(f"{relative}: {name} source does not resolve to its declared distribution")
            if state.get("source_sha") is not None:
                source = entry.get("source")
                expected_sha = state["source_sha"]
                if not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", expected_sha):
                    errors.append(f"{name}/{client}: reviewed source pin must be a full commit SHA")
                elif not isinstance(source, dict) or source.get("sha") != expected_sha:
                    errors.append(f"{relative}: {name} must retain its reviewed source pin")
            if client == "codex":
                if entry.get("policy") != {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}:
                    errors.append(f"{relative}: {name} must preserve installation/authentication policy")
                if not re.fullmatch(r"\d+\.\d+\.\d+", str(entry.get("version", ""))):
                    errors.append(f"{relative}: {name} needs a release version")
            if name in packages:
                versions = set()
                for manifest in MANIFESTS:
                    path = packages[name] / manifest
                    if path.is_file() and not path.is_symlink():
                        content = load(path.relative_to(root).as_posix())
                        if isinstance(content, dict):
                            check_manifest_references(root, packages[name], content, path.relative_to(root).as_posix(), errors)
                            version = content.get("version")
                            if not isinstance(version, str):
                                errors.append(f"{name}: manifest version must be a string")
                            else:
                                versions.add(version)
                if len(versions) != 1 or not all(isinstance(v, str) and re.fullmatch(r"\d+\.\d+\.\d+", v) for v in versions):
                    errors.append(f"{name}: local manifest versions must agree")
                elif client == "codex" and entry.get("version") not in versions:
                    errors.append(f"{relative}: {name} version differs from its local package")
        expected = {name for name, record in by_name.items() if record.get("clients", {}).get(client, {}).get("listed")}
        for name in sorted(expected - seen):
            errors.append(f"{relative}: missing required plugin {name} (possible catalog overwrite)")
    return sorted(set(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    errors = validate(args.root)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("Catalog integrity passed. Private source access and live OAuth/tool operations were not tested.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
