/**
 * Elevator Module for Foundry VTT v13
 * Non-invasive interop with easy-regions; enhances Regions with an elevator overlay and panel.
 */

const MOD_ID = "elevator";
const SOCKET_CHANNEL = `module.${MOD_ID}`;
const LEGACY_SOCKET = {
  setCurrentLevel: `${SOCKET_CHANNEL}.setCurrentLevel`,
  getCurrentLevel: `${SOCKET_CHANNEL}.getCurrentLevel`,
  currentLevelChanged: `${SOCKET_CHANNEL}.currentLevelChanged`,
};

function makeRequestId() {
  try {
    const id = foundry?.utils?.randomID?.();
    return id ? String(id) : String(Date.now());
  } catch (e) {
    return String(Date.now());
  }
}

const SETTINGS = {
  Theme: "theme",
  ArrivalDelayMs: "arrivalDelayMs",
  CombatDelayPolicy: "combatDelayPolicy", // next-round
  RequireGMForAll: "requireGMForAll", // if true, always require GM approval
  SfxEnabled: "sfxEnabled",
  Debug: "debug",
};

const DEFAULTS = {
  theme: "default",
  arrivalDelayMs: 2000,
  combatDelayPolicy: "next-round",
  requireGMForAll: false,
  sfxEnabled: true,
  debug: false,
};

function normalizeThemeValue(theme) {
  const t = String(theme ?? "").trim().toLowerCase();
  if (t === "default" || t === "scifi" || t === "horror" || t === "rustic") return t;
  // Backward compatibility with older versions.
  if (t === "light" || t === "dark") return "default";
  if (t === "fantasy") return "rustic";
  return "default";
}

function getSceneGridSizePx() {
  try {
    const size = Number(canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 0);
    return Number.isFinite(size) && size > 0 ? size : 100;
  } catch (e) {
    return 100;
  }
}

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

// World store for current elevator level per elevatorId
const WORLD_STATE = {
  CurrentLevelByElevatorId: "currentLevelByElevatorId",
  ElevatorLinksById: "elevatorLinksById"
};

const REGION_LABEL_SPACING = " \u21D2 "; // Rightwards Double Arrow

// Players cannot update world settings, and the replication of a world-setting change can lag a tick.
// Keep an optimistic client-side cache so the panel can update immediately.
const CLIENT_STATE = {
  currentLevelByElevatorId: {}
};

function getKnownCurrentLevelUuid(elevatorId) {
  const elevId = String(elevatorId ?? "").trim();
  if (!elevId) return "";
  // Prefer the optimistic cache: world-setting propagation can lag for players.
  const cached = String(CLIENT_STATE.currentLevelByElevatorId?.[elevId] || "").trim();
  if (cached) return cached;
  const currentById = game.settings.get(MOD_ID, WORLD_STATE.CurrentLevelByElevatorId) || {};
  return String(currentById?.[elevId] || "").trim();
}

function isDebugEnabled() {
  try { return !!game.settings.get(MOD_ID, SETTINGS.Debug); } catch (e) { return false; }
}

function dlog(...args) {
  if (!isDebugEnabled()) return;
  log("[debug]", ...args);
}

function requestSyncCurrentLevel(elevatorId) {
  const elevId = String(elevatorId ?? "").trim();
  if (!elevId) return;
  if (game.user?.isGM) return;
  const requestId = makeRequestId();
  game.socket.emit(SOCKET_CHANNEL, { type: "getCurrentLevel", requestId, elevatorId: elevId, requester: game.user?.id });
  // Backward compatibility for clients still listening on per-event channels.
  game.socket.emit(LEGACY_SOCKET.getCurrentLevel, { requestId, elevatorId: elevId, requester: game.user?.id });
}

async function requestSetCurrentLevel(elevatorId, regionUuid) {
  const elevId = String(elevatorId ?? "").trim();
  const uuid = String(regionUuid ?? "").trim();
  if (!elevId || !uuid) return;

  const requestId = makeRequestId();

  // Optimistically update local state so UIs can respond immediately.
  CLIENT_STATE.currentLevelByElevatorId[elevId] = uuid;
  dlog("requestSetCurrentLevel optimistic", { elevId, uuid, user: game.user?.name });
  try { queueRerenderOpenElevatorPanels(elevId); } catch (e) { /* ignore */ }

  if (game.user?.isGM) {
    const currentById = foundry.utils.duplicate(game.settings.get(MOD_ID, WORLD_STATE.CurrentLevelByElevatorId) || {});
    currentById[elevId] = uuid;
    await game.settings.set(MOD_ID, WORLD_STATE.CurrentLevelByElevatorId, currentById);

    // Also broadcast for immediate client updates.
    game.socket.emit(SOCKET_CHANNEL, { type: "currentLevelChanged", requestId, elevatorId: elevId, regionUuid: uuid });
    game.socket.emit(LEGACY_SOCKET.currentLevelChanged, { requestId, elevatorId: elevId, regionUuid: uuid });
    return;
  }

  // Players cannot update world settings; request the GM to do it.
  game.socket.emit(SOCKET_CHANNEL, { type: "setCurrentLevel", requestId, elevatorId: elevId, regionUuid: uuid, requester: game.user?.id });
  game.socket.emit(LEGACY_SOCKET.setCurrentLevel, { requestId, elevatorId: elevId, regionUuid: uuid, requester: game.user?.id });
}

// Simple logger
function log(...args) { console.log(`[${MOD_ID}]`, ...args); }
function warn(...args) { console.warn(`[${MOD_ID}]`, ...args); }

async function createGMApprovalChatCard(payload) {
  try {
    const gmIds = (game.users || []).filter(u => u?.isGM).map(u => u.id);
    if (!gmIds.length) return;

    const requesterName = game.users?.get?.(payload?.requester)?.name || "Player";
    const approveLabel = game.i18n.localize(`${MOD_ID}.gm.approvalTitle`) || "Approve Group Teleport";
    const prompt = game.i18n.localize(`${MOD_ID}.gm.approvalPrompt`) || "Approve teleporting tokens to the selected destination?";
    const destLabel = String(payload?.destLabel ?? "").trim();
    const destHeading = game.i18n.localize(`${MOD_ID}.gm.destinationLabel`) || "Destination";
    const destLine = destLabel ? `<p><strong>${destHeading}:</strong> ${destLabel}</p>` : "";

    const content = `
      <div class="elevator-approval-card" data-elevator-approval="1">
        <p><strong>${approveLabel}</strong></p>
        ${destLine}
        <p>${prompt}</p>
        <p><em>${requesterName}</em></p>
        <div class="elevator-approval-actions">
          <button type="button" data-action="elevator-approve">Approve</button>
          <button type="button" data-action="elevator-deny">Deny</button>
        </div>
      </div>
    `;

    await ChatMessage.create({
      content,
      whisper: gmIds,
      flags: { [MOD_ID]: { teleportRequest: payload } }
    });
  } catch (e) {
    warn("createGMApprovalChatCard error", e);
  }
}

async function createApprovalChatCard(payload, { whisperIds, tokenLabel } = {}) {
  try {
    const recipients = (Array.isArray(whisperIds) ? whisperIds : []).filter(Boolean);
    if (!recipients.length) return;

    const requesterName = game.users?.get?.(payload?.requester)?.name || "Player";
    const approveLabel = game.i18n.localize(`${MOD_ID}.gm.approvalTitle`) || "Approve Group Teleport";
    const prompt = game.i18n.localize(`${MOD_ID}.gm.approvalPrompt`) || "Approve teleporting tokens to the selected destination?";
    const tokenLine = tokenLabel ? `<p><strong>${tokenLabel}</strong></p>` : "";
    const destLabel = String(payload?.destLabel ?? "").trim();
    const destHeading = game.i18n.localize(`${MOD_ID}.gm.destinationLabel`) || "Destination";
    const destLine = destLabel ? `<p><strong>${destHeading}:</strong> ${destLabel}</p>` : "";

    const content = `
      <div class="elevator-approval-card" data-elevator-approval="1">
        <p><strong>${approveLabel}</strong></p>
        ${tokenLine}
        ${destLine}
        <p>${prompt}</p>
        <p><em>${requesterName}</em></p>
        <div class="elevator-approval-actions">
          <button type="button" data-action="elevator-approve">Approve</button>
          <button type="button" data-action="elevator-deny">Deny</button>
        </div>
      </div>
    `;

    await ChatMessage.create({
      content,
      whisper: recipients,
      flags: { [MOD_ID]: { teleportRequest: payload } }
    });
  } catch (e) {
    warn("createApprovalChatCard error", e);
  }
}

function getActorOwnerUserIds(actorDoc) {
  try {
    const actor = actorDoc;
    if (!actor) return [];
    const ownership = actor.ownership || {};
    const OWNER = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    return (game.users || [])
      .filter(u => {
        const lvl = Number(ownership?.[u.id] ?? ownership?.default ?? 0);
        return Number.isFinite(lvl) && lvl >= OWNER;
      })
      .map(u => u.id);
  } catch (e) {
    return [];
  }
}

function getGMUserIds({ onlineOnly = false } = {}) {
  return (game.users || [])
    .filter(u => u?.isGM && (!onlineOnly || u?.active))
    .map(u => u.id);
}

function computeApprovalRecipientsForToken(tokenDoc) {
  const ownerIds = getActorOwnerUserIds(tokenDoc?.actor);
  const onlineOwnerIds = ownerIds.filter(uid => !!game.users?.get?.(uid)?.active);
  const onlineNonGmOwners = onlineOwnerIds.filter(uid => !game.users?.get?.(uid)?.isGM);

  // Prefer online non-GM owners.
  if (onlineNonGmOwners.length) return { recipientIds: onlineNonGmOwners, routedTo: "owner" };

  // Otherwise route to an online GM.
  const onlineGms = getGMUserIds({ onlineOnly: true });
  if (onlineGms.length) return { recipientIds: onlineGms, routedTo: "gm" };

  // Fallback to any GM ids.
  const anyGms = getGMUserIds({ onlineOnly: false });
  return { recipientIds: anyGms, routedTo: "gm" };
}

async function playDoorSfxAndWait() {
  try {
    if (!game.settings.get(MOD_ID, SETTINGS.SfxEnabled)) return;

    // Use Foundry's built-in door sounds. Paths can vary slightly by version/system;
    // try a small set of common core asset paths.
    const candidates = [
      "sounds/doors/futuristic/close-fast.ogg",
      "sounds/doors/sliding/close.ogg"
    ];

    for (const src of candidates) {
      const ok = await playOneShotSfxAndWait(src, { volume: 0.8, fallbackMs: 750 });
      if (ok) return;
    }
  } catch (e) {
    // Never block teleportation due to SFX.
  }
}

