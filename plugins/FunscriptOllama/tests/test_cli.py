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
                                    "chatgpt_cli" if label == "ChatGPT CLI" else "gemini_cli"])
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
        for provider in ("chatgpt_cli", "gemini_cli"):
            client = self.client(provider)
            client.check_model()
            self.assertTrue(client.region(self.frames)["active"])
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()]
        self.assertEqual([c["provider"] for c in calls], ["chatgpt_cli", "gemini_cli"])
        self.assertTrue(all(not Path(c["cwd"]).exists() for c in calls))
        self.assertTrue(all(c["codex_home"].endswith("codex") for c in calls))
        self.assertTrue(all(c["gemini_home"].endswith("gemini") for c in calls))
        messages = "\n".join(self.log.messages)
        self.assertNotIn("private-api-secret", messages)
        self.assertIn("Step OK: ChatGPT CLI region validated", messages)
        self.assertIn("Step OK: Gemini CLI region validated", messages)

    def test_codex_api_key_login_is_rejected_before_image_request(self):
        os.environ["FAKE_AUTH"] = "API key"
        with self.assertRaisesRegex(cli.ProviderUnavailableError, "API-key authentication is not accepted"):
            self.client("chatgpt_cli").check_model()
        self.assertFalse(self.trace.exists())

    def test_quota_stops_without_echoing_raw_credentials_or_changing_provider(self):
        os.environ["FAKE_MODE"] = "quota"
        with self.assertRaisesRegex(cli.ProviderUnavailableError, "quota/rate limit") as caught:
            self.client("gemini_cli").region(self.frames)
        self.assertEqual(len(self.trace.read_text().splitlines()), 1)
        self.assertNotIn("private-output-secret", str(caught.exception) + "\n".join(self.log.messages))

    def test_gemini_error_envelope_is_not_an_inactive_region(self):
        os.environ["FAKE_MODE"] = "error-envelope"
        with self.assertRaises(cli.ProviderUnavailableError) as caught:
            self.client("gemini_cli").region(self.frames)
        self.assertNotIn("private-output-secret", str(caught.exception))

    def test_invalid_region_retries_once_and_fenced_json_is_accepted(self):
        os.environ["FAKE_MODE"] = "invalid-once"
        self.assertTrue(self.client("gemini_cli").region(self.frames)["active"])
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertIn("Return valid JSON only", calls[-1]["prompt"])
        os.environ["FAKE_MODE"] = "invalid"
        with self.assertRaisesRegex(ValueError, "twice"):
            self.client("chatgpt_cli").region(self.frames)
        self.assertEqual(len(self.trace.read_text().splitlines()), 4)
        os.environ["FAKE_MODE"] = "fenced"
        self.assertTrue(self.client("gemini_cli").region(self.frames)["active"])

    def test_provider_task_uses_synthetic_images_and_preserves_queue(self):
        fake = FakeStash([{"id": "1", "tags": [{"id": "1"}]}])
        settings = plugin.configuration({"ai_provider": "gemini_cli"})
        fake.get_configuration = lambda **_: {"plugins": {plugin.PLUGIN_ID: settings}}
        result = plugin.run({"server_connection": {}, "args": {"mode": "test_provider"}}, lambda _: fake, self.log)
        self.assertIn("OK", result["output"])
        self.assertEqual(fake.scene_data["1"]["tags"], [{"id": "1"}])

    def test_both_cli_providers_complete_real_video_to_sidecar_and_tags_offline(self):
        texture = np.random.default_rng(42).integers(20, 230, (20, 20, 3), dtype=np.uint8)
        for provider in ("chatgpt_cli", "gemini_cli"):
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
                                                 "import_chapters": False, "export_chapters": False})
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
            summary = plugin.process_queue(fake, plugin.configuration({"ai_provider": "gemini_cli"}), self.log)
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(analyze.call_count, 1)
        self.assertTrue(all({"id": "1"} in s["tags"] for s in fake.scene_data.values()))

    def test_preset_preserves_selected_provider_account_paths_and_models(self):
        untouched = {"ai_provider", "codex_path", "gemini_path", "codex_model", "gemini_model", "cli_account_dir"}
        self.assertTrue(untouched.isdisjoint(plugin.RECOMMENDED_GENERATION_SETTINGS))
        for values in ({"ai_provider": "api"}, {"codex_path": "bad\ncommand"}, {"cli_account_dir": "relative"}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                plugin.configuration(values)
        self.assertEqual(plugin.selected_model(plugin.configuration({"ai_provider": "gemini_cli"})), "CLI account default")
        with patch.object(plugin, "vision_client", side_effect=AssertionError("local mode must not contact a provider")):
            self.assertEqual(plugin.process_queue(FakeStash(), plugin.configuration({"engine": "haven", "ai_provider": "chatgpt_cli"}), self.log)["created"], 0)


class ProcessTests(unittest.TestCase):
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
            package = root / "node_modules/@google/gemini-cli"
            script = package / "bundle/gemini.js"
            script.parent.mkdir(parents=True)
            script.write_text("// fixture")
            (package / "package.json").write_text(json.dumps({"bin": {"gemini": "bundle/gemini.js"}}))
            with patch.object(cli.shutil, "which", side_effect=lambda name: "node-exe" if name == "node" else str(root / "gemini.cmd")):
                self.assertEqual(cli.cli_command("gemini", "Gemini CLI"), ["node-exe", str(script.resolve())])
            script.unlink()
            with patch.object(cli.shutil, "which", return_value=str(root / "gemini.cmd")), self.assertRaisesRegex(RuntimeError, "no shell wrappers"):
                cli.cli_command("gemini", "Gemini CLI")


if __name__ == "__main__":
    unittest.main()
