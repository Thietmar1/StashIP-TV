#!/usr/bin/env python3
"""Offline test of the 1.51 Intiface bridge: the script matcher, the page's
tuning keys, and a simulated Stashy driving the bridge over a real socket."""
import sys, os, asyncio, importlib.util, json, time, random, tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("isync", os.path.join(_HERE, "IntifaceSync.py"))
isync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isync)
websockets = isync.websockets
try:
    from websockets.asyncio.client import connect as ws_connect
except ImportError:
    from websockets.client import connect as ws_connect

GUSH = {
    "DeviceIndex": 0,
    "DeviceName": "Lovense Gush 2",
    "DeviceMessages": {"ScalarCmd": [{"StepCount": 20, "FeatureDescriptor": "Vibrator",
                                      "ActuatorType": "Vibrate"}], "StopDeviceCmd": {}},
}


class FakeBP(isync.ButtplugClient):
    def __init__(self, devices):
        super().__init__("ws://fake")
        self.devices = {d["DeviceIndex"]: d for d in devices}
        self.sent = []

    @property
    def connected(self):
        return True

    async def _send(self, msg_type, payload):
        self.sent.append((time.monotonic(), msg_type, payload))

    async def stop_all(self):
        self.sent.append((time.monotonic(), "StopAllDevices", {}))


def make_script(seed, length_ms=150000):
    rng = random.Random(seed)
    acts, t, up = [], 1000, True
    while t < length_ms:
        acts.append({"at": t, "pos": rng.randint(55, 100) if up else rng.randint(0, 45)})
        up = not up
        t += rng.randint(180, 650)
    return acts


# ── 1. the matcher ───────────────────────────────────────────────────────────
print("1. match_commands finds the place from strokes, with jitter, a skipped keyframe and a slow clock")
A = make_script(1)
B = make_script(2)
rng = random.Random(7)
j0 = 200
cmds = []
for j in range(j0, j0 + 16):
    if j == j0 + 6:
        continue                                   # two keyframes in one frame: one skipped
    cmds.append((50000 + (A[j]["at"] - A[j0]["at"]) * 0.95 + rng.uniform(-30, 30), A[j]["pos"]))
res = isync.match_commands(cmds, A)
assert [r[0] for r in res] == [j0 + 15], res
assert not isync.match_commands(cmds, B), "matched the wrong script"
assert not isync.match_commands(cmds[:5], A), "locked on too few strokes"
print("   right keyframe, other script rejected, 5 strokes are not enough  OK")

print("2. pick_match: a loop goes to the place nearest the resume point, or waits")
L = [{"at": 1000 + i * 500, "pos": (0, 100)[i % 2]} for i in range(400)]
res = [("s", 30, 9, 4000), ("s", 230, 9, 4000)]
assert isync.pick_match(res, {"s": L}, {"s": L[230]["at"] + 2000}) == ("s", 230)
assert isync.pick_match(res, {"s": L}, None) is None
assert isync.pick_match(res, {"s": L}, {"s": (L[30]["at"] + L[230]["at"]) / 2}) is None
assert isync.pick_match([("a", 5, 9, 4000), ("b", 5, 9, 4000)], {"a": L, "b": L}) is None
assert isync.pick_match([("a", 5, 12, 4000), ("b", 5, 9, 4000)], {"a": L, "b": L}) == ("a", 5)
print("   OK")

print("3. path_key equals the page's FNV-1a over UTF-16")
assert isync.path_key("/data/videos/Scene [FunGen].funscript") == "996b0943"
assert isync.path_key("/data/Ünïcödé 😀.funscript") == "848c6b09"
print("   OK")

print("4. tuning_for reads the page's per-script memory in the page's units")
p = "/data/x.funscript"
cfg = {"scriptSettings": json.dumps({"v": 1, "rev": 1, "scripts": {isync.path_key(p): {
    "path": p, "vibeMode": "beat", "flowSmooth": 70, "strokeMax": 60, "offsetMs": -120,
    "vibeTrackOn": False}}})}
