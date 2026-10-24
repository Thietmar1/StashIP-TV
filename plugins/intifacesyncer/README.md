# Intiface Sync

Syncs funscripts to your toy while you watch in Stash. Works with vibrators and
strokers through [Intiface Central](https://intiface.com/central/), or with a
Handy over WiFi.

A fork of [vib3coda/Stash-Intiface-Handy](https://github.com/vib3coda/Stash-Intiface-Handy),
adding support for vibrating toys, which the original did not drive.

## Setup

1. Install and run **Intiface Central**, and connect your toy to it.
2. In Stash: **Settings > Plugins > IntifaceSync**, set the server URL if it is
   not `ws://localhost:12345`.
3. Run the **Start Backend** task once (Settings > Tasks).
4. Open any scene. The toolbar appears under the player.

If a funscript sits next to the video with the same base name, it loads
automatically.

You do not need a toy connected for that. Scripts are found and loaded, and the
signal preview works, as soon as the backend is running — useful for checking a
script or a vibe mode before you connect anything.

## Under the player

**One quiet line** while you watch: a pill, the gear and **Stop**. Nothing
covers the video (except a small pill in fullscreen, below).

- **The pill** says what plays and how strong, in words: *Script · Gush 2 ·
  Auto · Flow · 60%*, *Manual · Build up · 42%*, *Goon · Waves · level 6 · 48%*.
  The percentage is what reaches the toy. When something needs doing it says
  that instead, with the one button that fixes it: *Backend not running* ·
  Start, *Old backend: restart it* · Restart backend, *No Intiface server* ·
  Retry, *Another tab drives the toy* · Take over, *Muted* · Unmute,
  *Stopped* · Resume. A `*` after a preset means you changed it since
  loading it. *paused · silent* means the video is paused and nothing reaches
  the toy (below). Click the pill to open the controls.
- **Stop** (or `0`) stops everything, in every mode: the script, the manual
  pattern and Goon mode, from any tab. The script starts again the next time
  you press play (or with Resume); Manual starts the pattern again. The
  Intiface connection stays, so there is nothing to reconnect. With the
  backend not running it says *Not connected: nothing is being sent from here*.
  Stop is on the bar, in both sheets, on the Goon pad, on the phone sheet and
  in fullscreen.
- **Keyboard shortcuts are shown on hover**, never printed on the buttons:
  rest the mouse on Stop (`0`), Live (`E`), a pad (`Alt+1`..), Edge
  (`Alt+W`) and so on. The full list is in the settings (the gear) and behind
  the **?** on the Goon pad.
- **In fullscreen** a small pill in the top right corner of the player shows
  what plays and how strong, with Stop. It dims while the player hides its
  controls and is never hidden.

### The controls

A click on the pill opens them right under the player; the page moves down,
the video stays clear.

- **Script · Manual · Goon**: what drives the toy. Script follows the
  funscript; Manual plays your pattern now; Goon builds up by itself on top of
  your pattern (below). Choosing Manual or Goon starts the toy, as the Manual
  button always did; Script hands back to the funscript (each says so on
  hover).
- **Strength**, with − and + (`[` `]`): the number is what reaches the toy.
  In Manual a red **Max** mark shows the preset's power limit, and Strength
  stops there; in Script the Max is the script's Strongest. In Goon this row
  is the **Level** 1 to 10: − and + around ten dots (click a dot to jump
  there), the same control as on the Goon pad. Each mode keeps its own
  strength.
- **Live / Muted** (`E`): muted means nothing reaches the toy, script or
  manual.
- With **Script**: the script's line (the mode Auto picked, the timing, the
  strongest) and **Tune script**.
- With **Manual**: your presets as cards with a picture of their shape and
  their Max; the first four are **Alt+1** to **Alt+4** (on hover, and the
  info mark next to Presets). Drag a card (or
  Shift + arrow keys on it) to reorder. Under them, the pattern in a
  sentence, **Update** / **Revert** when you changed it, a performer's
  favourite when there is one, **Fine-tune** and **Edit pattern**.
- With **Goon**: its style, stage and countdown, the graph (the last 40
  seconds and the plan ahead, with the 10-second close-up), Edge / Hold / Cool
  down as one small row, Pace, Built on, the start level and **End Goon**.
  The pads are only on the floating pad; the controls say how many there are
  and offer **Show pad** when it is made small or not on the page. Each line
  under a setting is short; rest the mouse on it for the whole sentence.

**Fold the controls while the video plays** (a switch in the settings, off
unless you turn it on) closes them 4 seconds after your last change while the
video plays; the pin in their corner keeps them open. Moving the mouse over
them or typing in a number box keeps them open; a mouse resting there, or the
Strength slider you just used, does not.

**Silent while the video is paused** (a switch in the settings, on unless you
turn it off): while the scene's video is paused, has ended or is buffering
for more than 2 seconds, nothing reaches the toy, in Script, Manual and Goon
mode alike. Manual stays on and Goon mode waits (its clock, Pace and stage
timers hold, as when muted); press play and it goes on from where it was.
This only applies where there is a video player: Manual or Goon mode on
another Stash page (a performer's page, the scene list) plays as before. It
is not a stop: Stop, `0`, mute and Disconnect work as always while paused.

### Settings (the gear)

The connection in three lines (the backend and its version, Intiface Central
with **Connect again**, the toy with its steps and which tab drives it),
**Disconnect** (stops the toy and drops the Intiface link), **This script**
with its tuning folded away, the switches (your pattern on scenes without a
funscript, folding the controls, micro pulsing, keyboard shortcuts), every key
in one list, **Scenes without a funscript** and **Not using it**. With the
Handy setting on, the Intiface / The Handy switch and the connection key live
here too. `Esc` closes it.

**Restart backend**, **Stop backend** (click twice) and **Start backend**
are under the connection lines; the pill's button says **Restart backend**
when the backend is older than the page (reloading plugins does not restart
the backend). Restart stops the toy first, then the backend, starts it
again, and says the new version when it answers. They do what Stop Backend and
Start Backend in Settings › Tasks › Intiface Sync do.

**On a phone** the line under the player is the pill and a big Stop. The pill
opens the controls as a sheet at the bottom of the screen (Fine-tune and All
presets are pages of it, with Back) with Stop always at its foot; the gear is
in the sheet's top line.

The heat strip over the player's timeline (1.38 to 1.45) is gone.

### Not using it

**Not using it: turn off in this browser** in the settings stops anything
that is running, then shrinks the bar to a small **Intiface · off** pill.
While it is off, nothing connects: no backend
connection, no Start Backend task, no Intiface retries, and the keys E, `\`,
`[`, `]`, `-`, `=` and `0` go back to Stash. It applies to every tab of this browser and
is remembered. Click the pill to turn it back on.

If Intiface Central is not running, the pill says **No Intiface server** and
waits: other tabs do not keep retrying on their own for a minute. **Retry**
tries at once.

### Scenes without a funscript

In the settings. Counts the scenes that have no funscript (Stash's
"interactive" flag) for the whole library, a performer or the studio of the
scene you are on, with counts per performer and studio (click one to narrow
it down) and the most played ones first, the ones most worth finding a script
for. **Open in Stash** shows the same list in Stash's own scene list. It only
reads.

### Favourite pattern per performer

In **Edit pattern**, under **For the people in this scene** (or the one-line
**Remember … for …** in the controls): **Remember for …** stores the current
pattern (and the preset it came from) for that performer. When a scene with
them plays in Manual, by hand or because it has no funscript, the controls
offer it (*Name: your favourite is …* · Use it). Use loads it like a
preset; it never starts the toy by itself. Favourites are saved in Stash's
plugin settings, shared by every browser.

## Manual patterns

| Pattern | What it does |
|---|---|
| **Steady** | One level, held. No movement. |
| **Wave** | Rises and falls smoothly, over and over. |
| **Pulse** | A short buzz at a regular beat, silence between. |
| **Ramp** | Climbs to the top, drops, climbs again. |
| **Tease** | Buzzes that start short and grow longer. |
| **Random** | Unpredictable level, changing on its own. |
| **Tidal** | Phrases of 2 to 5 buzzes that swell and ebb: accents, holds, long silences. |

**Edit pattern** (in the controls) draws the pattern you have set up, with a sentence underneath
saying the same thing in words ("One 0.4 s buzz at 60% every 4 s…"), so you
can see what a setting does as you drag it.

Each pattern shows only the settings it actually uses, so if a field is not on
screen, that pattern ignores it.

- **Cycle length / Repeat every** — one full rise and fall, or the gap between
  buzzes for Pulse and Tease (**A phrase every** for Tidal).
- **Buzz length** — how long each buzz lasts. Short reads as a tap, long as a throb.
- **Dip to** — how far the level falls between peaks. 0 falls to silence.
  When the low point is still strong enough to feel, a line under it says
  so ("Between peaks it keeps vibrating at N%"). Tease and Pulse do not use
  it: they are silent between buzzes.
- **Length build-up** (Tease): how many buzzes it takes to grow from the
  **Starting buzz length** to the **Final buzz length**, e.g. 0.2 s growing
  to 1.5 s over 10 buzzes. Changing a build setting starts the build over, so
  you feel the change straight away.
- **Strength build-up** (Tease) — how many buzzes it takes to grow from the
  **Starting strength** to full. Use it on its own, or with the length
  build-up so buzzes get both longer and stronger.
- **Power limit** — the strongest the motor may go: the **Max** mark on
  Strength. Strength is a share of it, so a lower Max gives finer control at
  low levels, and a preset with a higher Max plays stronger (it climbs there,
  never a jump).
- **Micro pulse** — length of each pulse used to reach levels below the motor's
  own floor.

The line at the bottom of Fine-tune tells you the peak output and whether it is
above or below your motor's floor. That is the number that decides whether
micro pulsing does anything.

### Fine-tune

Three sliders that each move a few of the values above together, with the
real values written under each:

- **Intensity** (gentle to full power): the Power limit, 5% to 100%, and the
  micro pulse length with it.
- **Rhythm** (slow, long throbs to fast, short taps): the cycle from 12 s to
  0.6 s, the buzz length and the starting buzz length in proportion, and how
  low it dips (30% down to silence).
- **Build-up** (none to long, Tease only): the length and strength build-up,
  0 to 30 buzzes (the chips **Longer buzzes** and **Stronger buzzes** choose
  which), starting shorter and weaker the longer it builds.

**Edit pattern** still has every value on its own slider and number box.

### Tidal

A richer pattern than a plain Tease. Buzzes come in **phrases** of 2 to 5,
each buzz 0.1 to 0.7 s with a short silence (0.18 to 0.42 s) inside a
phrase and a longer one between phrases (on average one phrase every
**A phrase every**, 6 s to start with). Over a 40-second **breath** the
phrases come closer, run longer and play a little stronger, then thin out
again. About one buzz in four is an **accent** (full strength, from the long
end), about one phrase in five ends in a **hold** of 0.8 to 1.2 s, and about
one gap in eight is a **long silence** of 6 to 12 s. Between buzzes it is
always off. **Longest buzz** and **Shortest buzz** set the range.

A few seconds of it, for example: *buzz 0.3 s · 0.25 s off · buzz 0.6 s
(accent) · 0.2 s off · buzz 0.15 s · 4.1 s off · buzz 0.4 s · 0.3 s off ·
hold 1.1 s · 9 s off · ...* and near high tide the phrases are four or five
buzzes with a second or two between them.

It is built in as Goon's **Tidal (built in)** base; **Save Tidal as my
preset** there makes a "Tidal" preset of your own with a **30%** power limit.
A Build up style Tease at a 10% Max is very gentle: one short buzz every 6
seconds. Tidal plays several buzzes a phrase with silences between, so its
preset starts at 30%. Lower its Max if that is too much.

### Presets

Set a pattern up the way you like it, then **+ Save as preset** (the last
card) and give it a name. Click a card to load it.

- The active preset stays active until you pick another one: new tabs, reloads
  and other browsers all come up with it loaded.
- Changing a setting keeps the preset active and marks it with `*`. **Update**
  saves the change into the preset, **Revert** throws it away.
- **Stop following the preset** (in Edit pattern) keeps the current settings
  but stops following the preset. Rename, Delete and Save as new are there too.
- A preset holds the pattern, its timing and the power limit. It does not hold
  Strength, and loading one never switches manual mode on.
- Presets are saved in Stash's plugin settings, so they survive plugin updates
  and are shared by every browser that uses this Stash.

### The first four cards (Alt+1..4)

In Manual (outside Goon mode) **Alt+1** to **Alt+4** load the first four
cards and **Alt+Shift+1** to **Alt+Shift+4** move the active preset to that
place (drag or Shift + arrows work too). Switching never jumps up in strength:
when the new preset's Max is higher, the toy climbs to it over a few seconds
(lower is at once). The quick slots of earlier versions became the first four
cards, in slot order, when this version first loaded.

### Goon mode

It builds up by itself; you only steer. Choose **Goon** in the controls: it
starts like Manual does (from the strength playing now), and **Manual** or
**End Goon** goes back to your pattern as it was. Three things, all changeable
while it plays:

- **Style**: Steady climb, Waves, Rhythm (beat rounds, faster each round, rests
  between), Tease (stop-start: up to the edge, pause, again), Rollercoaster (a
  mix of everything) or Endurance (a long plateau, rare edges).
- **Level 1-10** (the Strength row, `[` `]`): more or less while it plays;
  **Start level** (− and +, or **Use N** for where it is now) is where it
  starts next time. Level 10 is the
  current pattern's power limit (its Max); the numbers Goon shows are what
  reaches the toy. 1 to 3 begin with a warm-up; 4 and up skip it and climb
  straight to the build-up.
- **Pace** Slow / Normal / Fast: it moves the level up by itself about every 6 /
  4 / 2 minutes, at most 3 levels above where you started (beyond that only you).
- **Built on**: the preset whose buzzes Goon builds up, by default your
  "Build up" (else your first Tease preset), or **Tidal (built in)** (or a
  Tidal preset of yours). Its cycle and buzz lengths are the starting point;
  Goon plays more of them, longer and stronger as it climbs. On Tidal every
  stage plays phrases (Edge and Surge longer ones with more accents and no
  long silences); **Save as my preset** (next to Built on) makes an editable copy.

Goon plays **short buzzes with silence between them**, always: every buzz
its own length and strength, the pauses varied, now and then a double or
triple tap or a longer silence. The stages differ by how many buzzes, how
long, how strong and how long the pauses are: a warm-up close to your
preset, climbs and plateaus busier, **Edge** fast, long, strong buzzes with
short gaps (still gaps), a **Cool down** sparse light taps with long
silences.

The controls show all of it; besides, the whole time it plays a pad floats on
the page (drag it from anywhere but its buttons, with the mouse or a finger;
it stays inside the window and remembers where you put it; the arrow makes it a small strip, which it is
by itself over a fullscreen player; on a phone it is a sheet at the bottom). Its head names the style
in a word (click it for the controls), with End Goon and Stop. It shows what plays now and for how long,
what comes next, and a graph of the last 30 seconds and the next minute as planned,
with your power limit (red) and any learned cap (yellow), its scale topped just over the limit. Each buzz is a bar,
so the silence between them shows (the controls' graph adds the last and the next 10 seconds close up).
Each pad's picture is its buzzes with the gaps between them.

**Three moves.** **Edge** climbs to your peak and stays there until you press
it again; then a short cool-down and the build-up goes on (it lets go by itself
after 90 seconds). **Hold** freezes everything right where it is; press again to
go on. **Cool down** drops at once, rests 30 to 60 seconds, then climbs back.

**Launch pad.** Short flavours that take over for a few seconds and then glide
back to the build-up, all of them buzzes with silence between: Pulse burst,
Heartbeat, Fast rhythm and Surge by default,
with Stutter, Wave swell, Tease stop and one of your presets on pads 5 to 8. Set
how many pads you want (1 to 8) with − and +. Press a pad (or **Alt+1**..) to
play it for its length; hold it to keep it going; press it twice quickly to
latch it on until you press it again. Another pad replaces the playing one.
Right-click a pad (on a phone: **Edit**, then tap the pad) to choose what it
plays: a flavour or one of your presets and how long; **Alt+Shift+1**.. puts the
active preset on that pad.

**It learns, for this session only.** A Cool down near the top caps the next
peaks a little under where you were ("Peaks capped at 62%: you cooled down at
67%"); two in the same rhythm tier make that tier play one slower; one right
after a pad makes that pad softer; climbs after a Cool down take a little
longer. One line on the pad says what it learned and why; **Forget** undoes it.
Nothing is kept for the next time.

The strength never rises faster than 4% a second (8% as a pad starts), and never
goes above the power limit (or a pad preset's own). There are never more than four
buzzes a second, a buzz is never longer than 2 seconds, and a buzz is never softer
than 10% at the toy: between buzzes it is off. A preset of your own on a pad plays
as you made it. **Muted** or **paused** (the video, with Silent while the
video is paused on), Goon mode waits (no clock, no Pace) and goes on from
where it was when you unmute or press play.

| Key (while it runs) | |
|---|---|
| `Alt` + mouse wheel, `[` `]` | level up / down (the wheel over the pad works without Alt) |
| `Alt+1`..`Alt+8` | the pads (up to how many you have) |
| `Alt+Shift+1`..`8` | put the active preset on that pad |
| `Alt+W` | Edge (again: let go) |
| `Alt+A` | Hold / go on |
| `Alt+Q` | Cool down |

**End Goon** (the controls or the pad) turns Goon mode off and goes back to the
pattern as it was. **Stop** (or `0`) stops everything; `E` mutes. Choosing
Script or Manual, Manual off, or another tab taking over ends Goon mode.
Going to the next video, or to any other Stash page, in the same tab does
not: the session goes on (the same clock, level, learned limit and latched
pad) and the pad stays where you put it. A funscript on the new scene waits
while Goon runs (Goon keeps priority); after End Goon a pattern that started
by itself on a scene without a funscript hands over to it as usual.
Goon mode needs the 1.47 backend or newer (Restart backend after updating;
Tidal's phrases need 1.49) and says so if it is older.

**Started by Lockdown.** Lockdown's *Toy in charge* starts Goon mode when you
press its Start the toy button (never by itself), with the style, level and
pace you chose there; the pad then says **Started by Lockdown**. Ending the
Lockdown run ends it: back to your pattern if Manual was already on, else a
Stop. End Goon, Stop and `0` work as always and end it too.

## Script playback

**Tune script** (the controls, with Script chosen) opens the settings with
**This script** unfolded; the settings then move to the side so you can scrub
the video while you tune. At the top, a strip shows how busy each part of the
scene is; click it to jump there.

**Collections.** With the Collections plugin, a collection can say which mode
its scripts start in (Cock Hero starts in Beat). That applies to scripts you
have not tuned; your own tuning wins.

**Settings are remembered per script.** The right timing and feel depend on
the file, so whatever you change while a script is loaded is kept for that
script and comes back next time. Scripts you have not tuned use your defaults.
The panel says which applies, with **Use defaults** to forget a script's tuning
and **Make these my defaults** to copy it.

**Mode** decides how a stroking script becomes vibration:

- **Auto**: picks for you (Beat for Cock Hero style scripts, Flow for the
  rest). Start here.
- **Flow**: made for vibrators. It reads the whole script when it loads and
  follows how busy the scene is, levelled to that script, so a slow script and
  a frantic one both use the full range. Three sliders:
  - **Smoothness**: left follows each stroke, right follows the scene and
    fades gently when the action stops.
  - **Rhythm**: how much each stroke pulses on top. 0 is a smooth buzz, all the
    way right is a burst per stroke.
  - **Sensitivity**: right makes quieter parts stronger, left calms it down.
- **Beat**: one burst per stroke turnaround. Suits Cock Hero scripts and, with
  peak picking, tracker-generated ones too. Auto also recognises "graded" beat
  scripts (Cock Hero Colors style), where the height of each stroke sets how
  strong the burst is.
- **Speed (classic)**: intensity follows stroke speed against a fixed scale.
- **Position**: intensity follows stroke position.

**Scripts are matched strictly.** A video only gets its own script: the same
name (spaces, brackets and case may differ), or a named version like
`Scene [FunGen].funscript`. Another video's script in the same folder is never
used, and there is nothing to pick from.

**Scenes without a script** play your manual pattern once you press play,
and stop when it pauses or ends. A manual session you started yourself is left
alone, and if you turn it off during a scene it stays off. Switch it off in
the settings if you prefer those scenes quiet.

**Vibrator tracks.** Some scripts come with a second file made for vibrators,
named like `Scene.vib.funscript` next to `Scene.funscript`. When one is there
the vibrator plays it as written, which is almost always better than anything
worked out from stroke motion; the status shows `· vibe track`. A stroker
still follows the main script. You can turn this off in the script's tuning.

**Timing** shifts the toy against the video; it says "120 ms earlier"
and so on. **Weakest / Strongest** set the range the script plays in
(Strongest is the Max on Strength in Script); manual mode has its own Power
limit.

**Live signal** is a switch in the header of the script's tuning. When on,
a wide scope at the bottom draws the script, the Flow plan and what the toy
actually gets, while you tune. It remembers the switch; the stream only runs
while the settings are showing.

## Other apps: Stashy and the bridge

The backend can also stand in for Intiface Central, so an app that plays
funscripts through Intiface plays them through this plugin instead, with no
Stash page open. Made for [Stashy](https://github.com/1letzgo/stashy), and it
works with any app that drives a stroker through Intiface.

1. Run **Start Backend** once (it starts with Stash's connection, which the
   bridge uses to find scenes).
2. In Stashy: **Settings › Intiface**, server address
   `ws://<the computer Stash runs on>:12346` (in Docker, publish port 12346).
   Leave Intiface Central where it is: the backend connects to it itself, at
   the plugin's Intiface server URL.
3. Play a scene with a funscript in Stashy and press its **Intiface** button.

The app sees one stroker called *IntifaceSync*. What reaches your toy:

- **At once: live.** The app's strokes, as they come, played as vibration
  (**Bridge live mode** in the plugin settings: speed, beat or position). A
  stroker gets the strokes as they are.
- **After a few seconds: the scene's whole script.** The backend asks Stash
  which interactive scenes were played recently and finds the app's strokes in
  one of their funscripts. From then on it plays that script exactly as the
  page would: Flow, Beat, the vibe track, and the tuning you gave the script
  on the page. The Stash log says *Stashy plays 'Scene' at 3:12*.
- **Pause, seek, another scene** follow by themselves: a pause stops the toy,
  a seek is found again in the script within about two seconds (silent
  meanwhile), another scene goes back to live until it is recognised.
- **Timing** runs on the backend's own clock from where the app was. Stashy
  counts its clock in display frames and falls behind the video when frames
  drop; the bridge does not follow that, only the app's jumps.

The app counts as a tab: it takes the toy when nothing else plays, a Stash
tab that presses play takes it back, and Stop, `0` and Muted in any tab stop
it. Its tab line says which scene it plays. The app closing, or its
connection dropping, stops the toy.

Limits: scenes are recognised only when Stash knows they were played (Stashy
reports it after the play-count time in its settings) and the funscript sits
next to the video. With a Stash login and no API key generated
(Settings › Security), recognition stops when the task's session expires; the
live playback goes on. Strength is the page's last Script strength.
**Turn off the bridge for other apps** in the plugin settings closes the
port.

## Keyboard shortcuts

| Key | |
|---|---|
| `0` | Stop: script, manual pattern and Goon mode |
| `E` | mute / unmute output |
| `\` | manual mode on/off |
| `[` `]`, or `-` `=` | strength down / up by 5% at the toy, the level in Goon (never switches the mode) |
| `Alt+1`..`Alt+4` | load preset card 1 to 4 (Manual, outside Goon mode) |
| `Alt+Shift+1`..`4` | move the active preset to that place |
| `Esc` | close the settings or Edit pattern |
| `Alt+W` `Alt+A` `Alt+Q`, `Alt+1`..`8`, `Alt` + wheel | Goon mode: Edge, Hold, Cool down, the pads, the level (only while it runs) |

The keys work by their place on the keyboard too, so on layouts where `\`,
`[` and `]` need AltGr (German, French, Nordic) the keys in those places work
without it, and `-` `=` are always there.

Turn them off for this browser in the settings, or for every browser in
**Settings > Plugins > IntifaceSync > Turn off keyboard shortcuts**, if they
clash with other plugins. Everything stays available under the player. While
IntifaceSync is off in this browser the keys do nothing at all.

## Multiple tabs

One tab drives the toy at a time, across every browser and device that has
Stash open.

- Pressing play in a tab makes it the one driving, and it loads that tab's
  script.
- A tab you switch to takes over by itself only when the one driving is not
  playing.
- Every other tab says *Another tab drives the toy* (hover for which scene)
  and offers **Take over**.
- **Muted**, **Stop** (`0`), Manual off and **Disconnect** work from any tab.
  `Alt+1`..`4` in a tab that is not driving say so instead of changing only
  that tab's controls.
- Closing the tab that is driving stops the toy.

## Safety

When the toy is stopped for safety (the tab that was driving it closed, or
went quiet for 15 seconds because the browser froze or the computer slept),
the other open tabs say so in a message at the bottom of the screen.


The toy stops when you close the browser, when the tab crashes, when the laptop
sleeps, when the connection drops, and when the backend shuts down. A watchdog
stops output if the page has not been heard from for 15 seconds, which covers
the cases where no close event ever arrives.

**None of that helps if the Python backend itself hangs.** Know where your
toy's power button is. Provided as-is, with no warranty.

## Troubleshooting

**Nothing happens.** Check Intiface Central is running with the toy connected,
then that the pill does not say Muted. Run Stop Backend then Start Backend. If the bar
is a small *Intiface · off* pill, click it: it is turned off in this browser.

**Backend changes did nothing.** Reloading plugins does not restart the Python
process. Run Stop Backend, then Start Backend.

**It buzzes constantly instead of following the script.** Set the mode to
Auto or Flow in the script's tuning (Tune script). With Flow, lower Sensitivity or raise
Smoothness; with Beat, check Fire on.

**Another tab has the toy.** The pill says so (hover it for which scene);
press **Take over**, or press play in this tab.

**Timing drifts.** Turn on Live signal in the script's tuning and watch
`drift`. It should hover near zero. If it climbs steadily, report it.

## Live signal

Switch on **Live signal** in the script's tuning (Tune script) for a scope of the last 8
seconds:

- **grey line** — the funscript itself, with a dashed playhead at the current
  position and faint verticals marking where beat mode will fire
- **dashed purple** — the Flow plan, including what is coming next
- **blue line** — the intensity the plugin wants
- **green fill** — the level actually sent to the toy
- **orange ticks** — each command over Bluetooth
- **dashed yellow** — your motor's floor

Use it to check a vibe mode is reading a script sensibly: the green fill should
follow the shape of the grey line in a way that makes sense for the mode. It
streams continuously, so it pauses whenever the script's tuning is folded or the settings are closed.

Debug logging: `localStorage.intifaceSyncDebug = "1"` in the browser console.
