# Elevator (Foundry VTT v13)

Enhances Regions with an elevator overlay and panel. Compatible with easy-regions (no modifications).

## Features
- Center overlay icon appears when tokens are inside an elevator Region.
- Click icon to open Elevator panel: Call Elevator or Select Level.
- Call enforces 2s delay (or next round tick if any combatant), then enables selection.
- Select Level teleports all tokens in the Region to the chosen destination; owned tokens move immediately, non-owned require GM approval.
- Cross-scene destinations via Region UUIDs.
- Basic themes: light, dark, sci-fi, fantasy.

## Setup
1. Enable the module.
2. Open a Region’s config and enable "Elevator"; assign an `Elevator ID`, optionally set "Elevator Is Here" and an icon.
3. Configure `levels` with destination Region UUIDs and labels.
4. Adjust module settings under Game Settings → Module Settings:
   - Panel theme, arrival delay, combat delay policy, GM approval policy, SFX.

## Notes
- Destinations are Region UUIDs (cross-scene supported).
- If easy-regions is installed, existing teleport behaviors remain untouched.
- GM receives a prompt to approve moving non-owned tokens.

## Troubleshooting
- If icon doesn’t appear, ensure the Region is enabled for elevator and has a teleport behavior.
- For combat delay, ensure a Combat is active; selection unlocks on the next round increment.
- If destination is invalid, verify the UUID and that the Region exists.
