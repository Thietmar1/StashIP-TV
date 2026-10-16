# FunscriptHaven and Funscript Markers

`haven_motion.py` contains adapted functions/classes from Funscript Haven by
Haven-hvn and contributors, distributed in stashapp/CommunityScripts under
AGPL-3.0. Original source:
https://github.com/stashapp/CommunityScripts/blob/main/plugins/FunscriptHaven/funscript_haven.py
Git blob: `8794afe78233b20a7b8ba44c12be525bfd0cc5a0`.

Adapted on 2026-10-16: isolated numerical routines, removed runtime dependency
installation and direct file writes, stable multi-axis seeds, support for zero
auto-home duration. The decoder and orchestration are maintained by Funscript
Ollama. The original decord/Intel Arc decoder setup is not bundled.

The chapter workflow follows Funscript Markers by its CommunityScripts
contributors:
https://github.com/stashapp/CommunityScripts/tree/main/plugins/funscriptMarkers
Its `metadata.chapters` import is implemented independently, with validation,
zero-time chapters, end times, duplicate checks and preservation of manual markers.

The accompanying LICENCE contains the full AGPL-3.0 license. OpenCV, NumPy and
stashapp-tools are separately installed dependencies with their own licenses.
