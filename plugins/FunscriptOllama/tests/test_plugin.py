import copy
import importlib.util
import json
import math
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("funscript_ollama", ROOT / "funscript_ollama.py")
plugin = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plugin)

REGION = {"active": True, "confidence": 0.9, "roi": [0.15, 0.15, 0.85, 0.85], "axis": "y"}


class FakeLog:
    def __init__(self):
        self.messages, self.progresses = [], []

    def info(self, text): self.messages.append(text)
    def error(self, text): self.messages.append(text)
    def progress(self, value): self.progresses.append(value)


class FakeStash:
    def __init__(self, scenes=None):
        self.tags = {"FunscriptOllama_Process": {"id": "1"}, "keep": {"id": "2"}}
        self.scene_data = {s["id"]: copy.deepcopy(s) for s in scenes or []}

    def get_configuration(self, **kwargs): return {"plugins": {}}

    def find_tag(self, name, create=False):
        if create and name not in self.tags:
            self.tags[name] = {"id": str(len(self.tags)+1)}
        return self.tags.get(name)

    def find_scenes(self, **kwargs): return list(self.scene_data.values())
    def find_scene(self, scene_id, **kwargs): return copy.deepcopy(self.scene_data.get(scene_id))

    def update_scene(self, value):
        self.scene_data[value["id"]]["tags"] = [{"id": i} for i in value["tag_ids"]]


class ConfigTests(unittest.TestCase):
    def test_defaults_and_native_endpoint_normalization(self):
        c = plugin.configuration({})
        self.assertEqual(c["ollama_url"], "http://192.168.178.16:11434")
        self.assertEqual(c["model"], "qwen3-vl:8b-instruct")
        self.assertEqual(plugin.normalize_url("http://host/prefix/api/chat/"), "http://host/prefix")

    def test_bad_settings_and_tag_collisions(self):
        for raw in ({"analysis_fps": 0}, {"max_speed": math.nan}, {"overwrite": "false"},
                    {"timeout_seconds": True}, {"trigger_tag": "FunscriptOllama_Error"},
                    {"ollama_url": "file:///tmp/test"}, {"ollama_url": "http://u:p@host"}):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                plugin.configuration(raw)

    def test_regions_fail_closed_and_low_confidence_is_inactive(self):
        self.assertFalse(plugin.validate_region({**REGION, "confidence": 0.2})["active"])
        for value in ({}, {**REGION, "active": "true"}, {**REGION, "roi": [0, 0, 100, 100]},
                      {**REGION, "roi": [0, 0, 0, 1]}, {**REGION, "confidence": float("nan")},
                      {**REGION, "axis": "z"}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                plugin.validate_region(value)


class OllamaTests(unittest.TestCase):
    def setUp(self):
        self.calls, self.reply, self.status = [], {"done": True, "message": {"content": json.dumps(REGION)}}, 200
        self.delay = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.calls.append((self.path, body))
                if self.path == "/graphql":
                    query = body["query"]
                    if "StashVersion" in query:
                        data = {"version": {"version": "v0.31.1", "hash": "test", "build_time": "2026-01-01"}}
                    elif "getApiKey" in query:
                        data = {"configuration": {"general": {"apiKey": "private-stash-key"}}}
                    elif "__schema" in query:
                        data = {"__schema": {"types": []}}
                    elif "ConfigurePlugin" in query:
                        variables = body["variables"]
                        owner.settings = copy.deepcopy(variables["input"])
                        data = {"configurePlugin": owner.settings}
                    elif "Configuration" in query or "FindPluginConfig" in query:
                        data = {"configuration": {"plugins": {plugin.PLUGIN_ID: owner.settings}}}
                    else:
                        data = {}
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"data": data}).encode())
                    return
                time.sleep(owner.delay)
                self.send_response(owner.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"capabilities": ["vision"]} if self.path == "/api/show" else owner.reply).encode())

            def log_message(self, *args): pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.settings = plugin.configuration({"ollama_url": f"http://127.0.0.1:{self.server.server_port}"})
        self.client = plugin.Ollama(self.settings)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def test_real_http_vision_payload_and_structured_response(self):
        self.client.check_model()
        self.assertTrue(self.client.region([np.zeros((32, 32, 3), np.uint8)] * 2)["active"])
        path, body = self.calls[-1]
        self.assertEqual(path, "/api/chat")
        self.assertEqual(body["model"], "qwen3-vl:8b-instruct")
        self.assertEqual(len(body["messages"][0]["images"]), 2)
        self.assertFalse(body["stream"])
        self.assertEqual(body["format"], plugin.REGION_SCHEMA)
        self.assertEqual(body["options"]["temperature"], 0)

    def test_truncated_or_non_json_model_response(self):
        for reply in ({"done": False}, {"done": True, "done_reason": "length"},
                      {"done": True, "message": {"content": "refused"}}):
            self.reply = reply
            with self.subTest(reply=reply), self.assertRaises(ValueError):
                self.client.region([np.zeros((32, 32, 3), np.uint8)])

    def test_waits_for_delayed_response_and_logs_wait_without_retry(self):
        self.delay = 0.15
        log = FakeLog()
        client = plugin.Ollama(self.settings, log)
        started = time.monotonic()
        self.assertTrue(client.region([np.zeros((32, 32, 3), np.uint8)])["active"])
        self.assertGreaterEqual(time.monotonic()-started, self.delay)
        self.assertEqual([p for p, _ in self.calls], ["/api/chat"])
        self.assertIn("10800 seconds", log.messages[0])
        self.assertIn("answered after", log.messages[1])

    def test_apply_preset_via_real_stash_client_preserves_other_settings(self):
        preserved = {"ollama_url": "http://custom-host:11434", "model": "custom-model",
                     "trigger_tag": "Queue", "complete_tag": "Done", "error_tag": "Failed",
                     "vr_tags": "Custom VR", "import_chapters": False, "export_chapters": False,
                     "marker_tolerance": 1.5, "add_marker": True, "private_value": "do-not-log"}
        self.settings = {**preserved, "timeout_seconds": 600, "engine": "ollama",
                         "analysis_fps": 10, "overwrite": True}
        payload = {"server_connection": {"Scheme": "http", "Host": "127.0.0.1",
                                         "Port": self.server.server_port, "ApiKey": "private-stash-key"},
                   "args": {"mode": "apply_recommended"}}
        result = subprocess.run([sys.executable, str(ROOT / "funscript_ollama.py")],
                                input=json.dumps(payload), text=True, capture_output=True,
                                timeout=30, env=os.environ.copy())
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("applied", json.loads(result.stdout)["output"])
        self.assertEqual(self.settings, {**preserved, **plugin.RECOMMENDED_GENERATION_SETTINGS})
        mutations = [body for path, body in self.calls if "ConfigurePlugin" in body.get("query", "")]
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0]["variables"]["plugin_id"], plugin.PLUGIN_ID)
        self.assertTrue(all(path == "/graphql" for path, _ in self.calls))
        for secret in ("private-stash-key", "do-not-log"):
            self.assertNotIn(secret, result.stdout + result.stderr)

    def test_http_errors_do_not_echo_response_body(self):
        self.status = 404
        with self.assertRaisesRegex(RuntimeError, "Ollama HTTP 404"):
            self.client.check_model()

    def test_task_connection_uses_only_synthetic_images(self):
        fake = FakeStash()
        fake.get_configuration = lambda **kwargs: {"plugins": {plugin.PLUGIN_ID: self.settings}}
        result = plugin.run({"server_connection": {}, "args": {"mode": "test_connection"}}, lambda _: fake, FakeLog())
        self.assertIn("OK", result["output"])
        self.assertEqual([p for p, _ in self.calls], ["/api/show", "/api/chat"])

    def test_raw_stdin_stdout_with_real_stash_client(self):
        payload = {"server_connection": {"Scheme": "http", "Host": "127.0.0.1",
                                         "Port": self.server.server_port, "ApiKey": "private-stash-key"},
                   "args": {"mode": "test_connection"}}
        result = subprocess.run([sys.executable, str(ROOT / "funscript_ollama.py")],
                                input=json.dumps(payload), text=True, capture_output=True,
                                timeout=30, env=os.environ.copy())
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        output = json.loads(result.stdout)
        self.assertIsInstance(output["output"], str)
        self.assertIn("OK", output["output"])
        self.assertNotIn("private-stash-key", result.stdout + result.stderr)
        self.assertIn("\x01i\x02", result.stderr)
        self.assertIn("/graphql", [p for p, _ in self.calls])
        self.assertIn("/api/chat", [p for p, _ in self.calls])