function playOneShotSfxAndWait(src, { volume = 0.8, fallbackMs = 750 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok = true) => {
      if (done) return;
      done = true;
      resolve(ok);
    };

    try {
      const maybeSound = foundry.audio.AudioHelper.play({ src, volume, autoplay: true, loop: false }, true);
      Promise.resolve(maybeSound).then((soundObj) => {
        const howl = soundObj?.sound ?? soundObj;

        // Resolve when the sound ends, or if it fails to load/play.
        if (howl?.once) {
          howl.once("end", () => finish(true));
          howl.once("loaderror", () => finish(false));
          howl.once("playerror", () => finish(false));
        }

        // Fallback timeout (or use duration if available).
        let ms = fallbackMs;
        try {
          const dur = typeof howl?.duration === "function" ? howl.duration() : null;
          if (dur && Number.isFinite(dur) && dur > 0) ms = Math.ceil(dur * 1000) + 25;
        } catch (e) { /* ignore */ }
        setTimeout(() => finish(true), ms);
      }).catch(() => setTimeout(() => finish(false), fallbackMs));
    } catch (e) {
      setTimeout(() => finish(false), fallbackMs);
    }
  });
}

// Utility: safely get our namespace flags on a RegionDocument
function getElevatorFlags(doc) {
  return doc?.flags?.[MOD_ID] || {};
}

function isElevatorEnabled(doc) {
  const f = getElevatorFlags(doc);
  return !!f.enabled;
}

// Utility: detect teleportToken behavior presence on a Region
function hasTeleportBehavior(regionDoc) {
  try {
    return !!regionDoc?.behaviors?.find?.(b => b?.type === "teleportToken");
  } catch (e) {
    return false;
  }
}

function getElevatorLinksById() {
  try {
    return game.settings.get(MOD_ID, WORLD_STATE.ElevatorLinksById) || {};
  } catch (e) {
    return {};
  }
}

async function setElevatorLinksById(next) {
  try {
    await game.settings.set(MOD_ID, WORLD_STATE.ElevatorLinksById, next || {});
  } catch (e) {
    warn("Failed to persist elevator links", e);
  }
}

function normalizeStops(stops) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(stops) ? stops : []) {
    const uuid = String(s?.uuid ?? "").trim();
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    out.push({ uuid, label: stripElevatorNamePrefix(String(s?.label ?? "").trim()) });
  }
  return out;
}

function stripElevatorNamePrefix(name) {
  const s = String(name ?? "").trim();
  // Only strip when it matches our own naming scheme: "ELV <id> <NN> <Label>".
  // This prevents re-adding the same Region from accumulating nested prefixes.
  if (!s.startsWith("ELV ")) return s;
  // Non-greedy match for the elevatorId segment (which may contain spaces), then a 2-digit floor.
  const stripped = s.replace(/^ELV\s+.+?\s+\d{2}\s+/, "").trim();
  return stripped || s;
}

function formatElevatorRegionName(elevatorId, floorNumber, label) {
  const id = String(elevatorId ?? "").trim();
  const num = String(Math.max(1, Number(floorNumber) || 1)).padStart(2, "0");
  const lbl = stripElevatorNamePrefix(String(label ?? "").trim());
  return `ELV ${id} ${num} ${lbl}`.trim();
}

async function restrictTeleportBehaviorsToNetwork(regionDoc, allowedUUIDs, fallbackUUID) {
  try {
    const allowed = allowedUUIDs instanceof Set ? allowedUUIDs : new Set(Array.isArray(allowedUUIDs) ? allowedUUIDs : []);
    const fallback = fallbackUUID && allowed.has(fallbackUUID) ? fallbackUUID : null;
    const behaviors = regionDoc?.behaviors;
    if (!behaviors?.size) return;

    for (const behavior of behaviors) {
      if (behavior?.type !== "teleportToken") continue;
      const dest = behavior?.system?.destination;
      if (!dest) continue;
      if (allowed.has(dest)) continue;
      if (!fallback) continue;
      await behavior.update({ "system.destination": fallback });
    }
  } catch (e) {
    // Best-effort only; don't block sync.
    warn("restrictTeleportBehaviorsToNetwork error", e);
  }
}

async function syncElevatorNetwork(elevatorId, { homeUuid } = {}) {
  if (!game.user?.isGM) return;
  if (!elevatorId) return;

  const linksById = getElevatorLinksById();
  const master = linksById[elevatorId];
  if (!master) return;

  const stops = normalizeStops(master.stops);
  if (!stops.length) return;

  // Filter missing Regions; keep setting clean.
  const resolved = [];
  for (const s of stops) {
    const doc = await fromUuid(s.uuid).catch(() => null);
    if (doc instanceof RegionDocument) {
      resolved.push({ doc, uuid: s.uuid, label: s.label || doc.name });
    }
  }

  if (!resolved.length) return;

  // Update the stored stops list to only include existing docs (keeps labels).
  const cleanedStops = resolved.map(r => ({ uuid: r.uuid, label: r.label }));
  if (cleanedStops.length !== stops.length) {
    linksById[elevatorId] = foundry.utils.mergeObject(master, { stops: cleanedStops }, { inplace: false });
    await setElevatorLinksById(linksById);
  }

  const home = homeUuid || master.homeUuid || cleanedStops[0]?.uuid;
  const homeLabel = cleanedStops.find(s => s.uuid === home)?.label || "Return";

  const allowedSet = new Set(cleanedStops.map(s => s.uuid));

  for (const stop of resolved) {
    const floorIndex = cleanedStops.findIndex(s => s.uuid === stop.uuid);
    // UI requirement: list is ordered from Level <max> at the top to Level 1 at the bottom.
    // So floor numbers are assigned in reverse order of the stored stops list.
    const floorNumber = cleanedStops.length - (floorIndex >= 0 ? floorIndex : 0);
    const stopLabel = cleanedStops[floorIndex]?.label || stop.label || stop.doc.name;
    const desiredName = formatElevatorRegionName(elevatorId, floorNumber, stopLabel);

    const otherStops = cleanedStops.filter(s => s.uuid !== stop.uuid);
    const current = getElevatorFlags(stop.doc);
    const nextFlags = foundry.utils.mergeObject(current, {
      enabled: true,
      elevatorId,
      // Ensure only one stop advertises "Elevator Is Here" (used only as an initial fallback).
      // The authoritative location is WORLD_STATE.CurrentLevelByElevatorId.
      isElevatorHere: stop.uuid === home,
      theme: master.theme,
      iconSrc: master.iconSrc,
      iconSize: master.iconSize,
      iconAlwaysOn: !!master.iconAlwaysOn,
      levels: otherStops,
      returnTo: home && home !== stop.uuid ? { uuid: home, label: homeLabel } : null
    }, { inplace: false });

    const updateData = { [`flags.${MOD_ID}`]: nextFlags };
    if (stop.doc.name !== desiredName) updateData.name = desiredName;
    await stop.doc.update(updateData);

    // If teleportToken behaviors exist, force their destinations to remain within the elevator network.
    // (Single-destination behavior in v13/easy-regions.)
    await restrictTeleportBehaviorsToNetwork(stop.doc, allowedSet, home);
  }
}

// Get tokens inside region (best-effort fallback if API differs)
function tokensInsideRegion(region) {
  const tokens = canvas.tokens?.placeables || [];
  const inside = [];
  for (const tok of tokens) {
    const pt = tok.center || { x: tok.x + tok.width/2, y: tok.y + tok.height/2 };
    if (isPointInRegion(pt, region)) inside.push(tok.document);
  }

  try {
    /*
    dlog("tokensInsideRegion", {
      regionUuid: region?.document?.uuid,
      regionName: region?.document?.name,
      count: inside.length,
      tokens: inside.map(td => ({
        uuid: td?.uuid,
        name: td?.name,
        actor: td?.actor?.name,
        hidden: !!td?.hidden,
        disposition: td?.disposition,
        isOwner: !!td?.isOwner
      }))
    });
    */
  } catch (e) { /* ignore */ }

  return inside;
}

