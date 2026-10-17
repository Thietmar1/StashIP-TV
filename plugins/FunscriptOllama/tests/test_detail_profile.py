"""Detail retention on numeric signals and synthetic non-content video."""
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from test_plugin import plugin, REGION


class DetailProfileTests(unittest.TestCase):
    def test_numeric_limits_and_explicit_old_options_remain_available(self):
        defaults = plugin.configuration({})
        self.assertEqual(defaults["analysis_fps"], 30)
        self.assertEqual(defaults["max_speed"], 300)
        self.assertFalse(defaults["keyframe_reduction"])
        for option in ({"minimum_motion_range": 0}, {"motion_smoothing_seconds": -0.1},
                       {"motion_smoothing_seconds": math.nan}, {"ai_frame_spacing_seconds": 3},
                       {"inactive_roi_interval": 0}):
            with self.subTest(option=option), self.assertRaises(ValueError):
                plugin.configuration(option)
        old = plugin.configuration({"analysis_fps": 15, "roi_interval": 30, "max_speed": 150,
                                    "keyframe_reduction": True, "motion_smoothing_seconds": 0.15,
                                    "minimum_motion_range": 0.5, "inactive_roi_interval": 30})
        self.assertEqual(old["analysis_fps"], 15)
        self.assertTrue(old["keyframe_reduction"])
        self.assertEqual(plugin.configuration({"motion_smoothing_seconds": 0})["motion_smoothing_seconds"], 0)

    def test_lower_range_threshold_retains_small_measured_signal_but_not_stillness(self):
        samples = [(round(i*1000/30), 0.15*math.sin(i*2*math.pi*4/30)) for i in range(300)]
        settings = plugin.configuration({"max_speed": 500})
        detailed = plugin.segment_actions(samples, 500, settings)
        conservative = plugin.segment_actions(samples, 500, {**settings, "minimum_motion_range": 0.5})
        self.assertGreater(max(p["pos"] for p in detailed)-min(p["pos"] for p in detailed), 3)
        self.assertEqual({p["pos"] for p in conservative}, {50})
        for amplitude in (0, 0.0001):
            still = [(at, amplitude*math.sin(i)) for i, (at, _) in enumerate(samples)]
            self.assertEqual({p["pos"] for p in plugin.segment_actions(still, 500, settings)}, {50})

    def test_less_smoothing_retains_more_of_a_short_measured_change(self):
        samples = [(round(i*1000/30), 2*math.sin(i*2*math.pi*3/30)) for i in range(300)]
        settings = plugin.configuration({"max_speed": 500})
        reference = plugin.segment_actions(samples, 500, {**settings, "motion_smoothing_seconds": 0})
        detailed = plugin.segment_actions(samples, 500, settings)
        old_smoothing = plugin.segment_actions(samples, 500, {**settings, "motion_smoothing_seconds": 0.15})
        ref = np.array([p["pos"] for p in reference])
        errors = [float(np.mean(abs(np.array([p["pos"] for p in points])-ref))) for points in (detailed, old_smoothing)]
        self.assertLess(errors[0], errors[1])
        self.assertEqual(len(detailed), len(samples))
        self.assertEqual([p["at"] for p in detailed], [at for at, _ in samples])

    def test_speed_limit_is_still_strict_at_full_sample_rate(self):
        samples = [(round(i*1000/30), 3*math.sin(i/2)) for i in range(300)]
        for limit in (150, 300):
            points = plugin.finalize_actions([plugin.segment_actions(samples, limit)], limit)
            for a, b in zip(points, points[1:]):
                self.assertLessEqual(abs(b["pos"]-a["pos"]), limit*(b["at"]-a["at"])/1000)
            self.assertTrue(all(0 <= p["pos"] <= 100 for p in points))

    def video(self, directory):
        path = Path(directory) / "synthetic-motion.avi"
        writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 30, (120, 90))
        self.assertTrue(writer.isOpened())
        texture = np.random.default_rng(2026).integers(30, 240, (20, 30, 3), dtype=np.uint8)
        for i in range(240):
            frame = np.zeros((90, 120, 3), dtype=np.uint8)
            y = round(35+10*math.sin(i*2*math.pi/30))
            frame[y:y+20, 45:75] = texture
            writer.write(frame)
        writer.release()
        return path

    def test_inactive_rechecks_and_separated_image_pairs_use_video_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.video(directory)
            settings = plugin.configuration({"engine": "ollama", "roi_interval": 4, "inactive_roi_interval": 2})
            class Model:
                def __init__(self): self.calls = 0
                def region(self, frames):
                    self.calls += 1
                    return {**REGION, "active": self.calls != 1}
            model = Model()
            script = plugin.analyze_video(path, settings, model)
            regions = script["metadata"]["regions"]
            self.assertEqual(len(regions), 3)
            self.assertFalse(regions[0]["active"])
            self.assertTrue(regions[1]["active"])
            self.assertAlmostEqual((regions[1]["at"]-regions[0]["at"])/1000, 2, delta=0.05)
            self.assertAlmostEqual((regions[2]["at"]-regions[1]["at"])/1000, 4, delta=0.05)
            for region in regions[1:]:
                self.assertAlmostEqual(region["frame_gap_ms"], 250, delta=35)
            self.assertEqual(script["metadata"]["generation_settings"]["motion_smoothing_seconds"], 0.05)
            for key in ("ollama_url", "cli_account_dir", "codex_path", "vr_tags"):
                self.assertNotIn(key, script["metadata"]["generation_settings"])

    def test_vision_history_resets_at_cuts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.video(directory)
            settings = plugin.configuration({"engine": "ollama", "roi_interval": 4})
            model = type("Model", (), {"region": lambda self, frames: REGION})()
            calls = 0
            def one_cut(*args):
                nonlocal calls
                calls += 1
                return calls == 120
            with patch.object(plugin, "is_cut", side_effect=one_cut):
                script = plugin.analyze_video(path, settings, model)
            regions = script["metadata"]["regions"]
            after_cut = next(r for r in regions if r["at"] >= 4000)
            self.assertLessEqual(after_cut["frame_gap_ms"], 35)
            self.assertGreater(len(script["actions"]), 150)

    def test_new_motion_options_invalidate_old_analysis_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.mp4"
            path.write_bytes(b"fixture")
            settings = plugin.configuration({})
            expected = plugin.recovery_context(path, "1", settings, False)
            for name, value in (("minimum_motion_range", 0.5), ("motion_smoothing_seconds", 0.15),
                                ("inactive_roi_interval", 30), ("ai_frame_spacing_seconds", 0.5)):
                with self.subTest(name=name):
                    changed = plugin.recovery_context(path, "1", {**settings, name: value}, False)
                    self.assertNotEqual(expected["analysis_sha256"], changed["analysis_sha256"])


if __name__ == "__main__":
    unittest.main()