t = isync.tuning_for(p, cfg)
assert t["vibe_mode"] == "beat" and abs(t["flow_smooth"] - 0.7) < 1e-9
assert abs(t["stroke_max"] - 0.6) < 1e-9 and t["offset_ms"] == -120 and t["vibe_track"] is False
assert isync.tuning_for("/data/other.funscript", cfg)["vibe_mode"] == "auto"
print("   OK")


# ── 5. a simulated Stashy over a real socket ─────────────────────────────────
class FakeStash:
    def __init__(self, scenes):
        self.scenes = scenes

    async def init(self):
        pass

    async def plugin_config(self):
        return {}

    async def recent_interactive(self, n=8):
        return self.scenes


class Stashy:
    """What Stashy's ButtplugManager does: one LinearCmd per keyframe, sent when
    its clock passes the previous one, duration = time left to it."""

    def __init__(self, url, actions):
        self.url, self.actions = url, actions
        self.ws = None
        self.media0 = 0.0
        self.t0 = None
        self.sent_at = None
        self.mid = 1
        self.rate = 1.0          # the app's clock against the video: < 1 when frames drop

    def media(self):
        return self.media0 + (time.monotonic() - self.t0) * 1000.0 * self.rate if self.t0 else self.media0

    def video(self):
        return self.media0 + (time.monotonic() - self.t0) * 1000.0 if self.t0 else self.media0

    async def send(self, name, body):
        body = {"Id": self.mid, **body}
        self.mid += 1
        await self.ws.send(json.dumps([{name: body}]))

    async def open(self):
        self.ws = await ws_connect(self.url)
        await self.send("RequestServerInfo", {"ClientName": "Stashy", "MessageVersion": 3})
        await self.send("StartScanning", {})
        await self.send("RequestDeviceList", {})
        self.replies = []
        async def drain():
            try:
                async for raw in self.ws:
                    self.replies.extend(json.loads(raw))
            except Exception:
                pass
        self.drain = asyncio.ensure_future(drain())

    async def play(self, at_ms, seconds):
        self.media0, self.t0, self.sent_at = at_ms, time.monotonic(), None
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            cur = self.media()
            nxt = next((a for a in self.actions if a["at"] > cur), None)
            if nxt and nxt["at"] != self.sent_at:
                await self.send("LinearCmd", {"DeviceIndex": 0, "Vectors": [
                    {"Index": 0, "Duration": int(nxt["at"] - cur), "Position": nxt["pos"] / 100.0}]})
                self.sent_at = nxt["at"]
            await asyncio.sleep(1 / 60)

    async def pause(self):
        self.media0, self.t0 = self.media(), None
        await self.send("StopAllDevices", {})