// Point-in-region using polygonTree bounds centers (approximate)
function isPointInRegion(pt, region) {
  try {
    const doc = region?.document ?? region;
    const tree = doc?.polygonTree;
    if (!tree) return false;
    for (const node of tree) {
      const b = node?.bounds;
      if (!b) continue;
      // PIXI Rectangle-like bounds with contains(x,y)
      if (typeof b.contains === "function" && b.contains(pt.x, pt.y)) return true;
      // Fallback to range check
      if (b.x !== undefined) {
        const within = pt.x >= b.x && pt.y >= b.y && pt.x <= (b.x + b.width) && pt.y <= (b.y + b.height);
        if (within) return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

function getGridSizePxForScene(scene) {
  try {
    const size = Number(scene?.grid?.size ?? canvas?.grid?.size ?? 0);
    return Number.isFinite(size) && size > 0 ? size : 100;
  } catch (e) {
    return 100;
  }
}

function tokenCenterPointPx(tokenDoc, gridSizePx) {
  const x = Number(tokenDoc?.x ?? 0);
  const y = Number(tokenDoc?.y ?? 0);
  const w = Number(tokenDoc?.width ?? 1);
  const h = Number(tokenDoc?.height ?? 1);
  return {
    x: x + (w * gridSizePx) / 2,
    y: y + (h * gridSizePx) / 2
  };
}

function isTokenOwnedByUser(tokenDoc, userId) {
  const uid = String(userId ?? "").trim();
  const user = uid ? game.users?.get?.(uid) : null;
  if (!user) return false;
  try {
    const actor = tokenDoc?.actor;
    const OWNER = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (actor?.testUserPermission) return !!actor.testUserPermission(user, OWNER);
    const ownership = actor?.ownership || {};
    const lvl = Number(ownership?.[uid] ?? ownership?.default ?? 0);
    return lvl >= OWNER;
  } catch (e) {
    return false;
  }
}

function getElevatorOverlayRoot() {
  const controls = canvas.controls;
  if (!controls) return null;
  if (controls.elevatorOverlayRoot) return controls.elevatorOverlayRoot;
  // Ensure zIndex sorting is honored
  controls.sortableChildren = true;
  const root = new PIXI.Container();
  root.sortableChildren = true;
  root.zIndex = 10000;
  root.eventMode = "passive";
  root.name = `${MOD_ID}.overlayRoot`;
  controls.addChild(root);
  controls.elevatorOverlayRoot = root;
  return root;
}

function isPointVisibleToUser(pt) {
  try {
    if (game.user?.isGM) return true;
    // Prefer the engine's visibility test when available.
    const test1 = canvas.visibility?.testVisibility;
    if (typeof test1 === "function") return !!test1(pt, { tolerance: 0 });
    const test2 = canvas.effects?.visibility?.testVisibility;
    if (typeof test2 === "function") return !!test2(pt, { tolerance: 0 });
  } catch (e) { /* ignore */ }
  // If visibility APIs are unavailable, do not hide the icon.
  return true;
}

function buildRegionUuidIndex() {
  const options = [];
  const uuidToLabel = new Map();

  try {
    const scenes = [...(game.scenes?.contents || game.scenes || [])].sort((a, b) => {
      const an = a?.name ?? "";
      const bn = b?.name ?? "";
      return an.localeCompare(bn);
    });

    for (const scene of scenes) {
      const regions = [...(scene?.regions?.contents || scene?.regions || [])].sort((a, b) => {
        const an = a?.name ?? "";
        const bn = b?.name ?? "";
        return an.localeCompare(bn);
      });

      for (const region of regions) {
        const uuid = region?.uuid;
        if (!uuid) continue;
        const label = `${scene.name}${REGION_LABEL_SPACING}${region.name}`;
        uuidToLabel.set(uuid, label);
        options.push({ uuid, label, regionName: region.name });
      }
    }
  } catch (e) {
    warn("buildRegionUuidIndex error", e);
  }

  return { options, uuidToLabel };
}

function buildSceneRegionIndex() {
  const scenesOut = [];
  try {
    const scenes = [...(game.scenes?.contents || game.scenes || [])].sort((a, b) => {
      const an = a?.name ?? "";
      const bn = b?.name ?? "";
      return an.localeCompare(bn);
    });

    for (const scene of scenes) {
      const regions = [...(scene?.regions?.contents || scene?.regions || [])].sort((a, b) => {
        const an = a?.name ?? "";
        const bn = b?.name ?? "";
        return an.localeCompare(bn);
      }).map(r => ({
        uuid: r.uuid,
        name: r.name,
        label: `${scene.name}${REGION_LABEL_SPACING}${r.name}`
      }));

      scenesOut.push({
        id: scene.id,
        name: scene.name,
        regions
      });
    }
  } catch (e) {
    warn("buildSceneRegionIndex error", e);
  }

  return scenesOut;
}

function ensureElevatorRegionConfigTab(rootEl) {
  const root = rootEl?.tagName === "FORM" ? rootEl : (rootEl?.querySelector?.("form") ?? rootEl);
  if (!root?.querySelector) return null;

  const tabsNav = root.querySelector("nav.sheet-tabs")
    || root.querySelector("nav.sheet-tabs.tabs")
    || root.querySelector("nav.tabs");
  if (!tabsNav) return null;

  const firstTab = tabsNav.querySelector('a[data-action="tab"]');
  const group = firstTab?.dataset?.group || "main";

  // Create tab button if missing
  let tabButton = tabsNav.querySelector(`a[data-action="tab"][data-group="${group}"][data-tab="elevator"]`);
  if (!tabButton) {
    tabButton = document.createElement("a");
    tabButton.dataset.action = "tab";
    tabButton.dataset.group = group;
    tabButton.dataset.tab = "elevator";
    const label = game.i18n?.localize?.(`${MOD_ID}.regionConfig.tab.label`) ?? "Elevator";
    tabButton.innerHTML = `<span>${foundry.utils.escapeHTML(label)}</span>`;
    tabsNav.append(tabButton);
  }

  // Find existing tab sections and attach our new tab section alongside them.
  let tabSection = root.querySelector(`section.tab[data-group="${group}"][data-tab="elevator"]`)
    || root.querySelector(`div.tab[data-group="${group}"][data-tab="elevator"]`);

  if (!tabSection) {
    const existingSection = root.querySelector(`section.tab[data-group="${group}"]`)
      || root.querySelector(`div.tab[data-group="${group}"]`)
      || root.querySelector("section.tab")
      || root.querySelector("div.tab");

    const parent = existingSection?.parentElement || root;
    tabSection = document.createElement(existingSection?.tagName?.toLowerCase?.() || "section");
    tabSection.classList.add("tab");
    tabSection.dataset.group = group;
    tabSection.dataset.tab = "elevator";
    parent.append(tabSection);
  }

  return { tabSection, group };
}

// Overlay icon management
async function ensureElevatorOverlay(region) {
  const flags = getElevatorFlags(region.document);
  if (!isElevatorEnabled(region.document)) return;
  // Do not require teleport behavior: users may delete behaviors; elevator UI should still show.

  if (region?.elevatorOverlay) return; // already created

  const overlayRoot = getElevatorOverlayRoot();
  if (!overlayRoot) return;

  const iconSrc = flags.iconSrc || "modules/elevator/images/interface.webp";
  const texture = await foundry.canvas.loadTexture(iconSrc).catch(() => null);
  if (!texture) return warn("Failed to load elevator icon", iconSrc);

  // IMPORTANT: attach to controls layer so pointer events work reliably.
  const container = overlayRoot.addChild(new PIXI.Container());
  container.eventMode = "static";
  container.cursor = "pointer";
  // Ensure the container can receive pointer hits even if the region itself handles events.
  container.interactiveChildren = true;
  container.visible = false; // only visible when tokens present
  container.zIndex = 1000;
  container.name = `${MOD_ID}.regionOverlay.${region.document.id}`;

  container.on("pointerdown", () => {
    openElevatorPanel(region);
  });

  // Draw one icon per polygon node, centered
  const iconSize = flags.iconSize || 48;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of region.document.polygonTree) {
    const sprite = new PIXI.Sprite(texture);
    sprite.width = sprite.height = iconSize;
    sprite.x = node.bounds.center.x - (iconSize / 2);
    sprite.y = node.bounds.center.y - (iconSize / 2);
    // Make the sprite itself clickable.
    sprite.eventMode = "static";
    sprite.cursor = "pointer";
    sprite.on("pointerdown", (ev) => {
      ev?.stopPropagation?.();
      openElevatorPanel(region);
    });
    container.addChild(sprite);
    minX = Math.min(minX, sprite.x);
    minY = Math.min(minY, sprite.y);
    maxX = Math.max(maxX, sprite.x + iconSize);
    maxY = Math.max(maxY, sprite.y + iconSize);
  }

  // Give the container a broad hitArea covering all icons.
  if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
    container.hitArea = new PIXI.Rectangle(minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY));
  }

  region.elevatorOverlay = container;
  updateOverlayVisibility(region);
}

function updateOverlayVisibility(region) {
  try {
    const flags = getElevatorFlags(region.document);
    const alwaysOn = !!flags.iconAlwaysOn;

    // Only show/interact in Token controls mode. In Region controls/edit mode,
    // clicks are intended for region selection/editing.
    const tokensLayerActive = !!canvas.tokens?.active;
    if (!tokensLayerActive) {
      if (region.elevatorOverlay) {
        region.elevatorOverlay.visible = false;
        region.elevatorOverlay.eventMode = "none";
      }
      return;
    }

    if (region.elevatorOverlay) {
      region.elevatorOverlay.eventMode = "static";
      region.elevatorOverlay.cursor = "pointer";
    }

    if (alwaysOn) {
      if (region.elevatorOverlay) region.elevatorOverlay.visible = true;
      // Even if always-on, still respect walls/fog for non-GM.
      if (region.elevatorOverlay?.visible) {
        for (const child of region.elevatorOverlay.children || []) {
          if (!(child instanceof PIXI.Sprite)) continue;
          const cx = child.x + (child.width / 2);
          const cy = child.y + (child.height / 2);
          child.visible = isPointVisibleToUser({ x: cx, y: cy });
        }
      }
      return;
    }
    const occupied = tokensInsideRegion(region).length > 0;
    if (region.elevatorOverlay) region.elevatorOverlay.visible = occupied;
    // When visible, also respect vision/walls/fog-of-war like other placeables.
    if (region.elevatorOverlay?.visible) {
      for (const child of region.elevatorOverlay.children || []) {
        if (!(child instanceof PIXI.Sprite)) continue;
        const cx = child.x + (child.width / 2);
        const cy = child.y + (child.height / 2);
        child.visible = isPointVisibleToUser({ x: cx, y: cy });
      }
    }
  } catch (e) { /* ignore */ }
}

function refreshAllElevatorOverlays() {
  try {
    const regions = canvas.scene?.regions || [];
    for (const regionDoc of regions) {
      if (!isElevatorEnabled(regionDoc)) continue;
      const regionObj = regionDoc.object;
      if (!regionObj?.elevatorOverlay) continue;
      updateOverlayVisibility(regionObj);
    }
  } catch (e) {
    /* ignore */
  }
}

// Token updates can arrive before Token placeables have updated positions.
// Queue a short, coalesced refresh so overlay visibility uses the latest centers.
let _overlayRefreshQueued = false;
function queueOverlayRefresh() {
  if (_overlayRefreshQueued) return;
  _overlayRefreshQueued = true;
  setTimeout(() => {
    _overlayRefreshQueued = false;
    refreshAllElevatorOverlays();
  }, 50);
}

// Panel Implementation (legacy Application; reliable rendering in v13)
class ElevatorPanel extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "elevator-panel",
      template: "modules/elevator/templates/elevator-panel.hbs",
      title: "Elevator",
      width: 360,
      height: "auto",
      resizable: false,
    });
  }

  constructor(region, options = {}) {
    super(options);
    this.region = region;
    this.flags = getElevatorFlags(region.document);
    this._elevatorState = this._deriveState();
    this._editMode = false;
    this._configTab = "settings";

    // Localize title now that `game` should exist.
    try {
      this.options.title = game.i18n.localize(`${MOD_ID}.panel.title`);
    } catch (e) { /* ignore */ }

    // Players may have stale world-setting state; ask the GM for the current elevator location.
    try { requestSyncCurrentLevel(this.flags.elevatorId); } catch (e) { /* ignore */ }
  }

  _deriveState() {
    const elevId = this.flags.elevatorId;
    const currentUUID = getKnownCurrentLevelUuid(elevId);
    const hereUUID = this.region.document.uuid;
    const isHere = currentUUID
      ? (currentUUID === hereUUID)
      : !!this.flags.isElevatorHere;
    dlog("deriveState", { elevId, hereUUID, currentUUID, isHere, user: game.user?.name });
    return {
      isHere,
    };
  }

  getData(_options = {}) {
    const delayMs = game.settings.get(MOD_ID, SETTINGS.ArrivalDelayMs) || DEFAULTS.arrivalDelayMs;
    const gridSizePx = getSceneGridSizePx();

    const { options: regionUuidOptions, uuidToLabel } = (game.user?.isGM && this._editMode)
      ? buildRegionUuidIndex()
      : { options: [], uuidToLabel: new Map() };

    // Prefer master elevator links (world setting) when available so deleted flags/behaviors
    // don't break the panel.
    const masterLinks = getElevatorLinksById();
    const elevIdForLinks = this.flags.elevatorId;
    const master = elevIdForLinks ? masterLinks[elevIdForLinks] : null;

    const elevId = this.flags.elevatorId;
    const hereUUID = this.region.document.uuid;
    const currentCabUUID = getKnownCurrentLevelUuid(elevId) || (this.flags.isElevatorHere ? hereUUID : "");

    // The Select Level list should show all levels (including current), and highlight the current.
    const rawStops = Array.isArray(master?.stops)
      ? normalizeStops(master.stops)
      : normalizeStops([{ uuid: hereUUID, label: this.region.document.name }, ...(Array.isArray(this.flags.levels) ? this.flags.levels : [])]);

    // Ensure the current region is always present as a stop.
    if (!rawStops.some(s => s.uuid === hereUUID)) rawStops.push({ uuid: hereUUID, label: this.region.document.name });

    const baseLevels = rawStops.map((lvl, i) => ({
      uuid: lvl.uuid,
      uuidLabel: uuidToLabel.get(lvl.uuid) || lvl.uuid,
      label: lvl.label || `Level ${i + 1}`,
      isCurrent: (!!currentCabUUID && lvl.uuid === currentCabUUID) || (!currentCabUUID && lvl.uuid === hereUUID)
    }));

    // If this Region has a return destination (propagated from another elevator stop),
    // expose it as an additional selectable level.
    const returnTo = this.flags.returnTo && typeof this.flags.returnTo === "object" ? this.flags.returnTo : null;
    const levels = [...baseLevels];
    if (returnTo?.uuid && !levels.some(l => l.uuid === returnTo.uuid)) {
      levels.unshift({
        uuid: returnTo.uuid,
        uuidLabel: uuidToLabel.get(returnTo.uuid) || returnTo.uuid,
        label: returnTo.label || returnTo.name || "Return",
        isCurrent: !!currentCabUUID && returnTo.uuid === currentCabUUID
      });
    }

    // Editable list includes the current Region as a stop so floor numbering can be set by ordering.
    const currentUuid = this.region.document.uuid;
    const currentStop = { uuid: currentUuid, label: this.region.document.name };
    const stopsForEdit = (game.user?.isGM && this._editMode)
      ? (() => {
          const stops = Array.isArray(master?.stops)
            ? normalizeStops(master.stops)
            : normalizeStops([currentStop, ...(Array.isArray(this.flags.levels) ? this.flags.levels : [])]);
          if (!stops.some(s => s.uuid === currentUuid)) stops.push(currentStop);
          return stops.map((s) => ({
            uuid: s.uuid,
            uuidLabel: uuidToLabel.get(s.uuid) || s.uuid,
            label: s.label || (s.uuid === currentUuid ? this.region.document.name : ""),
            isCurrent: s.uuid === currentUuid
          }));
        })()
      : baseLevels;

    const iconSizePx = Number.isFinite(this.flags.iconSize) ? this.flags.iconSize : gridSizePx;
    const iconScalePct = clampNumber(Math.round((iconSizePx / gridSizePx) * 100), 20, 200);

    const cfg = {
      enabled: !!this.flags.enabled,
      elevatorId: this.flags.elevatorId || "",
      isElevatorHere: !!this.flags.isElevatorHere,
      theme: normalizeThemeValue(this.flags.theme || (game.settings.get(MOD_ID, SETTINGS.Theme) || DEFAULTS.theme)),
      iconSrc: this.flags.iconSrc || "modules/elevator/images/interface.webp",
      iconSize: iconSizePx,
      iconScalePct,
      iconAlwaysOn: !!this.flags.iconAlwaysOn,
      // IMPORTANT: config editor should not include synthesized return entries.
      levels: stopsForEdit
    };

    // Player-flavor themes are only applied to the action button/call layouts.
    // The window surfaces, settings, and GM edit UI should remain Foundry-default.
    const flavorTheme = (cfg.theme === "scifi" || cfg.theme === "rustic") ? cfg.theme : "";

    return {
      isHere: !!this._elevatorState?.isHere,
      arrivalSeconds: Math.floor(delayMs / 1000),
      // Keep the overall panel surfaces in Foundry-default styling.
      themeClass: "default",
      // Apply optional player-flavor styling only to the action layout.
      flavorClass: flavorTheme,
      levels,
      isGM: !!game.user?.isGM,
      editMode: !!this._editMode,
      config: cfg,
      regionUuidOptions,
      configTab: this._configTab,
      gridSizePx
    };
  }

  _syncWindowThemeClass(html) {
    const el = this.element?.[0] ?? html?.[0] ?? null;
    if (!el?.classList) return;

    const bodyClasses = document.body?.classList;
    const wantsDark = !!bodyClasses?.contains?.("theme-dark");
    if (wantsDark) {
      el.classList.add("theme-dark");
      el.classList.remove("theme-light");
    } else {
      el.classList.add("theme-light");
      el.classList.remove("theme-dark");
    }
  }

  async _propagateToDestinationRegions({ elevatorId, theme, iconSrc, iconSize, iconAlwaysOn, levels }) {
    try {
      if (!game.user?.isGM) return;
      const sourceUUID = this.region?.document?.uuid;
      if (!sourceUUID) return;

      const sourceName = this.region?.document?.name || "Return";

      // Persist a master list of stops for this elevatorId.
      if (!elevatorId) return;
      const linksById = foundry.utils.duplicate(getElevatorLinksById());

      const stops = normalizeStops([
        { uuid: sourceUUID, label: sourceName },
        ...(levels || [])
      ]);

      linksById[elevatorId] = {
        elevatorId,
        homeUuid: sourceUUID,
        iconSrc,
        iconSize,
        iconAlwaysOn: !!iconAlwaysOn,
        theme,
        stops
      };

      await setElevatorLinksById(linksById);

      // Sync every stop so each has all other levels + a return destination.
      await syncElevatorNetwork(elevatorId, { homeUuid: sourceUUID });
    } catch (e) {
      warn("propagateToDestinationRegions error", e);
    }
  }

  activateListeners(html) {
    super.activateListeners(html);

    try { this._syncWindowThemeClass(html); } catch (e) { /* ignore */ }

    // Sync icon scale percent inputs (number <-> range) and keep hidden px field in sync.
    try {
      const form = html.find('form.elevator-config-form');
      if (form?.length) {
        const pctNumber = form.find('input[name="iconScalePct"]');
        const pctRange = form.find('input[name="iconScalePctRange"]');
        const pxHidden = form.find('input[name="iconSize"]');

        const sync = (value) => {
          const v = clampNumber(value, 20, 200);
          pctNumber.val(String(v));
          pctRange.val(String(v));
          const px = Math.max(24, Math.round((getSceneGridSizePx() * v) / 100));
          pxHidden.val(String(px));
        };

        pctNumber.on('input change', (ev) => sync(ev.currentTarget?.value));
        pctRange.on('input change', (ev) => sync(ev.currentTarget?.value));
      }
    } catch (e) { /* ignore */ }

    const activateDragReorder = () => {
      if (!game.user?.isGM || !this._editMode) return;
      const container = html[0]?.querySelector?.('.levels-rows');
      if (!container) return;

      container.addEventListener('dragstart', (ev) => {
        // Drag reorder is initiated via the drag handle.
        const handle = ev.target?.closest?.('.drag-handle');
        if (!handle) return;
        const row = handle.closest?.('.level-row');
        if (!row) return;
        row.classList.add('dragging');
        try {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', '');
        } catch (e) { /* ignore */ }
      });

      container.addEventListener('dragend', (ev) => {
        const row = ev.target?.closest?.('.drag-handle')?.closest?.('.level-row') || ev.target?.closest?.('.level-row');
        row?.classList?.remove?.('dragging');
      });

      const getDragAfterElement = (containerEl, y) => {
        const candidates = [...containerEl.querySelectorAll('.level-row:not(.dragging)')];
        let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
        for (const child of candidates) {
          const box = child.getBoundingClientRect();
          const offset = y - box.top - box.height / 2;
          if (offset < 0 && offset > closest.offset) {
            closest = { offset, element: child };
          }
        }
        return closest.element;
      };

      container.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        const dragging = container.querySelector('.level-row.dragging');
        if (!dragging) return;
        const afterElement = getDragAfterElement(container, ev.clientY);
        if (afterElement == null) container.appendChild(dragging);
        else container.insertBefore(dragging, afterElement);
      });
    };

    const wireUuidRow = ($row) => {
      const $uuidLabel = $row.find('input[name="levelUuidLabel"]');
      const $uuidHidden = $row.find('input[name="levelUuid"]');
      const $label = $row.find('input[name="levelLabel"]');
      if (!$uuidLabel.length || !$uuidHidden.length) return;

      const datalist = html[0]?.querySelector?.('#elevator-region-uuids');

      $uuidLabel.off(`input.${MOD_ID}`).on(`input.${MOD_ID}`, () => {
        const value = String($uuidLabel.val() ?? "");
        let resolved = value;

        if (datalist?.options?.length) {
          for (const opt of datalist.options) {
            if (opt.value === value) {
              resolved = opt.dataset.value || value;
              if ($label.length && !String($label.val() ?? "").trim()) {
                const rn = opt.dataset.region || "";
                if (rn) $label.val(rn);
              }
              break;
            }
          }
        }

        $uuidHidden.val(resolved);
      });
    };

    const appendStopRow = ({ uuid, uuidLabel, label }) => {
      const rows = html.find('.levels-rows');
      const existing = new Set(rows.find('input[name="levelUuid"]').toArray().map(el => String(el.value ?? "").trim()).filter(Boolean));
      const u = String(uuid ?? "").trim();
      if (!u || existing.has(u)) return;
      const row = $(
        `<div class="level-row">
          <span class="drag-handle" draggable="true" title="Drag to reorder">⋮⋮</span>
          <input type="hidden" name="levelUuid" value="${foundry.utils.escapeHTML(u)}">
          <input type="text" name="levelUuidLabel" value="${foundry.utils.escapeHTML(String(uuidLabel ?? u))}" placeholder="Scene ⇒ Region" list="elevator-region-uuids">
          <input type="text" name="levelLabel" value="${foundry.utils.escapeHTML(String(label ?? ""))}" placeholder="Label">
          <button type="button" class="icon-btn level-remove" data-action="remove-level" title="${game.i18n.localize("elevator.panel.remove")}"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>`
      );
      rows.append(row);
      wireUuidRow(row);
      row.find('button[data-action="remove-level"]').on('click', ev => {
        ev.preventDefault();
        $(ev.currentTarget).closest('.level-row').remove();
      });
    };

    const appendBlankRow = () => {
      const rows = html.find('.levels-rows');
      const row = $(
        `<div class="level-row">
          <span class="drag-handle" draggable="true" title="Drag to reorder">⋮⋮</span>
          <input type="hidden" name="levelUuid" value="">
          <input type="text" name="levelUuidLabel" value="" placeholder="Scene ⇒ Region" list="elevator-region-uuids">
          <input type="text" name="levelLabel" value="" placeholder="Label">
          <button type="button" class="icon-btn level-remove" data-action="remove-level" title="${game.i18n.localize("elevator.panel.remove")}"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>`
      );
      rows.append(row);
      wireUuidRow(row);
      row.find('button[data-action="remove-level"]').on('click', ev => {
        ev.preventDefault();
        $(ev.currentTarget).closest('.level-row').remove();
      });
      return row;
    };

    const extractRegionUuidFromDrop = (ev) => {
      const dt = ev?.dataTransfer;
      if (!dt?.getData) return "";

      const tryUuidFromObject = (obj) => {
        if (!obj || typeof obj !== "object") return "";
        const uuid = String(obj.uuid ?? obj.documentUuid ?? "").trim();
        if (uuid) return uuid;

        // Common Foundry drag payloads include identifiers instead of a UUID.
        const type = String(obj.type ?? obj.documentName ?? obj.documentType ?? "");
        const sceneId = String(obj.sceneId ?? obj.parentId ?? "").trim();
        const id = String(obj.id ?? obj.documentId ?? "").trim();
        if ((type === "Region" || type === "RegionDocument") && sceneId && id) {
          return `Scene.${sceneId}.Region.${id}`;
        }
        return "";
      };

      const tryParseJson = (raw) => {
        const s = String(raw ?? "").trim();
        if (!s) return null;
        if (!(s.startsWith("{") || s.startsWith("["))) return null;
        try { return JSON.parse(s); } catch (e) { return null; }
      };

      const tryUuidFromString = (raw) => {
        const s = String(raw ?? "").trim();
        if (!s) return "";
        // Direct UUID
        if (s.startsWith("Scene.") && s.includes(".Region.")) return s;
        // Embedded UUID
        const m = s.match(/Scene\.[A-Za-z0-9]{16}\.Region\.[A-Za-z0-9]{16}/);
        if (m?.[0]) return m[0];
        return "";
      };

      // 1) Best-effort: Foundry helper for editor-style drag payloads.
      try {
        const TE = foundry?.applications?.ux?.TextEditor;
        const getDragEventData = TE?.implementation?.getDragEventData || TE?.getDragEventData || globalThis?.TextEditor?.getDragEventData;
        const data = typeof getDragEventData === "function" ? getDragEventData(ev) : null;
        const uuid = tryUuidFromObject(data);
        if (uuid) return uuid;
      } catch (e) { /* ignore */ }

      // 2) Handle payloads from other parts of the UI (e.g., Region Legend).
      for (const type of ["text/plain", "application/json", "text"]) {
        let raw = "";
        try { raw = dt.getData(type); } catch (e) { raw = ""; }
        if (!raw) continue;

        const uuidFromString = tryUuidFromString(raw);
        if (uuidFromString) return uuidFromString;

        const parsed = tryParseJson(raw);
        if (parsed) {
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const uuid = tryUuidFromObject(item);
              if (uuid) return uuid;
            }
          } else {
            const uuid = tryUuidFromObject(parsed);
            if (uuid) return uuid;
          }
        }
      }

      return "";
    };

    const wireRegionDropSupport = () => {
      if (!game.user?.isGM || !this._editMode) return;
      const container = html[0]?.querySelector?.('.levels-rows');
      if (!container) return;

      container.addEventListener('dragover', (ev) => {
        // Allow dropping Regions from sidebar/doc directories.
        const dragging = container.querySelector('.level-row.dragging');
        if (dragging) return; // row-reorder already handled elsewhere
        const uuid = extractRegionUuidFromDrop(ev);
        if (!uuid) return;
        ev.preventDefault();
        try { ev.dataTransfer.dropEffect = 'copy'; } catch (e) { /* ignore */ }
      });

      container.addEventListener('drop', async (ev) => {
        const dragging = container.querySelector('.level-row.dragging');
        if (dragging) return; // don't interfere with reorder
        const uuid = extractRegionUuidFromDrop(ev);
        if (!uuid) return;
        ev.preventDefault();

        const doc = await fromUuid(uuid).catch(() => null);
        if (!(doc instanceof RegionDocument)) return;

        const sceneName = doc.parent?.name ?? "";
        const uuidLabel = sceneName ? `${sceneName}${REGION_LABEL_SPACING}${doc.name}` : doc.name;
        const label = doc.name;

        const targetRowEl = ev.target?.closest?.('.level-row');
        const $row = targetRowEl ? $(targetRowEl) : appendBlankRow();

        // Prevent duplicates (including current stop).
        const currentUuid = this.region.document.uuid;
        const existing = new Set(html.find('.levels-rows input[name="levelUuid"]').toArray().map(el => String(el.value ?? "").trim()).filter(Boolean));
        existing.add(currentUuid);
        if (existing.has(uuid)) return;

        $row.find('input[name="levelUuid"]').val(uuid);
        $row.find('input[name="levelUuidLabel"]').val(uuidLabel);
        if (!$row.find('input[name="levelLabel"]').val()) $row.find('input[name="levelLabel"]').val(label);
      });
    };

    // Wire any pre-existing rows in edit mode.
    html.find('.level-row').each((_i, el) => wireUuidRow($(el)));

    activateDragReorder();
    wireRegionDropSupport();

    html.find('button[data-action="set-config-tab"]').on('click', ev => {
      if (!game.user?.isGM) return;
      const tab = String(ev.currentTarget?.dataset?.tab || "settings");
      this._configTab = (tab === "levels") ? "levels" : "settings";
      this.render(true);
    });

    html.find('[data-action="pick-icon"]').on('click', async () => {
      if (!game.user?.isGM) return;
      const current = String(html.find('input[name="iconSrc"]').val() ?? "").trim();
      const fp = new FilePicker({
        type: "image",
        current,
        callback: (path) => {
          html.find('input[name="iconSrc"]').val(path);
          html.find('img.icon-preview').attr('src', path);
        }
      });
      fp.render(true);
    });

    html.find('button[data-action="call"]').on('click', () => this._handleCall());
    html.find('button[data-action="select"]').on('click', ev => this._handleSelect(ev.currentTarget?.dataset?.uuid));

    html.find('button[data-action="toggle-edit"]').on('click', () => {
      if (!game.user?.isGM) return;
      this._editMode = !this._editMode;
      if (this._editMode) this._configTab = "settings";
      this.render(true);
    });

    html.find('button[data-action="cancel-config"]').on('click', () => {
      if (!game.user?.isGM) return;
      this._editMode = false;
      this._configTab = "settings";
      this.render(true);
    });

    html.find('button[data-action="add-level"]').on('click', () => {
      if (!game.user?.isGM) return;
      appendBlankRow();
    });

    html.find('button[data-action="bulk-add-levels"]').on('click', async () => {
      if (!game.user?.isGM) return;
      // Build a scene->regions checklist dialog like easy-regions' scene listing.
      const scenes = buildSceneRegionIndex();
      const currentUuid = this.region.document.uuid;

      const existing = new Set(html.find('.levels-rows input[name="levelUuid"]').toArray().map(el => String(el.value ?? "").trim()).filter(Boolean));
      existing.add(currentUuid);

      const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

      let content = `<form class="elevator-bulk-add" autocomplete="off">`;
      content += `<p>${esc(game.i18n.localize("elevator.panel.bulkAddHint"))}</p>`;
      for (const s of scenes) {
        content += `<details open><summary>${esc(s.name)}</summary>`;
        content += `<div class="bulk-scene">`;
        for (const r of s.regions) {
          if (!r.uuid || existing.has(r.uuid)) continue;
          content += `<label class="bulk-item"><input type="checkbox" name="regionUuid" value="${esc(r.uuid)}" data-label="${esc(r.label)}" data-region="${esc(r.name)}"> ${esc(r.name)}</label>`;
        }
        content += `</div></details>`;
      }
      content += `</form>`;

      return new Dialog({
        title: game.i18n.localize("elevator.panel.bulkAddTitle"),
        content,
        buttons: {
          add: {
            icon: '<i class="fas fa-plus"></i>',
            label: game.i18n.localize("elevator.panel.bulkAddConfirm"),
            callback: (dlgHtml) => {
              const checked = dlgHtml.find('input[name="regionUuid"]:checked').toArray();
              if (!checked.length) return;
              for (const el of checked) {
                const uuid = String(el.value ?? "").trim();
                const uuidLabel = String(el.dataset.label ?? uuid);
                const label = String(el.dataset.region ?? "");
                appendStopRow({ uuid, uuidLabel, label });
              }
            }
          },
          cancel: { label: game.i18n.localize("elevator.panel.cancel") }
        },
        default: "add"
      }).render(true);
    });

    html.find('button[data-action="remove-level"]').on('click', ev => {
      if (!game.user?.isGM) return;
      ev.preventDefault();
      $(ev.currentTarget).closest('.level-row').remove();
    });

    html.find('button[data-action="save-config"]').on('click', async () => {
      if (!game.user?.isGM) return;
      const form = html.find('form.elevator-config-form');
      if (!form.length) return;

      const enabled = !!form.find('input[name="enabled"]').prop('checked');
      const elevatorId = String(form.find('input[name="elevatorId"]').val() ?? "").trim();
      const isElevatorHere = !!form.find('input[name="isElevatorHere"]').prop('checked');
      const theme = normalizeThemeValue(String(form.find('select[name="theme"]').val() ?? DEFAULTS.theme));
      const iconSrc = String(form.find('input[name="iconSrc"]').val() ?? "").trim();

      const pctFromNumber = form.find('input[name="iconScalePct"]').val();
      const pctFromRange = form.find('input[name="iconScalePctRange"]').val();
      const iconScalePct = clampNumber(pctFromNumber ?? pctFromRange ?? 100, 20, 200);
      const iconSize = Math.max(24, Math.round((getSceneGridSizePx() * iconScalePct) / 100));

      const iconAlwaysOn = !!form.find('input[name="iconAlwaysOn"]').prop('checked');

      const currentUuid = this.region.document.uuid;
      const stopRows = form.find('.levels-rows .level-row').toArray();
      const stops = [];
      for (const row of stopRows) {
        const $row = $(row);
        const uuid = String($row.find('input[name="levelUuid"]').val() ?? "").trim();
        const label = String($row.find('input[name="levelLabel"]').val() ?? "").trim();
        if (!uuid) continue;
        stops.push({ uuid, label });
      }
      const normalizedStops = normalizeStops(stops);
      if (!normalizedStops.some(s => s.uuid === currentUuid)) {
        normalizedStops.push({ uuid: currentUuid, label: this.region.document.name });
      }

      // This Region's destinations are all other stops.
      const levels = normalizedStops.filter(s => s.uuid !== currentUuid);

      const current = getElevatorFlags(this.region.document);
      const nextFlags = foundry.utils.mergeObject(current, {
        enabled,
        elevatorId,
        isElevatorHere,
        theme,
        iconSrc,
        iconSize,
        iconAlwaysOn,
        levels
      }, { inplace: false });

      await this.region.document.update({ [`flags.${MOD_ID}`]: nextFlags });

      // Only build/sync the elevator network when enabled.
      if (enabled && elevatorId) {
        // Persist master order (top-to-bottom = Level max -> Level 1)
        const linksById = foundry.utils.duplicate(getElevatorLinksById());
        linksById[elevatorId] = {
          elevatorId,
          homeUuid: currentUuid,
          iconSrc,
          iconSize,
          iconAlwaysOn: !!iconAlwaysOn,
          theme,
          stops: normalizedStops
        };
        await setElevatorLinksById(linksById);
        await syncElevatorNetwork(elevatorId, { homeUuid: currentUuid });
      }

      this.flags = nextFlags;
      this._elevatorState = this._deriveState();
      this._editMode = false;
      this.render(true);
      queueOverlayRefresh();
    });
  }

  async _handleCall() {
    const elevId = this.flags.elevatorId;
    if (!elevId) return ui.notifications.warn(game.i18n.localize(`${MOD_ID}.warn.noElevatorId`));

    const anyCombatant = tokensInsideRegion(this.region).some(t => t?.combatantId || t?.isCombatant);
    const requireNextRound = anyCombatant && (game.settings.get(MOD_ID, SETTINGS.CombatDelayPolicy) === "next-round");

    if (requireNextRound && game.combat) {
      const startRound = game.combat.round;
      ui.notifications.info(game.i18n.localize(`${MOD_ID}.info.waitNextRound`));
      const untilNextRound = () => new Promise(resolve => {
        const handler = (combat, changed) => {
          if (changed.round && combat.round > startRound) {
            Hooks.off('updateCombat', handler);
            resolve();
          }
        };
        Hooks.on('updateCombat', handler);
      });
      await untilNextRound();
    } else {
      const delayMs = game.settings.get(MOD_ID, SETTINGS.ArrivalDelayMs) || DEFAULTS.arrivalDelayMs;
      await new Promise(r => setTimeout(r, delayMs));
    }

    // Update world state to mark elevator is at this Region (GM via socket for players).
    await requestSetCurrentLevel(elevId, this.region.document.uuid);

    // Rerender as Select Level
    this._elevatorState = this._deriveState();
    this.render(true);
  }

  async _handleSelect(destUUID) {
    if (!destUUID) return ui.notifications.warn(game.i18n.localize(`${MOD_ID}.warn.noDestination`));
    const dest = await fromUuid(destUUID);
    if (!(dest instanceof RegionDocument)) return ui.notifications.error(game.i18n.localize(`${MOD_ID}.error.invalidDestination`));

    const destLabel = `${dest.parent?.name || ""}${REGION_LABEL_SPACING}${dest.name || ""}`.trim();

    // If selecting the current stop, do nothing.
    if (destUUID === this.region.document.uuid) {
      this._elevatorState = this._deriveState();
      return this.render(true);
    }

    const tokens = tokensInsideRegion(this.region);
    if (!tokens.length) return ui.notifications.warn(game.i18n.localize(`${MOD_ID}.warn.noTokensInRegion`));

    try {
      dlog("Panel select: tokens inside region", {
        user: game.user?.name,
        userId: game.user?.id,
        regionUuid: this.region?.document?.uuid,
        regionName: this.region?.document?.name,
        tokenCount: tokens.length,
        tokens: tokens.map(td => ({
          uuid: td?.uuid,
          name: td?.name,
          actor: td?.actor?.name,
          hidden: !!td?.hidden,
          isOwner: !!td?.isOwner
        }))
      });
    } catch (e) { /* ignore */ }

    // Play SFX first, then teleport after it finishes.
    await playDoorSfxAndWait();

    const requireAllGM = !!game.settings.get(MOD_ID, SETTINGS.RequireGMForAll);
    const owned = [], notOwned = [];
    for (const t of tokens) {
      (t.isOwner ? owned : notOwned).push(t);
    }

    try {
      dlog("Panel select: ownership split", {
        user: game.user?.name,
        owned: owned.map(t => ({ uuid: t?.uuid, name: t?.name, actor: t?.actor?.name })),
        notOwned: notOwned.map(t => ({ uuid: t?.uuid, name: t?.name, actor: t?.actor?.name })),
        requireAllGM
      });
    } catch (e) { /* ignore */ }

    // Owned tokens: teleport locally
    for (const t of owned) {
      try {
        if (typeof dest.teleportToken === "function") await dest.teleportToken(t);
        else throw new Error("Destination region has no teleportToken method");
      } catch (e) {
        warn("Teleport failed", t, e);
        ui.notifications.warn(game.i18n.localize(`${MOD_ID}.warn.teleportUnavailable`) || "Teleport unavailable for this destination.");
      }
    }

    // Non-owned tokens: request GM/owner approval
    // IMPORTANT: A player may not be able to see hidden/unowned tokens (so we can't enumerate them).
    // Always send a request with source region/scene info; GM will compute which tokens need approval.
    const payload = {
      requestId: makeRequestId(),
      requester: game.user.id,
      elevatorId: this.flags.elevatorId,
      destUUID,
      destLabel,
      tokenUUIDs: notOwned.map(t => t.uuid),
      sceneFromId: this.region.document.parent?.id,
      sourceRegionUuid: this.region.document.uuid
    };

    try { dlog("Teleport request payload", payload); } catch (e) { /* ignore */ }

    if (!game.user?.isGM) {
      // Approval routing via chat cards (server-mediated, reliable across multi-machine setups):
      // - Prefer online non-GM token owners
      // - Otherwise route to GM (GM-only owner, or owners offline)
      if (notOwned.length) {
        let sentToOwner = 0;
        let sentToGM = 0;

        for (const t of notOwned) {
          const { recipientIds, routedTo } = computeApprovalRecipientsForToken(t);
          if (!recipientIds?.length) continue;

          const oneTokenPayload = {
            ...payload,
            requestId: makeRequestId(),
            tokenUUIDs: [t.uuid]
          };
          const tokenLabel = t?.name || t?.actor?.name || "Token";
          try {
            await createApprovalChatCard(oneTokenPayload, { whisperIds: recipientIds, tokenLabel });
            if (routedTo === "owner") sentToOwner += 1;
            else sentToGM += 1;
          } catch (e) { /* ignore */ }
        }

        if (sentToOwner) ui.notifications.info(game.i18n.localize(`${MOD_ID}.info.sentOwnerRequest`));
        if (sentToGM) ui.notifications.info(game.i18n.localize(`${MOD_ID}.info.sentGMRequest`));
        if (requireAllGM && !sentToGM) ui.notifications.info(game.i18n.localize(`${MOD_ID}.info.sentGMRequest`));
      }
    }

    // Cross-scene view change for self
    if (dest.parent && dest.parent !== canvas.scene) {
      await dest.parent.view();
    }

    // Update world state so the elevator is now at the destination stop (GM via socket for players).
    try {
      await requestSetCurrentLevel(this.flags.elevatorId, destUUID);
    } catch (e) { /* ignore */ }

    // Rebind this panel to the destination region so subsequent selections operate on the new location.
    try {
      const destDocInView = canvas.scene?.regions?.get?.(dest.id) || await fromUuid(destUUID).catch(() => null);
      const destRegionObj = destDocInView?.object;
      if (destRegionObj) {
        this.region = destRegionObj;
        this.flags = getElevatorFlags(destDocInView);
        this._elevatorState = this._deriveState();
        this.render(true);
        return;
      }
    } catch (e) { /* ignore */ }
  }
}

