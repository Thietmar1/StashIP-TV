"""Funscript chapter import/export; existing Stash markers are never changed."""
import json
import math
from pathlib import Path


def seconds(value):
    if isinstance(value, str):
        parts = value.strip().split(":")
        if not 1 <= len(parts) <= 3 or any(not p for p in parts):
            raise ValueError("Invalid chapter time")
        try:
            numbers = [float(p) for p in parts]
        except ValueError:
            raise ValueError("Chapter time must be seconds or HH:MM:SS.mmm") from None
        if any(not math.isfinite(n) or n < 0 for n in numbers):
            raise ValueError("Invalid chapter time")
        if len(parts) > 1 and (any(n >= 60 for n in numbers[1:]) or any(n != int(n) for n in numbers[:-1])):
            raise ValueError("Invalid chapter minutes/seconds")
        value = sum(n * (60 ** i) for i, n in enumerate(reversed(numbers)))
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("Chapter time must be finite and nonnegative")
    return float(value)


def timestamp(value):
    milliseconds = round(seconds(value) * 1000)
    whole, fraction = divmod(milliseconds, 1000)
    minutes, sec = divmod(whole, 60)
    hour, minute = divmod(minutes, 60)
    return f"{hour:02}:{minute:02}:{sec:02}.{fraction:03}"


def parse_chapters(script):
    metadata = script.get("metadata") or {}
    if not isinstance(metadata, dict):
        raise ValueError("Funscript metadata must be an object")
    chapters = metadata.get("chapters", [])
    if not isinstance(chapters, list):
        raise ValueError("Funscript chapters must be an array")
    parsed = []
    for chapter in chapters:
        if not isinstance(chapter, dict) or not isinstance(chapter.get("name"), str):
            raise ValueError("Every chapter needs a string name")
        start = seconds(chapter.get("startTime"))
        item = {"title": chapter["name"].strip() or "#", "seconds": start}
        if chapter.get("endTime") not in (None, ""):
            end = seconds(chapter["endTime"])
            if end < start:
                raise ValueError("Chapter end precedes start")
            item["end_seconds"] = end
        parsed.append(item)
    return sorted(parsed, key=lambda item: item["seconds"])


def load_script(path):
    if Path(path).stat().st_size > 64 * 1024 * 1024:
        raise ValueError("Funscript exceeds 64 MiB")
    with Path(path).open(encoding="utf-8-sig") as stream:
        script = json.load(stream)
    if not isinstance(script, dict):
        raise ValueError("Funscript must be an object")
    return script


def scene_markers(stash, scene_id):
    scene = stash.find_scene(scene_id, fragment="id scene_markers { id title seconds end_seconds primary_tag { id name } }")
    if not scene:
        raise ValueError("Scene no longer exists")
    return scene.get("scene_markers") or []


def import_chapters(stash, scene_id, script, tolerance=0.25):
    parsed = parse_chapters(script)  # Validate every chapter before any writes.
    if not parsed:
        return 0
    existing = scene_markers(stash, scene_id)
    added = 0
    for chapter in parsed:
        name, start = chapter["title"], chapter["seconds"]
        if any(abs(float(m["seconds"])-start) <= tolerance and
               name.casefold() in {str(m.get("title", "")).casefold(),
                                   str((m.get("primary_tag") or {}).get("name", "")).casefold()}
               for m in existing):
            continue
        tag = stash.find_tag(name, create=True)
        if not tag:
            raise ValueError("Cannot create chapter tag")
        value = {"scene_id": scene_id, "title": name, "seconds": start,
                 "primary_tag_id": tag["id"], "tag_ids": []}
        if "end_seconds" in chapter:
            value["end_seconds"] = chapter["end_seconds"]
        marker = stash.create_scene_marker(value, fragment="id")
        if not marker:
            raise ValueError("Stash did not create the chapter marker")
        existing.append({**chapter, "primary_tag": {"name": name}})
        added += 1
    return added


def export_chapters(stash, scene_id, script, previous=None):
    # Retain pre-existing sidecar chapters when explicitly overwriting motion.
    merged = parse_chapters(previous or {})
    for marker in scene_markers(stash, scene_id):
        start = seconds(marker["seconds"])
        title = str(marker.get("title") or (marker.get("primary_tag") or {}).get("name") or "#")
        if any(c["title"].casefold() == title.casefold() and abs(c["seconds"]-start) < 0.001 for c in merged):
            continue
        item = {"title": title, "seconds": start}
        if marker.get("end_seconds") is not None:
            item["end_seconds"] = seconds(marker["end_seconds"])
            if item["end_seconds"] < start:
                raise ValueError("Stash marker end precedes start")
        merged.append(item)
    chapters = []
    for item in sorted(merged, key=lambda c: c["seconds"]):
        chapter = {"name": item["title"], "startTime": timestamp(item["seconds"])}
        if "end_seconds" in item:
            chapter["endTime"] = timestamp(item["end_seconds"])
        chapters.append(chapter)
    if chapters:
        script.setdefault("metadata", {})["chapters"] = chapters
    return script


def completion_marker(stash, scene_id, tolerance=0.25):
    if any(abs(float(m["seconds"])) <= tolerance and m.get("title") == "Funscript Generated"
           for m in scene_markers(stash, scene_id)):
        return 0
    tag = stash.find_tag("Funscript", create=True)
    if not tag or not stash.create_scene_marker({"scene_id": scene_id, "title": "Funscript Generated",
                                                "seconds": 0, "primary_tag_id": tag["id"], "tag_ids": []}, fragment="id"):
        raise ValueError("Cannot create completion marker")
    return 1
