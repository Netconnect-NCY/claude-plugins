"""Regressions for omitted plugins, publisher overwrites and unsafe public artifacts."""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_marketplace", ROOT / "scripts/check_marketplace.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class MarketplaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "catalog"
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns(".git", "__pycache__"))

    def change_json(self, path, change):
        file = self.root / path
        document = json.loads(file.read_text())
        change(document)
        file.write_text(json.dumps(document))

    def assert_invalid(self, phrase):
        errors = CHECK.validate(self.root)
        self.assertTrue(any(phrase in error for error in errors), errors)
        return errors

    def test_current_catalog_and_inventory_agree(self):
        self.assertEqual(CHECK.validate(self.root), [])

    def test_missing_ready_native_entry_is_rejected(self):
        self.change_json(".agents/plugins/marketplace.json",
                         lambda d: d.update(plugins=[p for p in d["plugins"] if p["name"] != "ssh-fleet"]))
        self.assert_invalid("missing required plugin ssh-fleet")

    def test_publisher_replacing_the_shared_catalog_with_only_its_entry_is_rejected(self):
        self.change_json(".agents/plugins/marketplace.json",
                         lambda d: d.update(plugins=[p for p in d["plugins"] if p["name"] == "swarm2"]))
        errors = self.assert_invalid("possible catalog overwrite")
        for name in ("sunday", "ssh-fleet", "ssh-fleet-connect", "golden-path"):
            self.assertTrue(any(f"missing required plugin {name}" in error for error in errors))

    def test_reviewed_external_source_pin_cannot_disappear(self):
        self.change_json(".agents/plugins/marketplace.json",
                         lambda d: next(p for p in d["plugins"] if p["name"] == "golden-path")["source"].pop("sha"))
        self.assert_invalid("golden-path must retain its reviewed source pin")

    def test_ready_product_cannot_be_hidden_by_changing_both_catalog_and_inventory(self):
        self.change_json(".agents/plugins/marketplace.json",
                         lambda d: d.update(plugins=[p for p in d["plugins"] if p["name"] != "sunday"]))
        def hide(document):
            next(p for p in document["plugins"] if p["name"] == "sunday")["clients"]["codex"]["listed"] = False
        self.change_json("catalog/plugin-readiness.json", hide)
        self.assert_invalid("compatible package must be listed")

    def test_required_product_cannot_disappear_from_inventory(self):
        self.change_json("catalog/plugin-readiness.json",
                         lambda d: d.update(plugins=[p for p in d["plugins"] if p["name"] != "odoo"]))
        self.assert_invalid("missing required products: odoo")

    def test_duplicate_catalog_entry_is_rejected(self):
        self.change_json(".agents/plugins/marketplace.json", lambda d: d["plugins"].append(d["plugins"][0]))
        self.assert_invalid("duplicate plugin swarm2")

    def test_nonexistent_odoo_package_cannot_be_advertised(self):
        self.change_json(".agents/plugins/marketplace.json", lambda d: d["plugins"].append({
            "name": "odoo", "version": "1.0.0", "source": {"source": "git-subdir", "url": CHECK.CATALOG_URL, "path": "plugins/odoo"}}))
        self.assert_invalid("odoo is listed before it is ready")

    def test_unresolvable_local_source_is_rejected(self):
        self.change_json(".claude-plugin/marketplace.json",
                         lambda d: next(p for p in d["plugins"] if p["name"] == "sunday").update(source="./plugins/missing"))
        self.assert_invalid("sunday source does not resolve")

    def test_missing_local_manifest_is_rejected(self):
        (self.root / "plugins/ssh-fleet-connect/.claude-plugin/plugin.json").unlink()
        self.assert_invalid("missing or unsafe local file")

    def test_declared_mcp_connection_cannot_disappear(self):
        (self.root / "plugins/ssh-fleet-connect/.mcp.json").unlink()
        self.assert_invalid("declared MCP configuration must contain a server")

    def test_manifest_cannot_point_outside_its_package(self):
        self.change_json("plugins/sunday/.codex-plugin/plugin.json", lambda d: d.update(mcpServers="../../private.json"))
        self.assert_invalid("mcpServers references a missing or unsafe package path")

    def test_declared_app_manifest_must_exist(self):
        self.change_json("plugins/sunday/.codex-plugin/plugin.json", lambda d: d.update(apps="./.app.json"))
        self.assert_invalid("apps references a missing or unsafe package path")

    def test_native_version_must_follow_the_local_package(self):
        self.change_json(".agents/plugins/marketplace.json",
                         lambda d: next(p for p in d["plugins"] if p["name"] == "sunday").update(version="0.0.1"))
        self.assert_invalid("sunday version differs")

    def test_generated_swarm_version_can_advance_without_inventory_edits(self):
        for name in ("plugin.json", ".claude-plugin/plugin.json"):
            self.change_json("plugins/swarm2/" + name, lambda d: d.update(version="0.6.999"))
        self.change_json(".agents/plugins/marketplace.json",
                         lambda d: next(p for p in d["plugins"] if p["name"] == "swarm2").update(version="0.6.999"))
        self.assertEqual(CHECK.validate(self.root), [])

    def test_private_source_requires_explicit_github_access(self):
        self.change_json("catalog/plugin-readiness.json",
                         lambda d: next(p for p in d["plugins"] if p["name"] == "ssh-fleet")["distribution"].update(access="public"))
        self.assert_invalid("must declare GitHub repository access")

    def test_copying_private_package_into_public_repository_is_rejected(self):
        package = self.root / "plugins/ssh-fleet/skills/network-operations"
        package.mkdir(parents=True)
        (package / "SKILL.md").write_text("Private source content")
        self.assert_invalid("undeclared package; do not copy private source")

    def test_path_traversal_in_local_distribution_is_rejected(self):
        self.change_json("catalog/plugin-readiness.json",
                         lambda d: next(p for p in d["plugins"] if p["name"] == "sunday")["distribution"].update(path="../private"))
        self.assert_invalid("local package path is missing or unsafe")

    def test_symlink_in_package_is_rejected_without_reading_target(self):
        (self.root / "plugins/sunday/secret-link").symlink_to(self.root.parent / "not-present")
        self.assert_invalid("symlinks are not allowed")

    def test_sensitive_artifact_filenames_are_rejected(self):
        for name in (".env", "credentials.json", "inventory.sqlite"):
            with self.subTest(name=name):
                path = self.root / "plugins/sunday" / name
                path.write_text("{}")
                self.assert_invalid("private/runtime artifact")
                path.unlink()

    def test_valid_nonsecret_app_reference_is_supported(self):
        # Synthetic documentation ID only; this does not claim a live app exists.
        path = self.root / "plugins/ssh-fleet-connect/.app.json"
        path.write_text(json.dumps({"apps": {"example": {"id": "asdk_app_example", "required": True}}}))
        self.assertEqual(CHECK.validate(self.root), [])

    def test_app_reference_cannot_embed_credentials(self):
        path = self.root / "plugins/ssh-fleet-connect/.app.json"
        path.write_text(json.dumps({"apps": {"example": {
            "id": "asdk_app_example", "required": True, "clientSecret": "DO_NOT_ECHO_THIS_VALUE"}}}))
        errors = self.assert_invalid("embedded credentials or tenant/user data")
        self.assertNotIn("DO_NOT_ECHO_THIS_VALUE", "\n".join(errors))

    def test_app_reference_flags_and_id_format_are_checked(self):
        path = self.root / "plugins/ssh-fleet-connect/.app.json"
        path.write_text(json.dumps({"apps": {"example": {"id": "asdk_app_example", "required": "yes"}}}))
        self.assert_invalid("flags must be booleans")
        path.write_text(json.dumps({"apps": {"example": {"id": "plugin_asdk_app_example"}}}))
        self.assert_invalid("supported registered app ID")

    def test_schema_field_names_and_explicit_placeholders_are_not_stored_secrets(self):
        path = self.root / "plugins/sunday/example-schema.json"
        path.write_text(json.dumps({"properties": {"password": {"type": "string"},
                                                  "tenant_id": {"type": "string"}},
                                    "example": {"password": "<password>", "tenant_id": "example-tenant"}}))
        self.assertEqual(CHECK.validate(self.root), [])

    def test_unpackaged_product_does_not_publish_a_private_implementation_mapping(self):
        self.change_json("catalog/plugin-readiness.json",
                         lambda d: next(p for p in d["plugins"] if p["name"] == "odoo").update(
                             canonical_source={"repository": "https://github.com/example/private-implementation"}))
        self.assert_invalid("keep private implementation mappings out")

    def test_embedded_secret_and_tenant_data_are_rejected_without_echoing_values(self):
        for field in ("clientSecret", "access_token", "tenant_id", "user_id"):
            with self.subTest(field=field):
                path = self.root / "plugins/sunday/accidental-export.json"
                path.write_text(json.dumps({field: "DO_NOT_ECHO_THIS_VALUE"}))
                errors = self.assert_invalid("embedded credentials or tenant/user data")
                self.assertNotIn("DO_NOT_ECHO_THIS_VALUE", "\n".join(errors))
                path.unlink()

    def test_claude_compatibility_manifest_and_implicit_mcp_file_are_accepted(self):
        # The real public connection-only package exercises this supported layout.
        package = self.root / "plugins/ssh-fleet-connect"
        self.assertFalse((package / "plugin.json").exists())
        manifest = json.loads((package / ".claude-plugin/plugin.json").read_text())
        self.assertNotIn("mcpServers", manifest)
        self.assertTrue((package / ".mcp.json").is_file())
        self.assertEqual(CHECK.validate(self.root), [])


if __name__ == "__main__":
    unittest.main()