function openElevatorPanel(region) {
  const panel = new ElevatorPanel(region);
  panel.render(true);
}

function rerenderOpenElevatorPanels(elevatorId) {
  const elevId = String(elevatorId ?? "").trim();
  if (!elevId) return;
  try {
    for (const app of Object.values(ui.windows || {})) {
      if (!(app instanceof ElevatorPanel)) continue;
      const appElevId = String(app?.flags?.elevatorId ?? "").trim();
      if (appElevId !== elevId) continue;
      app._elevatorState = app._deriveState();
      app.render(false);
    }
  } catch (e) { /* ignore */ }
}

const _rerenderTimersByElevId = new Map();
function queueRerenderOpenElevatorPanels(elevatorId) {
  const elevId = String(elevatorId ?? "").trim();
  if (!elevId) return;
  const prev = _rerenderTimersByElevId.get(elevId);
  if (prev) clearTimeout(prev);
  _rerenderTimersByElevId.set(elevId, setTimeout(() => {
    _rerenderTimersByElevId.delete(elevId);
    rerenderOpenElevatorPanels(elevId);
  }, 50));
}

// Socket handling (GM-side)
let SOCKET_REGISTERED = false;
const _SEEN_SOCKET_IDS = new Map();

function wasSocketRequestSeen(requestId, windowMs = 8000) {
  const id = String(requestId ?? "").trim();
  if (!id) return false;
  const now = Date.now();
  // Cleanup opportunistically
  for (const [k, ts] of _SEEN_SOCKET_IDS) {
    if (now - ts > windowMs) _SEEN_SOCKET_IDS.delete(k);
  }
  if (_SEEN_SOCKET_IDS.has(id)) return true;
  _SEEN_SOCKET_IDS.set(id, now);
  return false;
}
async function gmTeleportTokenToRegion(destRegionDoc, tokenUuid) {
  const tokenEntity = await fromUuid(tokenUuid);
  if (!tokenEntity) return;
  // fromUuid for a Token returns a TokenDocument; for safety accept either.
  const tokenDoc = tokenEntity?.document ?? tokenEntity;
  const tokenObj = tokenDoc?.object ?? tokenEntity?.object ?? null;
  if (typeof destRegionDoc?.teleportToken !== "function") throw new Error("Destination region has no teleportToken method");

  try {
    // Prefer TokenDocument (works cross-scene); fall back to Token object if needed.
    await destRegionDoc.teleportToken(tokenDoc);
  } catch (e) {
    if (tokenObj) await destRegionDoc.teleportToken(tokenObj);
    else throw e;
  }
}