async def e2e():
    tmp = tempfile.mkdtemp()
    for name, acts in (("scene one", A), ("scene two", B)):
        open(os.path.join(tmp, name + ".mp4"), "w").close()
        with open(os.path.join(tmp, name + ".funscript"), "w") as f:
            json.dump({"actions": acts}, f)
    srv = isync.BackendServer(None)
    srv.bp = FakeBP([GUSH])
    srv.player = isync.FunscriptPlayer(srv.bp)
    br = srv.bridge
    br.stash = FakeStash([
        {"id": "2", "title": "Two", "resume_time": 0, "files": [{"path": os.path.join(tmp, "scene two.mp4")}]},
        {"id": "1", "title": "One", "resume_time": 0, "files": [{"path": os.path.join(tmp, "scene one.mp4")}]},
    ])
    server = await isync.ws_serve(br.handler, "127.0.0.1", 0)
    port = list(server.sockets)[0].getsockname()[1]
    app = Stashy(f"ws://127.0.0.1:{port}", A)
    await app.open()
    await asyncio.sleep(0.2)
    names = [list(m)[0] for m in app.replies]
    assert "ServerInfo" in names and "DeviceList" in names, names
    dl = next(m["DeviceList"] for m in app.replies if "DeviceList" in m)
    assert "LinearCmd" in dl["Devices"][0]["DeviceMessages"], dl

    print("5. strokes play live at once, then the scene's own script takes over")
    task = asyncio.ensure_future(app.play(30000, 1.2))
    await task
    assert br.state == "live", br.state
    assert srv._driver is br.ws, "the app is not driving"
    levels = [p["Scalars"][0]["Scalar"] for _, m, p in srv.bp.sent if m == "ScalarCmd"]
    assert any(l > 0 for l in levels), "nothing reached the vibrator live"
    await app.play(app.media(), 4.5)
    assert br.state == "locked" and br.lock["sid"] == "1", (br.state, br.lock and br.lock["sid"])
    assert srv.player.actions and srv.player.actions[0]["at"] == A[0]["at"]
    drift = srv.player._current_media_ms() - app.media()
    assert abs(drift) < 150, f"locked {drift:+.0f} ms off"
    assert srv.player.effective_vibe_mode() == "flow", srv.player.effective_vibe_mode()
    print(f"   live first, then 'One' locked, {drift:+.0f} ms from the app, Flow  OK")

    print("6. pause and resume in the app")
    await app.pause()
    await asyncio.sleep(0.2)
    assert br.paused and not srv.player.playing
    at = app.media()
    await asyncio.sleep(0.8)
    await app.play(at, 1.0)
    drift = srv.player._current_media_ms() - app.media()
    assert srv.player.playing and not br.paused and abs(drift) < 150, drift
    print(f"   paused, resumed {drift:+.0f} ms from the app  OK")

    print("7. a seek in the app is found again in the same script")
    await app.play(90000, 3.0)
    drift = srv.player._current_media_ms() - app.media()
    assert br.state == "locked" and srv.player.playing and abs(drift) < 150, (br.state, drift)
    print(f"   jumped to 90 s, {drift:+.0f} ms from the app  OK")

    print("8. another scene in the app: back to live, then that scene")
    app.actions = B
    await app.play(40000, 14.0)
    assert br.state == "locked" and br.lock["sid"] == "2", (br.state, br.lock and br.lock["sid"])
    drift = srv.player._current_media_ms() - app.media()
    assert abs(drift) < 150, drift
    print(f"   'Two' locked, {drift:+.0f} ms from the app  OK")

    print("8b. the app's clock falls behind the video (dropped frames): the bridge keeps the video's")
    app.rate = 0.97
    await app.play(60000, 2.5)                     # a seek: found again, anchored to the app
    assert br.state == "locked" and srv.player.playing
    off0 = srv.player._current_media_ms() - app.video()
    t_end = time.monotonic() + 12.0
    while time.monotonic() < t_end:                # play on without a new anchor
        cur = app.media()
        nxt = next((a for a in app.actions if a["at"] > cur), None)
        if nxt and nxt["at"] != app.sent_at:
            await app.send("LinearCmd", {"DeviceIndex": 0, "Vectors": [
                {"Index": 0, "Duration": int(nxt["at"] - cur), "Position": nxt["pos"] / 100.0}]})
            app.sent_at = nxt["at"]
        await asyncio.sleep(1 / 60)
    vs_video = srv.player._current_media_ms() - app.video()
    vs_app = srv.player._current_media_ms() - app.media()
    assert br.state == "locked" and srv.player.playing and not br.paused, (br.state, br.paused)
    assert abs(vs_video - off0) < 60, f"followed the app: {vs_video - off0:+.0f} ms"
    assert vs_app > 300 and abs(br.app_off + vs_app) < 120, (vs_app, br.app_off)
    print(f"   app {vs_app:.0f} ms behind after 14 s; bridge stayed on the video ({vs_video - off0:+.0f} ms)  OK")
    await app.pause()
    resume_at = app.video()                        # the app resumes at the video's time
    app.rate = 1.0
    await asyncio.sleep(0.5)
    await app.play(resume_at, 1.0)
    drift = srv.player._current_media_ms() - app.media()
    assert srv.player.playing and abs(drift) < 150, drift
    print(f"   resumed at the video's time, {drift:+.0f} ms  OK")

    print("9. a Stash tab that presses play takes the toy; the app's strokes then wait")
    class Tab:
        remote_address = ("tab", 1)
        def __init__(self): self.out = []
        async def send(self, data): self.out.append(json.loads(data))
    tab = Tab()
    srv.clients.add(tab)
    await srv._route(tab, {"type": "hello", "tab": "t1", "scene": "9", "playing": True})
    await srv._route(tab, {"type": "play", "time": 0})
    assert srv._driver is tab
    await app.play(app.media(), 0.5)
    assert srv._driver is tab and br.state is None, br.state
    await srv._client_gone(tab)
    print("   OK")

    print("10. the app disconnecting stops the toy")
    await app.play(app.media(), 0.5)
    assert srv._driver is br.ws
    await app.ws.close()
    await asyncio.sleep(0.3)
    assert srv._driver is None and br.ws is None and not srv.player.playing
    assert srv.bp.sent[-1][1] == "StopAllDevices", srv.bp.sent[-1]
    print("   OK")
    server.close()