class MotionTests(unittest.TestCase):
    def test_static_image_is_not_motion_and_translated_object_has_direction(self):
        rng = np.random.default_rng(18)
        image = np.zeros((120, 160), np.uint8)
        image[35:75, 50:100] = rng.integers(20, 250, (40, 50), dtype=np.uint8)
        shifted = cv2.warpAffine(image, np.float32([[1, 0, 0], [0, 1, 4]]), (160, 120))
        self.assertEqual(plugin.measured_motion(image, image, REGION), 0)
        self.assertGreater(plugin.measured_motion(image, shifted, REGION), 2)
        self.assertEqual(plugin.measured_motion(image, shifted, {**REGION, "active": False}), 0)

    def test_action_order_range_rate_and_duplicate_boundaries(self):
        points = [(i*100, 2*math.sin(i/3)) for i in range(100)]
        first = plugin.segment_actions(points, 100)
        actions = plugin.finalize_actions([first, [{"at": 9900, "pos": 0}, {"at": 10000, "pos": 100}]], 100)
        self.assertGreater(len(actions), 8)
        for a, b in zip(actions, actions[1:]):
            self.assertGreater(b["at"], a["at"])
            self.assertLessEqual(abs(b["pos"]-a["pos"]), 100*(b["at"]-a["at"])/1000)
        self.assertTrue(all(0 <= a["pos"] <= 100 for a in actions))

    def test_real_video_decoder_and_moving_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "motion.avi"
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 20, (160, 120))
            self.assertTrue(writer.isOpened())
            rng = np.random.default_rng(123)
            texture = rng.integers(30, 230, (24, 36, 3), dtype=np.uint8)
            for i in range(160):
                image = np.zeros((120, 160, 3), np.uint8)
                y = round(45 + 20*math.sin(i*math.pi/15))
                image[y:y+24, 60:96] = texture
                writer.write(image)
            writer.release()
            model = type("Model", (), {"region": lambda self, frames: REGION})()
            script = plugin.analyze_video(path, plugin.configuration({"engine": "ollama"}), model)
            self.assertGreater(len(script["actions"]), 5)
            self.assertGreater(max(a["pos"] for a in script["actions"])-min(a["pos"] for a in script["actions"]), 10)
            self.assertGreater(script["actions"][-1]["at"], 7000)
            self.assertTrue(script["metadata"]["experimental"])

    def test_unreadable_video_produces_no_script(self):
        with self.assertRaisesRegex(ValueError, "cannot open"):
            plugin.analyze_video(Path("missing-video-file.mp4"), plugin.configuration({}), None)

    def test_cuts_and_background_camera_translation(self):
        a = np.random.default_rng(23).integers(30, 220, (120, 160), dtype=np.uint8)
        b = cv2.warpAffine(a, np.float32([[1, 0, 0], [0, 1, 3]]), (160, 120))
        self.assertLess(abs(plugin.measured_motion(a, b, REGION)), 0.3)
        self.assertTrue(plugin.is_cut(np.zeros_like(a), np.full_like(a, 255)))
        self.assertFalse(plugin.is_cut(a, a))

    def test_inactive_or_failed_model_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "still.avi"
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (80, 60))
            self.assertTrue(writer.isOpened())
            for _ in range(30):
                writer.write(np.zeros((60, 80, 3), dtype=np.uint8))
            writer.release()
            model = type("Model", (), {"region": lambda self, frames: {**REGION, "active": False}})()
            with self.assertRaisesRegex(ValueError, "No reliable motion"):
                plugin.analyze_video(path, plugin.configuration({}), model)
            self.assertFalse(path.with_suffix(".funscript").exists())
            with patch.object(model, "region", side_effect=ValueError("invalid model response")):
                with self.assertRaisesRegex(ValueError, "invalid model"):
                    plugin.analyze_video(path, plugin.configuration({}), model)
            self.assertFalse(path.with_suffix(".funscript").exists())