function registerSocket() {
  if (SOCKET_REGISTERED) return;
  SOCKET_REGISTERED = true;

  const handleSocketMessage = async (data) => {
    const type = String(data?.type ?? "").trim();
    if (!type) return;

    // De-dupe for mixed clients (we may receive the same request on both unified + legacy channels).
    if (wasSocketRequestSeen(data?.requestId)) return;

    // Debug connectivity test
    if (type === "socketPing") {
      try {
        dlog("socketPing received", {
          requestId: data?.requestId,
          fromUserId: data?.fromUserId,
          fromUserName: game.users?.get?.(data?.fromUserId)?.name,
          user: game.user?.name,
          isGM: !!game.user?.isGM
        });
      } catch (e) { /* ignore */ }

      // Only a GM responds.
      if (!game.user?.isGM) return;
      try {
        game.socket.emit(SOCKET_CHANNEL, {
          type: "socketPong",
          requestId: data?.requestId,
          toUserId: data?.fromUserId,
          fromUserId: game.user?.id
        });
      } catch (e) { /* ignore */ }
      return;
    }

    if (type === "socketPong") {
      if (String(data?.toUserId ?? "") !== String(game.user?.id ?? "")) return;
      try {
        dlog("socketPong received", {
          requestId: data?.requestId,
          fromUserId: data?.fromUserId,
          fromUserName: game.users?.get?.(data?.fromUserId)?.name
        });
      } catch (e) { /* ignore */ }
      try { ui.notifications?.info?.("Elevator: GM socket response received (debug)"); } catch (e) { /* ignore */ }
      return;
    }

    // Player -> GM: update world state
    if (type === "setCurrentLevel") {
      if (!game.user?.isGM) return;
      try {
        const elevId = String(data?.elevatorId ?? "").trim();
        const uuid = String(data?.regionUuid ?? "").trim();
        if (!elevId || !uuid) return;

        dlog("GM setCurrentLevel", { elevId, uuid, requester: data?.requester });

        const currentById = foundry.utils.duplicate(game.settings.get(MOD_ID, WORLD_STATE.CurrentLevelByElevatorId) || {});
        currentById[elevId] = uuid;
        await game.settings.set(MOD_ID, WORLD_STATE.CurrentLevelByElevatorId, currentById);

        // Broadcast so all clients update immediately.
        const requestId = String(data?.requestId ?? "").trim() || makeRequestId();
        game.socket.emit(SOCKET_CHANNEL, { type: "currentLevelChanged", requestId, elevatorId: elevId, regionUuid: uuid });
        game.socket.emit(LEGACY_SOCKET.currentLevelChanged, { requestId, elevatorId: elevId, regionUuid: uuid });
      } catch (e) {
        warn("Socket setCurrentLevel error", e);
      }
      return;
    }

    // Player -> GM: request current state
    if (type === "getCurrentLevel") {
      if (!game.user?.isGM) return;
      try {
        const elevId = String(data?.elevatorId ?? "").trim();
        if (!elevId) return;
        const currentById = game.settings.get(MOD_ID, WORLD_STATE.CurrentLevelByElevatorId) || {};
        const uuid = String(currentById?.[elevId] || "").trim();
        dlog("GM getCurrentLevel", { elevId, uuid, requester: data?.requester });
        if (!uuid) return;
        const requestId = String(data?.requestId ?? "").trim() || makeRequestId();
        game.socket.emit(SOCKET_CHANNEL, { type: "currentLevelChanged", requestId, elevatorId: elevId, regionUuid: uuid });
        game.socket.emit(LEGACY_SOCKET.currentLevelChanged, { requestId, elevatorId: elevId, regionUuid: uuid });
      } catch (e) {
        warn("Socket getCurrentLevel error", e);
      }
      return;
    }

    // GM -> everyone: state broadcast
    if (type === "currentLevelChanged") {
      try {
        const elevId = String(data?.elevatorId ?? "").trim();
        const uuid = String(data?.regionUuid ?? "").trim();
        if (!elevId || !uuid) return;
        dlog("currentLevelChanged", { elevId, uuid, user: game.user?.name });
        CLIENT_STATE.currentLevelByElevatorId[elevId] = uuid;
        queueRerenderOpenElevatorPanels(elevId);
      } catch (e) {
        warn("Socket currentLevelChanged error", e);
      }
    }

  };

  // Unified channel (correct for Foundry)
  game.socket.on(SOCKET_CHANNEL, handleSocketMessage);

  // Legacy per-event channels (backward compatibility)
  game.socket.on(LEGACY_SOCKET.setCurrentLevel, (payload) => handleSocketMessage({ ...(payload || {}), type: "setCurrentLevel" }));
  game.socket.on(LEGACY_SOCKET.getCurrentLevel, (payload) => handleSocketMessage({ ...(payload || {}), type: "getCurrentLevel" }));
  game.socket.on(LEGACY_SOCKET.currentLevelChanged, (payload) => handleSocketMessage({ ...(payload || {}), type: "currentLevelChanged" }));

  try {
    dlog("Sockets registered", {
      channel: SOCKET_CHANNEL,
      legacy: LEGACY_SOCKET,
      user: game.user?.name,
      userId: game.user?.id,
      isGM: !!game.user?.isGM
    });
  } catch (e) { /* ignore */ }

  try {
    if (isDebugEnabled()) ui.notifications?.info?.("Elevator: sockets registered (debug)");
  } catch (e) { /* ignore */ }
}

