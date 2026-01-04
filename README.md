# Elevator (Foundry VTT v13)

Enhances Regions with an elevator overlay and panel. Compatible with easy-regions (no modifications).

## Features
- Center overlay icon appears when tokens are inside an elevator Region.
- Click icon to open Elevator panel: Call Elevator or Select Level.
- Call enforces a configurable delay (or next round tick if any combatant), then enables selection.
- Select Level teleports all tokens in the Region to the chosen destination; owned tokens move immediately, non-owned require approval.
- Cross-scene destinations via Region UUIDs.
- Themes: Default (inherits Foundry light/dark), plus optional Sci-Fi / Horror / Rustic flavor.

## Approval flow (non-owned tokens)
- Owned tokens teleport immediately.
- For non-owned tokens, Elevator sends a whispered approval chat card:
   - Routed to online non-GM token owner(s) when possible.
   - If the owning user is offline, or if the only owner is a GM, the request is sent to the GM.
- Approve/Deny buttons are on the chat card.
- The card shows the destination label as "Scene ⇒ Region" so owners know where the token is going.

## Setup
1. Enable the module.
2. Open a Region’s config and enable "Elevator"; assign an `Elevator ID`, optionally set "Elevator Is Here" and an icon.
3. Configure `levels` with destination Region UUIDs and labels.
4. Adjust module settings under Game Settings → Module Settings:
   - Panel theme, arrival delay, combat delay policy, GM approval policy, SFX.

## Notes
- Destinations are Region UUIDs (cross-scene supported).
- If easy-regions is installed, existing teleport behaviors remain untouched.
- Approval requests are delivered via whispered chat cards (server-mediated), and do not rely on module socket delivery.
- Module sockets are still used for elevator state syncing (current level) so panels can update quickly.

## Troubleshooting
- If icon doesn’t appear, ensure the Region is enabled for elevator and has a teleport behavior.
- For combat delay, ensure a Combat is active; selection unlocks on the next round increment.
- If destination is invalid, verify the UUID and that the Region exists.
- If a non-owned token isn’t moving, check:
   - The token’s owner(s) are online (otherwise the request routes to the GM).
   - The approval card is visible in Chat (it is whispered).