class FilesAndQueueTests(unittest.TestCase):
    def test_atomic_write_preserve_existing_backup_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.funscript"
            plugin.save_script(path, {"actions": []})
            original = path.read_bytes()
            with self.assertRaises(FileExistsError):
                plugin.save_script(path, {"different": True})
            self.assertEqual(path.read_bytes(), original)
            plugin.save_script(path, {"new": True}, True)
            self.assertEqual(json.loads(path.read_text()), {"new": True})
            self.assertEqual(list(path.parent.glob("*.bak"))[0].read_bytes(), original)
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_failed_serialization_keeps_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.funscript"
            path.write_text("previous")
            with self.assertRaises(ValueError):
                plugin.save_script(path, {"bad": math.nan}, True)
            self.assertEqual(path.read_text(), "previous")
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_tag_updates_preserve_fresh_unrelated_tags_and_failure_queue(self):
        fake = FakeStash([{"id": "1", "tags": [{"id": "1"}, {"id": "2"}, {"id": "concurrent"}]}])
        queue = plugin.SceneQueue(fake, plugin.configuration({}))
        queue.status("1", False)
        ids = [t["id"] for t in fake.scene_data["1"]["tags"]]
        self.assertTrue({"1", "2", "concurrent"}.issubset(ids))
        error_id = fake.tags["FunscriptOllama_Error"]["id"]
        self.assertIn(error_id, ids)
        queue.status("1", True)
        ids = [t["id"] for t in fake.scene_data["1"]["tags"]]
        self.assertNotIn("1", ids)
        self.assertNotIn(error_id, ids)
        self.assertIn("concurrent", ids)
        self.assertIn(fake.tags["FunscriptOllama_Complete"]["id"], ids)

    def test_processing_success_skips_and_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "video.mp4"
            video.write_bytes(b"fixture")
            scenes = [{"id": str(i), "files": [{"path": str(video)}], "tags": [{"id": "1"}, {"id": "2"}]} for i in range(3)]
            scenes[-1]["files"] = []
            fake, log = FakeStash(scenes), FakeLog()
            with patch.object(plugin.Ollama, "check_model"), patch.object(plugin, "analyze_video", return_value={"actions": [{"at": 0, "pos": 50}]}):
                result = plugin.process_queue(fake, plugin.configuration({}), log)
            self.assertEqual(result, {"created": 1, "skipped": 1, "failed": 1})
            self.assertTrue(video.with_suffix(".funscript").exists())
            self.assertEqual(log.progresses[-1], 1)
            self.assertIn({"id": "1"}, fake.scene_data["1"]["tags"])
            self.assertIn({"id": "1"}, fake.scene_data["2"]["tags"])


if __name__ == "__main__":
    unittest.main()