function registerChatApprovals() {
  Hooks.on("renderChatMessage", (message, html) => {
    try {
      const payload = message?.flags?.[MOD_ID]?.teleportRequest;
      if (!payload) return;
      const root = html?.[0] ?? html;
      if (!root?.querySelector) return;
      const card = root.querySelector('[data-elevator-approval="1"]');
      if (!card) return;

      const approveBtn = card.querySelector('button[data-action="elevator-approve"]');
      const denyBtn = card.querySelector('button[data-action="elevator-deny"]');
      if (approveBtn) {
        approveBtn.addEventListener("click", async () => {
          try {
            const dest = await fromUuid(payload.destUUID);
            if (!(dest instanceof RegionDocument)) return;

            // Prefer explicit token list; otherwise compute from source region/scene.
            let tokenUUIDs = Array.isArray(payload.tokenUUIDs) ? payload.tokenUUIDs.filter(Boolean) : [];
            if (!tokenUUIDs.length && payload.sourceRegionUuid && payload.sceneFromId) {
              const scene = game.scenes?.get?.(payload.sceneFromId);
              const srcRegion = await fromUuid(payload.sourceRegionUuid).catch(() => null);
              if (scene && srcRegion) {
                const gridSizePx = getGridSizePxForScene(scene);
                const inside = [];
                for (const td of scene.tokens || []) {
                  const pt = tokenCenterPointPx(td, gridSizePx);
                  if (isPointInRegion(pt, srcRegion)) inside.push(td);
                }
                tokenUUIDs = inside
                  .filter(td => !isTokenOwnedByUser(td, payload.requester))
                  .map(td => td.uuid);
              }
            }

            const approverId = game.user?.id;
            const isGM = !!game.user?.isGM;
            const approvedTokenUUIDs = [];
            for (const tUUID of tokenUUIDs) {
              try {
                const tokenEntity = await fromUuid(tUUID);
                const tokenDoc = tokenEntity?.document ?? tokenEntity;
                if (!tokenDoc) continue;
                if (!isGM && !isTokenOwnedByUser(tokenDoc, approverId)) continue;
                await gmTeleportTokenToRegion(dest, tUUID);
                approvedTokenUUIDs.push(tUUID);
              } catch (e) {
                warn("Approval teleport failed", tUUID, e);
              }
            }

            if (!approvedTokenUUIDs.length) {
              try { ui.notifications?.warn?.(game.i18n.localize(`${MOD_ID}.warn.noTokensApprovable`)); } catch (e) { /* ignore */ }
              return;
            }

            // Also persist elevator location if we know the elevator id.
            try {
              const elevId = String(payload.elevatorId ?? "").trim();
              if (elevId) await requestSetCurrentLevel(elevId, payload.destUUID);
            } catch (e) { /* ignore */ }

            // Notify requester (best-effort).
            try {
              const requesterId = String(payload.requester ?? "").trim();
              if (requesterId) {
                await ChatMessage.create({
                  content: game.i18n.format(`${MOD_ID}.info.approvalGranted`, { name: game.user?.name || "GM" }),
                  whisper: [requesterId]
                });
              }
            } catch (e) { /* ignore */ }

            try { await message.delete(); } catch (e) { /* ignore */ }
          } catch (e) {
            warn("Approval chat approve error", e);
          }
        });
      }

      if (denyBtn) {
        denyBtn.addEventListener("click", async () => {
          try { await message.delete(); } catch (e) { /* ignore */ }
        });
      }
    } catch (e) {
      warn("renderChatMessage elevator approval error", e);
    }
  });
}