asyncio.run(e2e())


# ── 11-12. Stash's GraphQL and the plugin setting ────────────────────────────
print("11. StashClient: the task's cookie first, then Stash's API key; recent interactive scenes")
from aiohttp import web

async def stash_api():
    seen = []
    async def graphql(req):
        body = await req.json()
        seen.append((req.headers.get("ApiKey"), req.cookies.get("session"), body))
        q = body["query"]
        if "apiKey" in q:
            return web.json_response({"data": {"configuration": {"general": {"apiKey": "KEY"}}}})
        if "plugins" in q:
            return web.json_response({"data": {"configuration": {"plugins": {
                "IntifaceSync": {"bridgeLiveMode": "beat", "intifaceUrl": "ws://h:1"}}}}})
        sort = body["variables"]["f"]["sort"]
        assert body["variables"]["sf"] == {"interactive": True}
        scenes = {"last_played_at": [{"id": "1", "files": [{"path": "/a.mp4"}]}],
                  "updated_at": [{"id": "2", "files": [{"path": "/b.mp4"}]},
                                 {"id": "1", "files": [{"path": "/a.mp4"}]},
                                 {"id": "3", "files": []}]}[sort]
        return web.json_response({"data": {"findScenes": {"scenes": scenes}}})
    app = web.Application()
    app.router.add_post("/graphql", graphql)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    sc = isync.StashClient({"Scheme": "http", "Host": "0.0.0.0", "Port": port,
                            "SessionCookie": {"Name": "session", "Value": "abc"}})
    assert sc.url == f"http://localhost:{port}/graphql"
    await sc.init()
    assert sc.api_key == "KEY" and seen[0][:2] == (None, "abc"), seen[0]
    cfg = await sc.plugin_config()
    assert cfg["bridgeLiveMode"] == "beat" and seen[-1][0] == "KEY"
    ids = [s["id"] for s in await sc.recent_interactive()]
    assert ids == ["1", "2"], ids                    # played first, no duplicates, no file-less scene

    print("12. the bridge listens unless the plugin settings turn it off")
    srv = isync.BackendServer({"Scheme": "http", "Host": "127.0.0.1", "Port": port})
    assert srv.bridge.stash is not None
    isync.BRIDGE_PORT = 0
    s, tick = await srv._start_bridge()
    assert s is not None and srv.bridge.live_mode == "beat"
    tick.cancel(); s.close()
    srv.bridge.stash.plugin_config = lambda: asyncio.sleep(0, {"bridgeOff": True})
    s, tick = await srv._start_bridge()
    assert s is None and tick is None
    await runner.cleanup()

asyncio.run(stash_api())
print("   OK")
print("\nBRIDGE TESTS PASSED")
