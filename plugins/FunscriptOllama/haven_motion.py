"""Adapted FunscriptHaven motion and multi-axis components (AGPL-3.0).

Upstream: stashapp/CommunityScripts/plugins/FunscriptHaven/funscript_haven.py
Git blob: 8794afe78233b20a7b8ba44c12be525bfd0cc5a0
Changes 2026-10-16: isolated math components; no runtime pip/config/Stash imports;
stable axis seeds; support zero-duration auto-home; sidecar writes handled by caller.
See THIRD-PARTY-NOTICES.md and the accompanying LICENCE.
"""
import hashlib
import math
import random
import numpy as np
import cv2

def max_divergence(flow):
    """
    Computes the divergence of the optical flow over the whole image and returns
    the pixel (x, y) with the highest absolute divergence along with its value.
    """
    div = np.gradient(flow[..., 0], axis=0) + np.gradient(flow[..., 1], axis=1)
    y, x = np.unravel_index(np.argmax(np.abs(div)), div.shape)
    return x, y, div[y, x]

def radial_motion_weighted(flow, center, is_cut, pov_mode=False, balance_global=True):
    """
    Computes signed radial motion: positive for outward motion, negative for inward motion.
    Closer pixels have higher weight.
    """
    if is_cut:
        return 0.0
    h, w, _ = flow.shape
    y, x = np.indices((h, w))
    dx = x - center[0]
    dy = y - center[1]

    dot = flow[..., 0] * dx + flow[..., 1] * dy

    if pov_mode or not balance_global:
        return np.mean(dot)
    
    weighted_dot = np.where(x > center[0], dot * (w - x) / w, dot * x / w)
    weighted_dot = np.where(y > center[1], weighted_dot * (h - y) / h, weighted_dot * y / h)

    return np.mean(weighted_dot)