// Region Config UI injection for elevator flags
function renderRegionConfig(doc, html) {
  try {
    // Hook signature is (app, html, data). In v13 the html arg is not always the full form,
    // so prefer the application's element.
    const app = doc;
    const candidateFromApp = app?.element?.[0] ?? app?.element ?? null;
    const candidateFromHtml = html?.[0] ?? html;

    let root = candidateFromApp || candidateFromHtml;
    if (root?.tagName === "BUTTON" && root?.closest) {
      root = root.closest("form") || root;
    }
    if (!root?.querySelector && app?.id) {
      root = document.getElementById(app.id) || root;
    }

    if (!root?.querySelector) {
      warn("renderRegionConfig: unsupported root element", { html, candidateFromApp, candidateFromHtml });
      return;
    }

    log("renderRegionConfig: hook fired", {
      appId: app?.id,
      docName: app?.document?.name,
      rootTag: root?.tagName,
      rootClass: root?.className
    });

    const fields = foundry.data.fields;
    const PREFIX = `${MOD_ID}.regionConfig`;

    const schema = new fields.SchemaField({
      enabled: new fields.BooleanField({ initial: false, label: `${PREFIX}.enabled.label`, hint: `${PREFIX}.enabled.hint` }),
      elevatorId: new fields.StringField({ initial: "", label: `${PREFIX}.elevatorId.label`, hint: `${PREFIX}.elevatorId.hint` }),
      isElevatorHere: new fields.BooleanField({ initial: false, label: `${PREFIX}.isHere.label`, hint: `${PREFIX}.isHere.hint` }),
      iconSrc: new fields.FilePathField({ categories: ["IMAGE"], label: `${PREFIX}.icon.label`, hint: `${PREFIX}.icon.hint` }),
      iconSize: new fields.NumberField({ integer: true, min: 24, initial: 48, label: `${PREFIX}.iconSize.label`, hint: `${PREFIX}.iconSize.hint` }),
      theme: new fields.StringField({ initial: DEFAULTS.theme, label: `${PREFIX}.theme.label`, hint: `${PREFIX}.theme.hint`, choices: { default: "Default", scifi: "Sci-Fi", horror: "Horror", rustic: "Rustic" } }),
      returnTo: new fields.SchemaField({
        uuid: new fields.DocumentUUIDField({ type: "Region" }),
        label: new fields.StringField({ initial: "" })
      }),
      // levels: array of { uuid, label }
      levels: new fields.ArrayField(new fields.SchemaField({
        uuid: new fields.DocumentUUIDField({ type: "Region" }),
        label: new fields.StringField({ initial: "" })
      })),
    }, {}, { name: `flags.${MOD_ID}` });

    // Prevent duplicates on re-render.
    root.querySelectorAll("fieldset.elevator-config").forEach(el => el.remove());

    const group = document.createElement("fieldset");
    group.classList.add("elevator-config");
    group.append(schema.fields.enabled.toFormGroup({ localize: true }, { value: doc.document.flags?.[MOD_ID]?.enabled }));
    group.append(schema.fields.elevatorId.toFormGroup({ localize: true }, { value: doc.document.flags?.[MOD_ID]?.elevatorId }));
    group.append(schema.fields.isElevatorHere.toFormGroup({ localize: true }, { value: doc.document.flags?.[MOD_ID]?.isElevatorHere }));
    group.append(schema.fields.iconSrc.toFormGroup({ localize: true }, { value: doc.document.flags?.[MOD_ID]?.iconSrc }));
    group.append(schema.fields.iconSize.toFormGroup({ localize: true }, { value: doc.document.flags?.[MOD_ID]?.iconSize }));
    group.append(schema.fields.theme.toFormGroup({ localize: true }, { value: normalizeThemeValue(doc.document.flags?.[MOD_ID]?.theme || DEFAULTS.theme) }));

    // Return destination (optional)
    const returnTo = doc.document.flags?.[MOD_ID]?.returnTo || {};
    const returnWrap = document.createElement("div");
    returnWrap.classList.add("returnto-config");
    const returnUuidField = schema.fields.returnTo.fields.uuid.toFormGroup({ localize: true }, { value: returnTo.uuid });
    const returnLabelField = schema.fields.returnTo.fields.label.toFormGroup({ localize: true }, { value: returnTo.label });
    returnWrap.append(returnUuidField, returnLabelField);
    group.append(returnWrap);

    // Simple list UI for levels (basic add/remove via input list)
    const levelsContainer = document.createElement("div");
    levelsContainer.classList.add("levels-config");
    const existing = doc.document.flags?.[MOD_ID]?.levels || [];
    const list = document.createElement("div");
    list.classList.add("levels-list");
    existing.forEach(lvl => {
      const row = document.createElement("div");
      row.classList.add("level-row");
      const uuidField = schema.fields.levels.element.fields.uuid.toFormGroup({ localize: true }, { value: lvl.uuid });
      const labelField = schema.fields.levels.element.fields.label.toFormGroup({ localize: true }, { value: lvl.label });
      row.append(uuidField, labelField);
      list.append(row);
    });
    levelsContainer.append(list);
    group.append(levelsContainer);

    // Prefer an "Elevator" tab; fallback to shapes section if tabs are not present.
    const tab = ensureElevatorRegionConfigTab(root);
    if (tab?.tabSection) {
      tab.tabSection.append(group);
      log("renderRegionConfig: appended elevator fieldset", { target: `tab:elevator (${tab.group})`, inserted: true });
    } else {
      let section = root.querySelector('section.region-shapes');
      let target = 'section.region-shapes';
      if (!section) { section = root.querySelector('section'); target = 'section'; }
      if (!section) { section = root.querySelector('form'); target = 'form'; }
      if (!section) { section = root; target = 'root'; }
      section.append(group);
      log("renderRegionConfig: appended elevator fieldset", { target, inserted: true });
    }
  } catch (e) {
    warn("renderRegionConfig error", e);
  }
}

