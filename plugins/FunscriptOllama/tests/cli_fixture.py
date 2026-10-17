"""Offline command-contract fixture. Never contacts an AI service."""
import json
import os
from pathlib import Path
import sys

provider, args = sys.argv[1], sys.argv[2:]
if "--version" in args:
    print("offline-cli-fixture 1.0")
    sys.exit(0)
if "--help" in args:
    print("--json-schema --print-timeout --disable-slash-commands")
    sys.exit(0)
if args == ["login", "status"]:
    print("Logged in using " + os.environ.get("FAKE_AUTH", "ChatGPT"), file=sys.stderr)
    sys.exit(0)

assert not any(os.environ.get(key) for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"))
images = sorted(Path.cwd().glob("frame-*.jpg"))
assert len(images) == 2 and all(p.read_bytes().startswith(b"\xff\xd8") for p in images)
assert "--yolo" not in args and "shell" not in args
record = {"provider": provider, "images": len(images), "cwd": str(Path.cwd()), "args": args,
          "codex_home": os.environ.get("CODEX_HOME"), "account_home": os.environ.get("HOME")}
if provider == "chatgpt_cli":
    prompt = sys.stdin.read()
    assert "required" in prompt and 'forced_login_method="chatgpt"' in args
    assert 'features.shell_tool=false' in args and "--ignore-user-config" in args
    assert "--sandbox" in args and args[args.index("--sandbox")+1] == "read-only"
    schema = json.loads(Path(args[args.index("--output-schema")+1]).read_text())
    assert schema["required"] == ["active", "confidence", "roi", "axis"]
else:
    prompt = args[args.index("--prompt")+1]
    assert all("@"+p.name in prompt for p in images)
    config = json.loads((Path(os.environ["HOME"]) / ".gemini/antigravity-cli/settings.json").read_text())
    assert os.environ["HOME"] == os.environ["USERPROFILE"]
    assert not config.get("modelProvider") and config["toolPermission"] == "strict"
    assert set(config["permissions"]["deny"]) >= {"command(*)", "mcp(*)", "write_file(*)", "read_url(*)"}
    assert "--approval-mode" not in args and "--disable-slash-commands" in args
    assert "--dangerously-skip-permissions" not in args
    schema = json.loads(Path(args[args.index("--json-schema")+1]).read_text())
    assert schema["required"] == ["active", "confidence", "roi", "axis"]
    record["timeout"] = args[args.index("--print-timeout")+1]
record["prompt"] = prompt
trace = Path(os.environ["FAKE_TRACE"])
prior = trace.read_text().splitlines() if trace.exists() else []
with trace.open("a", encoding="utf-8") as out:
    out.write(json.dumps(record)+"\n")
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "quota":
    print("429 private-output-secret", file=sys.stderr)
    sys.exit(7)
if mode == "error-envelope":
    print(json.dumps({"error": {"message": "private-output-secret"}}))
    sys.exit(0)
region = {"active": True, "confidence": 0.9, "roi": [0.1, 0.1, 0.9, 0.9], "axis": "y"}
text = json.dumps(region)
if mode == "invalid" or (mode == "invalid-once" and not prior):
    region["roi"] = [0.8, 0.8, 0.1, 0.1]
    text = json.dumps(region)
if mode == "fenced":
    text = "```json\n"+text+"\n```"
if provider == "chatgpt_cli":
    Path(args[args.index("--output-last-message")+1]).write_text(text, encoding="utf-8")
else:
    envelope = {"status": "SUCCESS", "structured_output": region, "response": text}
    if mode.startswith("status-"):
        envelope["status"] = mode[7:].upper()
    if mode == "missing-status":
        del envelope["status"]
    if mode in ("missing-structured", "empty-success"):
        del envelope["structured_output"]
    if mode == "empty-success":
        envelope["response"] = ""
    if mode == "partial-timeout":
        print("[agy] print timeout; returning partial output", file=sys.stderr)
    print(json.dumps(envelope))