def precompute_flow_info(p0, p1, params):
    """
    Compute optical flow and extract relevant information for funscript generation.
    """
    cut_threshold = params.get("cut_threshold", 7)
    
    flow = cv2.calcOpticalFlowFarneback(p0, p1, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    
    if params.get("pov_mode"):
        max_val = (p0.shape[1] // 2, p0.shape[0] - 1, 0)
    else:
        max_val = max_divergence(flow)
    
    pos_center = max_val[0:2]
    val_pos = max_val[2]
    
    mag, ang = cv2.cartToPolar(flow[..., 0], flow[..., 1])
    mean_mag = np.mean(mag)
    is_cut = mean_mag > cut_threshold

    return {
        "flow": flow,
        "pos_center": pos_center,
        "neg_center": pos_center,
        "val_pos": val_pos,
        "val_neg": val_pos,
        "cut": is_cut,
        "cut_center": pos_center[0],
        "mean_mag": mean_mag
    }

class OpenSimplex:
    """OpenSimplex noise generator for smooth, natural random motion."""
    PSIZE = 2048
    PMASK = PSIZE - 1

    def __init__(self, seed=None):
        if seed is None:
            seed = random.randint(0, 2**63 - 1)
        
        self._perm = [0] * self.PSIZE
        self._grad = [(0.0, 0.0)] * self.PSIZE
        
        grad_base = [
            (0.130526192220052, 0.991444861373810),
            (0.382683432365090, 0.923879532511287),
            (0.608761429008721, 0.793353340291235),
            (0.793353340291235, 0.608761429008721),
            (0.923879532511287, 0.382683432365090),
            (0.991444861373810, 0.130526192220051),
            (0.991444861373810, -0.130526192220051),
            (0.923879532511287, -0.382683432365090),
            (0.793353340291235, -0.608761429008720),
            (0.608761429008721, -0.793353340291235),
            (0.382683432365090, -0.923879532511287),
            (0.130526192220052, -0.991444861373810),
            (-0.130526192220052, -0.991444861373810),
            (-0.382683432365090, -0.923879532511287),
            (-0.608761429008721, -0.793353340291235),
            (-0.793353340291235, -0.608761429008721),
            (-0.923879532511287, -0.382683432365090),
            (-0.991444861373810, -0.130526192220052),
            (-0.991444861373810, 0.130526192220051),
            (-0.923879532511287, 0.382683432365090),
            (-0.793353340291235, 0.608761429008721),
            (-0.608761429008721, 0.793353340291235),
            (-0.382683432365090, 0.923879532511287),
            (-0.130526192220052, 0.991444861373810)
        ]
        
        n = 0.05481866495625118
        self._grad_lookup = [(dx / n, dy / n) for dx, dy in grad_base]
        
        source = list(range(self.PSIZE))
        for i in range(self.PSIZE - 1, -1, -1):
            seed = (seed * 6364136223846793005 + 1442695040888963407) & 0xFFFFFFFFFFFFFFFF
            r = int((seed + 31) % (i + 1))
            if r < 0:
                r += i + 1
            self._perm[i] = source[r]
            self._grad[i] = self._grad_lookup[self._perm[i] % len(self._grad_lookup)]
            source[r] = source[i]
    
    def calculate_2d(self, x, y):
        s = 0.366025403784439 * (x + y)
        return self._calculate_2d_impl(x + s, y + s)
    
    def calculate_2d_octaves(self, x, y, octaves=1, persistence=1.0, lacunarity=1.0):
        frequency = 1.0
        amplitude = 1.0
        total_value = 0.0
        total_amplitude = 0.0
        
        for _ in range(octaves):
            total_value += self.calculate_2d(x * frequency, y * frequency) * amplitude
            total_amplitude += amplitude
            amplitude *= persistence
            frequency *= lacunarity
        
        return total_value / total_amplitude if total_amplitude > 0 else 0
    
    def _calculate_2d_impl(self, xs, ys):
        xsb = int(math.floor(xs))
        ysb = int(math.floor(ys))
        xsi = xs - xsb
        ysi = ys - ysb
        
        a = int(xsi + ysi)
        
        ssi = (xsi + ysi) * -0.211324865405187
        xi = xsi + ssi
        yi = ysi + ssi
        
        value = 0.0
        
        value += self._contribute(xsb, ysb, xi, yi)
        value += self._contribute(xsb + 1, ysb + 1, xi - 1 + 2 * 0.211324865405187, yi - 1 + 2 * 0.211324865405187)
        
        if a == 0:
            value += self._contribute(xsb + 1, ysb, xi - 1 + 0.211324865405187, yi + 0.211324865405187)
            value += self._contribute(xsb, ysb + 1, xi + 0.211324865405187, yi - 1 + 0.211324865405187)
        else:
            value += self._contribute(xsb + 2, ysb + 1, xi - 2 + 3 * 0.211324865405187, yi - 1 + 3 * 0.211324865405187)
            value += self._contribute(xsb + 1, ysb + 2, xi - 1 + 3 * 0.211324865405187, yi - 2 + 3 * 0.211324865405187)
        
        return value
    
    def _contribute(self, xsb, ysb, dx, dy):
        attn = 2.0 / 3.0 - dx * dx - dy * dy
        if attn <= 0:
            return 0
        
        pxm = xsb & self.PMASK
        pym = ysb & self.PMASK
        grad = self._grad[self._perm[pxm] ^ pym]
        extrapolation = grad[0] * dx + grad[1] * dy
        
        attn *= attn
        return attn * attn * extrapolation

MULTI_AXIS_CONFIG = {
    "surge": {
        "name": "L1",
        "friendly_name": "Forward/Backward",
        "file_suffix": "surge",
        "default_value": 50,
        "phase_offset": 0.25,
    },
    "sway": {
        "name": "L2", 
        "friendly_name": "Left/Right",
        "file_suffix": "sway",
        "default_value": 50,
        "phase_offset": 0.5,
    },
    "twist": {
        "name": "R0",
        "friendly_name": "Twist",
        "file_suffix": "twist",
        "default_value": 50,
        "phase_offset": 0.0,
    },
    "roll": {
        "name": "R1",
        "friendly_name": "Roll",
        "file_suffix": "roll", 
        "default_value": 50,
        "phase_offset": 0.33,
    },
    "pitch": {
        "name": "R2",
        "friendly_name": "Pitch",
        "file_suffix": "pitch",
        "default_value": 50,
        "phase_offset": 0.66,
    },
}

class MultiAxisGenerator:
    """Generates secondary axis funscripts from primary L0 (stroke) data."""

    def __init__(self, settings):
        self.settings = settings
        self.intensity = settings.get('multi_axis_intensity', 0.5)
        self.random_speed = settings.get('random_speed', 0.3)
        self.smart_limit = settings.get('smart_limit', True)
        self.auto_home_delay = settings.get('auto_home_delay', 1.0)
        self.auto_home_duration = settings.get('auto_home_duration', 0.5)
        self.noise_generators = {axis_name: OpenSimplex(seed=int.from_bytes(hashlib.sha256(axis_name.encode()).digest()[:4], "big")) for axis_name in MULTI_AXIS_CONFIG.keys()}

    def generate_all_axes(self, l0_actions, fps, log_func=None):
        if not l0_actions or len(l0_actions) < 2:
            return {}
        activity_data = self._analyze_activity(l0_actions)
        results = {}
        for axis_name, axis_config in MULTI_AXIS_CONFIG.items():
            if log_func:
                log_func(f"Generating {axis_config['friendly_name']} ({axis_config['name']}) axis...")
            axis_actions = self._generate_axis(axis_name, axis_config, l0_actions, activity_data, fps)
            axis_actions = self._apply_auto_home(axis_actions, activity_data, axis_config)
            results[axis_name] = axis_actions
            if log_func:
                log_func(f"  Generated {len(axis_actions)} actions for {axis_config['file_suffix']}")
        return results

    def _analyze_activity(self, l0_actions):
        velocities = []
        activity_levels = []
        for i in range(len(l0_actions)):
            if i == 0:
                velocities.append(0)
            else:
                dt = (l0_actions[i]['at'] - l0_actions[i - 1]['at']) / 1000.0
                if dt > 0:
                    dp = abs(l0_actions[i]['pos'] - l0_actions[i - 1]['pos'])
                    velocities.append(dp / dt)
                else:
                    velocities.append(0)
        max_vel = max(velocities) if velocities else 1
        if max_vel > 0:
            activity_levels = [min(1.0, v / max_vel) for v in velocities]
        else:
            activity_levels = [0] * len(velocities)
        window_size = min(5, len(activity_levels))
        smoothed_activity = []
        for i in range(len(activity_levels)):
            start = max(0, i - window_size // 2)
            end = min(len(activity_levels), i + window_size // 2 + 1)
            smoothed_activity.append(sum(activity_levels[start:end]) / (end - start))
        idle_periods = []
        idle_threshold = 0.1
        min_idle_duration_ms = self.auto_home_delay * 1000
        idle_start = None
        for i, (action, activity) in enumerate(zip(l0_actions, smoothed_activity)):
            if activity < idle_threshold:
                if idle_start is None:
                    idle_start = action['at']
            elif idle_start is not None:
                idle_duration = action['at'] - idle_start
                if idle_duration >= min_idle_duration_ms:
                    idle_periods.append((idle_start, action['at']))
                idle_start = None
        if idle_start is not None and l0_actions:
            idle_duration = l0_actions[-1]['at'] - idle_start
            if idle_duration >= min_idle_duration_ms:
                idle_periods.append((idle_start, l0_actions[-1]['at']))
        return {'velocities': velocities, 'activity_levels': smoothed_activity, 'idle_periods': idle_periods}

    def _generate_axis(self, axis_name, axis_config, l0_actions, activity_data, fps):
        noise = self.noise_generators[axis_name]
        phase_offset = axis_config['phase_offset']
        default_value = axis_config['default_value']
        actions = []
        for i, l0_action in enumerate(l0_actions):
            timestamp_ms = l0_action['at']
            time_sec = timestamp_ms / 1000.0
            noise_x = time_sec * self.random_speed + phase_offset * 10
            noise_y = time_sec * self.random_speed * 0.7 + phase_offset * 5
            noise_value = noise.calculate_2d_octaves(noise_x, noise_y, octaves=2, persistence=0.5, lacunarity=2.0)
            raw_pos = default_value + noise_value * 50 * self.intensity
            if self.smart_limit and i < len(activity_data['activity_levels']):
                activity = activity_data['activity_levels'][i]
                deviation = raw_pos - default_value
                raw_pos = default_value + deviation * activity
            pos = int(round(max(0, min(100, raw_pos))))
            actions.append({'at': timestamp_ms, 'pos': pos})
        return actions

    def _apply_auto_home(self, actions, activity_data, axis_config):
        if not actions or not activity_data['idle_periods']:
            return actions
        default_value = axis_config['default_value']
        home_duration_ms = self.auto_home_duration * 1000
        result_actions = []
        idle_periods = activity_data['idle_periods']
        for action in actions:
            timestamp_ms = action['at']
            in_idle = False
            for idle_start, idle_end in idle_periods:
                if idle_start <= timestamp_ms <= idle_end:
                    in_idle = True
                    idle_progress = (timestamp_ms - idle_start) / home_duration_ms if home_duration_ms else 1.0
                    idle_progress = min(1.0, idle_progress)
                    ease = 1 - (1 - idle_progress) ** 2
                    current_pos = action['pos']
                    homed_pos = int(round(current_pos + (default_value - current_pos) * ease))
                    result_actions.append({'at': timestamp_ms, 'pos': homed_pos})
                    break
            if not in_idle:
                result_actions.append(action)
        return result_actions