async function refreshRegion(region, options) {
  try {
    await ensureElevatorOverlay(region);
  } catch (e) { warn("refreshRegion error", e); }
}

function updateRegion(document, changed, options, userId) {
  const region = document.object;
  if (!region) return;
  if (changed.flags?.[MOD_ID]) {
    // Rebuild overlay on flag changes
    try {
      if (region.elevatorOverlay) { region.elevatorOverlay.destroy({ children: true }); region.elevatorOverlay = null; }
      ensureElevatorOverlay(region);
    } catch (e) { warn("updateRegion rebuild overlay error", e); }
  }
}

function onUpdateToken(tokenDoc, changed, options, userId) {
  try {
    // Defer visibility evaluation until after token placeables refresh.
    // This prevents stale show/hide behavior when a token crosses a boundary.
    if (changed?.x !== undefined || changed?.y !== undefined || changed?.hidden !== undefined || changed?.disposition !== undefined) {
      queueOverlayRefresh();
    }
  } catch (e) { /* ignore */ }
}

function onRefreshToken(_token, _options, _userId) {
  try {
    // refreshToken fires after the placeable updates, so it's a good time to re-check occupancy.
    queueOverlayRefresh();
  } catch (e) { /* ignore */ }
}

function registerSettings() {
  game.settings.register(MOD_ID, SETTINGS.Theme, {
    name: game.i18n.localize(`${MOD_ID}.settings.theme.name`),
    hint: game.i18n.localize(`${MOD_ID}.settings.theme.hint`),
    scope: "client",
    type: String,
    choices: { default: "Default", scifi: "Sci-Fi", horror: "Horror", rustic: "Rustic" },
    default: DEFAULTS.theme,
    config: true
  });

  game.settings.register(MOD_ID, SETTINGS.ArrivalDelayMs, {
    name: game.i18n.localize(`${MOD_ID}.settings.arrivalDelay.name`),
    hint: game.i18n.localize(`${MOD_ID}.settings.arrivalDelay.hint`),
    scope: "world",
    type: Number,
    default: DEFAULTS.arrivalDelayMs,
    config: true
  });

  game.settings.register(MOD_ID, SETTINGS.CombatDelayPolicy, {
    name: game.i18n.localize(`${MOD_ID}.settings.combatDelay.name`),
    hint: game.i18n.localize(`${MOD_ID}.settings.combatDelay.hint`),
    scope: "world",
    type: String,
    choices: { "next-round": "Next Round" },
    default: DEFAULTS.combatDelayPolicy,
    config: true
  });

  game.settings.register(MOD_ID, SETTINGS.RequireGMForAll, {
    name: game.i18n.localize(`${MOD_ID}.settings.requireGM.name`),
    hint: game.i18n.localize(`${MOD_ID}.settings.requireGM.hint`),
    scope: "world",
    type: Boolean,
    default: DEFAULTS.requireGMForAll,
    config: true
  });

  game.settings.register(MOD_ID, SETTINGS.SfxEnabled, {
    name: game.i18n.localize(`${MOD_ID}.settings.sfx.name`),
    hint: game.i18n.localize(`${MOD_ID}.settings.sfx.hint`),
    scope: "client",
    type: Boolean,
    default: DEFAULTS.sfxEnabled,
    config: true
  });

  game.settings.register(MOD_ID, SETTINGS.Debug, {
    name: game.i18n.localize(`${MOD_ID}.settings.debug.name`) || "Elevator Debug Logging",
    hint: game.i18n.localize(`${MOD_ID}.settings.debug.hint`) || "Log extra elevator state to the console.",
    scope: "client",
    type: Boolean,
    default: DEFAULTS.debug,
    config: true
  });

  game.settings.register(MOD_ID, WORLD_STATE.CurrentLevelByElevatorId, {
    name: game.i18n.localize(`${MOD_ID}.settings.worldState.name`),
    scope: "world",
    type: Object,
    default: {},
    config: false
  });

  game.settings.register(MOD_ID, WORLD_STATE.ElevatorLinksById, {
    name: game.i18n.localize(`${MOD_ID}.settings.linksState.name`) || "Elevator Links",
    scope: "world",
    type: Object,
    default: {},
    config: false
  });
}

Hooks.on("init", () => {
  registerSettings();
  Hooks.on("renderRegionConfig", renderRegionConfig);
  registerChatApprovals();
  log("Initialized");
});

Hooks.once("ready", () => {
  // Socket listeners must be registered regardless of canvas lifecycle.
  // Otherwise, GMs may miss player requests if hooks fire out of order.
  registerSocket();

  // GM-only best-effort repair: re-sync known elevator networks from the master links.
  // This helps recover from users deleting flags/behaviors on Regions.
  if (!game.user?.isGM) return;
  const linksById = getElevatorLinksById();
  const ids = Object.keys(linksById || {});
  if (!ids.length) return;
  (async () => {
    for (const id of ids) {
      await syncElevatorNetwork(id, { homeUuid: linksById[id]?.homeUuid });
    }
  })();
});

Hooks.once('canvasInit', () => {
  // Install Region hooks
  Hooks.on("refreshRegion", refreshRegion);
  Hooks.on("updateRegion", updateRegion);
  // Token movement
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("refreshToken", onRefreshToken);
  // Layer switching can change whether the icon should be clickable/visible.
  Hooks.on("canvasReady", refreshAllElevatorOverlays);
  Hooks.on("activateCanvasLayer", refreshAllElevatorOverlays);
  Hooks.on("sightRefresh", queueOverlayRefresh);
  log("Canvas init, hooks registered");
});
