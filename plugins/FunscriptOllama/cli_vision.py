"""Account-authenticated official CLIs; no HTTP client or credential extraction."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time

MAX_OUTPUT = 2 * 1024 * 1024


class ProviderUnavailableError(RuntimeError):
    """Stop the queue on account, quota, transport or CLI installation errors."""


def cli_command(executable, provider):
    """Resolve npm Windows shims through Node without invoking cmd/PowerShell."""
    resolved = shutil.which(executable)
    if not resolved:
        raise RuntimeError(f"{provider} executable not found; install the official CLI in the Stash runtime and check CLI Path")
    path = Path(resolved)
    if path.suffix.lower() in (".cmd", ".bat", ".ps1"):
        name = "@openai/codex" if provider == "ChatGPT CLI" else "@google/gemini-cli"
        package = ((path.parent.parent / name) if path.parent.name == ".bin" else path.parent / "node_modules" / name)
        try:
            manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))
            bins = manifest["bin"]
            relative = bins["codex" if provider == "ChatGPT CLI" else "gemini"] if isinstance(bins, dict) else bins
            script = (package / relative).resolve()
            if not script.is_relative_to(package.resolve()):
                raise ValueError("Package entry point escapes its package")
        except (OSError, ValueError, KeyError, TypeError):
            raise RuntimeError(f"{provider}: cannot resolve the official npm package entry point") from None
        node = shutil.which("node")
        if not node or not script.is_file():
            raise RuntimeError(f"{provider}: npm shim needs Node and the official package beside it; no shell wrappers are executed")
        return [node, str(script)]
    return [str(path)]


def account_environment(settings):
    env = os.environ.copy()
    # Explicitly selected account mode must not silently fall back to paid keys,
    # Vertex, alternate endpoints or an inherited .env file.
    for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY",
                "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_ACCESS_TOKEN",
                "GOOGLE_CLOUD_ACCESS_TOKEN"):
        env.pop(key, None)
    if settings["cli_account_dir"]:
        root = Path(settings["cli_account_dir"]).expanduser()
        for child in (root / "codex", root / "gemini"):
            child.mkdir(parents=True, exist_ok=True, mode=0o700)
        env["CODEX_HOME"] = str(root / "codex")
        env["GEMINI_CLI_HOME"] = str(root / "gemini")
    env["NO_COLOR"] = "1"
    return env


class WindowsJob:
    """Own descendants even when an npm/native launcher exits before its worker."""
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        class BasicLimit(c.Structure):
            _fields_ = [("process_time", c.c_longlong), ("job_time", c.c_longlong), ("flags", w.DWORD),
                        ("min_ws", c.c_size_t), ("max_ws", c.c_size_t), ("active", w.DWORD),
                        ("affinity", c.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
        class ExtendedLimit(c.Structure):
            _fields_ = [("basic", BasicLimit), ("io", c.c_ulonglong * 6),
                        ("memory", c.c_size_t * 4)]
        class Accounting(c.Structure):
            _fields_ = [("times", c.c_longlong * 4), ("faults", w.DWORD), ("total", w.DWORD),
                        ("active", w.DWORD), ("terminated", w.DWORD)]
        self.c, self.Accounting = c, Accounting
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([c.c_void_p, w.LPCWSTR], w.HANDLE),
            "SetInformationJobObject": ([w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
            "AssignProcessToJobObject": ([w.HANDLE, w.HANDLE], w.BOOL),
            "TerminateJobObject": ([w.HANDLE, w.UINT], w.BOOL),
            "QueryInformationJobObject": ([w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p], w.BOOL),
            "CloseHandle": ([w.HANDLE], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            getattr(self.kernel, name).argtypes = args
            getattr(self.kernel, name).restype = result
        self.handle = self.kernel.CreateJobObjectW(None, None)
        limit = ExtendedLimit()
        limit.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, c.byref(limit), c.sizeof(limit)):
            if self.handle:
                self.kernel.CloseHandle(self.handle)
            raise ProviderUnavailableError("Cannot create Windows CLI process job")

    def attach(self, process):
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            process.kill()
            process.wait(timeout=10)
            self.close()
            raise ProviderUnavailableError("Cannot isolate Windows CLI process tree")

    def close(self):
        if not self.handle:
            return
        try:
            self.kernel.TerminateJobObject(self.handle, 1)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                info = self.Accounting()
                if not self.kernel.QueryInformationJobObject(self.handle, 1, self.c.byref(info), self.c.sizeof(info), None) or not info.active:
                    break
                time.sleep(0.02)
        finally:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def stop_process_tree(process, job=None):
    if job:
        job.close()
    elif os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)


def run_cli(argv, *, cwd, env, timeout, label, prompt="", log=None, extra_outputs=()):
    """Bound output, lifetime and child processes without logging raw CLI output."""
    # Anonymous/delete-on-close capture avoids Windows launcher/broker handles
    # blocking removal of the image workspace. Raw output is never persisted as
    # a named log inside the workspace or included in a user-facing exception.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        job = WindowsJob() if os.name == "nt" else None
        options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
                   if os.name == "nt" else {"start_new_session": True})
        try:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                       stdout=out, stderr=err, shell=False, **options)
        except OSError:
            if job:
                job.close()
            raise ProviderUnavailableError(f"{label} could not start; check executable/runtime permissions") from None
        if job:
            job.attach(process)
        started, last_update = time.monotonic(), time.monotonic()
        try:
            try:
                process.stdin.write(prompt.encode("utf-8"))
                process.stdin.close()
            except BrokenPipeError:
                pass  # The CLI exited early; classify its exit below without echoing output.
            while True:
                if (os.fstat(out.fileno()).st_size > MAX_OUTPUT or os.fstat(err.fileno()).st_size > MAX_OUTPUT
                        or any(p.exists() and p.stat().st_size > MAX_OUTPUT for p in extra_outputs)):
                    raise ProviderUnavailableError(f"{label} output exceeded 2 MiB; request stopped")
                if process.poll() is not None:
                    break
                now = time.monotonic()
                if now - started >= timeout:
                    raise ProviderUnavailableError(f"{label} timed out after {timeout} seconds; request stopped")
                if log and now - last_update >= 30:
                    log.info(f"Still waiting for {label}; elapsed {now-started:.0f} seconds")
                    last_update = now
                time.sleep(0.1)
        finally:
            # Also clean descendants after an early CLI exit, cancellation or error.
            stop_process_tree(process, job)
        out.seek(0)
        err.seek(0)
        stdout = out.read(MAX_OUTPUT + 1).decode("utf-8", errors="replace")
        stderr = err.read(MAX_OUTPUT + 1).decode("utf-8", errors="replace")
    if process.returncode:
        if any(word in (stdout + stderr).lower() for word in ("429", "quota", "resource_exhausted", "rate_limit")):
            raise ProviderUnavailableError(f"{label} quota/rate limit reached; no provider or API-key fallback was used")
        raise ProviderUnavailableError(f"{label} failed (exit {process.returncode}); check account login, quota and CLI compatibility manually; raw output withheld")
    return stdout, stderr


def parse_region_text(text):
    if not isinstance(text, str):
        raise ValueError("AI CLI returned no region JSON")
    # Only a complete JSON object or a single JSON fence is accepted. Never
    # extract a plausible object from explanations, refusals or tool transcripts.
    text = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError("AI CLI returned invalid region JSON") from None
    return value


class CLIVision:
    def __init__(self, settings, log, validator, prompt, schema):
        self.settings, self.log, self.validator = settings, log, validator
        self.prompt, self.schema = prompt, schema
        self.codex = settings["ai_provider"] == "chatgpt_cli"
        self.label = "ChatGPT CLI" if self.codex else "Gemini CLI"
        self.command = cli_command(settings["codex_path" if self.codex else "gemini_path"], self.label)
        self.env = account_environment(settings)

    def invoke(self, args, directory, prompt="", extra_outputs=(), timeout=None):
        return run_cli(self.command + args, cwd=directory, env=self.env,
                       timeout=timeout or self.settings["timeout_seconds"], label=self.label,
                       prompt=prompt, log=self.log, extra_outputs=extra_outputs)

    def check_model(self):
        with tempfile.TemporaryDirectory(prefix="funscript-cli-check-") as directory:
            self.invoke(["--version"], directory, timeout=30)
            if self.codex:
                out, err = self.invoke(["login", "status"], directory, timeout=30)
                if "logged in using chatgpt" not in (out + err).lower():
                    raise ProviderUnavailableError("ChatGPT CLI needs ChatGPT account login; API-key authentication is not accepted")
        if self.log:
            self.log.info(f"Step OK: {self.label} available; account-only mode (image test verifies model access)")

    def region(self, frames):
        import cv2
        with tempfile.TemporaryDirectory(prefix="funscript-vision-") as directory:
            root = Path(directory)
            images = []
            for i, frame in enumerate(frames):
                target = root / f"frame-{i+1}.jpg"
                if not cv2.imwrite(str(target), frame, [cv2.IMWRITE_JPEG_QUALITY, 75]):
                    raise RuntimeError("Cannot prepare CLI analysis image")
                images.append(target.name)
            prompt = self.prompt + "\nRequired JSON Schema: " + json.dumps(self.schema)
            for attempt in range(2):
                if self.log:
                    self.log.info(f"Waiting for {self.label}; {len(images)} selected frames; timeout {self.settings['timeout_seconds']} seconds")
                started = time.monotonic()
                if self.codex:
                    schema = root / "region-schema.json"
                    schema.write_text(json.dumps(self.schema), encoding="utf-8")
                    output = root / "region.json"
                    output.unlink(missing_ok=True)
                    args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
                            "--sandbox", "read-only", "--color", "never", "--output-schema", str(schema),
                            "--output-last-message", str(output)]
                    for config in ('forced_login_method="chatgpt"', 'model_provider="openai"',
                                   'approval_policy="never"', 'features.shell_tool=false', 'features.apps=false',
                                   'features.hooks=false', 'features.multi_agent=false', 'features.remote_plugin=false',
                                   'agents.enabled=false', 'web_search="disabled"'):
                        args += ["-c", config]
                    if self.settings["codex_model"]:
                        args += ["--model", self.settings["codex_model"]]
                    for image in images:
                        args += ["--image", image]
                    args += ["--", "-"]  # End the repeatable image option before stdin prompt.
                    self.invoke(args, directory, prompt, (output,))
                    if not output.is_file():
                        raise ProviderUnavailableError("ChatGPT CLI produced no final response file")
                    text = output.read_text(encoding="utf-8")
                else:
                    config = root / ".gemini" / "settings.json"
                    config.parent.mkdir(exist_ok=True)
                    config.write_text(json.dumps({
                        "security": {"auth": {"selectedType": "oauth-personal", "enforcedType": "oauth-personal"}},
                        "admin": {"extensions": {"enabled": False}, "mcp": {"enabled": False}, "skills": {"enabled": False}},
                        "hooksConfig": {"enabled": False}, "skills": {"enabled": False},
                        "tools": {"core": ["read_file", "read_many_files"]},
                        "advanced": {"ignoreLocalEnv": True}, "telemetry": {"enabled": False},
                    }), encoding="utf-8")
                    # Force these settings for this process only. Account files
                    # remain under the CLI's own home and are never read here.
                    self.env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = str(config)
                    args = ["--approval-mode", "default", "--output-format", "json", "--prompt",
                            prompt + "\nImages in chronological order: " + " ".join("@" + name for name in images)]
                    if self.settings["gemini_model"]:
                        args += ["--model", self.settings["gemini_model"]]
                    stdout, _ = self.invoke(args, directory)
                    try:
                        envelope = json.loads(stdout)
                    except json.JSONDecodeError:
                        raise ProviderUnavailableError("Gemini CLI produced no valid output envelope") from None
                    if not isinstance(envelope, dict) or envelope.get("error"):
                        raise ProviderUnavailableError("Gemini CLI reported an error; check account login, quota or content restrictions")
                    text = envelope.get("response")
                try:
                    result = self.validator(parse_region_text(text))
                except ValueError:
                    if attempt:
                        raise ValueError(f"{self.label} returned an invalid tracking region twice; no output created") from None
                    if self.log:
                        self.log.info(f"Invalid {self.label} region; requesting one correction")
                    prompt = self.prompt + " Return valid JSON only; active ROI needs positive width/height. Schema: " + json.dumps(self.schema)
                    continue
                if self.log:
                    self.log.info(f"Step OK: {self.label} region validated after {time.monotonic()-started:.1f} seconds; active={result['active']}")
                return result
