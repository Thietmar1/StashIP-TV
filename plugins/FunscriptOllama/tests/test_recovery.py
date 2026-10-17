"""Long-running Stash authentication and publication recovery (synthetic data)."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from test_plugin import plugin, FakeLog, FakeStash


class PersistentAuthTests(unittest.TestCase):
    def setUp(self):
        self.key = "private-local-stash-key"
        self.protected, self.expired = True, False
        self.seen = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                key, cookie = self.headers.get("ApiKey"), self.headers.get("Cookie", "")
                owner.seen.append((body["query"], key, cookie, owner.expired))
                allowed = (not owner.protected or bool(owner.key and key == owner.key) or
                           (not owner.expired and "session=private-session" in cookie))
                if not allowed:
                    self.send_response(401)
                    self.end_headers()
                    return
                query = body["query"]
                if "StashVersion" in query:
                    data = {"version": {"version": "v0.31.1", "hash": "test", "build_time": "2026-01-01"}}
                elif "getApiKey" in query:
                    data = {"configuration": {"general": {"apiKey": owner.key}}}
                elif "__schema" in query:
                    data = {"__schema": {"types": []}}
                elif "FindScene" in query:
                    data = {"findScene": {"id": "1596", "scene_markers": []}}
                else:
                    data = {"configuration": {"plugins": {}}}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"data": data}).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connection = {"Scheme": "http", "Host": "127.0.0.1", "Port": self.server.server_port,
                           "SessionCookie": {"Value": "private-session"}}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def test_real_stash_client_survives_cookie_expiry_without_logging_credentials(self):
        log = FakeLog()
        def delayed_work(stash, settings, task_log):
            self.expired = True  # Represent hours passing without waiting for wall time.
            self.assertEqual(stash.find_scene("1596", fragment="id scene_markers { id }")["id"], "1596")
            return {"created": 1, "skipped": 0, "failed": 0}
        with patch.object(plugin, "process_queue", side_effect=delayed_work) as process:
            result = plugin.run({"server_connection": self.connection}, log=log)
        self.assertFalse(result["error"])
        process.assert_called_once()
        after = [(key, cookie) for _, key, cookie, expired in self.seen if expired]
        self.assertTrue(after)
        self.assertTrue(all(key == self.key and not cookie for key, cookie in after))
        text = "\n".join(log.messages) + json.dumps(result)
        self.assertNotIn(self.key, text)
        self.assertNotIn("private-session", text)
        self.assertIn("Persistent Stash connection verified", text)

    def test_missing_api_key_on_protected_server_stops_before_processing(self):
        self.key = ""
        with patch.object(plugin, "process_queue") as process:
            with self.assertRaisesRegex(RuntimeError, "Generate an API key in Stash"):
                plugin.run({"server_connection": self.connection}, log=FakeLog())
        process.assert_not_called()

    def test_unprotected_server_does_not_require_api_key(self):
        self.key, self.protected = "", False
        with patch.object(plugin, "process_queue", return_value={"created": 0, "skipped": 0, "failed": 0}):
            result = plugin.run({"server_connection": self.connection}, log=FakeLog())
        self.assertFalse(result["error"])


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.video = Path(self.temp.name) / "synthetic.mp4"
        self.video.write_bytes(b"synthetic-media-identity")
        self.output = self.video.with_suffix(".funscript")
        self.pending = self.output.with_name("." + self.output.name + ".pending.json")
        self.fake = FakeStash([{"id": "1596", "files": [{"path": str(self.video)}],
                                "tags": [{"id": "1"}, {"id": "2"}], "scene_markers": []}])
        self.settings = plugin.configuration({})
        self.script = {"version": "1.0", "actions": [{"at": 0, "pos": 20}, {"at": 1000, "pos": 80}],
                       "metadata": {"creator": "synthetic test"}}
        self.log = FakeLog()

    def checkpoint(self, script=None):
        context = plugin.recovery_context(self.video, "1596", self.settings, False)
        plugin.save_script(self.pending, {"context": context, "script": script or self.script})

    def test_completed_analysis_survives_chapter_401_and_resumes_without_ai(self):
        find_scene = self.fake.find_scene
        def expired(scene_id, **kwargs):
            if "scene_markers" in kwargs.get("fragment", ""):
                raise Exception("401 Unauthorized query failed. v0.31.1-0")
            return find_scene(scene_id, **kwargs)
        with patch.object(plugin, "vision_client"), patch.object(plugin, "analyze_video", return_value=copy.deepcopy(self.script)), \
             patch.object(self.fake, "find_scene", side_effect=expired):
            first = plugin.process_queue(self.fake, self.settings, self.log)
        self.assertEqual(first, {"created": 0, "skipped": 0, "failed": 1})
        self.assertTrue(self.pending.is_file())
        self.assertFalse(self.output.exists())
        self.assertEqual(json.loads(self.pending.read_text())["script"], self.script)
        self.assertIn({"id": "1"}, self.fake.scene_data["1596"]["tags"])
        with patch.object(plugin, "vision_client") as provider, patch.object(plugin, "analyze_video") as analyze:
            second = plugin.process_queue(self.fake, self.settings, self.log)
        self.assertEqual(second, {"created": 1, "skipped": 0, "failed": 0})
        provider.assert_not_called()
        analyze.assert_not_called()
        self.assertEqual(json.loads(self.output.read_text())["actions"], self.script["actions"])
        self.assertFalse(self.pending.exists())
        self.assertNotIn({"id": "1"}, self.fake.scene_data["1596"]["tags"])
        self.assertIn({"id": "2"}, self.fake.scene_data["1596"]["tags"])
        self.assertIn("Completed analysis recovered locally", "\n".join(self.log.messages))

    def test_publication_failure_keeps_checkpoint_for_retry(self):
        save = plugin.save_script
        def fail_publication(path, *args, **kwargs):
            if Path(path) == self.output:
                raise OSError("synthetic publication failure")
            return save(path, *args, **kwargs)
        with patch.object(plugin, "vision_client"), patch.object(plugin, "analyze_video", return_value=self.script), \
             patch.object(plugin, "save_script", side_effect=fail_publication):
            self.assertEqual(plugin.process_queue(self.fake, self.settings, self.log)["failed"], 1)
        self.assertTrue(self.pending.exists())
        self.assertFalse(self.output.exists())
        with patch.object(plugin, "vision_client") as provider, patch.object(plugin, "analyze_video") as analyze:
            self.assertEqual(plugin.process_queue(self.fake, self.settings, self.log)["created"], 1)
        provider.assert_not_called()
        analyze.assert_not_called()

    def test_source_changed_during_analysis_is_not_checkpointed_or_published(self):
        def changed(*args, **kwargs):
            self.video.write_bytes(b"replaced-media-during-analysis")
            return self.script
        with patch.object(plugin, "vision_client"), patch.object(plugin, "analyze_video", side_effect=changed):
            self.assertEqual(plugin.process_queue(self.fake, self.settings, self.log)["failed"], 1)
        self.assertFalse(self.pending.exists())
        self.assertFalse(self.output.exists())

    def test_recovery_excludes_transport_and_login_settings(self):
        self.checkpoint()
        settings = plugin.configuration({"ollama_url": "http://replacement-host:11434", "timeout_seconds": 600,
                                         "codex_path": "another-codex", "gemini_path": "another-gemini"})
        context = plugin.recovery_context(self.video, "1596", settings, False)
        self.assertEqual(plugin.load_recovery(self.pending, context)["actions"], self.script["actions"])
        text = self.pending.read_text()
        for name in ("ollama_url", "cli_account_dir", "timeout_seconds", "codex_path", "gemini_path"):
            self.assertNotIn(name, text)

    def test_mismatched_or_invalid_recovery_is_preserved_without_analysis(self):
        for case in ("source", "settings", "scene", "actions", "order"):
            with self.subTest(case=case):
                self.pending.unlink(missing_ok=True)
                self.video.write_bytes(b"synthetic-media-identity")
                self.checkpoint()
                settings = dict(self.settings)
                saved = json.loads(self.pending.read_text())
                if case == "source":
                    self.video.write_bytes(b"changed-video")
                elif case == "settings":
                    settings["max_speed"] = 200
                elif case == "scene":
                    saved["context"]["scene_id"] = "another-scene"
                elif case == "actions":
                    saved["script"]["actions"][0]["pos"] = 101
                else:
                    saved["script"]["actions"][1]["at"] = 0
                self.pending.write_text(json.dumps(saved))
                before = self.pending.read_bytes()
                with patch.object(plugin, "vision_client") as provider, patch.object(plugin, "analyze_video") as analyze:
                    self.assertEqual(plugin.process_queue(self.fake, settings, self.log)["failed"], 1)
                provider.assert_not_called()
                analyze.assert_not_called()
                self.assertEqual(self.pending.read_bytes(), before)
                self.assertFalse(self.output.exists())

    def test_existing_sidecar_is_preserved_even_with_pending_recovery(self):
        self.checkpoint()
        self.output.write_text(json.dumps({"actions": [{"at": 0, "pos": 40}]}))
        before = self.output.read_bytes()
        with patch.object(plugin, "vision_client") as provider, patch.object(plugin, "analyze_video") as analyze:
            summary = plugin.process_queue(self.fake, self.settings, self.log)
        self.assertEqual(summary["skipped"], 1)
        self.assertEqual(self.output.read_bytes(), before)
        self.assertTrue(self.pending.exists())
        provider.assert_not_called()
        analyze.assert_not_called()

    def test_auth_failure_stops_remaining_scenes_without_more_tag_calls(self):
        self.fake.scene_data["second"] = {**self.fake.scene_data["1596"], "id": "second"}
        with patch.object(self.fake, "find_scene", side_effect=Exception("401 Unauthorized query failed. v0.31.1-0")) as find, \
             patch.object(plugin, "analyze_video") as analyze:
            summary = plugin.process_queue(self.fake, self.settings, self.log)
        self.assertEqual(summary, {"created": 0, "skipped": 0, "failed": 1})
        self.assertEqual(find.call_count, 1)
        analyze.assert_not_called()
        self.assertIn({"id": "1"}, self.fake.scene_data["second"]["tags"])


if __name__ == "__main__":
    unittest.main()
