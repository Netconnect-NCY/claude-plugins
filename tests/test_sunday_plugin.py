"""Offline release checks for Sunday's discoverable, self-contained package."""

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "plugins" / "sunday"
ENDPOINT = "https://sunday.work/api/v1/mcp/rpc"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


class SundayPackageTests(unittest.TestCase):
    def test_portable_manifest_is_discoverable(self):
        manifest = read_json(PACKAGE / "plugin.json")
        self.assertEqual(manifest["$schema"],
                         "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
        self.assertEqual(manifest["name"], "sunday")
        self.assertRegex(manifest["version"], r"^\d+\.\d+\.\d+$")
        self.assertNotIn("mcpServers", manifest)
        self.assertNotIn("apps", manifest)
        interface = manifest["extensions"]["com.openai"]["interface"]
        self.assertEqual(interface["displayName"], "Sunday")
        self.assertLessEqual(len(interface["shortDescription"]), 30)
        self.assertEqual(interface["category"], "Productivity")

    def test_compatibility_manifests_preserve_identity_and_version(self):
        portable = read_json(PACKAGE / "plugin.json")
        for path in [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]:
            with self.subTest(path=path):
                compatibility = read_json(PACKAGE / path)
                self.assertEqual(compatibility["name"], portable["name"])
                self.assertEqual(compatibility["version"], portable["version"])
        codex = read_json(PACKAGE / ".codex-plugin/plugin.json")
        self.assertTrue((PACKAGE / codex["mcpServers"]).is_file())
        self.assertEqual(codex["interface"],
                         portable["extensions"]["com.openai"]["interface"])

    def test_native_catalog_lists_the_installable_sunday_package(self):
        marketplace = read_json(ROOT / ".agents/plugins/marketplace.json")
        self.assertEqual(marketplace["name"], "netconnect-claude-plugins")
        entries = [p for p in marketplace["plugins"] if p["name"] == "sunday"]
        self.assertEqual(len(entries), 1, "Sunday must survive other plugin releases")
        entry = entries[0]
        self.assertEqual(entry["version"], read_json(PACKAGE / "plugin.json")["version"])
        self.assertEqual(entry["source"], {
            "source": "git-subdir",
            "url": "https://github.com/Netconnect-NCY/claude-plugins.git",
            "path": "plugins/sunday",
        })
        self.assertTrue((ROOT / entry["source"]["path"] / "plugin.json").is_file())
        self.assertEqual(entry["policy"], {
            "installation": "AVAILABLE", "authentication": "ON_INSTALL"})

    def test_claude_catalog_still_resolves_sunday(self):
        marketplace = read_json(ROOT / ".claude-plugin/marketplace.json")
        entries = [p for p in marketplace["plugins"] if p["name"] == "sunday"]
        self.assertEqual(len(entries), 1)
        self.assertEqual((ROOT / entries[0]["source"]).resolve(), PACKAGE.resolve())

    def test_remote_mcp_and_provided_public_oauth_agree(self):
        config = read_json(PACKAGE / "mcp.json")
        self.assertEqual(config["$schema"],
                         "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json")
        self.assertEqual(list(config["mcpServers"]), ["sunday"])
        server = config["mcpServers"]["sunday"]
        self.assertEqual(server["type"], "streamable-http")
        self.assertEqual(server["url"], ENDPOINT)
        auth = server["extensions"]["com.openai"]["auth"]
        self.assertEqual(auth["type"], "oauth")
        self.assertEqual(auth["resource"], ENDPOINT)
        self.assertEqual(auth["client"], {
            "mode": "provided", "clientId": "sunday-mcp",
            "tokenEndpointAuthMethod": "none"})
        self.assertEqual(auth["baseScopes"], ["offline_access"])
        self.assertEqual(set(auth["defaultScopes"]), {"openid", "profile", "email"})
        for key, suffix in [("authorizationUrl", "auth"), ("tokenUrl", "token")]:
            self.assertEqual(auth[key],
                "https://auth.netconnect.ro/auth/realms/netconnect/protocol/openid-connect/" + suffix)
        legacy = read_json(PACKAGE / ".mcp.json")["mcpServers"]["sunday"]
        self.assertEqual(legacy["url"], server["url"])
        self.assertEqual(legacy["oauth"]["clientId"], auth["client"]["clientId"])

    def test_package_contains_no_local_runtime_or_credentials(self):
        forbidden_keys = {"clientsecret", "client_secret", "authorization",
                          "access_token", "refresh_token", "command", "args", "env"}

        def inspect(value, path):
            if isinstance(value, dict):
                for key, child in value.items():
                    self.assertNotIn(key.lower(), forbidden_keys, f"{path}: {key}")
                    inspect(child, path)
            elif isinstance(value, list):
                for child in value:
                    inspect(child, path)

        for path in PACKAGE.rglob("*"):
            self.assertFalse(path.is_symlink(), str(path))
            self.assertNotIn(path.name, {"node_modules", "hooks"})
            if path.suffix == ".json":
                inspect(read_json(path), path.relative_to(PACKAGE))

    def test_skill_is_portable_and_self_contained(self):
        skills = list((PACKAGE / "skills").glob("*/SKILL.md"))
        self.assertEqual(len(skills), 1)
        content = skills[0].read_text(encoding="utf-8")
        frontmatter = re.match(r"\A---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n", content)
        self.assertIsNotNone(frontmatter)
        self.assertEqual(frontmatter.group(1), skills[0].parent.name)
        self.assertEqual(frontmatter.group(1), "working-with-sunday")
        self.assertGreater(len(frontmatter.group(2)), 20)
        self.assertLess(len(content.encode()), 1024 * 1024)
        for target in re.findall(r"\]\(([^)]+)\)", content):
            if not target.startswith(("https://", "http://", "#")):
                referenced = (skills[0].parent / target.split("#")[0]).resolve()
                self.assertTrue(referenced.is_relative_to(PACKAGE.resolve()))
                self.assertTrue(referenced.exists())


if __name__ == "__main__":
    unittest.main()
