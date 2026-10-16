import copy
import json
import math
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from test_plugin import plugin, FakeStash, FakeLog, ROOT
import chapters
import haven_motion


class MarkerStash(FakeStash):
    def create_scene_marker(self, value, **kwargs):
        tag_name = next(name for name, tag in self.tags.items() if tag["id"] == value["primary_tag_id"])
        marker = {**value, "id": str(len(self.scene_data[value["scene_id"]].get("scene_markers", []))+1),
                  "primary_tag": {"id": value["primary_tag_id"], "name": tag_name}}
        self.scene_data[value["scene_id"]].setdefault("scene_markers", []).append(marker)
        return {"id": marker["id"]}


def scene(path="video.mp4"):
    return {"id": "1", "files": [{"path": str(path)}], "tags": [{"id": "1"}], "scene_markers": []}


class SettingsTests(unittest.TestCase):
    def test_every_runtime_setting_has_a_manifest_entry(self):
        manifest = (ROOT / "FunscriptOllama.yml").read_text(encoding="utf-8")
        settings = manifest.split("settings:\n", 1)[1]
        self.assertEqual(set(re.findall(r"^  ([a-z_]+):$", settings, re.M)), set(plugin.DEFAULTS))
        self.assertIn('version: "'+plugin.VERSION+'"', manifest)

    def test_installer_timeout_is_used_by_the_actual_http_request(self):
        self.assertEqual(plugin.configuration({})["timeout_seconds"], 10800)
        for seconds in (947, 10800):
            settings = plugin.configuration({"timeout_seconds": seconds})
            with self.subTest(seconds=seconds), patch.object(plugin, "urlopen") as request:
                request.return_value.__enter__.return_value.read.return_value = b'{"capabilities":["vision"]}'
                plugin.Ollama(settings).check_model()
                self.assertEqual(request.call_args.kwargs["timeout"], seconds)
        with self.assertRaises(ValueError):
            plugin.configuration({"timeout_seconds": 10801})

    def test_distributed_preset_is_valid_and_matches_runtime(self):
        preset = json.loads((ROOT / "recommended-settings.json").read_text(encoding="utf-8"))
        self.assertEqual(preset, plugin.RECOMMENDED_GENERATION_SETTINGS)
        settings = plugin.configuration(preset)
        self.assertEqual(settings["engine"], "ollama_haven")
        self.assertFalse(settings["multi_axis"])
        self.assertFalse(settings["overwrite"])

    def test_invalid_extra_settings_and_explicit_zero_values(self):
        for values in ({"threads": 1.5}, {"batch_size": 0}, {"engine": "unknown"}, {"vr_layout": "auto"},
                       {"multi_axis": "false"}, {"auto_home_delay": -1}, {"vr_tags": []}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                plugin.configuration(values)
        config = plugin.configuration({"auto_home_duration": 0, "multi_axis_intensity": 0,
                                       "marker_tolerance": 0, "keyframe_reduction": False})
        self.assertEqual(config["auto_home_duration"], 0)
        self.assertFalse(config["keyframe_reduction"])


class ChapterTests(unittest.TestCase):
    def test_time_formats_zero_fractional_and_invalid(self):
        self.assertEqual(chapters.seconds("01:02:03.125"), 3723.125)
        self.assertEqual(chapters.seconds("02:03.5"), 123.5)
        self.assertEqual(chapters.timestamp(3723.125), "01:02:03.125")
        for bad in (True, -1, math.nan, "00:99:01", "00:-1:02", "nan", "00:nan:01", "1:2:3:4"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                chapters.seconds(bad)

    def test_import_preserves_manual_markers_and_is_repeatable(self):
        s = scene()
        manual = {"id": "manual", "title": "Manual", "seconds": 7.0, "primary_tag": {"name": "Manual"}}
        s["scene_markers"] = [copy.deepcopy(manual)]
        stash = MarkerStash([s])
        script = {"metadata": {"chapters": [
            {"name": "", "startTime": "00:00:00"},
            {"name": "Chapter A", "startTime": "00:00:10.125", "endTime": "00:00:15"}]}}
        self.assertEqual(chapters.import_chapters(stash, "1", script), 2)
        self.assertEqual(chapters.import_chapters(stash, "1", script), 0)
        items = stash.scene_data["1"]["scene_markers"]
        self.assertEqual(items[0], manual)
        self.assertEqual(items[1]["title"], "#")
        self.assertEqual(items[1]["seconds"], 0)
        self.assertEqual(items[2]["end_seconds"], 15)

    def test_invalid_later_chapter_causes_no_writes(self):
        stash = MarkerStash([scene()])
        data = {"metadata": {"chapters": [{"name": "OK", "startTime": "00:00:02"},
                                           {"name": "Bad", "startTime": "oops"}]}}
        with self.assertRaises(ValueError):
            chapters.import_chapters(stash, "1", data)
        self.assertEqual(stash.scene_data["1"]["scene_markers"], [])
        self.assertNotIn("OK", stash.tags)

    def test_export_merges_prior_chapters_and_preserves_end_times(self):
        s = scene()
        s["scene_markers"] = [{"title": "New", "seconds": 20, "end_seconds": 25}]
        stash = MarkerStash([s])
        old = {"metadata": {"chapters": [{"name": "Old", "startTime": "00:00:05"}]}}
        result = chapters.export_chapters(stash, "1", {"actions": []}, old)
        self.assertEqual([c["name"] for c in result["metadata"]["chapters"]], ["Old", "New"])
        self.assertEqual(result["metadata"]["chapters"][1]["endTime"], "00:00:25.000")

    def test_import_task_works_without_ollama_and_does_not_write_sidecar(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "video.mp4"
            sidecar = video.with_suffix(".funscript")
            sidecar.write_text(json.dumps({"metadata": {"chapters": [{"name": "A", "startTime": "00:00:04"}]}}))
            original = sidecar.read_bytes()
            stash = MarkerStash([scene(video)])
            with patch.object(plugin.Ollama, "check_model", side_effect=AssertionError("must not call Ollama")):
                result = plugin.run({"server_connection": {}, "args": {"mode": "import_all_chapters"}},
                                    lambda _: stash, FakeLog())
            self.assertIsNone(result["error"])
            self.assertEqual(len(stash.scene_data["1"]["scene_markers"]), 1)
            self.assertEqual(sidecar.read_bytes(), original)
            self.assertEqual(stash.scene_data["1"]["tags"], [{"id": "1"}])

    def test_completion_marker_does_not_duplicate(self):
        stash = MarkerStash([scene()])
        self.assertEqual(chapters.completion_marker(stash, "1"), 1)
        self.assertEqual(chapters.completion_marker(stash, "1"), 0)
        self.assertEqual(stash.scene_data["1"]["scene_markers"][0]["primary_tag"]["name"], "Funscript")


class HavenTests(unittest.TestCase):
    def test_combined_queue_creates_axes_exports_chapters_and_keeps_manual_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "video.mp4"
            video.write_bytes(b"fixture")
            s = scene(video)
            manual = {"id": "manual", "title": "Manual", "seconds": 1.25, "primary_tag": {"name": "Manual"}}
            s["scene_markers"] = [copy.deepcopy(manual)]
            stash = MarkerStash([s])
            settings = plugin.configuration({"engine": "haven", "multi_axis": True, "add_marker": True})
            data = {"actions": [{"at": 0, "pos": 20}, {"at": 2000, "pos": 80}], "metadata": {}}
            with patch.object(plugin, "analyze_video", return_value=data), patch.object(plugin.Ollama, "check_model") as model:
                result = plugin.process_queue(stash, settings, FakeLog())
            model.assert_not_called()
            self.assertEqual(result, {"created": 1, "skipped": 0, "failed": 0})
            self.assertEqual(len(list(Path(directory).glob("*.funscript"))), 6)
            primary = json.loads(video.with_suffix(".funscript").read_text())
            self.assertEqual(primary["metadata"]["chapters"], [{"name": "Manual", "startTime": "00:00:01.250"}])
            self.assertEqual(stash.scene_data["1"]["scene_markers"][0], manual)
            self.assertEqual(len(stash.scene_data["1"]["scene_markers"]), 2)
            self.assertNotIn({"id": "1"}, stash.scene_data["1"]["tags"])

    def test_vr_tag_detection_and_selectable_layouts(self):
        settings = plugin.configuration({})
        self.assertTrue(plugin.vr_scene({"tags": [{"name": "virtual REALITY"}]}, settings))
        self.assertFalse(plugin.vr_scene({"tags": [{"name": "VR"}]}, {**settings, "vr_auto": False}))
        image = np.zeros((80, 120, 3), np.uint8)
        image[40:, :60] = 100
        haven = plugin.prepare_frame(image, {**settings, "vr_layout": "haven"}, True)
        self.assertEqual(haven.shape, (40, 60, 3))
        self.assertTrue(np.all(haven == 100))
        self.assertEqual(plugin.prepare_frame(image, settings, True).shape, (80, 60, 3))
        self.assertEqual(plugin.prepare_frame(image, {**settings, "vr_layout": "sbs"}, True).shape, (80, 60, 3))
        self.assertEqual(plugin.prepare_frame(image, {**settings, "vr_layout": "tb"}, True).shape, (40, 120, 3))
        self.assertEqual(plugin.prepare_frame(image, {**settings, "vr_layout": "mono"}, True).shape, image.shape)

    def test_pov_mode_and_global_weighting(self):
        image = np.random.default_rng(5).integers(0, 255, (40, 60), dtype=np.uint8)
        shifted = cv2.warpAffine(image, np.float32([[1, 0, 0], [0, 1, 2]]), (60, 40))
        info = haven_motion.precompute_flow_info(image, shifted, {"pov_mode": True})
        self.assertEqual(info["pos_center"], (30, 39))
        region = {"active": True, "roi": [0, 0, 1, 1], "axis": "y"}
        for balance in (True, False):
            value = plugin.measure_selected(image, shifted, region, plugin.configuration({"pov_mode": True, "balance_global": balance}))
            self.assertTrue(math.isfinite(value))

    def test_dense_output_and_normalization_window(self):
        values = [(i*100, 2*math.sin(i/3)) for i in range(100)]
        settings = plugin.configuration({"keyframe_reduction": False})
        dense = plugin.segment_actions(values, 100, settings)
        reduced = plugin.segment_actions(values, 100, {**settings, "keyframe_reduction": True})
        changed = plugin.segment_actions(values, 100, {**settings, "norm_window": 1})
        self.assertEqual(len(dense), len(values))
        self.assertLess(len(reduced), len(dense))
        self.assertNotEqual(dense, changed)

    def test_secondary_files_reproducibility_preservation_and_backups(self):
        actions = [{"at": i*200, "pos": 20 if i%2 else 80} for i in range(30)]
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "video.mp4"
            settings = plugin.configuration({"multi_axis": True})
            script = {"actions": actions}
            self.assertEqual(plugin.secondary_scripts(video, script, settings, FakeLog()), 5)
            files = sorted(Path(directory).glob("*.funscript"))
            self.assertEqual({f.name for f in files}, {"video."+name+".funscript" for name in haven_motion.MULTI_AXIS_CONFIG})
            originals = {f.name: f.read_bytes() for f in files}
            self.assertEqual(plugin.secondary_scripts(video, script, settings, FakeLog()), 0)
            self.assertEqual(plugin.secondary_scripts(video, script, {**settings, "overwrite": True}, FakeLog()), 5)
            self.assertEqual({f.name: f.read_bytes() for f in files}, originals)
            self.assertEqual(len(list(Path(directory).glob("*.bak"))), 5)
            for file in files:
                points = json.loads(file.read_text())["actions"]
                self.assertTrue(all(0 <= p["pos"] <= 100 for p in points))
                self.assertTrue(all(abs(a["pos"]-b["pos"]) <= settings["max_speed"]*(b["at"]-a["at"])/1000 for a,b in zip(points,points[1:])))

    def test_zero_duration_auto_home_and_smart_limit(self):
        generator = haven_motion.MultiAxisGenerator({"auto_home_duration": 0})
        result = generator._apply_auto_home([{"at": 0, "pos": 80}, {"at": 1000, "pos": 20}],
                                            {"idle_periods": [(0, 1000)]}, {"default_value": 50})
        self.assertEqual([r["pos"] for r in result], [50, 50])
        idle = [{"at": i*1000, "pos": 50} for i in range(10)]
        axes = generator.generate_all_axes(idle, 10)
        self.assertTrue(all(p["pos"] == 50 for points in axes.values() for p in points))

    def test_haven_engine_real_video_without_ollama_and_batch_continuity(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "radial.avi"
            writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 20, (120, 120))
            self.assertTrue(writer.isOpened())
            texture = np.random.default_rng(6).integers(20, 240, (50, 50, 3), dtype=np.uint8)
            for i in range(120):
                frame = np.zeros((120, 120, 3), dtype=np.uint8)
                size = round(35+10*math.sin(i/5))
                start = 60-size//2
                frame[start:start+size, start:start+size] = cv2.resize(texture, (size, size))
                writer.write(frame)
            writer.release()
            settings = plugin.configuration({"engine": "haven", "threads": 1, "batch_size": 1})
            a = plugin.analyze_video(video, settings, None)
            b = plugin.analyze_video(video, {**settings, "threads": 2, "batch_size": 4}, None)
            self.assertEqual(a["actions"], b["actions"])
            self.assertGreater(len(a["actions"]), 4)
            self.assertEqual(a["metadata"]["engine"], "haven")


if __name__ == "__main__":
    unittest.main()
