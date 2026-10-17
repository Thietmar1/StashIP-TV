import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import numpy as np
import cv2
from test_plugin import plugin, FakeLog, FakeStash, ROOT
import cli_vision as cli


class CLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cli-test-")
        self.root = Path(self.temp.name)
        self.trace = self.root / "trace.jsonl"
        self.env = patch.dict(os.environ, {"FAKE_TRACE": str(self.trace), "FAKE_MODE": "ok", "FAKE_AUTH": "ChatGPT",
                              "OPENAI_API_KEY": "private-api-secret", "CODEX_API_KEY": "private-api-secret",
                              "GEMINI_API_KEY": "private-api-secret", "GOOGLE_API_KEY": "private-api-secret"})
        self.env.start()
        self.resolve = patch.object(cli, "cli_command", side_effect=lambda _, label:
                                   [sys.executable, str(ROOT / "tests/cli_fixture.py"),
                                    "chatgpt_cli" if label == "ChatGPT CLI" else "antigravity_cli"])
        self.resolve.start()
        self.log = FakeLog()
        self.frames = [np.zeros((32, 48, 3), np.uint8)] * 2

    def tearDown(self):
        self.resolve.stop()
        self.env.stop()
        self.temp.cleanup()

    def client(self, provider, **kwargs):
        settings = plugin.configuration({"ai_provider": provider, "cli_account_dir": str(self.root / "accounts"), **kwargs})
        return plugin.vision_client(settings, self.log)

    def test_real_process_contracts_images_account_mode_and_temporary_cleanup(self):
        for provider in ("chatgpt_cli", "antigravity_cli"):
            client = self.client(provider)
            client.check_model()
            self.assertTrue(client.region(self.frames)["active"])
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()]
        self.assertEqual([c["provider"] for c in calls], ["chatgpt_cli", "antigravity_cli"])
        self.assertTrue(all(not Path(c["cwd"]).exists() for c in calls))
        self.assertTrue(calls[0]["codex_home"].endswith("codex"))
        self.assertTrue(calls[1]["account_home"].endswith("antigravity"))
        self.assertEqual(calls[1]["timeout"], "10800s")
        messages = "\n".join(self.log.messages)
        self.assertNotIn("private-api-secret", messages)
        self.assertIn("Step OK: ChatGPT CLI region validated", messages)
        self.assertIn("Step OK: Antigravity CLI region validated", messages)

    def test_codex_api_key_login_is_rejected_before_image_request(self):
        os.environ["FAKE_AUTH"] = "API key"
        with self.assertRaisesRegex(cli.ProviderUnavailableError, "API-key authentication is not accepted"):
            self.client("chatgpt_cli").check_model()
        self.assertFalse(self.trace.exists())

    def test_quota_stops_without_echoing_raw_credentials_or_changing_provider(self):
        os.environ["FAKE_MODE"] = "quota"
        with self.assertRaisesRegex(cli.ProviderUnavailableError, "quota/rate limit") as caught:
            self.client("antigravity_cli").region(self.frames)
        self.assertEqual(len(self.trace.read_text().splitlines()), 1)
        self.assertNotIn("private-output-secret", str(caught.exception) + "\n".join(self.log.messages))

    def test_antigravity_error_envelope_is_not_an_inactive_region(self):
        os.environ["FAKE_MODE"] = "error-envelope"
        with self.assertRaises(cli.ProviderUnavailableError) as caught:
            self.client("antigravity_cli").region(self.frames)
        self.assertNotIn("private-output-secret", str(caught.exception))

    def test_invalid_region_retries_once_and_fenced_json_is_accepted(self):
        os.environ["FAKE_MODE"] = "invalid-once"
        self.assertTrue(self.client("antigravity_cli").region(self.frames)["active"])
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertIn("Return valid JSON only", calls[-1]["prompt"])
        os.environ["FAKE_MODE"] = "invalid"
        with self.assertRaisesRegex(ValueError, "twice"):
            self.client("chatgpt_cli").region(self.frames)
        self.assertEqual(len(self.trace.read_text().splitlines()), 4)
        os.environ["FAKE_MODE"] = "fenced"
        self.assertTrue(self.client("chatgpt_cli").region(self.frames)["active"])

    def test_provider_task_uses_synthetic_images_and_preserves_queue(self):
        fake = FakeStash([{"id": "1", "tags": [{"id": "1"}]}])
        settings = plugin.configuration({"ai_provider": "antigravity_cli", "cli_account_dir": str(self.root / "accounts")})
        fake.get_configuration = lambda **_: {"plugins": {plugin.PLUGIN_ID: settings}}
        result = plugin.run({"server_connection": {}, "args": {"mode": "test_provider"}}, lambda _: fake, self.log)
        self.assertIn("OK", result["output"])
        self.assertEqual(fake.scene_data["1"]["tags"], [{"id": "1"}])

    def test_both_cli_providers_complete_real_video_to_sidecar_and_tags_offline(self):
        texture = np.random.default_rng(42).integers(20, 230, (20, 20, 3), dtype=np.uint8)
        for provider in ("chatgpt_cli", "antigravity_cli"):
            with self.subTest(provider=provider):
                video = self.root / (provider + ".avi")
                writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 20, (96, 96))
                self.assertTrue(writer.isOpened())
                for index in range(80):
                    frame = np.zeros((96, 96, 3), np.uint8)
                    y = round(38 + 12 * np.sin(index / 4))
                    frame[y:y+20, 38:58] = texture
                    writer.write(frame)
                writer.release()
                fake = FakeStash([{"id": "1", "files": [{"path": str(video)}], "tags": [{"id": "1"}, {"id": "2"}]}])
                settings = plugin.configuration({"ai_provider": provider, "engine": "ollama",
                                                 "cli_account_dir": str(self.root / "accounts"), "import_chapters": False, "export_chapters": False})
                result = plugin.process_queue(fake, settings, self.log)
                self.assertEqual(result, {"created": 1, "skipped": 0, "failed": 0})
                script = json.loads(video.with_suffix(".funscript").read_text())
                self.assertEqual(script["metadata"]["ai_provider"], provider)
                self.assertEqual(script["metadata"]["model"], "CLI account default")
                self.assertGreater(len(script["actions"]), 4)
                self.assertNotIn({"id": "1"}, fake.scene_data["1"]["tags"])
                self.assertIn({"id": "2"}, fake.scene_data["1"]["tags"])

    def test_provider_outage_stops_remaining_queue_and_keeps_tags(self):
        video = self.root / "video.mp4"
        video.write_bytes(b"fixture")
        fake = FakeStash([{"id": str(i), "files": [{"path": str(video)}], "tags": [{"id": "1"}]} for i in range(3)])
        with patch.object(plugin, "vision_client") as factory, patch.object(plugin, "analyze_video", side_effect=cli.ProviderUnavailableError("quota")) as analyze:
            summary = plugin.process_queue(fake, plugin.configuration({"ai_provider": "antigravity_cli"}), self.log)
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(analyze.call_count, 1)
        self.assertTrue(all({"id": "1"} in s["tags"] for s in fake.scene_data.values()))

    def test_preset_preserves_selected_provider_account_paths_and_models(self):
        untouched = {"ai_provider", "codex_path", "antigravity_path", "codex_model", "antigravity_model", "cli_account_dir"}
        self.assertTrue(untouched.isdisjoint(plugin.RECOMMENDED_GENERATION_SETTINGS))
        for values in ({"ai_provider": "api"}, {"codex_path": "bad\ncommand"}, {"cli_account_dir": "relative"}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                plugin.configuration(values)
        self.assertEqual(plugin.selected_model(plugin.configuration({"ai_provider": "antigravity_cli"})), "CLI account default")
        with patch.object(plugin, "vision_client", side_effect=AssertionError("local mode must not contact a provider")):
            self.assertEqual(plugin.process_queue(FakeStash(), plugin.configuration({"engine": "haven", "ai_provider": "chatgpt_cli"}), self.log)["created"], 0)


    def test_native_help_on_stderr_is_accepted_and_ide_launcher_is_rejected(self):
        client = self.client("antigravity_cli")
        with patch.object(client, "invoke", side_effect=[("1.4.0", ""), ("", "--json-schema --print-timeout --disable-slash-commands")]):
            client.check_model()
        with patch.object(client, "invoke", side_effect=[("Desktop", ""), ("--open-file", "")]):
            with self.assertRaisesRegex(cli.ProviderUnavailableError, "official Antigravity"):
                client.check_model()

    def test_legacy_provider_migrates_without_old_executable_or_model_alias(self):
        settings = plugin.configuration({"ai_provider": "gemini_cli", "gemini_path": "old-gemini.cmd",
                                         "gemini_model": "pro"})
        self.assertEqual(settings["ai_provider"], "antigravity_cli")
        self.assertEqual(settings["antigravity_path"], "agy")
        self.assertEqual(settings["antigravity_model"], "")
        self.assertEqual(plugin.configuration({"ai_provider": "antigravity"})["ai_provider"], "antigravity_cli")

    def test_failure_status_partial_timeout_and_missing_result_fail_closed(self):
        for mode in ("status-error", "status-waiting", "status-canceled", "missing-status",
                     "missing-structured", "partial-timeout", "empty-success"):
            with self.subTest(mode=mode):
                os.environ["FAKE_MODE"] = mode
                with self.assertRaises(cli.ProviderUnavailableError) as caught:
                    self.client("antigravity_cli").region(self.frames)
                self.assertNotIn("private-output-secret", str(caught.exception))
        self.assertEqual(len(self.trace.read_text().splitlines()), 7)

    def test_explicit_model_and_timeout_are_forwarded(self):
        self.client("antigravity_cli", antigravity_model="exact-model-slug", timeout_seconds=120).region(self.frames)
        call = json.loads(self.trace.read_text().splitlines()[0])
        self.assertEqual(call["timeout"], "120s")
        self.assertEqual(call["args"][call["args"].index("--model")+1], "exact-model-slug")

    def test_sparse_cli_settings_and_empty_mcp_placeholder_remain_usable(self):
        settings = plugin.configuration({"ai_provider": "antigravity_cli", "cli_account_dir": str(self.root)})
        home = cli.prepare_antigravity_profile(settings)
        config = home / ".gemini/antigravity-cli/settings.json"
        value = json.loads(config.read_text())
        del value["allowNonWorkspaceAccess"]  # agy omits its false default when saving.
        config.write_text(json.dumps(value), encoding="utf-8")
        mcp = home / ".gemini/config/mcp_config.json"
        mcp.parent.mkdir(parents=True, exist_ok=True)
        for placeholder in ("", " \n\t", "\ufeff\n"):
            with self.subTest(placeholder=repr(placeholder)):
                mcp.write_text(placeholder, encoding="utf-8")
                before = (config.read_bytes(), mcp.read_bytes())
                env = cli.account_environment(settings)
                self.assertEqual(env["USERPROFILE"], str(home))
                self.assertEqual((config.read_bytes(), mcp.read_bytes()), before)
        for content in ("{", "null", '{"mcpServers":{"enabled":{"command":"bad"}}}'):
            mcp.write_text(content, encoding="utf-8")
            with self.assertRaises(cli.ProviderUnavailableError):
                cli.account_environment(settings)

    def test_reserved_profile_rejects_api_mode_hooks_mcp_and_unsafe_permissions(self):
        settings = plugin.configuration({"ai_provider": "antigravity_cli", "cli_account_dir": str(self.root)})
        home = cli.prepare_antigravity_profile(settings)
        config = home / ".gemini/antigravity-cli/settings.json"
        safe = config.read_text()
        for field, value in (("modelProvider", "gemini"), ("toolPermission", "always-proceed"),
                             ("allowNonWorkspaceAccess", True), ("permissions", {"deny": []})):
            changed = json.loads(safe)
            changed[field] = value
            config.write_text(json.dumps(changed))
            with self.assertRaises(cli.ProviderUnavailableError):
                cli.account_environment(settings)
            config.write_text(safe)
        for name, value in (("hooks.json", {"hooks": {"start": [{"command": "bad"}]}}),
                            ("mcp_config.json", {"mcpServers": {"bad": {"command": "bad"}}}),
                            ("config.json", {"userSettings": {"enableAdc": True}})):
            extra = config.parent / name
            extra.write_text(json.dumps(value))
            with self.assertRaises(cli.ProviderUnavailableError):
                cli.account_environment(settings)
            extra.unlink()
        with patch.dict(os.environ, {"AGY_ADC_AUTH": "true", "GOOGLE_GEMINI_BASE_URL": "private-endpoint",
                                     "ANTIGRAVITY_GEMINI_DIR": "untrusted", "AGY_LLM_GATEWAY_API_KEY": "private-key"}):
            env = cli.account_environment(settings)
        self.assertEqual(env["HOME"], str(home))
        self.assertEqual(env["USERPROFILE"], str(home))
        for key in ("AGY_ADC_AUTH", "GOOGLE_GEMINI_BASE_URL", "ANTIGRAVITY_GEMINI_DIR", "AGY_LLM_GATEWAY_API_KEY"):
            self.assertNotIn(key, env)
        self.assertEqual(config.read_text(), safe)


class ProcessTests(unittest.TestCase):
    def test_antigravity_requires_native_executable(self):
        with patch.object(cli.shutil, "which", return_value="C:/agy/agy.exe"):
            self.assertEqual(cli.cli_command("agy", "Antigravity CLI"), [str(Path("C:/agy/agy.exe"))])
        with patch.object(cli.shutil, "which", return_value="C:/agy/agy.cmd"):
            with self.assertRaisesRegex(cli.ProviderUnavailableError, "native agy"):
                cli.cli_command("agy", "Antigravity CLI")
    def test_exited_launcher_does_not_leave_a_worker_holding_capture_files(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "orphan-survived"
            child = "import time;from pathlib import Path;time.sleep(1);Path("+repr(str(marker))+").write_text('bad')"
            parent = "import subprocess,sys;subprocess.Popen([sys.executable,'-c',"+repr(child)+"]);print('finished')"
            out, _ = cli.run_cli([sys.executable, "-c", parent], cwd=directory, env=os.environ.copy(), timeout=10, label="fixture")
            self.assertIn("finished", out)
            self.assertEqual(list(Path(directory).iterdir()), [])  # No named raw-output logs remain.
            time.sleep(1.1)
            self.assertFalse(marker.exists())

    def test_output_cap_and_process_tree_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(cli.ProviderUnavailableError, "2 MiB"):
                cli.run_cli([sys.executable, "-c", "import sys;sys.stdout.write('x'*3000000)"], cwd=directory,
                            env=os.environ.copy(), timeout=10, label="fixture")
            marker = Path(directory) / "child-survived"
            child = "import time;from pathlib import Path;time.sleep(1);Path("+repr(str(marker))+").write_text('bad')"
            parent = "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',"+repr(child)+"]);time.sleep(20)"
            with self.assertRaisesRegex(cli.ProviderUnavailableError, "timed out"):
                cli.run_cli([sys.executable, "-c", parent], cwd=directory, env=os.environ.copy(), timeout=0.3, label="fixture")
            time.sleep(1.1)
            self.assertFalse(marker.exists(), "timeout must stop descendants as well")

    def test_windows_npm_shim_resolves_to_node_without_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "node_modules/@openai/codex"
            script = package / "bin/codex.js"
            script.parent.mkdir(parents=True)
            script.write_text("// fixture")
            (package / "package.json").write_text(json.dumps({"bin": {"codex": "bin/codex.js"}}))
            with patch.object(cli.shutil, "which", side_effect=lambda name: "node-exe" if name == "node" else str(root / "codex.cmd")):
                self.assertEqual(cli.cli_command("codex", "ChatGPT CLI"), ["node-exe", str(script.resolve())])
            script.unlink()
            with patch.object(cli.shutil, "which", return_value=str(root / "codex.cmd")), self.assertRaisesRegex(RuntimeError, "no shell wrappers"):
                cli.cli_command("codex", "ChatGPT CLI")


if __name__ == "__main__":
    unittest.main()
