/**
 * AutoMusic — per-engine settings memory, fixed crossfade on track change,
 * optional Connection Profile for scene analysis (route LLM call through a
 * different profile, then auto-restore the main one).
 */
import {
    eventSource, event_types, getRequestHeaders,
    saveSettingsDebounced, generateQuietPrompt,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

var M = 'auto_music';
var L = '[AutoMusic]';
var AM_VERSION = '1.16.1';

function amSlayOwnsScreen() {
    try {
        if (typeof window === 'undefined') return false;
        var standalone = window.MesugakiCampaign;
        if (standalone && standalone.isOpen && standalone.isOpen()) return true;
        var game = window.SlayCampaign;
        if (game && typeof game.isOpen === 'function' && game.isOpen()) return true;
        var lib = window.CharacterLibrary;
        var campaign = lib && typeof lib.getActiveCampaign === 'function' ? lib.getActiveCampaign() : null;
        return !!(campaign && ['slay-run', 'mesugaki-rpg'].includes(campaign.mode));
    } catch (e) { return false; }
}

/* ============ MUSIC THEORY ============ */
var KEYSCALES = [
    'C major','C minor','C# major','C# minor','D major','D minor',
    'D# major','D# minor','E major','E minor','F major','F minor',
    'F# major','F# minor','G major','G minor','G# major','G# minor',
    'A major','A minor','A# major','A# minor','B major','B minor',
];
var TIME_SIGS = ['2','3','4','6'];

/* ============ AUDIO ENGINES ============ */
// Each channel (ambient / music) can be driven by one of these engines.
// 'stable_audio'    — Stable Audio Open 1.0  (text prompt, no music theory params)
// 'ace_step'        — ACE Step v1.5          (full music: bpm / keyscale / timesig / unet)
// 'stable_audio_3'  — Stable Audio 3.0       (text prompt, can do music & SFX/ambient)
//
// `defaults` hold the recommended duration/steps/cfg per engine *per channel*.
// They are used to seed engineParams[channel][engine] the first time an engine
// is selected, so each engine remembers its own optimal settings.
var ENGINES = {
    stable_audio: {
        label: 'Stable Audio Open 1.0', musicParams: false,
        defaults: { ambient: { duration: 60, steps: 50, cfg: 5 }, music: { duration: 120, steps: 50, cfg: 5 } },
    },
    ace_step: {
        label: 'ACE Step v1.5', musicParams: true,
        defaults: { ambient: { duration: 60, steps: 8, cfg: 1 }, music: { duration: 120, steps: 8, cfg: 1 } },
    },
    stable_audio_3: {
        label: 'Stable Audio 3.0', musicParams: false,
        defaults: { ambient: { duration: 60, steps: 8, cfg: 1 }, music: { duration: 120, steps: 8, cfg: 1 } },
    },
};
function engineDefaults(channel, engine) {
    var e = ENGINES[engine] || ENGINES.stable_audio;
    var d = (e.defaults && e.defaults[channel]) || { duration: 60, steps: 8, cfg: 1 };
    return { duration: d.duration, steps: d.steps, cfg: d.cfg };
}

/* ============ DEFAULTS ============ */
var DEFAULTS = {
    enabled: false,
    ambientEnabled: true,
    musicEnabled: true,
    ambientVolume: 0.5,
    musicVolume: 0.3,
    ambientMuted: false,
    musicMuted: false,
    ambientLocked: false,
    musicLocked: false,
    comfyUrl: '',
    ambientWorkflow: '',
    musicWorkflow: '',
    // v1.8: per-channel engine selection + Stable Audio 3.0 workflows
    ambientEngine: 'stable_audio',
    musicEngine: 'ace_step',
    ambientSa3Workflow: '',
    musicSa3Workflow: '',
    sa3CheckpointModel: 'stable_audio_3_medium.safetensors',
    musicUnetModel: 'acestep_v1.5_xl_sft_bf16.safetensors',
    // v1.9: per-engine, per-channel duration/steps/cfg so each engine keeps its own
    // optimal settings. Shape: engineParams[channel][engine] = {duration, steps, cfg}
    engineParams: {},
    musicPresets: {},
    ambientDuration: 60,
    musicDuration: 120,
    ambientSteps: 50,
    musicSteps: 8,
    ambientCfg: 5,
    musicCfg: 1,
    cooldownSeconds: 60,
    crossfadeDuration: 3,
    contextMessages: 5,
    ambientLoop: true,
    musicLoop: true,
    generateOnChatStart: true,
    startDelay: 8,
    showGallery: false,
    llmMusicParams: true,
    checkEveryN: 1,
    libraryEnabled: true,
    libraryShuffle: true,
    libraryAutoplay: true,
    autoDeleteOnChatRemove: false,
    savedTracks: {},
    // --- Player favorites (global, shared across ALL chats) ---
    // A flat playlist of tracks the user pinned from the gallery/library.
    // Each entry mirrors a library track: {id, prompt, type, url, path, params, time}.
    favorites: [],
    // Repeat-one for the favorites player: the track you started keeps looping
    // in its channel instead of advancing. Applies to music and ambient alike.
    favRepeatOne: false,
    quickPlayerEnabled: false,
    quickPlayerExpanded: false,
    quickPlayerPosition: null,
    // --- Connection profile support ---
    // Route AutoMusic's scene-analysis LLM call through a separate profile
    // (e.g. a cheaper / JSON-friendly model) and switch back to the user's
    // main profile when done. Requires SillyTavern's built-in Connection
    // Profiles extension.
    useConnectionProfile: false,
    connectionProfile: '',   // name of the profile to use (empty = current/main)
    _restoreProfile: '',     // internal: profile to restore if interrupted by reload
};

function S() { return extension_settings[M]; }

function loadSettings() {
    extension_settings[M] = extension_settings[M] || {};
    var s = extension_settings[M];
    for (var k in DEFAULTS) {
        if (DEFAULTS.hasOwnProperty(k) && s[k] === undefined) {
            if (typeof DEFAULTS[k] === 'object' && DEFAULTS[k] !== null) {
                s[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
            } else {
                s[k] = DEFAULTS[k];
            }
        }
    }

    if (!s._migrated_v13) {
        if (s.musicSteps === 50) s.musicSteps = 8;
        if (s.musicCfg === 5) s.musicCfg = 1;
        s._migrated_v13 = true;
    }
    if (!s._migrated_v14) {
        if ((s.savedAmbient && s.savedAmbient.length) || (s.savedMusic && s.savedMusic.length)) {
            if (!s.savedTracks) s.savedTracks = {};
            s.savedTracks['_migrated'] = { ambient: s.savedAmbient || [], music: s.savedMusic || [], name: 'Migrated tracks' };
        }
        delete s.savedAmbient; delete s.savedMusic;
        s._migrated_v14 = true;
    }
    // v1.7: Migrate old hardcoded UNET workflow to use the new variable %unet_name%
    if (!s._migrated_v17_unet) {
        if (s.musicWorkflow && s.musicWorkflow.includes('"acestep_v1.5_xl_sft_bf16.safetensors"')) {
            s.musicWorkflow = s.musicWorkflow.replace('"acestep_v1.5_xl_sft_bf16.safetensors"', '"%unet_name%"');
        }
        s._migrated_v17_unet = true;
    }
    // v1.8: existing chats keep their classic engines (ambient=Stable Audio, music=ACE Step)
    if (!s._migrated_v18_engine) {
        if (!s.ambientEngine) s.ambientEngine = 'stable_audio';
        if (!s.musicEngine) s.musicEngine = 'ace_step';
        s._migrated_v18_engine = true;
    }
    // v1.9: seed per-engine params. The current flat duration/steps/cfg values are
    // adopted as the settings for whatever engine is *currently* active on each
    // channel, so nothing changes for the user until they switch engines.
    if (!s.engineParams || typeof s.engineParams !== 'object') s.engineParams = {};
    if (!s._migrated_v19_engine_params) {
        s.engineParams.ambient = s.engineParams.ambient || {};
        s.engineParams.music = s.engineParams.music || {};
        var ambEng0 = s.ambientEngine || 'stable_audio';
        var musEng0 = s.musicEngine || 'ace_step';
        if (!s.engineParams.ambient[ambEng0]) {
            s.engineParams.ambient[ambEng0] = { duration: s.ambientDuration, steps: s.ambientSteps, cfg: s.ambientCfg };
        }
        if (!s.engineParams.music[musEng0]) {
            s.engineParams.music[musEng0] = { duration: s.musicDuration, steps: s.musicSteps, cfg: s.musicCfg };
        }
        s._migrated_v19_engine_params = true;
    }

    if (!s.savedTracks) s.savedTracks = {};
    if (!s.musicPresets) s.musicPresets = {};
    if (!Array.isArray(s.favorites)) s.favorites = [];
}

/* ============ PER-ENGINE PARAMS ============ */
// Return the {duration,steps,cfg} for a channel's *currently selected* engine,
// creating the entry from the engine's recommended defaults if it doesn't exist.
function getEngineParams(channel) {
    var s = S();
    var engine = (channel === 'ambient') ? (s.ambientEngine || 'stable_audio') : (s.musicEngine || 'ace_step');
    if (!s.engineParams) s.engineParams = {};
    if (!s.engineParams[channel]) s.engineParams[channel] = {};
    if (!s.engineParams[channel][engine]) {
        s.engineParams[channel][engine] = engineDefaults(channel, engine);
    }
    var p = s.engineParams[channel][engine];
    // Backfill any missing field from defaults (robustness against partial data).
    var def = engineDefaults(channel, engine);
    if (p.duration === undefined) p.duration = def.duration;
    if (p.steps === undefined) p.steps = def.steps;
    if (p.cfg === undefined) p.cfg = def.cfg;
    return p;
}
function setEngineParam(channel, key, value) {
    var p = getEngineParams(channel);
    p[key] = value;
    // Keep the flat ambientX/musicX fields in sync with the active engine, so the
    // rest of the codebase (generation, presets) keeps working unchanged.
    syncFlatParams(channel);
}
// Mirror the active engine's params into the legacy flat fields used elsewhere.
function syncFlatParams(channel) {
    var s = S(), p = getEngineParams(channel);
    if (channel === 'ambient') {
        s.ambientDuration = p.duration; s.ambientSteps = p.steps; s.ambientCfg = p.cfg;
    } else {
        s.musicDuration = p.duration; s.musicSteps = p.steps; s.musicCfg = p.cfg;
    }
}

/* ============ STATE ============ */
var state = {
    ambientAudio: null, musicAudio: null,
    /* ephemeral host-boot score (see amApiPlayBrief/amApiEndBrief): the live
       session token, and the track it produced so endBrief can silence
       exactly that one and nothing newer */
    briefSession: null, briefTrack: null,
    /* a host track that must SURVIVE the next chat change (endBrief with
       stop:false) — the boot score keeps playing into the campaign instead of
       cutting to silence while the campaign's own score is still rendering */
    carryTrack: null,
    /* the chat a host has already scored through playBrief: our own
       on-chat-start pass would be a duplicate AND a wasted analyseAudio call */
    hostScoredChat: null,
    currentAmbientPrompt: '', currentMusicPrompt: '',
    lastGenerateTime: 0, generating: false,
    ambientPlaying: false, musicPlaying: false,
    generatedTracks: [],
    queueBusy: false, queueItems: [],
    messageCounter: 0,
    ambientLibIndex: -1, musicLibIndex: -1,
    lastChatKey: null,
    // --- Favorites player (two independent channels: music + ambient can play together) ---
    fav: {
        music:   { audio: null, index: -1 },
        ambient: { audio: null, index: -1 },
    },
    quickQueueOpen: false,
    // A sibling extension can temporarily take over the music channel (for
    // example the Inventory smartphone player) without destroying the track
    // that AutoMusic should resume afterwards.
    externalOverride: null,
};

/* ============ UTILITIES ============ */
function esc(t) { if (!t) return ''; var e = document.createElement('span'); e.textContent = t; return e.innerHTML; }
function escJ(s) {
    if (!s) return '';
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\x00-\x1f]/g, '');
}
function getComfyUrl() {
    var s = S(); if (s.comfyUrl) return s.comfyUrl;
    var sd = extension_settings.sd || {};
    return sd.comfy_url || sd.comfyUrl || sd.comfy_server_url || 'http://127.0.0.1:8188';
}
function getRecentText(n) {
    var ctx = getContext(); if (!ctx.chat) return '';
    var msgs = [], start = Math.max(0, ctx.chat.length - (n || 5));
    for (var i = start; i < ctx.chat.length; i++) { var m = ctx.chat[i]; if (m && m.mes) msgs.push(m.mes); }
    return msgs.join('\n\n');
}
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* ============ CHAT-KEYED LIBRARY ============ */
function getChatKey() {
    var ctx = getContext();
    if (ctx.groupId) return 'group_' + ctx.groupId;
    if (ctx.chatId) return String(ctx.chatId);
    return 'default';
}
function getChatStoreByKey(key) {
    var s = S();
    if (!s.savedTracks) s.savedTracks = {};
    if (!s.savedTracks[key]) s.savedTracks[key] = { ambient: [], music: [], name: '' };
    return s.savedTracks[key];
}
function getChatStore() {
    var store = getChatStoreByKey(getChatKey());
    var ctx = getContext();
    if (ctx.characters && ctx.characterId !== undefined && ctx.characters[ctx.characterId]) {
        store.name = ctx.characters[ctx.characterId].name || '';
    } else if (ctx.groupId && ctx.groups) {
        var g = ctx.groups.find(function (gr) { return gr.id === ctx.groupId; });
        if (g) store.name = g.name || '';
    }
    return store;
}
function getChatTracks(type) { return type === 'ambient' ? getChatStore().ambient : getChatStore().music; }

/* ============ FILE DELETION HELPER ============ */
async function deleteTrackFiles(trackList) {
    if (!trackList || !trackList.length) return;
    // A favorite reuses its library track's file: deleting the library entry
    // (or the chat) must not pull the file out from under the player.
    var pinned = {};
    getFavorites().forEach(function (f) { if (f.path) pinned[f.path] = true; });
    for (var i = 0; i < trackList.length; i++) {
        var track = trackList[i];
        if (track.path && pinned[track.path]) continue;
        if (track.path) {
            try {
                /* the endpoint reads `path`, not `name` — with the old key every
                   delete came back 400 and the file stayed behind */
                await fetch('/api/files/delete', { method: 'POST', headers: Object.assign({}, getRequestHeaders(), { 'Content-Type': 'application/json' }), body: JSON.stringify({ path: track.path }) });
            } catch (e) { console.warn(L, 'Could not delete file:', track.path, e.message); }
        }
    }
}
function onChatDeleted(chatId) {
    var s = S(); if (!s.autoDeleteOnChatRemove || !chatId) return;
    var key = String(chatId);
    if (s.savedTracks && s.savedTracks[key]) {
        var store = s.savedTracks[key];
        var allTracks = (store.ambient || []).concat(store.music || []);
        deleteTrackFiles(allTracks);
        delete s.savedTracks[key]; saveSettingsDebounced();
        if (allTracks.length > 0) toastr.info('Deleted ' + allTracks.length + ' track(s) for removed chat', 'AutoMusic');
        updateLibraryUI();
    }
}
function onGroupDeleted(groupId) {
    var s = S(); if (!s.autoDeleteOnChatRemove || !groupId) return;
    var key = 'group_' + groupId;
    if (s.savedTracks && s.savedTracks[key]) {
        var store = s.savedTracks[key];
        var allTracks = (store.ambient || []).concat(store.music || []);
        deleteTrackFiles(allTracks);
        delete s.savedTracks[key]; saveSettingsDebounced();
        if (allTracks.length > 0) toastr.info('Deleted ' + allTracks.length + ' track(s) for removed group', 'AutoMusic');
        updateLibraryUI();
    }
}
function deleteAllTracksFromLibrary() {
    var s = S(); if (!s.savedTracks) return 0;
    var totalCount = 0, allKeys = Object.keys(s.savedTracks), allFiles = [];
    for (var i = 0; i < allKeys.length; i++) {
        var store = s.savedTracks[allKeys[i]];
        if (store.ambient) { allFiles = allFiles.concat(store.ambient); totalCount += store.ambient.length; }
        if (store.music) { allFiles = allFiles.concat(store.music); totalCount += store.music.length; }
    }
    deleteTrackFiles(allFiles);
    s.savedTracks = {}; saveSettingsDebounced(); updateLibraryUI();
    return totalCount;
}

/* ============ SAVE TO LIBRARY ============ */
// The extension it belongs to, spelled the way SillyTavern's upload endpoint
// demands: ONE flat segment. validateAssetFileName() rejects '/' outright, so
// the old 'automusic/<type>/<file>' name was refused with 400 on EVERY track
// ever generated — the whole library was links into ComfyUI's output folder,
// alive only while ComfyUI is up (fix 2026-08-08).
function libraryFileName(type, prompt, sourceUrl) {
    var safeName = (prompt || 'track').replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 40).trim().replace(/ /g, '_');
    /* ComfyUI decides the container (mp3 / flac / wav); a hardcoded .mp3 on a
       flac payload would be served under the wrong type and refuse to play */
    var ext = 'mp3', m = /[?&]filename=([^&]*)/.exec(String(sourceUrl || ''));
    if (m) {
        var dot = decodeURIComponent(m[1]).lastIndexOf('.');
        if (dot !== -1) {
            var raw = decodeURIComponent(m[1]).substring(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (raw) ext = raw;
        }
    }
    return ('automusic_' + type + '_' + Date.now() + '_' + safeName).replace(/[^a-zA-Z0-9_\-]/g, '') + '.' + ext;
}
async function saveAudioToLibrary(type, prompt, sourceUrl, params) {
    var audioBlob;
    try {
        var resp = await fetch(sourceUrl);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        audioBlob = await resp.blob();
    } catch (e) { console.warn(L, 'library: cannot fetch the generated audio —', e.message); return null; }
    var filename = libraryFileName(type, prompt, sourceUrl);
    try {
        var reader = new FileReader();
        var b64 = await new Promise(function (resolve) { reader.onload = function () { resolve(reader.result.split(',')[1]); }; reader.readAsDataURL(audioBlob); });
        var uploadResp = await fetch('/api/files/upload', {
            method: 'POST', headers: Object.assign({}, getRequestHeaders(), { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name: filename, data: b64 }),
        });
        if (uploadResp.ok) {
            /* the server answers with the URL the client can fetch it from —
               that URL IS the durable copy, so it becomes the track's url and
               ComfyUI is out of the loop from here on */
            var info = await uploadResp.json();
            if (info && info.path) return { filename: filename, path: info.path, url: info.path };
        } else {
            /* silence here is what hid the 400 for 110 tracks in a row */
            console.warn(L, 'library: upload refused —', uploadResp.status, await uploadResp.text());
        }
    } catch (e2) { console.warn(L, 'library: upload failed —', e2.message); }
    return { filename: filename, path: null, url: sourceUrl };
}
function getTrackPlayUrl(track) {
    if (track.url) return track.url;
    /* `path` is what /api/files/upload answered: a client-relative URL, already
       served by SillyTavern. There is no /api/files/get endpoint — the old
       fallback pointed at one that has never existed. */
    if (track.path) return track.path.charAt(0) === '/' ? track.path : '/' + track.path;
    return null;
}

/* ============ COMFYUI-LINK RESCUE (1.14.3) ============ */
// Tracks saved before the 2026-08-08 upload fix — and favorites pinned while
// their upload was still running — hold ONLY a ComfyUI /view URL and no `path`.
// They play while ComfyUI is up and go silent the moment it is not (the
// favorites player showed them as present but ▶ did nothing). This pass moves
// every such track onto a SillyTavern-served copy under a STABLE name derived
// from the ComfyUI file, so a favorite and its library twin share one copy and
// a copy placed in user/files by hand (rescue-copy.js) is picked up as-is.
function comfyLinkInfo(url) {
    var m = /\/view\?(.*)$/.exec(String(url || ''));
    if (!m || !/^https?:\/\//i.test(String(url))) return null;
    var q = new URLSearchParams(m[1]), filename = q.get('filename');
    if (!filename) return null;
    return { filename: filename, subfolder: q.get('subfolder') || '', type: q.get('type') || 'output' };
}
function rescuedFileName(info) {
    return ('automusic_comfy_' + (info.subfolder ? info.subfolder + '_' : '') + info.filename).replace(/[^a-zA-Z0-9_\-.]/g, '');
}
function isComfyOnlyTrack(track) { return !!(track && !track.path && comfyLinkInfo(track.url)); }
// Returns true when the track now points at a SillyTavern copy.
async function localizeTrack(track) {
    if (!isComfyOnlyTrack(track)) return false;
    var name = rescuedFileName(comfyLinkInfo(track.url)), local = '/user/files/' + name;
    var adopt = function (p) { track.url = p; track.path = p; track.filename = name; return true; };
    // 1) a copy is already there (an earlier pass, or copied off disk)
    try { var h = await fetch(local, { method: 'HEAD', cache: 'no-store' }); if (h.ok) return adopt(local); } catch (e) { /* fall through */ }
    // 2) ComfyUI is up: pull the file and upload it under the stable name
    var blob;
    try { var r = await fetch(track.url); if (!r.ok) return false; blob = await r.blob(); } catch (e2) { return false; }
    try {
        var b64 = await new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
            fr.onerror = function () { reject(fr.error); };
            fr.readAsDataURL(blob);
        });
        var up = await fetch('/api/files/upload', {
            method: 'POST', headers: Object.assign({}, getRequestHeaders(), { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name: name, data: b64 }),
        });
        if (!up.ok) { console.warn(L, 'rescue: upload refused —', up.status, await up.text()); return false; }
        var res = await up.json();
        return res && res.path ? adopt(res.path) : false;
    } catch (e3) { console.warn(L, 'rescue: upload failed —', e3.message); return false; }
}
var rescueRunning = false;
async function rescueComfyLinks(quiet) {
    if (rescueRunning) return; rescueRunning = true;
    try {
        var s = S(), all = getFavorites().slice();
        Object.keys(s.savedTracks || {}).forEach(function (k) {
            var st = s.savedTracks[k]; all = all.concat(st.ambient || [], st.music || []);
        });
        var todo = all.filter(isComfyOnlyTrack);
        if (!todo.length) return;
        var moved = 0;
        for (var i = 0; i < todo.length; i++) { if (await localizeTrack(todo[i])) moved++; }
        if (moved) { saveSettingsDebounced(); updateLibraryUI(); renderFavOverlayList(); }
        var left = todo.length - moved;
        console.log(L, 'rescue: ' + moved + ' ComfyUI-only track(s) moved into SillyTavern storage, ' + left + ' still ComfyUI-only');
        if (!quiet && moved) toastr.success(moved + ' track(s) moved from ComfyUI into SillyTavern storage', 'AutoMusic');
        if (!quiet && left) toastr.warning(left + ' track(s) exist only in ComfyUI, which is not reachable. Start ComfyUI and reload to keep them.', 'AutoMusic', { timeOut: 10000 });
    } finally { rescueRunning = false; }
}
function warnUnplayable(track, url) {
    var where = 'its file';
    var ci = comfyLinkInfo(url);
    if (ci) { try { where = 'ComfyUI at ' + new URL(url).host; } catch (e) { where = 'ComfyUI'; } }
    var label = String((track && track.prompt) || url || '').substring(0, 50);
    toastr.warning('Cannot load "' + label + '…" — ' + where + ' is not reachable.' + (ci ? ' Start ComfyUI and the track will be copied into SillyTavern.' : ''), 'AutoMusic', { timeOut: 8000 });
}
// `chatKey` (optional) pins the track to the chat that REQUESTED the generation.
// Generation takes minutes; without the pin, a chat switch mid-generation would
// file the track under whatever chat is open when ComfyUI finishes (or under
// 'default' on the start screen).
function addTrackToLibrary(type, prompt, sourceUrl, params, chatKey) {
    var store = chatKey ? getChatStoreByKey(chatKey) : getChatStore();
    var list = (type === 'ambient') ? store.ambient : store.music;
    var entry = { prompt: prompt || '', url: sourceUrl, params: params || null, time: new Date().toISOString(), id: Date.now() + '_' + Math.random().toString(36).substr(2, 6) };
    saveAudioToLibrary(type, prompt, sourceUrl, params).then(function (fileInfo) {
        if (fileInfo) { entry.filename = fileInfo.filename; entry.path = fileInfo.path; if (fileInfo.url) entry.url = fileInfo.url; saveSettingsDebounced(); }
    });
    list.push(entry); saveSettingsDebounced(); updateLibraryUI(); return entry;
}
function removeFromLibrary(type, id) {
    var list = getChatTracks(type);
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
            if (list[i].path) deleteTrackFiles([list[i]]);
            list.splice(i, 1); break;
        }
    }
    saveSettingsDebounced(); updateLibraryUI();
}
function getNextLibraryTrack(type) {
    var s = S(), list = getChatTracks(type);
    if (!list || !list.length) return null;
    if (s.libraryShuffle) return list[randInt(0, list.length - 1)];
    var idx = type === 'ambient' ? state.ambientLibIndex : state.musicLibIndex;
    idx = (idx + 1) % list.length;
    if (type === 'ambient') state.ambientLibIndex = idx; else state.musicLibIndex = idx;
    return list[idx];
}
function playFromLibrary(type, track) {
    if (!track) return;
    var url = getTrackPlayUrl(track); if (!url) return;
    playAudio(type, url);
    if (type === 'ambient') { state.currentAmbientPrompt = track.prompt; $('#am_amb_name').text(track.prompt).attr('title', track.prompt); }
    else {
        var info = track.prompt; if (track.params && track.params.bpm) info += ' [' + track.params.bpm + ' BPM, ' + (track.params.keyscale || '') + ']';
        state.currentMusicPrompt = track.prompt; $('#am_mus_name').text(info).attr('title', info);
    }
}
function playNextFromLibrary(type) { var track = getNextLibraryTrack(type); if (track) playFromLibrary(type, track); }

/* ============ QUEUE ============ */
async function enqueue(taskFn) {
    return new Promise(function (resolve, reject) { state.queueItems.push({ fn: taskFn, resolve: resolve, reject: reject }); processQueue(); });
}
async function processQueue() {
    if (state.queueBusy || !state.queueItems.length) return;
    state.queueBusy = true; var item = state.queueItems.shift();
    try { item.resolve(await item.fn()); } catch (e) { item.reject(e); }
    finally { state.queueBusy = false; if (state.queueItems.length) processQueue(); }
}
async function waitForComfyFree() {
    var base = getComfyUrl().replace(/\/+$/, ''), maxWait = 120000, start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            var r = await fetch(base + '/queue');
            if (r.ok) { var q = await r.json(); if (!(q.queue_running || []).length && !(q.queue_pending || []).length) return true; }
        } catch (e) { }
        await new Promise(function (r) { setTimeout(r, 3000); });
    }
    return false;
}

/* ACE Step 1.5 ships with three language-model text encoders (0.6B / 1.7B /
   4B) and an install usually has only some of them. The built-in workflow
   names 1.7B; a ComfyUI without that file rejected the whole prompt with
   "Prompt outputs failed validation". Before submitting, every model input of
   an ACE loader is checked against the list ComfyUI itself reports, and a
   missing file is swapped for an installed one of the same family. */
var comfyChoiceCache = {};
async function comfyChoices(base, nodeClass, input) {
    var key = base + '|' + nodeClass;
    if (!comfyChoiceCache[key]) {
        try {
            var r = await fetch(base + '/object_info/' + encodeURIComponent(nodeClass));
            comfyChoiceCache[key] = r.ok ? ((await r.json())[nodeClass] || null) : null;
        } catch (e) { comfyChoiceCache[key] = null; }
        if (!comfyChoiceCache[key]) { var k = key; setTimeout(function () { delete comfyChoiceCache[k]; }, 30000); }
    }
    var info = comfyChoiceCache[key], spec = info && info.input && ((info.input.required || {})[input] || (info.input.optional || {})[input]);
    if (!spec) return null;
    if (Array.isArray(spec[0])) return spec[0];
    if (spec[0] === 'COMBO' && spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
    return null;
}
// Preference order when the requested file is missing (first installed wins).
var ACE_LM_PREF = ['qwen_1.7b_ace15', 'qwen_4b_ace15', 'qwen_0.6b_ace15'];
function pickInstalled(list, prefs, exclude) {
    for (var i = 0; i < prefs.length; i++) {
        for (var j = 0; j < list.length; j++) {
            if (list[j] !== exclude && list[j].toLowerCase().indexOf(prefs[i]) === 0) return list[j];
        }
    }
    return null;
}
async function adaptAceModels(base, obj) {
    var swaps = [];
    for (var id in obj) {
        var n = obj[id], inp = n && n.inputs;
        if (!inp) continue;
        if (n.class_type === 'DualCLIPLoader' && inp.type === 'ace') {
            var list = await comfyChoices(base, 'DualCLIPLoader', 'clip_name1');
            if (!list) continue;
            if (list.indexOf(inp.clip_name1) < 0) {
                var c1 = pickInstalled(list, ['qwen_0.6b_ace15'], null);
                if (c1) { swaps.push(inp.clip_name1 + ' → ' + c1); inp.clip_name1 = c1; }
            }
            if (list.indexOf(inp.clip_name2) < 0) {
                var c2 = pickInstalled(list, ACE_LM_PREF, inp.clip_name1);
                if (c2) { swaps.push(inp.clip_name2 + ' → ' + c2); inp.clip_name2 = c2; }
            }
        } else if (n.class_type === 'VAELoader' && /ace/i.test(String(inp.vae_name))) {
            var vl = await comfyChoices(base, 'VAELoader', 'vae_name');
            if (vl && vl.indexOf(inp.vae_name) < 0) {
                var v = pickInstalled(vl, ['ace_1.5', 'ace'], null);
                if (v) { swaps.push(inp.vae_name + ' → ' + v); inp.vae_name = v; }
            }
        }
    }
    if (swaps.length) console.log(L, 'ACE Step: using installed models instead of missing ones:', swaps.join(', '));
    return obj;
}
// ComfyUI's top-level message ("Prompt outputs failed validation") names no
// node; the details live in node_errors. Turn them into one readable line.
function comfyErrorText(eb, obj) {
    var msg = (eb && eb.error && eb.error.message) || 'request rejected', parts = [];
    var ne = eb && eb.node_errors;
    if (ne && typeof ne === 'object') {
        for (var id in ne) {
            var errs = (ne[id] && ne[id].errors) || [], cls = (ne[id] && ne[id].class_type) || (obj && obj[id] && obj[id].class_type) || ('node ' + id);
            errs.forEach(function (e) {
                var d = String(e.details || e.message || '');
                if (d.length > 160) d = d.substring(0, 157) + '…';
                parts.push(cls + ': ' + d);
            });
        }
    }
    return parts.length ? msg + ' — ' + parts.slice(0, 3).join('; ') : msg;
}

/* ============ DEFAULT WORKFLOWS ============ */
var DEFAULT_AMBIENT_WF = JSON.stringify({
    "3": { "inputs": { "seed": "%seed%", "steps": "%steps%", "cfg": "%cfg%", "sampler_name": "dpmpp_3m_sde_gpu", "scheduler": "exponential", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["11", 0] }, "class_type": "KSampler" },
    "4": { "inputs": { "ckpt_name": "stable-audio-open-1.0.safetensors" }, "class_type": "CheckpointLoaderSimple" },
    "6": { "inputs": { "text": "%prompt%", "clip": ["10", 0] }, "class_type": "CLIPTextEncode" },
    "7": { "inputs": { "text": "%negative_prompt%", "clip": ["10", 0] }, "class_type": "CLIPTextEncode" },
    "10": { "inputs": { "clip_name": "t5-base.safetensors", "type": "stable_audio", "device": "default" }, "class_type": "CLIPLoader" },
    "11": { "inputs": { "seconds": "%duration%", "batch_size": 1 }, "class_type": "EmptyLatentAudio" },
    "12": { "inputs": { "samples": ["3", 0], "vae": ["4", 2] }, "class_type": "VAEDecodeAudio" },
    "19": { "inputs": { "filename_prefix": "audio/AutoMusic_amb", "quality": "V0", "audio": ["12", 0] }, "class_type": "SaveAudioMP3" }
});

var DEFAULT_MUSIC_WF = JSON.stringify({
    "3": { "inputs": { "seed": "%seed%", "steps": "%steps%", "cfg": "%cfg%", "sampler_name": "euler", "scheduler": "simple", "denoise": 1, "model": ["78", 0], "positive": ["94", 0], "negative": ["47", 0], "latent_image": ["98", 0] }, "class_type": "KSampler" },
    "18": { "inputs": { "samples": ["3", 0], "vae": ["106", 0] }, "class_type": "VAEDecodeAudio" },
    "47": { "inputs": { "conditioning": ["94", 0] }, "class_type": "ConditioningZeroOut" },
    "78": { "inputs": { "shift": 3, "model": ["104", 0] }, "class_type": "ModelSamplingAuraFlow" },
    "94": { "inputs": { "tags": "%prompt%", "lyrics": "", "seed": "%seed%", "bpm": "%bpm%", "duration": "%duration%", "timesignature": "%timesignature%", "language": "en", "keyscale": "%keyscale%", "generate_audio_codes": true, "cfg_scale": 2, "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0, "clip": ["105", 0] }, "class_type": "TextEncodeAceStepAudio1.5" },
    "98": { "inputs": { "seconds": "%duration%", "batch_size": 1 }, "class_type": "EmptyAceStep1.5LatentAudio" },
    "104": { "inputs": { "unet_name": "%unet_name%", "weight_dtype": "default" }, "class_type": "UNETLoader" },
    "105": { "inputs": { "clip_name1": "qwen_0.6b_ace15.safetensors", "clip_name2": "qwen_1.7b_ace15.safetensors", "type": "ace", "device": "default" }, "class_type": "DualCLIPLoader" },
    "106": { "inputs": { "vae_name": "ace_1.5_vae.safetensors" }, "class_type": "VAELoader" },
    "107": { "inputs": { "filename_prefix": "audio/AutoMusic_mus", "quality": "V0", "audio": ["18", 0] }, "class_type": "SaveAudioMP3" }
});

// Stable Audio 3.0 — usable for BOTH ambient sounds and background music.
// Cleaned from the SwarmUI export: SwarmUI-only helper nodes (TextGenerate
// reprompt, CustomCombo, JsonExtractString, Math, Switch, PreviewAny) removed,
// since SillyTavern's own LLM already produces the final prompt.
var DEFAULT_SA3_WF = JSON.stringify({
    "57": { "inputs": { "text": "%negative_prompt%", "clip": ["76", 0] }, "class_type": "CLIPTextEncode" },
    "62": { "inputs": { "text": "%prompt%", "clip": ["76", 0] }, "class_type": "CLIPTextEncode" },
    "59": { "inputs": { "seconds": "%duration%", "batch_size": 1 }, "class_type": "EmptyLatentAudio" },
    "60": { "inputs": { "seed": "%seed%", "steps": "%steps%", "cfg": "%cfg%", "sampler_name": "lcm", "scheduler": "simple", "denoise": 1, "model": ["75", 0], "positive": ["62", 0], "negative": ["57", 0], "latent_image": ["59", 0] }, "class_type": "KSampler" },
    "58": { "inputs": { "samples": ["60", 0], "vae": ["75", 2] }, "class_type": "VAEDecodeAudio" },
    "75": { "inputs": { "ckpt_name": "%sa3_ckpt%" }, "class_type": "CheckpointLoaderSimple" },
    "76": { "inputs": { "clip_name": "t5gemma_b_b_ul2.safetensors", "type": "stable_audio", "device": "default" }, "class_type": "CLIPLoader" },
    "19": { "inputs": { "filename_prefix": "audio/AutoMusic_sa3", "quality": "V0", "audio": ["58", 0] }, "class_type": "SaveAudioMP3" }
});

/* ============ CONNECTION PROFILE SUPPORT ============ */
// Slash-command runner — loaded lazily in init so a path change in
// SillyTavern can never break the whole extension.
var runSlash = null;

// Returns the array of saved connection profiles, or [] if Connection
// Manager isn't installed / enabled.
function getProfileList() {
    try {
        var cm = extension_settings && extension_settings.connectionManager;
        if (!cm || !Array.isArray(cm.profiles)) return [];
        return cm.profiles;
    } catch (e) { return []; }
}

// Returns the name of the currently selected connection profile,
// or "" if none / unavailable.
function getCurrentProfileName() {
    try {
        var cm = extension_settings && extension_settings.connectionManager;
        if (!cm) return '';
        var sel = cm.selectedProfile;
        if (!sel) return '';
        var found = (cm.profiles || []).find(function (p) { return p.id === sel; });
        return found ? (found.name || '') : '';
    } catch (e) { return ''; }
}

// True only if we actually can and should route the LLM call through
// a different profile.
function shouldSwitchProfile() {
    var s = S();
    if (!s.useConnectionProfile) return false;
    if (!runSlash) return false;                       // slash runner not loaded
    var target = (s.connectionProfile || '').trim();
    if (!target) return false;                         // no target -> use main
    if (getProfileList().length === 0) return false;   // CM not installed
    var current = getCurrentProfileName();
    if (current && current === target) return false;   // already on target
    return true;
}

// Switch to a named profile via the official slash command and wait a bit
// for the API / model / preset to settle.
async function switchProfile(name) {
    if (!runSlash || !name) return false;
    try {
        await runSlash('/profile "' + String(name).replace(/"/g, '\\"') + '"');
        await new Promise(function (r) { setTimeout(r, 150); });
        return true;
    } catch (e) {
        console.warn(L, "Failed to switch to profile '" + name + "':", e);
        return false;
    }
}

// Run an async LLM task on the configured profile, then always restore the
// user's main profile. If switching isn't needed/possible, the task simply
// runs on the current profile.
async function withConnectionProfile(task) {
    if (!shouldSwitchProfile()) {
        return await task();
    }
    var s = S();
    var original = getCurrentProfileName();
    var target = (s.connectionProfile || '').trim();
    var switched = false;
    try {
        switched = await switchProfile(target);
        if (!switched) console.warn(L, 'Profile switch failed; running on current profile.');
        // Persist which profile to return to in case the page reloads mid-call.
        if (switched && original && original !== target) {
            s._restoreProfile = original;
            saveSettingsDebounced();
        }
        return await task();
    } finally {
        if (switched && original && original !== target) {
            await switchProfile(original);
        }
        if (S()._restoreProfile) { S()._restoreProfile = ''; saveSettingsDebounced(); }
    }
}

// Safety net: if a previous LLM call was interrupted (e.g. by page reload)
// while we were on the analysis profile, the marker survives in settings.
// On load, quietly switch back.
async function recoverProfileIfNeeded() {
    var s = S();
    var pending = s._restoreProfile;
    if (!pending || !runSlash) return;
    try {
        var current = getCurrentProfileName();
        if (current !== pending && getProfileList().some(function (p) { return p.name === pending; })) {
            console.log(L, "Recovering interrupted profile switch → restoring '" + pending + "'.");
            await switchProfile(pending);
        }
    } catch (e) {
        console.warn(L, 'Profile recovery failed:', e);
    } finally {
        s._restoreProfile = ''; saveSettingsDebounced();
    }
}

// Fills the settings dropdown with the available connection profiles.
function populateProfileDropdown() {
    var $sel = $('#am_profile_sel');
    if (!$sel.length) return;
    var profiles = getProfileList();
    var html = '<option value="">— Use current / main profile —</option>';
    if (profiles.length === 0) {
        html += '<option value="" disabled>(No profiles — install/enable Connection Profiles)</option>';
    } else {
        profiles.forEach(function (p) {
            var name = p && p.name ? p.name : '';
            if (!name) return;
            html += '<option value="' + esc(name) + '">' + esc(name) + '</option>';
        });
    }
    $sel.html(html);
    var saved = (S().connectionProfile || '');
    if (saved && profiles.some(function (p) { return p.name === saved; })) {
        $sel.val(saved);
    } else if (saved && profiles.length > 0) {
        // Saved profile no longer exists — visually fall back, but keep the
        // setting so the user notices the mismatch.
        $sel.val('');
    }
}

/* ============ LLM ============ */
function buildAudioPrompt(text, llmParams) {
    var s = S();
    var ambEng = s.ambientEngine || 'stable_audio';
    var musEng = s.musicEngine || 'ace_step';
    var ambModelName = (ambEng === 'stable_audio_3') ? 'Stable Audio 3.0' : 'Stable Audio';
    var musModelName = (musEng === 'stable_audio_3') ? 'Stable Audio 3.0' : (musEng === 'stable_audio' ? 'Stable Audio' : 'ACE Step');
    var musicExtra = '';
    if (llmParams) {
        musicExtra = '\n\nMUSIC PARAMS: Also determine:\n' +
            '- "bpm": 40-220. Slow/contemplative ~50-75, calm ~80-100, medium ~100-130, upbeat ~135-160, intense/action ~160-220.\n' +
            '- "keyscale": e.g. "C major", "A minor". Happy/triumph→major, Sad/dark→minor, Epic→D minor or C minor, Mystery→B minor.\n' +
            '- "timesignature": "4" (standard march/rock/most genres), "3" (waltz/gentle), "6" (flowing/compound).\n';
    }
    var noAmb = !state.currentAmbientPrompt, noMus = !state.currentMusicPrompt;
    var forceNote = (noAmb || noMus) ? '\nIMPORTANT: Current ' + (noAmb && noMus ? 'ambient and music are' : noAmb ? 'ambient is' : 'music is') + ' empty — you MUST set changed:true and provide a prompt.\n' : '\nOnly change if atmosphere SIGNIFICANTLY shifted.\n';
    
    return 'You analyze narrative text and generate audio cues: ambient sounds and background music.\n\n' +
        'AMBIENT: environmental/atmospheric sounds only — NOT music. For the ' + ambModelName + ' model.\n' +
        'Examples: "rain on windows, distant thunder, cozy fireplace crackling", "busy city street, car horns, crowd chatter"\n\n' +
        'MUSIC: Detailed narrative description for the ' + musModelName + ' music generation model.\n' +
        'Instead of simple tags, write a rich, descriptive paragraph (3-5 sentences) detailing the track. Include:\n' +
        '  1. GENRE & VIBE: (e.g., "A quiet, meditative ambient electronic track...")\n' +
        '  2. INSTRUMENTS & TEXTURES: Be specific (e.g., "slowly evolving pad textures," "fingerpicked acoustic guitar," "faint crackle of vinyl").\n' +
        '  3. PROGRESSION & DYNAMICS: How it flows (e.g., "breathes and shifts slowly," "builds to a gentle swell," "relentless driving rhythm").\n' +
        '  4. PRODUCTION QUALITY: (e.g., "warm, intimate atmosphere," "hushed and spacious," "wide cinematic mix").\n' +
        '  NOTE ON VOCALS: Keep it mostly instrumental. Textural, breathy, or ethereal background vocals/choirs are allowed, but NO actual lyrics or prominent pop singing.\n\n' +
        'MUSIC EXAMPLES of good prompts:\n' +
        '  Quiet/Intimate: "A quiet, meditative ambient electronic track. The piece opens with slowly evolving pad textures layered with gentle granular synthesis and the faint crackle of vinyl, creating a warm, intimate atmosphere. A delicate fingerpicked acoustic guitar weaves between the pads, its notes ringing out with natural decay. A breathy, ethereal female vocal enters softly, singing sparse, whispered phrases that dissolve into the soundscape. The arrangement breathes and shifts slowly like clouds, leaving generous space between every element."\n' +
        '  Tense Action: "A driving, high-stakes cinematic thriller score. The track kicks off with aggressive, staccato string ostinatos and booming orchestral percussion. A prominent, growling analog synth bass provides a relentless undercurrent. As the tension mounts, sharp brass hits puncture the mix, adding a sense of urgent danger. The arrangement is dense and dynamic, constantly pushing forward with a live studio orchestra feel."\n' +
        '  Emotional: "A melancholic, highly emotional solo piano piece. The composition centers on a delicate, descending melody played with a soft, felt-piano tone, accompanied by sparse, echoing chords. Halfway through, a hauntingly beautiful solo cello joins, playing long, expressive legato phrases that intertwine with the piano. The production is raw and intimate, warmly reverberant."\n' +
        musicExtra + forceNote + '\n' +
        'CURRENT AMBIENT: "' + (state.currentAmbientPrompt || 'none') + '"\n' +
        'CURRENT MUSIC: "' + (state.currentMusicPrompt || 'none') + '"\n\n' +
        'Output ONLY valid JSON, no explanation:\n' +
        (llmParams ?
            '{"ambient":{"changed":true/false,"prompt":"..."},"music":{"changed":true/false,"prompt":"...","bpm":120,"keyscale":"A minor","timesignature":"4","lyrics":""}}\n\n' :
            '{"ambient":{"changed":true/false,"prompt":"..."},"music":{"changed":true/false,"prompt":"...","lyrics":""}}\n\n') +
        'lyrics must always be empty string "".\n' +
        /* §9.2: the prompt string goes straight into the T5/Qwen text encoders
           of the audio model, which are English-trained. */
        'Write every "prompt" in ENGLISH ONLY, whatever language the story is in.\n\n' +
        '--- TEXT ---\n' + text + '\n--- END ---';
}

// Music theory params (bpm/key/timesig) only make sense for engines that consume
// them as structured inputs. SA3 is text-only, so don't bother the LLM for them.
function musicEngineUsesParams() {
    var eng = ENGINES[S().musicEngine || 'ace_step'];
    return eng ? eng.musicParams : true;
}

async function analyseAudio(text) {
    var wantParams = S().llmMusicParams && musicEngineUsesParams();
    var prompt = buildAudioPrompt(text, wantParams), raw = null;
    // Route through the configured connection profile (if any), then auto-restore.
    try {
        raw = await withConnectionProfile(function () {
            return generateQuietPrompt(prompt, false, false).catch(function () {
                return generateQuietPrompt(prompt, false, true);
            });
        });
    } catch (e) { return null; }
    if (!raw) return null;
    var c = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, ''), f = c.indexOf('{'), l = c.lastIndexOf('}');
    if (f < 0 || l <= f) return null;
    try { return JSON.parse(c.substring(f, l + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
}

/* ============ WORKFLOW FILL ============ */
function fillAmbientWorkflow(wfStr, prompt, duration, steps, cfg) {
    var t = wfStr;
    var strMap = { '%prompt%': escJ(prompt || ''), '%negative_prompt%': '' };
    var numMap = { '%seed%': Math.floor(Math.random() * 2147483647), '%steps%': steps || 50, '%cfg%': cfg || 5, '%duration%': duration || 60, '%denoise%': 1 };
    for (var key in strMap) t = t.split(key).join(strMap[key]);
    for (var key in numMap) { var v = String(numMap[key]); t = t.split('"' + key + '"').join(v); t = t.split(key).join(v); }
    try { return JSON.parse(t); } catch (e) { console.error(L, 'Ambient WF error:', e.message); return null; }
}

// Stable Audio 3.0 fill — works for either channel. SA3 is purely text-driven,
// so any music params (bpm/keyscale) are softly appended to the prompt text
// rather than mapped to dedicated workflow inputs.
function fillSa3Workflow(wfStr, prompt, duration, steps, cfg, musicParams) {
    var t = wfStr, s = S();
    var finalPrompt = prompt || '';
    if (musicParams) {
        var extras = [];
        if (musicParams.bpm) extras.push('BPM: ' + musicParams.bpm);
        if (musicParams.keyscale) extras.push('Key: ' + musicParams.keyscale);
        if (extras.length) finalPrompt = finalPrompt.replace(/\s*$/, '') + '. ' + extras.join('. ') + '.';
    }
    // SA3 reads target length from the prompt too — append it if not already present.
    if (duration && !/length\s*:/i.test(finalPrompt)) {
        finalPrompt = finalPrompt.replace(/\s*$/, '') + ' Length: ' + Math.round(duration) + ' seconds.';
    }
    var strMap = {
        '%prompt%': escJ(finalPrompt), '%negative_prompt%': '',
        '%sa3_ckpt%': escJ(s.sa3CheckpointModel || 'stable_audio_3_medium.safetensors')
    };
    var numMap = { '%seed%': Math.floor(Math.random() * 2147483647), '%steps%': steps || 8, '%cfg%': cfg || 1, '%duration%': duration || 60, '%denoise%': 1 };
    for (var key in strMap) t = t.split(key).join(strMap[key]);
    for (var key in numMap) { var v = String(numMap[key]); t = t.split('"' + key + '"').join(v); t = t.split(key).join(v); }
    try { return JSON.parse(t); } catch (e) { console.error(L, 'SA3 WF error:', e.message); return null; }
}

function fillMusicWorkflow(wfStr, prompt, musicParams) {
    var t = wfStr, s = S(), mp = getEngineParams('music');
    var bpm = (musicParams && musicParams.bpm) ? musicParams.bpm : randInt(80, 160);
    var keyscale = (musicParams && musicParams.keyscale) ? musicParams.keyscale : randPick(KEYSCALES);
    var timesig = (musicParams && musicParams.timesignature) ? String(musicParams.timesignature) : randPick(TIME_SIGS);
    var lyrics = (musicParams && musicParams.lyrics) ? musicParams.lyrics : '';
    if (bpm < 40) bpm = 40; if (bpm > 220) bpm = 220;
    if (KEYSCALES.indexOf(keyscale) < 0) keyscale = randPick(KEYSCALES);
    if (TIME_SIGS.indexOf(timesig) < 0) timesig = '4';
    var strMap = {
        '%prompt%': escJ(prompt || ''), '%negative_prompt%': '', '%lyrics%': escJ(lyrics),
        '%keyscale%': escJ(keyscale), '%timesignature%': escJ(timesig),
        '%unet_name%': escJ(s.musicUnetModel || 'acestep_v1.5_xl_sft_bf16.safetensors')
    };
    var numMap = { '%seed%': Math.floor(Math.random() * 2147483647), '%steps%': mp.steps || 8, '%cfg%': mp.cfg || 1, '%duration%': mp.duration || 120, '%bpm%': bpm, '%denoise%': 1 };
    for (var key in strMap) t = t.split(key).join(strMap[key]);
    for (var key in numMap) { var v = String(numMap[key]); t = t.split('"' + key + '"').join(v); t = t.split(key).join(v); }
    try { return JSON.parse(t); } catch (e) { console.error(L, 'Music WF error:', e.message); return null; }
}

/* ============ COMFYUI GENERATION ============ */
async function generateAudioQueued(type, prompt, musicParams) {
    return enqueue(function () { return generateAudioDirect(type, prompt, musicParams); });
}

async function generateAudioDirect(type, prompt, musicParams) {
    var s = S(), base = getComfyUrl().replace(/\/+$/, ''), obj;
    var engine = (type === 'ambient') ? (s.ambientEngine || 'stable_audio') : (s.musicEngine || 'ace_step');
    // Source of truth: the active engine's own saved params for this channel.
    var ep = getEngineParams(type);

    if (engine === 'stable_audio_3') {
        // Per-channel custom SA3 workflow overrides the built-in default.
        var sa3Custom = (type === 'ambient') ? s.ambientSa3Workflow : s.musicSa3Workflow;
        // Music channel may carry bpm/keyscale to fold into the SA3 text prompt.
        obj = fillSa3Workflow(sa3Custom || DEFAULT_SA3_WF, prompt, ep.duration, ep.steps, ep.cfg, (type === 'music') ? musicParams : null);
    } else if (engine === 'ace_step') {
        obj = fillMusicWorkflow(s.musicWorkflow || DEFAULT_MUSIC_WF, prompt, musicParams);
    } else {
        // 'stable_audio' (Stable Audio Open 1.0) — the classic ambient engine.
        obj = fillAmbientWorkflow((type === 'ambient' ? s.ambientWorkflow : s.musicWorkflow) || DEFAULT_AMBIENT_WF, prompt,
            ep.duration, ep.steps, ep.cfg);
    }
    if (!obj) return null;
    try { await adaptAceModels(base, obj); } catch (e) { console.warn(L, 'ACE model check skipped:', e.message); }

    updateStatus('gen-' + type);
    await waitForComfyFree();

    var qr;
    try { qr = await fetch(base + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: obj }) }); }
    catch (e) { return null; }
    if (!qr.ok) {
        var eb; try { eb = await qr.json(); } catch (x) { eb = null; }
        if (eb && (eb.error || eb.node_errors)) {
            var et = comfyErrorText(eb, obj);
            console.warn(L, 'ComfyUI rejected the ' + type + ' workflow:', et, eb.node_errors || '');
            toastr.error('ComfyUI: ' + et, 'AutoMusic', { timeOut: 12000 });
        }
        return null;
    }

    var promptId = (await qr.json()).prompt_id, deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 3000); });
        var hist;
        try { var hr = await fetch(base + '/history/' + promptId); if (!hr.ok) continue; hist = await hr.json(); } catch (x) { continue; }
        if (!hist[promptId]) continue;
        var entry = hist[promptId];
        if (entry.status && entry.status.status_str === 'error') return null;
        if (entry.status && entry.status.completed === false) continue;
        var outs = entry.outputs;
        if (!outs || !Object.keys(outs).length) { if (entry.status && entry.status.completed) return null; continue; }
        var nids = Object.keys(outs);
        for (var ni = 0; ni < nids.length; ni++) {
            var nodeOut = outs[nids[ni]], audios = nodeOut && (nodeOut.audio || nodeOut.gifs || nodeOut.images);
            if (!audios || !audios.length) continue;
            var info = audios[0];
            return base + '/view?' + new URLSearchParams({ filename: info.filename, subfolder: info.subfolder || '', type: info.type || 'output' }).toString();
        }
        return null;
    }
    return null;
}

/* ============ AUDIO PLAYBACK ============ */
// Smoothly fade `oldAudio` out while fading `newAudio` in. Returns immediately
// if there's nothing to fade. Guarded against being run twice on the same pair.
function crossfade(oldAudio, newAudio, duration, targetVol) {
    if (!newAudio) return;
    if (newAudio._fading) return;            // already mid-fade, don't stack timers
    newAudio._fading = true;
    newAudio.volume = 0;
    newAudio.play().catch(function () {});
    var dur = (duration && duration > 0) ? duration : 0.01;
    var steps = 30, interval = (dur * 1000) / steps, step = 0;
    var oldVol = (oldAudio && !oldAudio.paused) ? oldAudio.volume : 0;
    var fade = setInterval(function () {
        step++; var p = step / steps;
        newAudio.volume = Math.min(p * targetVol, targetVol);
        if (oldAudio) {
            oldAudio.volume = Math.max((1 - p) * oldVol, 0);
            if (oldAudio.volume <= 0.01 && !oldAudio.paused) {
                oldAudio._stopping = true; oldAudio.pause();
                oldAudio.removeAttribute('src'); oldAudio.load();
            }
        }
        if (step >= steps) {
            clearInterval(fade);
            newAudio.volume = targetVol;
            newAudio._fading = false;
            if (oldAudio && !oldAudio.paused) { oldAudio._stopping = true; oldAudio.pause(); oldAudio.removeAttribute('src'); oldAudio.load(); }
        }
    }, interval);
}

// Schedule an overlapping crossfade into the next library track for a NON-looping
// clip: when playback reaches (duration - crossfade) seconds, start the next one
// while the current is still audible. This is what produces an actual crossfade
// at end-of-track instead of an abrupt stop.
function attachAutoCrossfade(type, audio) {
    audio.addEventListener('timeupdate', function onTU() {
        var s = S();
        if (audio.loop) return;                                  // looping clips never end
        if (!(s.libraryEnabled && s.libraryAutoplay)) return;    // autoplay-next disabled
        if (audio._nextScheduled) return;                        // already kicked off
        var cf = (s.crossfadeDuration && s.crossfadeDuration > 0) ? s.crossfadeDuration : 0;
        var dur = audio.duration;
        if (!isFinite(dur) || dur <= 0) return;
        // Begin the next track `cf` seconds before this one ends (min 0.05s guard).
        if (cf > 0 && audio.currentTime >= dur - cf - 0.05) {
            audio._nextScheduled = true;
            audio.removeEventListener('timeupdate', onTU);
            playNextFromLibrary(type);
        }
    });
}

function playAudio(type, url) {
    var s = S(), isAmb = type === 'ambient';
    var volume = isAmb ? (s.ambientMuted ? 0 : s.ambientVolume) : (s.musicMuted ? 0 : s.musicVolume);
    var loop = isAmb ? s.ambientLoop : s.musicLoop;
    var oldAudio = isAmb ? state.ambientAudio : state.musicAudio;
    var audio = new Audio(url);
    // Auto-play-next and native loop are mutually exclusive: a looping clip
    // never fires 'ended', so while library autoplay is ON the loop flag is
    // suppressed and the playlist advances; with autoplay OFF the channel's
    // Loop checkbox keeps the current track repeating.
    audio.loop = loop && !(s.libraryEnabled && s.libraryAutoplay);
    audio.preload = 'auto';

    var started = false;
    var start = function () {
        if (started) return; started = true;
        if (!isAmb && state.externalOverride) {
            if (oldAudio && !oldAudio.paused) oldAudio.pause();
            audio.volume = volume;
            state.musicAudio = audio;
            state.musicPlaying = false;
            state.externalOverride.baseAudio = audio;
            state.externalOverride.baseWasPlaying = true;
            syncPlayerUI(); updateStatus('playing');
            return;
        }
        if (oldAudio && !oldAudio.paused) crossfade(oldAudio, audio, s.crossfadeDuration, volume);
        else { audio.volume = volume; audio.play().catch(function () {}); }
        if (isAmb) { state.ambientAudio = audio; state.ambientPlaying = true; } else { state.musicAudio = audio; state.musicPlaying = true; }
        syncPlayerUI(); updateStatus('playing');
    };

    // `canplay` is more reliable than `canplaythrough` (which may not re-fire for
    // cached media). Fall back to a readyState check + a short timeout so a clip
    // never silently fails to start.
    audio.addEventListener('canplay', start, { once: true });
    audio.addEventListener('loadeddata', function () { if (audio.readyState >= 2) start(); }, { once: true });
    audio.addEventListener('error', function () { if (!started && !audio._stopping) warnUnplayable(null, url); });
    setTimeout(function () { if (!started && audio.readyState >= 2) start(); }, 1500);

    // Overlapping crossfade into the next library track (non-looping autoplay).
    attachAutoCrossfade(type, audio);

    // Fallback: if the clip ends without the pre-emptive crossfade having fired
    // (e.g. crossfade disabled, or duration unknown), still advance the library.
    // Settings are re-read here (not from the closure) so checkboxes toggled
    // MID-track take effect at the end of this track.
    audio.addEventListener('ended', function () {
        if (audio.loop || audio._stopping) return;
        var live = S();
        if (live.libraryEnabled && live.libraryAutoplay) {
            if (!audio._nextScheduled) {
                audio._nextScheduled = true;
                setTimeout(function () { playNextFromLibrary(type); }, 300);
            }
            return;
        }
        // Autoplay off → honor the channel's Loop checkbox: restart this track.
        if (isAmb ? live.ambientLoop : live.musicLoop) {
            audio.loop = true;
            audio.currentTime = 0;
            audio.play().catch(function () {});
            return;
        }
        if (isAmb) state.ambientPlaying = false; else state.musicPlaying = false;
        syncPlayerUI();
    });
}

function stopAudio(type) {
    var audio = type === 'ambient' ? state.ambientAudio : state.musicAudio;
    if (audio) { audio._stopping = true; audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (type === 'ambient') { state.ambientAudio = null; state.ambientPlaying = false; } else { state.musicAudio = null; state.musicPlaying = false; }
    syncPlayerUI();
}

function setVolume(type, vol) {
    var audio = type === 'ambient' ? state.ambientAudio : state.musicAudio, muted = type === 'ambient' ? S().ambientMuted : S().musicMuted;
    if (audio) audio.volume = muted ? 0 : vol;
    if (type === 'ambient') S().ambientVolume = vol; else S().musicVolume = vol;
    // The favorites player rides on the matching channel's volume/mute.
    var fc = state.fav[type === 'ambient' ? 'ambient' : 'music'];
    if (fc && fc.audio) fc.audio.volume = muted ? 0 : vol;
    saveSettingsDebounced();
}

function toggleMute(type) {
    var s = S();
    if (type === 'ambient') { s.ambientMuted = !s.ambientMuted; if (state.ambientAudio) state.ambientAudio.volume = s.ambientMuted ? 0 : s.ambientVolume; if (state.fav.ambient.audio) state.fav.ambient.audio.volume = s.ambientMuted ? 0 : s.ambientVolume; }
    else { s.musicMuted = !s.musicMuted; if (state.musicAudio) state.musicAudio.volume = s.musicMuted ? 0 : s.musicVolume; if (state.fav.music.audio) state.fav.music.audio.volume = s.musicMuted ? 0 : s.musicVolume; }
    saveSettingsDebounced(); syncPlayerUI();
}

function toggleLock(type) {
    var s = S(); if (type === 'ambient') s.ambientLocked = !s.ambientLocked; else s.musicLocked = !s.musicLocked;
    saveSettingsDebounced(); syncPlayerUI();
}

// Re-apply the effective loop flag to the LIVE audio elements whenever any of
// the loop / autoplay checkboxes change (autoplay-next suppresses native loop —
// see playAudio). Without this, toggles only affect the NEXT track.
function applyLoopFlags() {
    var s = S(), autoplayOn = s.libraryEnabled && s.libraryAutoplay;
    if (state.ambientAudio) state.ambientAudio.loop = s.ambientLoop && !autoplayOn;
    if (state.musicAudio) state.musicAudio.loop = s.musicLoop && !autoplayOn;
}

/* ============ GALLERY ============ */
function addToGallery(type, prompt, url, params) { state.generatedTracks.push({ type: type, prompt: prompt, url: url, params: params || null, time: new Date().toLocaleTimeString() }); updateGalleryBadge(); }
function updateGalleryBadge() { var n = state.generatedTracks.length; $('#am_gal_badge').text(n || ''); n > 0 ? $('#am_gal_badge').show() : $('#am_gal_badge').hide(); }
function openGallery() {
    var tracks = state.generatedTracks, html = '';
    if (!tracks.length) html = '<div style="text-align:center;padding:30px;color:#888">No tracks this session.</div>';
    else for (var i = tracks.length - 1; i >= 0; i--) {
        var t = tracks[i], paramsStr = '';
        if (t.params) { var p = []; if (t.params.bpm) p.push(t.params.bpm + ' BPM'); if (t.params.keyscale) p.push(t.params.keyscale); paramsStr = p.length ? '<span class="am-gal-params">' + esc(p.join(' · ')) + '</span>' : ''; }
        html += '<div class="am-gal-item"><div class="am-gal-info"><span class="am-gal-type">' + (t.type === 'ambient' ? '🔊' : '🎵') + '</span>' +
            '<div class="am-gal-text"><span class="am-gal-prompt" title="' + esc(t.prompt) + '">' + esc(t.prompt) + '</span>' + paramsStr + '</div>' +
            '<span class="am-gal-time">' + esc(t.time) + '</span></div><div class="am-gal-actions">' +
            '<button class="am-btn-sm am-gal-play" data-idx="' + i + '" title="Play">▶</button>' +
            '<button class="am-btn-sm am-gal-fav" data-idx="' + i + '" title="Add to player">★</button>' +
            '<a class="am-btn-sm am-gal-dl" href="' + esc(t.url) + '" download="automusic_' + t.type + '_' + i + '.mp3" title="Download">💾</a></div></div>';
    }
    var ov = $('<div id="am_gallery_overlay"><div class="am-gal-header"><span>📋 Session Gallery</span><span class="am-gal-count">' + tracks.length + '</span><span class="am-gal-close">✕</span></div><div class="am-gal-list">' + html + '</div></div>');
    $('body').append(ov); ov.find('.am-gal-close').on('click', function () { ov.remove(); });
    ov.find('.am-gal-play').on('click', function () {
        var idx = parseInt($(this).data('idx')), track = tracks[idx]; if (!track) return;
        playAudio(track.type, track.url);
        if (track.type === 'ambient') { state.currentAmbientPrompt = track.prompt; $('#am_amb_name').text(track.prompt).attr('title', track.prompt); }
        else { state.currentMusicPrompt = track.prompt; $('#am_mus_name').text(track.prompt).attr('title', track.prompt); }
    });
    ov.find('.am-gal-fav').on('click', function () {
        var idx = parseInt($(this).data('idx')), track = tracks[idx]; if (!track) return;
        addToFavorites(track, track.type);
    });
}

/* ============ FAVORITES PLAYER ============ */
// Favorites are a GLOBAL playlist (not chat-keyed): tracks the user pinned from
// the session gallery or the per-chat library. They reuse the same on-server
// files as library tracks, so they persist and are playable from any chat.

function getFavorites() { var s = S(); if (!Array.isArray(s.favorites)) s.favorites = []; return s.favorites; }

// Build a stable signature so the same underlying audio file isn't pinned twice.
function favSig(track) {
    if (!track) return '';
    return (track.path || track.url || '') + '|' + (track.prompt || '');
}
function isFavorite(track) {
    var sig = favSig(track);
    return getFavorites().some(function (f) { return favSig(f) === sig; });
}

// Add a track (from gallery or library) to the global favorites playlist.
// Returns true if added, false if it was already there.
function addToFavorites(track, type) {
    if (!track) return false;
    if (isFavorite(track)) { toastr.info('Already in player', 'AutoMusic'); return false; }
    var entry = {
        id: 'fav_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        prompt: track.prompt || '',
        type: type || track.type || 'music',
        url: track.url || null,
        path: track.path || null,
        params: track.params || null,
        time: track.time || new Date().toISOString(),
    };
    getFavorites().push(entry);
    saveSettingsDebounced();
    updateFavBadge();
    toastr.success('★ Added to player', 'AutoMusic');
    return true;
}
function removeFromFavorites(id) {
    var favs = getFavorites();
    for (var i = 0; i < favs.length; i++) {
        if (favs[i].id === id) {
            var ch = favChannel(favs[i].type);
            // If we're removing the track currently loaded in its channel, stop it.
            if (i === state.fav[ch].index) stopFavoriteChannel(ch);
            favs.splice(i, 1);
            // Fix up indices for the channels (both, since the array is shared).
            ['music', 'ambient'].forEach(function (c) {
                if (state.fav[c].index > i) state.fav[c].index--;
                else if (state.fav[c].index === i) state.fav[c].index = -1;
            });
            break;
        }
    }
    saveSettingsDebounced(); updateFavBadge();
}

/* --- Playback ---
 * The favorites player has two independent channels — 'music' and 'ambient' —
 * so a music track and an ambient track can play AT THE SAME TIME, exactly like
 * the auto-music engine. Each channel owns its own <audio> element and its own
 * position in the shared playlist. These streams are separate from the
 * auto-music channels so they never fight over playback. */
function favChannel(type) { return type === 'ambient' ? 'ambient' : 'music'; }
function favVolumeFor(type) {
    var s = S();
    return type === 'ambient'
        ? (s.ambientMuted ? 0 : (s.ambientVolume || 0.5))
        : (s.musicMuted ? 0 : (s.musicVolume || 0.3));
}

function stopFavoriteChannel(ch) {
    var c = state.fav[ch];
    if (c.audio) { c.audio._stopping = true; c.audio.pause(); c.audio.removeAttribute('src'); c.audio.load(); }
    c.audio = null;
    syncFavPlayerUI();
}
function stopFavorites() {
    stopFavoriteChannel('music');
    stopFavoriteChannel('ambient');
}

// Play the favorite at `index` in ITS OWN channel (music/ambient), leaving the
// other channel untouched so both can sound together.
function playFavoriteAt(index) {
    var favs = getFavorites();
    if (!favs.length) return;
    if (index < 0) index = favs.length - 1;
    if (index >= favs.length) index = 0;
    var track = favs[index];
    var url = getTrackPlayUrl(track);
    if (!url) { toastr.warning('Track file unavailable', 'AutoMusic'); return; }

    var ch = favChannel(track.type);
    var c = state.fav[ch];

    // Stop only this channel's previous stream (the other channel keeps playing).
    if (c.audio) { c.audio._stopping = true; c.audio.pause(); c.audio.removeAttribute('src'); c.audio.load(); }

    var audio = new Audio(url);
    audio.preload = 'auto';
    audio.loop = !!S().favRepeatOne;   // repeat-one: native loop, 'ended' never fires
    c.audio = audio;
    c.index = index;

    audio.volume = favVolumeFor(track.type);
    audio.play().catch(function () {});
    // A dead source used to fail in silence (the ▶ just did nothing).
    audio.addEventListener('error', function () {
        if (audio._stopping || c.audio !== audio) return;
        c.audio = null; syncFavPlayerUI(); warnUnplayable(track, url);
    });
    // Still a ComfyUI-only link but it loads → ComfyUI is up, take a copy now.
    if (isComfyOnlyTrack(track)) {
        audio.addEventListener('canplay', function () {
            localizeTrack(track).then(function (ok) { if (ok) saveSettingsDebounced(); });
        }, { once: true });
    }

    // When this track ends, auto-advance to the next track OF THE SAME TYPE.
    audio.addEventListener('ended', function () {
        if (audio._stopping) return;
        playNextFavoriteIn(ch);
    });
    audio.addEventListener('pause', function () { if (!audio._stopping) syncFavPlayerUI(); });
    audio.addEventListener('play', function () { syncFavPlayerUI(); });

    syncFavPlayerUI();
}

// Find the next/previous favorite index whose type maps to channel `ch`,
// starting from that channel's current position. Returns -1 if none exist.
function adjacentFavoriteIndex(ch, dir) {
    var favs = getFavorites();
    var matches = [];
    for (var i = 0; i < favs.length; i++) { if (favChannel(favs[i].type) === ch) matches.push(i); }
    if (!matches.length) return -1;
    var curIdx = state.fav[ch].index;
    var pos = matches.indexOf(curIdx);
    if (pos === -1) return dir > 0 ? matches[0] : matches[matches.length - 1];
    var next = (pos + dir + matches.length) % matches.length;
    return matches[next];
}
// Repeat-one toggle: flip the setting and re-apply it to BOTH live channels, so
// a track already playing starts/stops looping without a restart.
function toggleFavRepeatOne() {
    var s = S();
    s.favRepeatOne = !s.favRepeatOne;
    ['music', 'ambient'].forEach(function (c) { if (state.fav[c].audio) state.fav[c].audio.loop = s.favRepeatOne; });
    saveSettingsDebounced();
    syncFavPlayerUI();
}
function syncFavRepeatBtn() {
    var on = !!S().favRepeatOne;
    $('#am_fav_repeat, #am_fav_ovl_repeat, #am_quick_repeat').toggleClass('am-repeat-on', on)
        .attr('aria-pressed', String(on))
        .attr('title', on ? 'Repeat one: ON — the current track loops' : 'Repeat one: OFF — playlist advances');
}
function playNextFavoriteIn(ch) { var idx = adjacentFavoriteIndex(ch, 1); if (idx >= 0) playFavoriteAt(idx); }
function playPrevFavoriteIn(ch) { var idx = adjacentFavoriteIndex(ch, -1); if (idx >= 0) playFavoriteAt(idx); }

// Is anything currently sounding in either channel?
function anyFavPlaying() {
    return ['music', 'ambient'].some(function (c) { return state.fav[c].audio && !state.fav[c].audio.paused; });
}

function toggleFavoriteTrack(index) {
    var track = getFavorites()[index];
    if (!track) return;
    var channel = state.fav[favChannel(track.type)];
    if (channel.index !== index || !channel.audio) {
        playFavoriteAt(index);
    } else if (channel.audio.paused) {
        channel.audio.play().catch(function () {});
    } else {
        channel.audio.pause();
    }
}

function toggleFavoriteChannel(ch) {
    var channel = state.fav[ch];
    toggleFavoriteTrack(channel.index >= 0 ? channel.index : adjacentFavoriteIndex(ch, 1));
}

// Mini-bar play/pause: acts on BOTH channels together. If anything is playing,
// pause everything; otherwise resume/start each channel.
function toggleFavPlayPause() {
    var favs = getFavorites();
    if (!favs.length) { toastr.info('Player is empty — add tracks with ★', 'AutoMusic'); return; }

    if (anyFavPlaying()) {
        ['music', 'ambient'].forEach(function (c) { if (state.fav[c].audio && !state.fav[c].audio.paused) state.fav[c].audio.pause(); });
        return;
    }

    // Nothing playing → resume any paused streams, and for empty channels start
    // the first track of that type if one exists.
    var resumedOrStarted = false;
    ['music', 'ambient'].forEach(function (c) {
        var st = state.fav[c];
        if (st.audio && st.audio.src) { st.audio.play().catch(function () {}); resumedOrStarted = true; }
        else {
            var first = adjacentFavoriteIndex(c, 1);
            // adjacentFavoriteIndex with no current pos returns the first match.
            if (st.index < 0 && first >= 0) { playFavoriteAt(first); resumedOrStarted = true; }
            else if (st.index >= 0) { playFavoriteAt(st.index); resumedOrStarted = true; }
        }
    });
    if (!resumedOrStarted) playFavoriteAt(0);
}

// Mini-bar prev/next: advance whichever channels actually have tracks. With both
// a music and an ambient track present, this steps both playlists in parallel.
function playNextFavorite() {
    var advanced = false;
    ['music', 'ambient'].forEach(function (c) { if (adjacentFavoriteIndex(c, 1) >= 0 && (state.fav[c].audio || state.fav[c].index >= 0)) { playNextFavoriteIn(c); advanced = true; } });
    if (!advanced) { var idx = adjacentFavoriteIndex('music', 1); if (idx < 0) idx = adjacentFavoriteIndex('ambient', 1); if (idx >= 0) playFavoriteAt(idx); }
}
function playPrevFavorite() {
    var moved = false;
    ['music', 'ambient'].forEach(function (c) { if (adjacentFavoriteIndex(c, -1) >= 0 && (state.fav[c].audio || state.fav[c].index >= 0)) { playPrevFavoriteIn(c); moved = true; } });
    if (!moved) { var idx = adjacentFavoriteIndex('music', -1); if (idx < 0) idx = adjacentFavoriteIndex('ambient', -1); if (idx >= 0) playFavoriteAt(idx); }
}

// --- Player UI sync ---
function updateFavBadge() {
    var n = getFavorites().length;
    $('#am_fav_count').text(n || '0');
    $('#am_fav_badge').text(n || '');
    n > 0 ? $('#am_fav_badge').show() : $('#am_fav_badge').hide();
    renderQuickPlayerQueue();
    syncFavPlayerUI();
}
function favChannelLabel(ch) {
    var favs = getFavorites(), st = state.fav[ch];
    if (st.audio && favs[st.index]) return (ch === 'ambient' ? '🔊 ' : '🎵 ') + favs[st.index].prompt;
    return '';
}
function syncFavPlayerUI() {
    var favs = getFavorites();
    var playing = anyFavPlaying();
    $('#am_fav_playpause').html(playing ? '⏸' : '▶');
    var parts = [];
    var mus = favChannelLabel('music'); if (mus) parts.push(mus);
    var amb = favChannelLabel('ambient'); if (amb) parts.push(amb);
    var label = parts.length ? parts.join('  +  ') : (favs.length ? 'Ready — ' + favs.length + ' track(s)' : 'Player empty');
    $('#am_fav_now, #am_quick_now').text(label).attr('title', label);
    syncQuickPlayerPlayback(favs);
    syncFavRepeatBtn();
    if ($('#am_favplayer_overlay').length) renderFavOverlayList();
}

// --- Quick Player Widget HUD ---
function buildQuickPlayerHUD() {
    return `
        <aside id="am_quick_hud" aria-label="AutoMusic quick player" hidden>
            <div class="am-quick-head">
                <button id="am_quick_drag" type="button" class="am-btn-sm" aria-label="Drag player to move it" title="Drag player to move it">
                    <i class="fa-solid fa-grip" aria-hidden="true"></i>
                </button>
                <div class="am-quick-caption">
                    <span class="am-quick-label">AutoMusic</span>
                    <span id="am_quick_now" role="status">Player empty</span>
                </div>
                <button id="am_quick_toggle" type="button" class="am-btn-sm" aria-expanded="false" aria-controls="am_quick_panel am_quick_queue" aria-label="Show player controls" title="Show player controls">
                    <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
                </button>
            </div>
            <div class="am-quick-playback">
                <button id="am_quick_music" type="button" class="am-btn-sm am-quick-primary">
                    <i class="fa-solid fa-play" aria-hidden="true"></i> Music
                </button>
                <button id="am_quick_ambient" type="button" class="am-btn-sm am-quick-primary">
                    <i class="fa-solid fa-play" aria-hidden="true"></i> Ambient
                </button>
            </div>
            <div id="am_quick_panel" hidden>
                <button id="am_quick_prev" type="button" class="am-btn-sm" aria-label="Previous favorite" title="Previous favorite">
                    <i class="fa-solid fa-backward-step" aria-hidden="true"></i>
                </button>
                <button id="am_quick_next" type="button" class="am-btn-sm" aria-label="Next favorite" title="Next favorite">
                    <i class="fa-solid fa-forward-step" aria-hidden="true"></i>
                </button>
                <button id="am_quick_repeat" type="button" class="am-btn-sm" aria-label="Repeat one" aria-pressed="false" title="Repeat one">
                    <i class="fa-solid fa-repeat" aria-hidden="true"></i>
                </button>
                <button id="am_quick_playlist" type="button" class="am-btn-sm" aria-expanded="false" aria-controls="am_quick_queue" title="Show inline playlist">
                    <i class="fa-solid fa-list-ul" aria-hidden="true"></i> Playlist
                </button>
                <button id="am_quick_playlist_full" type="button" class="am-btn-sm" aria-label="Open full-screen playlist" title="Open full-screen playlist">
                    <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
                </button>
            </div>
            <div id="am_quick_queue" hidden>
                <ul id="am_quick_queue_list" aria-label="Favorites playlist" role="list"></ul>
                <p id="am_quick_queue_empty" hidden>No favorites yet. Add tracks with ★ in the library or gallery.</p>
            </div>
        </aside>`;
}

function renderQuickPlayerQueue() {
    var favs = getFavorites();
    var rows = favs.map(function (track, index) {
        var ambient = favChannel(track.type) === 'ambient';
        var icon = ambient ? 'fa-volume-high' : 'fa-music';
        var type = ambient ? 'Ambient' : 'Music';
        var name = track.prompt || type + ' ' + (index + 1);
        return `<li class="am-quick-queue-item">
            <button type="button" class="am-quick-queue-track" data-index="${index}" aria-pressed="false">
                <i class="fa-solid ${icon}" role="img" aria-label="${type}"></i>
                <span class="am-quick-track-name">${esc(name)}</span>
                <i class="fa-solid fa-play am-quick-track-action" aria-hidden="true"></i>
            </button>
        </li>`;
    });
    $('#am_quick_queue_list').html(rows.join('')).prop('hidden', !favs.length);
    $('#am_quick_queue_empty').prop('hidden', !!favs.length);
}

function syncQuickPlayerPlayback(favs) {
    $('#am_quick_prev, #am_quick_next').prop('disabled', !favs.length);
    var list = document.getElementById('am_quick_queue_list');
    if (!list) return;
    $(list).find('.am-quick-current').removeClass('am-quick-current').attr('aria-pressed', 'false').find('.am-quick-track-action')
        .removeClass('fa-pause').addClass('fa-play');
    ['music', 'ambient'].forEach(function (ch) {
        var current = state.fav[ch];
        var audible = current.audio && !current.audio.paused;
        var action = (audible ? 'Pause ' : 'Play ') + ch;
        var available = favs.some(function (track) { return favChannel(track.type) === ch; });
        $('#am_quick_' + ch).attr({ 'aria-label': action, title: action }).prop('disabled', !available)
            .find('i').toggleClass('fa-play', !audible).toggleClass('fa-pause', !!audible);
        var row = current.audio && list.children[current.index];
        if (row) {
            $(row.firstElementChild).addClass('am-quick-current').attr('aria-pressed', String(!!audible)).find('.am-quick-track-action')
                .toggleClass('fa-play', !audible).toggleClass('fa-pause', !!audible);
        }
    });
}

function setQuickPlayerFloating(hud, floating) {
    var anchor = document.getElementById('am_quick_anchor');
    var parent = floating ? document.body : anchor;
    if (hud.parentElement !== parent) parent.append(hud);
    anchor.hidden = floating || hud.hidden;
    hud.classList.toggle('am-quick-floating', floating);
    var label = floating ? 'Drag player to move it or click here to dock it' : 'Drag player to move it';
    $('#am_quick_drag').attr({ 'aria-label': label, title: label });
    if (!floating) {
        hud.style.removeProperty('left');
        hud.style.removeProperty('top');
    }
}

function placeQuickPlayerHUD(hud, x, y) {
    var viewport = window.visualViewport;
    var width = viewport?.width ?? document.documentElement.clientWidth;
    var height = viewport?.height ?? document.documentElement.clientHeight;
    var inset = 6;
    var minX = (viewport?.offsetLeft ?? 0) + inset;
    var minY = (viewport?.offsetTop ?? 0) + inset;
    hud.style.setProperty('--am-quick-viewport-width', width + 'px');
    hud.style.setProperty('--am-quick-viewport-height', height + 'px');
    x = Math.max(minX, Math.min(x, minX + width - hud.offsetWidth - 2 * inset));
    y = Math.max(minY, Math.min(y, minY + height - hud.offsetHeight - 2 * inset));
    hud.style.left = x + 'px';
    hud.style.top = y + 'px';
    return { x: x, y: y };
}

function syncQuickPlayerHUD() {
    var s = S(), expanded = !!s.quickPlayerExpanded;
    var hud = document.getElementById('am_quick_hud');
    if (!hud) return;
    var chat = document.getElementById('chat');
    // Keep the most recent message in view when the dock changes the chat's height.
    var atBottom = chat && chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 2;
    hud.hidden = !s.quickPlayerEnabled;
    $('#am_quick_panel').prop('hidden', !expanded);
    var action = expanded ? 'Hide player controls' : 'Show player controls';
    $('#am_quick_toggle').attr({ 'aria-expanded': String(expanded), 'aria-label': action, title: action });
    var queueOpen = expanded && state.quickQueueOpen;
    $('#am_quick_queue').prop('hidden', !queueOpen);
    $('#am_quick_playlist').attr({ 'aria-expanded': String(queueOpen), title: queueOpen ? 'Hide inline playlist' : 'Show inline playlist' });
    var saved = s.quickPlayerPosition;
    var floating = Number.isFinite(saved?.x) && Number.isFinite(saved?.y);
    setQuickPlayerFloating(hud, floating);
    if (floating && !hud.hidden) placeQuickPlayerHUD(hud, saved.x, saved.y);
    if (atBottom) chat.scrollTop = chat.scrollHeight;
}

function bindQuickPlayerHUD() {
    var hud = document.getElementById('am_quick_hud');
    if (!hud) return;
    var handle = document.getElementById('am_quick_drag');
    var drag = null;
    var moved = false;

    handle.addEventListener('pointerdown', function (event) {
        if (drag || !event.isPrimary || event.button !== 0) return;
        var rect = hud.getBoundingClientRect();
        moved = false;
        drag = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            position: null,
        };
    });
    window.addEventListener('pointermove', function (event) {
        if (!drag || drag.id !== event.pointerId) return;
        if (!moved) {
            if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
            moved = true;
            setQuickPlayerFloating(hud, true);
            hud.classList.add('am-quick-dragging');
            // Capture after reparenting the HUD so the handle keeps receiving pointer events.
            handle.setPointerCapture(event.pointerId);
        }
        drag.position = placeQuickPlayerHUD(hud, event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });
    var finishDrag = function (event) {
        if (!drag || (event.type !== 'blur' && drag.id !== event.pointerId)) return;
        var position = drag.position;
        drag = null;
        hud.classList.remove('am-quick-dragging');
        if (position) {
            S().quickPlayerPosition = position;
            saveSettingsDebounced();
        }
    };
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    window.addEventListener('blur', finishDrag);
    handle.addEventListener('click', function (event) {
        if ((moved && event.detail) || !S().quickPlayerPosition) return;
        S().quickPlayerPosition = null;
        syncQuickPlayerHUD();
        handle.focus({ preventScroll: true });
        saveSettingsDebounced();
    });

    var fitViewport = function () {
        var pos = drag?.position || S().quickPlayerPosition;
        if (pos && !hud.hidden && hud.classList.contains('am-quick-floating')) {
            placeQuickPlayerHUD(hud, pos.x, pos.y);
        }
    };
    window.addEventListener('resize', fitViewport);
    window.visualViewport?.addEventListener('resize', fitViewport);
    window.visualViewport?.addEventListener('scroll', fitViewport);
    // A favorites edit can change the floating HUD's height with the playlist open.
    new ResizeObserver(fitViewport).observe(hud);
}

// --- Full-screen favorites overlay (playlist manager) ---
function openFavPlayer() {
    if ($('#am_favplayer_overlay').length) return;
    var opener = document.activeElement;
    var ov = $('<div id="am_favplayer_overlay">' +
        '<div class="am-gal-header"><span>⭐ Player</span>' +
        '<span class="am-gal-count" id="am_fav_ovl_count">0</span>' +
        '<button type="button" class="am-btn-sm am-gal-close" aria-label="Close player playlist">✕</button></div>' +
        '<div class="am-fav-controls">' +
            '<button class="am-btn-sm" id="am_fav_ovl_prev" title="Previous">⏮</button>' +
            '<button class="am-btn-sm" id="am_fav_ovl_playpause" title="Play / Pause">▶</button>' +
            '<button class="am-btn-sm" id="am_fav_ovl_next" title="Next">⏭</button>' +
            '<button class="am-btn-sm" id="am_fav_ovl_stop" title="Stop all">⏹</button>' +
            '<button class="am-btn-sm" id="am_fav_ovl_repeat" title="Repeat one">🔂</button>' +
            '<span class="am-fav-ovl-now" id="am_fav_ovl_now">Player empty</span>' +
        '</div>' +
        '<div class="am-fav-hint">🎵 Music and 🔊 ambient play on separate channels — start one of each to layer them.</div>' +
        '<div class="am-gal-list" id="am_fav_ovl_list"></div></div>');
    $('body').append(ov);

    var close = function () { ov.remove(); opener?.focus(); };
    ov.find('.am-gal-close').on('click', close).trigger('focus');
    ov.on('keydown', function (event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    });
    ov.find('#am_fav_ovl_prev').on('click', playPrevFavorite);
    ov.find('#am_fav_ovl_next').on('click', playNextFavorite);
    ov.find('#am_fav_ovl_stop').on('click', stopFavorites);
    ov.find('#am_fav_ovl_playpause').on('click', toggleFavPlayPause);
    ov.find('#am_fav_ovl_repeat').on('click', toggleFavRepeatOne);

    renderFavOverlayList();
}
function renderFavOverlayList() {
    var $list = $('#am_fav_ovl_list'); if (!$list.length) return;
    var favs = getFavorites();
    $('#am_fav_ovl_count').text(favs.length);

    $('#am_fav_ovl_playpause').html(anyFavPlaying() ? '⏸' : '▶');
    var parts = [];
    var mus = favChannelLabel('music'); if (mus) parts.push(mus);
    var amb = favChannelLabel('ambient'); if (amb) parts.push(amb);
    syncFavRepeatBtn();
    $('#am_fav_ovl_now').text(parts.length ? parts.join('  +  ') : (favs.length ? favs.length + ' track(s)' : 'Player empty'));

    if (!favs.length) { $list.html('<div class="am-lib-empty">No tracks yet. Use the ★ button in the gallery or library to add tracks here.</div>'); return; }

    var html = '';
    for (var i = 0; i < favs.length; i++) {
        var t = favs[i], pStr = '';
        if (t.params) { var pp = []; if (t.params.bpm) pp.push(t.params.bpm + ' BPM'); if (t.params.keyscale) pp.push(t.params.keyscale); pStr = pp.length ? '<span class="am-gal-params">' + esc(pp.join(' · ')) + '</span>' : ''; }
        var ch = favChannel(t.type);
        var isCur = (i === state.fav[ch].index);
        var chPlaying = isCur && state.fav[ch].audio && !state.fav[ch].audio.paused;
        html += '<div class="am-lib-item' + (isCur ? ' am-fav-current' : '') + '">' +
            '<div class="am-gal-info"><span class="am-gal-type">' + (t.type === 'ambient' ? '🔊' : '🎵') + '</span>' +
            '<div class="am-gal-text"><span class="am-gal-prompt">' + esc(t.prompt) + '</span>' + pStr + '</div></div>' +
            '<div class="am-gal-actions">' +
            '<button class="am-btn-sm am-fav-ovl-play" data-idx="' + i + '" title="Play">' + (chPlaying ? '⏸' : '▶') + '</button>' +
            (t.url || t.path ? '<a class="am-btn-sm am-gal-dl" href="' + esc(getTrackPlayUrl(t) || '') + '" download title="Download">💾</a>' : '') +
            '<button class="am-btn-sm am-fav-ovl-del" data-id="' + esc(t.id) + '" title="Remove" style="color:#ef4444">✕</button>' +
            '</div></div>';
    }
    $list.html(html);

    $list.find('.am-fav-ovl-play').off('click').on('click', function () {
        var idx = parseInt($(this).data('idx'));
        var tr = favs[idx]; if (!tr) return;
        var ch = favChannel(tr.type), c = state.fav[ch];
        // Clicking the track currently playing in its channel pauses just that channel.
        if (idx === c.index && c.audio && !c.audio.paused) { c.audio.pause(); }
        else playFavoriteAt(idx);
    });
    $list.find('.am-fav-ovl-del').off('click').on('click', function () {
        var id = $(this).data('id');
        removeFromFavorites(id);
    });
}

/* ============ LIBRARY UI ============ */
function openLibrary() {
    var s = S(), ambList = getChatTracks('ambient'), musList = getChatTracks('music');
    var chatKey = getChatKey(), store = getChatStore(), chatName = store.name || chatKey;

    var html = '<div class="am-lib-chat-label">📌 ' + esc(chatName) + '</div>';
    html += '<div class="am-lib-tabs"><button class="am-lib-tab am-lib-tab-active" data-tab="music">🎵 Music (' + musList.length + ')</button>' +
        '<button class="am-lib-tab" data-tab="ambient">🔊 Ambient (' + ambList.length + ')</button>' +
        '<button class="am-lib-tab" data-tab="all">📁 All Chats</button></div>';
    html += '<div class="am-lib-controls"><label class="checkbox_label"><input id="am_lib_shuffle_dlg" type="checkbox" ' + (s.libraryShuffle ? 'checked' : '') + '/><span>Shuffle</span></label>' +
        '<label class="checkbox_label"><input id="am_lib_autoplay_dlg" type="checkbox" ' + (s.libraryAutoplay ? 'checked' : '') + '/><span>Auto-play next</span></label></div>';

    html += '<div class="am-lib-section" data-section="music">';
    if (!musList.length) html += '<div class="am-lib-empty">No music tracks.</div>';
    else for (var i = musList.length - 1; i >= 0; i--) {
        var t = musList[i], pStr = '';
        if (t.params) { var pp = []; if (t.params.bpm) pp.push(t.params.bpm + ' BPM'); if (t.params.keyscale) pp.push(t.params.keyscale); pStr = pp.length ? '<span class="am-gal-params">' + esc(pp.join(' · ')) + '</span>' : ''; }
        html += '<div class="am-lib-item"><div class="am-gal-info"><span class="am-gal-type">🎵</span><div class="am-gal-text"><span class="am-gal-prompt">' + esc(t.prompt) + '</span>' + pStr + '</div><span class="am-gal-time">' + esc(new Date(t.time).toLocaleDateString()) + '</span></div>' +
            '<div class="am-gal-actions"><button class="am-btn-sm am-lib-play" data-type="music" data-idx="' + i + '">▶</button><button class="am-btn-sm am-lib-fav" data-type="music" data-idx="' + i + '" title="Add to player">★</button><a class="am-btn-sm am-gal-dl" href="' + esc(t.url || '') + '" download>💾</a><button class="am-btn-sm am-lib-del" data-type="music" data-id="' + esc(t.id) + '" style="color:#ef4444">✕</button></div></div>';
    }
    html += '</div><div class="am-lib-section" data-section="ambient" style="display:none">';
    if (!ambList.length) html += '<div class="am-lib-empty">No ambient tracks.</div>';
    else for (var j = ambList.length - 1; j >= 0; j--) {
        var a = ambList[j];
        html += '<div class="am-lib-item"><div class="am-gal-info"><span class="am-gal-type">🔊</span><div class="am-gal-text"><span class="am-gal-prompt">' + esc(a.prompt) + '</span></div><span class="am-gal-time">' + esc(new Date(a.time).toLocaleDateString()) + '</span></div>' +
            '<div class="am-gal-actions"><button class="am-btn-sm am-lib-play" data-type="ambient" data-idx="' + j + '">▶</button><button class="am-btn-sm am-lib-fav" data-type="ambient" data-idx="' + j + '" title="Add to player">★</button><a class="am-btn-sm am-gal-dl" href="' + esc(a.url || '') + '" download>💾</a><button class="am-btn-sm am-lib-del" data-type="ambient" data-id="' + esc(a.id) + '" style="color:#ef4444">✕</button></div></div>';
    }
    html += '</div><div class="am-lib-section" data-section="all" style="display:none">';

    var allKeys = Object.keys(s.savedTracks || {}), globalTotal = 0;
    for (var gi = 0; gi < allKeys.length; gi++) { var gst = s.savedTracks[allKeys[gi]]; globalTotal += (gst.ambient || []).length + (gst.music || []).length; }
    if (globalTotal > 0) html += '<button class="am-lib-delete-all-btn" id="am_lib_delete_all">🗑 Delete All Tracks (' + globalTotal + ')</button>';
    if (!allKeys.length) html += '<div class="am-lib-empty">No saved tracks.</div>';
    else {
        for (var ki = 0; ki < allKeys.length; ki++) {
            var k = allKeys[ki], st = s.savedTracks[k], ambN = (st.ambient || []).length, musN = (st.music || []).length;
            if (!ambN && !musN) continue;
            var isCurrent = k === chatKey;
            html += '<div class="am-lib-chat-item' + (isCurrent ? ' am-lib-current' : '') + '"><div class="am-lib-chat-info"><span class="am-lib-chat-name">' + (isCurrent ? '📌 ' : '') + esc(st.name || k) + '</span>' +
                '<span class="am-lib-chat-stats">🎵 ' + musN + ' · 🔊 ' + ambN + '</span></div><button class="am-btn-sm am-lib-clear-chat" data-key="' + esc(k) + '" style="color:#ef4444;font-size:11px">🗑</button></div>';
        }
    }
    html += '</div>';

    var ov = $('<div id="am_library_overlay"><div class="am-gal-header"><span>📚 Audio Library</span><span class="am-gal-count">' + (ambList.length + musList.length) + '</span><span class="am-gal-close">✕</span></div><div class="am-gal-list">' + html + '</div></div>');
    $('body').append(ov);

    ov.find('.am-lib-tab').on('click', function () {
        var tab = $(this).data('tab'); ov.find('.am-lib-tab').removeClass('am-lib-tab-active'); $(this).addClass('am-lib-tab-active');
        ov.find('.am-lib-section').hide(); ov.find('.am-lib-section[data-section="' + tab + '"]').show();
    });
    ov.find('#am_lib_shuffle_dlg').on('change', function () { s.libraryShuffle = $(this).prop('checked'); saveSettingsDebounced(); });
    ov.find('#am_lib_autoplay_dlg').on('change', function () { s.libraryAutoplay = $(this).prop('checked'); applyLoopFlags(); saveSettingsDebounced(); });
    ov.find('.am-lib-play').on('click', function () {
        var type = $(this).data('type'), idx = parseInt($(this).data('idx')), list = getChatTracks(type), track = list[idx]; if (!track) return;
        playFromLibrary(type, track); toastr.info((type === 'ambient' ? '🔊 ' : '🎵 ') + track.prompt.substring(0, 40), 'Library');
    });
    ov.find('.am-lib-fav').on('click', function () {
        var type = $(this).data('type'), idx = parseInt($(this).data('idx')), list = getChatTracks(type), track = list[idx]; if (!track) return;
        addToFavorites(track, type);
    });
    ov.find('.am-lib-del').on('click', function () { var type = $(this).data('type'), id = $(this).data('id'); $(this).closest('.am-lib-item').fadeOut(200, function () { $(this).remove(); }); removeFromLibrary(type, id); });
    ov.find('.am-lib-clear-chat').on('click', function () {
        var key = $(this).data('key'); if (!confirm('Delete all tracks for this chat?')) return;
        var chatStore = s.savedTracks[key]; if (chatStore) deleteTrackFiles((chatStore.ambient || []).concat(chatStore.music || []));
        delete s.savedTracks[key]; saveSettingsDebounced(); $(this).closest('.am-lib-chat-item').fadeOut(200, function () { $(this).remove(); }); updateLibraryUI();
    });
    ov.find('#am_lib_delete_all').on('click', function () {
        if (!confirm('⚠️ DELETE ALL TRACKS?')) return;
        var count = deleteAllTracksFromLibrary(); toastr.warning('Deleted ' + count + ' tracks', 'AutoMusic'); ov.remove(); openLibrary();
    });
    ov.find('.am-gal-close').on('click', function () { ov.remove(); });
}
function updateLibraryUI() { $('#am_lib_count').text(getChatTracks('ambient').length + getChatTracks('music').length); }

/* ============ PIPELINE ============ */
async function processSceneChange(forceGenerate) {
    var s = S();
    if (!s.enabled || state.generating) return;
    var now = Date.now(); if (!forceGenerate && now - state.lastGenerateTime < (s.cooldownSeconds || 60) * 1000) return;
    var text = getRecentText(s.contextMessages || 5); if (!text || text.trim().length < 20) return;
    var ambLocked = s.ambientLocked || !s.ambientEnabled, musLocked = s.musicLocked || !s.musicEnabled;
    if (ambLocked && musLocked) return;

    state.generating = true; updateStatus('analyzing');
    // Pin the chat this generation belongs to. Analysis + ComfyUI take minutes;
    // if the user switches chats (or returns to the start screen) meanwhile,
    // the finished track must be saved under THIS chat's library and must NOT
    // start playing over whatever chat is open by then.
    var chatKey = getChatKey();
    try {
        var analysis;
        try { analysis = await analyseAudio(text); } catch (e) { console.error(L, 'analyseAudio error:', e); }
        if (!analysis) { updateStatus(state.ambientPlaying || state.musicPlaying ? 'playing' : 'idle'); return; }

        var ambChanged = !ambLocked && analysis.ambient && analysis.ambient.changed && analysis.ambient.prompt;
        var musChanged = !musLocked && analysis.music && analysis.music.changed && analysis.music.prompt;

        // Only burn the cooldown if something will actually be generated
        if (ambChanged || musChanged) state.lastGenerateTime = now;

        if (ambChanged) {
            updateStatus('gen-ambient');
            try {
                var ambUrl = await generateAudioQueued('ambient', analysis.ambient.prompt, null);
                if (ambUrl) {
                    addToGallery('ambient', analysis.ambient.prompt, ambUrl, null);
                    if (s.libraryEnabled) addTrackToLibrary('ambient', analysis.ambient.prompt, ambUrl, null, chatKey);
                    if (getChatKey() === chatKey) {
                        state.currentAmbientPrompt = analysis.ambient.prompt; playAudio('ambient', ambUrl);
                        $('#am_amb_name').text(analysis.ambient.prompt).attr('title', analysis.ambient.prompt);
                        toastr.info('🔊 ' + analysis.ambient.prompt.substring(0, 50), 'AutoMusic', { timeOut: 4000 });
                    }
                }
            } catch (e) { console.error(L, 'Ambient gen error:', e); }
        }

        if (musChanged) {
            updateStatus('gen-music');
            var musicParams = { bpm: randInt(80, 160), keyscale: randPick(KEYSCALES), timesignature: randPick(TIME_SIGS), lyrics: analysis.music.lyrics || '' };
            if (s.llmMusicParams && analysis.music) {
                if (analysis.music.bpm) musicParams.bpm = analysis.music.bpm;
                if (analysis.music.keyscale) musicParams.keyscale = analysis.music.keyscale;
                if (analysis.music.timesignature) musicParams.timesignature = String(analysis.music.timesignature);
                if (analysis.music.lyrics) musicParams.lyrics = analysis.music.lyrics;
            }
            try {
                var musUrl = await generateAudioQueued('music', analysis.music.prompt, musicParams);
                if (musUrl) {
                    addToGallery('music', analysis.music.prompt, musUrl, musicParams);
                    if (s.libraryEnabled) addTrackToLibrary('music', analysis.music.prompt, musUrl, musicParams, chatKey);
                    if (getChatKey() === chatKey) {
                        state.currentMusicPrompt = analysis.music.prompt; playAudio('music', musUrl);
                        var infoText = analysis.music.prompt + ' [' + musicParams.bpm + ' BPM, ' + musicParams.keyscale + ']';
                        $('#am_mus_name').text(infoText).attr('title', infoText);
                        toastr.info('🎵 ' + infoText.substring(0, 60), 'AutoMusic', { timeOut: 4000 });
                    }
                }
            } catch (e) { console.error(L, 'Music gen error:', e); }
        }
    } finally {
        // Always release the lock — even if an unexpected error occurred
        state.generating = false;
        updateStatus(state.ambientPlaying || state.musicPlaying ? 'playing' : 'idle');
    }
}

/* ============ STATUS / UI SYNC ============ */
function updateStatus(st) {
    var dot = $('#am_status_dot'), txt = $('#am_status_text'); dot.removeClass('am-gen am-play');
    if (st === 'analyzing') { dot.addClass('am-gen'); txt.text('Analyzing…'); }
    else if (st === 'gen-ambient') { dot.addClass('am-gen'); txt.text('Generating ambient…'); }
    else if (st === 'gen-music') { dot.addClass('am-gen'); txt.text('Generating music…'); }
    else if (st === 'playing') { dot.addClass('am-play'); txt.text('Playing'); }
    else { txt.text('Idle'); }
}
function syncPlayerUI() {
    var s = S();
    $('#am_mute_mus').html(s.musicMuted ? '🔇' : '🎵').toggleClass('am-muted', s.musicMuted);
    $('#am_mute_amb').html(s.ambientMuted ? '🔇' : '🔊').toggleClass('am-muted', s.ambientMuted);
    $('#am_lock_amb').html(s.ambientLocked ? '🔒' : '🔓').toggleClass('am-locked', s.ambientLocked);
    $('#am_lock_mus').html(s.musicLocked ? '🔒' : '🔓').toggleClass('am-locked', s.musicLocked);
    $('#am_vol_amb').val(s.ambientVolume); $('#am_vol_mus').val(s.musicVolume);
}
function updatePresetsUI() {
    var s = S(), sel = $('#am_mus_preset_sel'), curVal = sel.val();
    sel.empty().append('<option value="">-- Select --</option>');
    if (s.musicPresets) Object.keys(s.musicPresets).forEach(function(k) { sel.append('<option value="' + esc(k) + '">' + esc(k) + '</option>'); });
    if (curVal && s.musicPresets && s.musicPresets[curVal]) sel.val(curVal);
}

// Push the active engine's saved duration/steps/cfg into the input boxes.
function loadEngineParamsToUI(channel) {
    var p = getEngineParams(channel);
    if (channel === 'ambient') {
        $('#am_amb_dur').val(p.duration); $('#am_amb_steps').val(p.steps); $('#am_amb_cfg').val(p.cfg);
    } else {
        $('#am_mus_dur').val(p.duration); $('#am_mus_steps').val(p.steps); $('#am_mus_cfg').val(p.cfg);
    }
    syncFlatParams(channel);
}

// Show/hide engine-specific controls and update the channel labels in the player.
function syncEngineUI() {
    var s = S();
    var ambEng = s.ambientEngine || 'stable_audio';
    var musEng = s.musicEngine || 'ace_step';

    // Player section labels reflect the chosen engine.
    $('#am_amb_engine_lbl').text('(' + (ENGINES[ambEng] ? ENGINES[ambEng].label : ambEng) + ')');
    $('#am_mus_engine_lbl').text('(' + (ENGINES[musEng] ? ENGINES[musEng].label : musEng) + ')');

    // Ambient: SA3 workflow box only relevant when SA3 is the ambient engine;
    // the classic Stable Audio Open box otherwise.
    $('#am_amb_sa3_wf').toggle(ambEng === 'stable_audio_3');
    $('#am_amb_wf').toggle(ambEng !== 'stable_audio_3');

    // Music: swap between ACE Step controls and SA3 controls.
    var musIsSa3 = (musEng === 'stable_audio_3');
    $('#am_mus_ace_block').toggle(musEng === 'ace_step');
    $('#am_mus_sa3_block').toggle(musIsSa3);
    $('#am_mus_sa3_wf').toggle(musIsSa3);
    $('#am_mus_wf').toggle(musEng === 'ace_step');
}

/* ============ SETTINGS HTML ============ */
function buildUI() {
    return '<div id="auto_music_settings"><div class="inline-drawer">' +
        '<div class="inline-drawer-toggle inline-drawer-header"><b>🎵 AutoMusic</b>' +
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>' +
        '<div class="inline-drawer-content">' +

        '<label class="checkbox_label"><input id="am_on" type="checkbox"/><span>Enabled</span></label>' +
        '<label class="checkbox_label"><input id="am_ambient_on" type="checkbox"/><span>Ambient sounds</span></label>' +
        '<label class="checkbox_label"><input id="am_music_on" type="checkbox"/><span>Background music</span></label>' +
        '<label class="checkbox_label" title="Generate music when a new chat is created (only the greeting is present). When you re-open an existing chat, the last saved track from the library is resumed instead."><input id="am_gen_start" type="checkbox"/><span>Generate on new chat</span></label>' +
        '<label class="checkbox_label"><input id="am_llm_params" type="checkbox"/><span>LLM picks BPM / key / time sig</span></label>' +
        '<label class="checkbox_label"><input id="am_show_gal" type="checkbox"/><span>Session gallery</span></label>' +
        '<label class="checkbox_label"><input id="am_lib_on" type="checkbox"/><span>Save to library (persistent)</span></label>' +
        '<label class="checkbox_label am-lib-sub"><input id="am_lib_shuffle" type="checkbox"/><span>Library: Shuffle</span></label>' +
        '<label class="checkbox_label am-lib-sub"><input id="am_lib_autoplay" type="checkbox"/><span>Library: Auto-play next on end</span></label>' +
        '<label class="checkbox_label am-lib-sub"><input id="am_auto_delete" type="checkbox"/><span>Auto-delete tracks on chat removal</span></label>' +

        '<div class="am-sg" style="display:flex;align-items:center;gap:8px">' +
        '<label style="font-size:.85em;white-space:nowrap">Analyze every</label>' +
        '<input id="am_every_n" type="number" class="text_pole" min="1" max="50" style="width:50px;font-size:.85em"/>' +
        '<label style="font-size:.85em">message(s)</label></div>' +

        '<div style="display:flex;align-items:center;gap:6px;margin:6px 0">' +
        '<div id="am_status_dot" class="am-dot"></div><span id="am_status_text" style="font-size:.82em;color:#888">Idle</span></div>' +

        '<div class="am-section-label">Music <small id="am_mus_engine_lbl" style="color:#666">(ACE Step)</small></div>' +
        '<div class="am-track-row">' +
        '<button id="am_mute_mus" class="am-btn-sm" title="Mute">🎵</button>' +
        '<input id="am_vol_mus" type="range" class="am-vol" min="0" max="1" step="0.05" value="0.3"/>' +
        '<span id="am_mus_name" class="am-track-name" title="">—</span>' +
        '<button id="am_lock_mus" class="am-btn-sm am-lock-btn" title="Lock">🔓</button></div>' +

        '<div class="am-section-label">Ambient <small id="am_amb_engine_lbl" style="color:#666">(Stable Audio)</small></div>' +
        '<div class="am-track-row">' +
        '<button id="am_mute_amb" class="am-btn-sm" title="Mute">🔊</button>' +
        '<input id="am_vol_amb" type="range" class="am-vol" min="0" max="1" step="0.05" value="0.5"/>' +
        '<span id="am_amb_name" class="am-track-name" title="">—</span>' +
        '<button id="am_lock_amb" class="am-btn-sm am-lock-btn" title="Lock">🔓</button></div>' +

        '<div class="am-section-label">⭐ Player <small style="color:#666">(saved across all chats)</small></div>' +
        '<div class="am-track-row am-fav-bar">' +
        '<button id="am_fav_prev" class="am-btn-sm" title="Previous">⏮</button>' +
        '<button id="am_fav_playpause" class="am-btn-sm" title="Play / Pause">▶</button>' +
        '<button id="am_fav_next" class="am-btn-sm" title="Next">⏭</button>' +
        '<button id="am_fav_repeat" class="am-btn-sm" title="Repeat one">🔂</button>' +
        '<span id="am_fav_now" class="am-track-name" title="">Player empty</span>' +
        '<button id="am_fav_open" class="am-btn-sm" title="Open player playlist">📂<span id="am_fav_badge" style="display:none;background:#6366f1;color:#fff;border-radius:50%;padding:0 4px;font-size:9px;margin-left:1px">0</span></button></div>' +
        '<label class="checkbox_label"><input id="am_quick_enabled" type="checkbox"/><span>Quick Player Widget HUD</span></label>' +

        '<div style="display:flex;gap:4px;margin:8px 0">' +
        '<div id="am_gen_now" class="menu_button" style="flex:1;font-size:.82em">🎵 Generate</div>' +
        '<div id="am_stop_all" class="menu_button" style="flex:1;font-size:.82em">⏹ Stop</div>' +
        '<div id="am_test" class="menu_button" style="flex:1;font-size:.82em;opacity:.7">🧪 Test</div></div>' +

        '<div style="display:flex;gap:4px;margin-bottom:6px">' +
        '<div id="am_open_lib" class="menu_button" style="flex:1;font-size:.82em">📚 Library <span id="am_lib_count" style="opacity:.6">0</span></div>' +
        '<div id="am_open_gal" class="menu_button" style="flex:1;font-size:.82em;display:none" data-gal>📋 Session ' +
        '<span id="am_gal_badge" style="display:none;background:#ef4444;color:#fff;border-radius:50%;padding:0 5px;font-size:10px;margin-left:2px">0</span></div>' +
        '<div id="am_play_lib_amb" class="menu_button" style="font-size:.82em" title="Play next ambient from library">🔊▶</div>' +
        '<div id="am_play_lib_mus" class="menu_button" style="font-size:.82em" title="Play next music from library">🎵▶</div></div>' +

        '<details class="am-details"><summary style="cursor:pointer;font-size:.82em;color:#aaa">⚙️ Advanced Settings</summary>' +

        '<div class="am-sg"><label style="font-size:.8em"><b>🔊 Ambient</b></label>' +
        '<div style="margin-bottom:4px"><label style="font-size:.75em">Engine:</label>' +
        '<select id="am_amb_engine" class="text_pole" style="font-size:.82em">' +
        '<option value="stable_audio">Stable Audio Open 1.0</option>' +
        '<option value="stable_audio_3">Stable Audio 3.0</option>' +
        '<option value="ace_step">ACE Step v1.5</option></select></div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
        '<div style="flex:1"><label style="font-size:.75em">Duration (s):</label><input id="am_amb_dur" type="number" class="text_pole" style="font-size:.82em"/></div>' +
        '<div style="flex:1"><label style="font-size:.75em">Steps:</label><input id="am_amb_steps" type="number" class="text_pole" style="font-size:.82em"/></div>' +
        '<div style="flex:1"><label style="font-size:.75em">CFG:</label><input id="am_amb_cfg" type="number" step="0.5" class="text_pole" style="font-size:.82em"/></div></div>' +
        '<label class="checkbox_label"><input id="am_amb_loop" type="checkbox"/><span style="font-size:.82em">Loop</span></label>' +
        '<textarea id="am_amb_wf" class="text_pole" rows="2" style="font-size:.78em;margin-top:2px" placeholder="Custom Stable Audio Open workflow JSON"></textarea>' +
        '<textarea id="am_amb_sa3_wf" class="text_pole" rows="2" style="font-size:.78em;margin-top:2px" placeholder="Custom Stable Audio 3.0 workflow JSON (uses %sa3_ckpt%)"></textarea></div>' +

        '<div class="am-sg"><label style="font-size:.8em"><b>🎵 Music</b></label>' +
        '<div style="margin-bottom:6px"><label style="font-size:.75em">Engine:</label>' +
        '<select id="am_mus_engine" class="text_pole" style="font-size:.82em">' +
        '<option value="ace_step">ACE Step v1.5</option>' +
        '<option value="stable_audio_3">Stable Audio 3.0</option>' +
        '<option value="stable_audio">Stable Audio Open 1.0</option></select></div>' +
        '<div id="am_mus_ace_block">' +
        '<div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;background:rgba(255,255,255,.03);padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.05);">' +
        '<span style="font-size:.75em;color:#aaa">Presets:</span>' +
        '<select id="am_mus_preset_sel" class="text_pole" style="font-size:.82em;flex:1;padding:2px"><option value="">-- Select --</option></select>' +
        '<div id="am_mus_preset_load" class="menu_button" title="Load preset" style="font-size:.82em;padding:2px 8px;">📂</div>' +
        '<div id="am_mus_preset_save" class="menu_button" title="Save current" style="font-size:.82em;padding:2px 8px;">💾</div>' +
        '<div id="am_mus_preset_del" class="menu_button" title="Delete preset" style="font-size:.82em;padding:2px 8px;color:#ef4444;">🗑</div></div>' +
        '<div style="display:flex;gap:4px;margin-bottom:6px;">' +
        '<div style="flex:1"><label style="font-size:.75em">UNET Model:</label><input id="am_mus_unet" list="am_unet_list" class="text_pole" style="font-size:.82em" placeholder="acestep_...safetensors"/></div>' +
        '<div style="display:flex;align-items:flex-end;"><div id="am_refresh_models" class="menu_button" style="font-size:.82em;padding:5px 8px;" title="Fetch models from ComfyUI">🔄</div></div>' +
        '<datalist id="am_unet_list"></datalist></div></div>' +
        '<div id="am_mus_sa3_block" style="display:none;margin-bottom:6px;">' +
        '<label style="font-size:.75em">SA3 Checkpoint:</label><input id="am_mus_sa3_ckpt" class="text_pole" style="font-size:.82em" placeholder="stable_audio_3_medium.safetensors"/></div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
        '<div style="flex:1"><label style="font-size:.75em">Duration (s):</label><input id="am_mus_dur" type="number" class="text_pole" style="font-size:.82em"/></div>' +
        '<div style="flex:1"><label style="font-size:.75em">Steps:</label><input id="am_mus_steps" type="number" class="text_pole" style="font-size:.82em"/></div>' +
        '<div style="flex:1"><label style="font-size:.75em">CFG:</label><input id="am_mus_cfg" type="number" step="0.5" class="text_pole" style="font-size:.82em"/></div></div>' +
        '<label class="checkbox_label"><input id="am_mus_loop" type="checkbox"/><span style="font-size:.82em">Loop</span></label>' +
        '<textarea id="am_mus_wf" class="text_pole" rows="2" style="font-size:.78em;margin-top:2px" placeholder="Custom ACE Step workflow JSON (must use %unet_name%)"></textarea>' +
        '<textarea id="am_mus_sa3_wf" class="text_pole" rows="2" style="font-size:.78em;margin-top:2px" placeholder="Custom Stable Audio 3.0 workflow JSON (uses %sa3_ckpt%)"></textarea></div>' +

        '<div class="am-sg"><label style="font-size:.8em"><b>⚙️ General</b></label>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
        '<div style="flex:1"><label style="font-size:.75em">Cooldown (s):</label><input id="am_cooldown" type="number" class="text_pole" style="font-size:.82em"/></div>' +
        '<div style="flex:1"><label style="font-size:.75em">Context msgs:</label><input id="am_context" type="number" class="text_pole" style="font-size:.82em"/></div>' +
        '<div style="flex:1"><label style="font-size:.75em">Crossfade (s):</label><input id="am_crossfade" type="number" class="text_pole" style="font-size:.82em"/></div></div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' +
        '<div style="flex:2"><label style="font-size:.75em">ComfyUI URL:</label><input id="am_comfy_url" class="text_pole" placeholder="http://127.0.0.1:8188" style="font-size:.82em"/></div>' +
        '<div style="flex:1"><label style="font-size:.75em">Start delay (s):</label><input id="am_start_delay" type="number" class="text_pole" style="font-size:.82em"/></div></div></div>' +

        '<div class="am-sg"><label style="font-size:.8em"><b>🔌 LLM Connection Profile</b></label>' +
        '<label class="checkbox_label" style="margin-top:2px"><input id="am_use_profile" type="checkbox"/>' +
        '<span style="font-size:.82em">Use a separate Connection Profile for scene analysis</span></label>' +
        '<div style="font-size:.72em;opacity:.7;margin:2px 0 4px">Route AutoMusic\'s LLM analysis through a different (e.g. JSON-friendly) profile, then switch back automatically. Requires the built-in <b>Connection Profiles</b> extension.</div>' +
        '<div id="am_profile_row" style="display:flex;gap:4px;align-items:center">' +
        '<select id="am_profile_sel" class="text_pole" style="flex:1;font-size:.82em"></select>' +
        '<div id="am_profile_refresh" class="menu_button" style="font-size:.82em;padding:2px 8px" title="Refresh profile list">🔄</div></div></div>' +

        '</details>' +
        '</div></div></div>';
}

/* ============ BIND ============ */
function settingsToUI() {
    var s = S();
    $('#am_on').prop('checked', s.enabled);
    $('#am_ambient_on').prop('checked', s.ambientEnabled);
    $('#am_music_on').prop('checked', s.musicEnabled);
    $('#am_gen_start').prop('checked', s.generateOnChatStart);
    $('#am_llm_params').prop('checked', s.llmMusicParams);
    $('#am_show_gal').prop('checked', s.showGallery);
    $('#am_quick_enabled').prop('checked', s.quickPlayerEnabled);
    $('#am_lib_on').prop('checked', s.libraryEnabled);
    $('#am_lib_shuffle').prop('checked', s.libraryShuffle);
    $('#am_lib_autoplay').prop('checked', s.libraryAutoplay);
    $('#am_auto_delete').prop('checked', s.autoDeleteOnChatRemove);
    $('#am_every_n').val(s.checkEveryN || 1);
    $('#am_amb_loop').prop('checked', s.ambientLoop); $('#am_amb_wf').val(s.ambientWorkflow || '');
    $('#am_amb_sa3_wf').val(s.ambientSa3Workflow || '');
    $('#am_mus_loop').prop('checked', s.musicLoop); $('#am_mus_wf').val(s.musicWorkflow || '');
    $('#am_mus_sa3_wf').val(s.musicSa3Workflow || '');
    $('#am_mus_unet').val(s.musicUnetModel || 'acestep_v1.5_xl_sft_bf16.safetensors');
    $('#am_amb_engine').val(s.ambientEngine || 'stable_audio');
    $('#am_mus_engine').val(s.musicEngine || 'ace_step');
    $('#am_mus_sa3_ckpt').val(s.sa3CheckpointModel || 'stable_audio_3_medium.safetensors');
    // duration/steps/cfg are pulled from the active engine's saved params
    loadEngineParamsToUI('ambient'); loadEngineParamsToUI('music');
    $('#am_cooldown').val(s.cooldownSeconds); $('#am_context').val(s.contextMessages);
    $('#am_crossfade').val(s.crossfadeDuration); $('#am_comfy_url').val(s.comfyUrl || '');
    $('#am_start_delay').val(s.startDelay);
    // Connection profile
    $('#am_use_profile').prop('checked', !!s.useConnectionProfile);
    $('#am_profile_row').toggle(!!s.useConnectionProfile);
    populateProfileDropdown();
    $('[data-gal]').toggle(s.showGallery);
    syncPlayerUI(); updateGalleryBadge(); updateLibraryUI(); updatePresetsUI(); syncEngineUI();
    updateFavBadge(); syncQuickPlayerHUD();
}

function bindUI() {
    var s = S();
    $('#am_on').on('change', function () { s.enabled = $(this).prop('checked'); saveSettingsDebounced(); if (!s.enabled) { stopAudio('ambient'); stopAudio('music'); updateStatus('idle'); } });
    $('#am_ambient_on').on('change', function () { s.ambientEnabled = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_music_on').on('change', function () { s.musicEnabled = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_gen_start').on('change', function () { s.generateOnChatStart = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_llm_params').on('change', function () { s.llmMusicParams = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_show_gal').on('change', function () { s.showGallery = $(this).prop('checked'); $('[data-gal]').toggle(s.showGallery); saveSettingsDebounced(); });
    $('#am_lib_on').on('change', function () { s.libraryEnabled = $(this).prop('checked'); applyLoopFlags(); saveSettingsDebounced(); });
    $('#am_lib_shuffle').on('change', function () { s.libraryShuffle = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_lib_autoplay').on('change', function () { s.libraryAutoplay = $(this).prop('checked'); applyLoopFlags(); saveSettingsDebounced(); });
    $('#am_auto_delete').on('change', function () { s.autoDeleteOnChatRemove = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_every_n').on('change', function () { s.checkEveryN = Math.max(1, parseInt($(this).val()) || 1); $(this).val(s.checkEveryN); saveSettingsDebounced(); });
    $('#am_amb_loop').on('change', function () { s.ambientLoop = $(this).prop('checked'); applyLoopFlags(); saveSettingsDebounced(); });
    $('#am_mus_loop').on('change', function () { s.musicLoop = $(this).prop('checked'); applyLoopFlags(); saveSettingsDebounced(); });

    var sn = function (sel, key) { $(sel).on('change', function () { s[key] = parseFloat($(this).val()) || DEFAULTS[key]; saveSettingsDebounced(); }); };
    // duration/steps/cfg are now stored per-engine: write through setEngineParam so
    // each engine remembers its own values across switches.
    var snEng = function (sel, channel, key) {
        $(sel).on('change', function () {
            var def = engineDefaults(channel, channel === 'ambient' ? s.ambientEngine : s.musicEngine)[key];
            var val = parseFloat($(this).val());
            if (isNaN(val)) val = def;
            setEngineParam(channel, key, val);
            saveSettingsDebounced();
        });
    };
    snEng('#am_amb_dur', 'ambient', 'duration'); snEng('#am_amb_steps', 'ambient', 'steps'); snEng('#am_amb_cfg', 'ambient', 'cfg');
    snEng('#am_mus_dur', 'music', 'duration'); snEng('#am_mus_steps', 'music', 'steps'); snEng('#am_mus_cfg', 'music', 'cfg');
    sn('#am_cooldown', 'cooldownSeconds'); sn('#am_context', 'contextMessages'); sn('#am_crossfade', 'crossfadeDuration'); sn('#am_start_delay', 'startDelay');
    $('#am_comfy_url').on('change', function () { s.comfyUrl = $(this).val().trim(); saveSettingsDebounced(); });
    $('#am_amb_wf').on('change', function () { s.ambientWorkflow = $(this).val().trim(); saveSettingsDebounced(); });
    $('#am_mus_wf').on('change', function () { s.musicWorkflow = $(this).val().trim(); saveSettingsDebounced(); });
    $('#am_mus_unet').on('change', function () { s.musicUnetModel = $(this).val().trim(); saveSettingsDebounced(); });
    $('#am_amb_sa3_wf').on('change', function () { s.ambientSa3Workflow = $(this).val().trim(); saveSettingsDebounced(); });
    $('#am_mus_sa3_wf').on('change', function () { s.musicSa3Workflow = $(this).val().trim(); saveSettingsDebounced(); });
    $('#am_mus_sa3_ckpt').on('change', function () { s.sa3CheckpointModel = $(this).val().trim(); saveSettingsDebounced(); });

    // --- Connection Profile controls ---
    $('#am_use_profile').on('change', function () {
        s.useConnectionProfile = $(this).prop('checked');
        $('#am_profile_row').toggle(s.useConnectionProfile);
        saveSettingsDebounced();
    });
    $('#am_profile_sel').on('change', function () {
        s.connectionProfile = $(this).val() || '';
        saveSettingsDebounced();
    });
    $('#am_profile_refresh').on('click', function () {
        populateProfileDropdown();
        if (typeof toastr !== 'undefined') toastr.info('Connection profile list refreshed.', 'AutoMusic');
    });
    // On engine change: switch the active engine, pull that engine's saved params
    // into the flat fields + input boxes, then refresh visibility.
    $('#am_amb_engine').on('change', function () {
        s.ambientEngine = $(this).val(); syncFlatParams('ambient');
        loadEngineParamsToUI('ambient'); saveSettingsDebounced(); syncEngineUI();
    });
    $('#am_mus_engine').on('change', function () {
        s.musicEngine = $(this).val(); syncFlatParams('music');
        loadEngineParamsToUI('music'); saveSettingsDebounced(); syncEngineUI();
    });

    $('#am_refresh_models').on('click', async function () {
        var base = getComfyUrl().replace(/\/+$/, '');
        try {
            var r = await fetch(base + '/object_info');
            if (r.ok) {
                var d = await r.json();
                if (d.UNETLoader && d.UNETLoader.input && d.UNETLoader.input.required && d.UNETLoader.input.required.unet_name) {
                    var models = d.UNETLoader.input.required.unet_name[0] || [];
                    $('#am_unet_list').empty();
                    models.forEach(function(m) { $('#am_unet_list').append('<option value="' + esc(m) + '">'); });
                    toastr.success('Loaded ' + models.length + ' UNET models', 'ComfyUI');
                } else toastr.warning('No UNETLoader info found', 'ComfyUI');
            } else toastr.error(r.statusText, 'ComfyUI');
        } catch (e) { toastr.error(e.message, 'ComfyUI'); }
    });

    $('#am_mus_preset_save').on('click', function () {
        var name = prompt('Enter preset name (saves Model, Duration, Steps, CFG):');
        if (!name) return;
        var mp = getEngineParams('music');
        s.musicPresets[name] = { model: s.musicUnetModel, duration: mp.duration, steps: mp.steps, cfg: mp.cfg };
        saveSettingsDebounced(); updatePresetsUI(); $('#am_mus_preset_sel').val(name);
        toastr.success('Preset saved: ' + name, 'AutoMusic');
    });

    $('#am_mus_preset_load').on('click', function () {
        var name = $('#am_mus_preset_sel').val();
        if (!name || !s.musicPresets || !s.musicPresets[name]) return;
        var p = s.musicPresets[name];
        s.musicUnetModel = p.model || s.musicUnetModel;
        // Write into the music channel's current-engine params so it persists across switches.
        if (p.duration) setEngineParam('music', 'duration', p.duration);
        if (p.steps) setEngineParam('music', 'steps', p.steps);
        if (p.cfg) setEngineParam('music', 'cfg', p.cfg);
        $('#am_mus_unet').val(s.musicUnetModel);
        loadEngineParamsToUI('music');
        saveSettingsDebounced(); toastr.info('Preset loaded: ' + name, 'AutoMusic');
    });

    $('#am_mus_preset_del').on('click', function () {
        var name = $('#am_mus_preset_sel').val();
        if (!name || !s.musicPresets || !s.musicPresets[name]) return;
        if (confirm('Delete preset: ' + name + '?')) {
            delete s.musicPresets[name]; saveSettingsDebounced(); updatePresetsUI();
            toastr.success('Preset deleted', 'AutoMusic');
        }
    });

    $('#am_vol_amb').on('input', function () { setVolume('ambient', parseFloat($(this).val())); });
    $('#am_vol_mus').on('input', function () { setVolume('music', parseFloat($(this).val())); });
    $('#am_mute_amb').on('click', function () { toggleMute('ambient'); });
    $('#am_mute_mus').on('click', function () { toggleMute('music'); });
    $('#am_lock_amb').on('click', function () { toggleLock('ambient'); });
    $('#am_lock_mus').on('click', function () { toggleLock('music'); });

    $('#am_gen_now').on('click', function () {
        if (state.generating) { toastr.warning('Already generating.', 'AutoMusic'); return; }
        state.currentAmbientPrompt = ''; state.currentMusicPrompt = ''; state.lastGenerateTime = 0; processSceneChange(true);
    });
    $('#am_stop_all').on('click', function () {
        stopAudio('ambient'); stopAudio('music'); stopFavorites(); state.currentAmbientPrompt = ''; state.currentMusicPrompt = ''; updateStatus('idle');
    });
    $('#am_test').on('click', async function () {
        var url = getComfyUrl().replace(/\/+$/, '');
        try { var r = await fetch(url + '/queue'); if (r.ok) { var q = await r.json(); toastr.success('Queue: ' + (q.queue_running || []).length + ' running, ' + (q.queue_pending || []).length + ' pending', 'ComfyUI'); } else toastr.warning(r.status, 'ComfyUI'); }
        catch (e) { toastr.error(e.message, 'ComfyUI'); }
    });

    $('#am_open_lib').on('click', openLibrary);
    $('#am_open_gal').on('click', openGallery);
    $('#am_play_lib_amb').on('click', function () { playNextFromLibrary('ambient'); });
    $('#am_play_lib_mus').on('click', function () { playNextFromLibrary('music'); });

    $('#am_fav_open, #am_quick_playlist_full').on('click', openFavPlayer);
    $('#am_fav_playpause').on('click', toggleFavPlayPause);
    $('#am_quick_music').on('click', function () { toggleFavoriteChannel('music'); });
    $('#am_quick_ambient').on('click', function () { toggleFavoriteChannel('ambient'); });
    $('#am_fav_next, #am_quick_next').on('click', playNextFavorite);
    $('#am_fav_prev, #am_quick_prev').on('click', playPrevFavorite);
    $('#am_fav_repeat, #am_quick_repeat').on('click', toggleFavRepeatOne);
    $('#am_quick_enabled').on('change', function () {
        s.quickPlayerEnabled = this.checked;
        syncQuickPlayerHUD();
        saveSettingsDebounced();
    });
    $('#am_quick_toggle').on('click', function () {
        s.quickPlayerExpanded = !s.quickPlayerExpanded;
        syncQuickPlayerHUD();
        saveSettingsDebounced();
    });
    $('#am_quick_playlist').on('click', function () {
        state.quickQueueOpen = !state.quickQueueOpen;
        syncQuickPlayerHUD();
    });
    $('#am_quick_queue_list').on('click', '.am-quick-queue-track', function () {
        toggleFavoriteTrack(Number(this.dataset.index));
    });
    bindQuickPlayerHUD();
    syncFavRepeatBtn();
}

/* ============ EVENTS ============ */
/* Identity of the turn currently at the end of the chat.
   SillyTavern REPLAYS the opening turn on every load: getChatResult() in
   script.js emits MESSAGE_RECEIVED('first_message') whenever the chat holds
   exactly ONE message — the condition is `chat.length === 1`, not "the chat was
   just created". This is the SECOND door into the bug fixed on 2026-08-08: that
   fix taught onChatChanged to decide by the LIBRARY instead of the message
   count, but this handler was left deciding by nothing at all. With the default
   checkEveryN of 1, every reopen of an unwritten chat spent an analyseAudio call
   and — because onChatChanged clears currentAmbientPrompt, so the analysis has
   no baseline to call unchanged — usually a full ACE Step render of a duplicate
   track. Index alone is not identity: a swipe reuses it, so the text is
   fingerprinted too. */
function amTurnStamp() {
    var ctx = getContext();
    var chat = ctx ? ctx.chat : null;
    if (!Array.isArray(chat) || chat.length === 0) return "";
    var idx = chat.length - 1;
    var mes = String((chat[idx] && chat[idx].mes) || "");
    var h = 0;
    for (var i = 0; i < mes.length; i++) h = ((h << 5) - h + mes.charCodeAt(i)) | 0;
    return idx + ":" + mes.length + ":" + (h >>> 0).toString(36);
}

function onMessage() {
    if (amSlayOwnsScreen()) return;
    if (!S().enabled) return;
    /* Replay guard, see amTurnStamp(). The stamp is kept in the per-chat store
       (extension_settings.savedTracks[chatKey]) — the same place that already
       decides whether this chat has been scored, and one that survives the
       reload the replay rides in on. state.* would not: onChatChanged clears it.
       BEFORE the counter, so a replay cannot shift the checkEveryN cadence. */
    var amStamp = amTurnStamp();
    if (amStamp) {
        /* getChatStore() is a LAZY getter — asking it creates an entry. Only ask
           when there is a real turn to record, so an empty chat never mints a
           store for a conversation nobody is having (§7). */
        var amStore = getChatStore();
        if (amStore._lastTurn === amStamp) return;
        amStore._lastTurn = amStamp;
        saveSettingsDebounced();
    }

    state.messageCounter++; var every = S().checkEveryN || 1;
    if (state.messageCounter % every !== 0) return;
    /* GM Turn (§9.1, Shell Engines layer 4b): while the Game Shell drives the
       turn, the reply's <gm> block carries a "music" brief and the Shell routes
       it straight through AutoMusicAPI.playBrief — same generation, zero LLM.
       The guard sits INSIDE the timer on purpose: a turn that came back without
       a block releases the flag immediately, and by the time this fires (+2s)
       the flag is already down, so nothing is starved.
       The counter above still ticks — otherwise the checkEveryN cadence would
       drift for the whole Shell session. */
    setTimeout(function () {
        if (amSlayOwnsScreen()) return;
        if (typeof window !== 'undefined' && window.RPGShellDriving) return;
        processSceneChange();
    }, 2000);
}
function onChatChanged() {
    var newChatKey = getChatKey();
    if (newChatKey === state.lastChatKey && state.lastChatKey !== null) { updateLibraryUI(); return; }
    state.lastChatKey = newChatKey;

    /* A host score handed over with endBrief(stop:false) plays THROUGH this
       switch. Without it the boot track died here and the player heard silence
       until the campaign's own track finished rendering — ACE Step takes
       minutes, so "the music disappeared" was the whole experience. One-shot:
       the very next chat change silences it like any other track. */
    var carry = state.carryTrack;
    state.carryTrack = null;
    var keepChan = '';
    if (carry && carry.channel && carry.url) {
        var a = carry.channel === 'ambient' ? state.ambientAudio : state.musicAudio;
        if (a && a.src && String(a.src).indexOf(carry.url) !== -1) keepChan = carry.channel;
    }
    if (keepChan !== 'ambient') stopAudio('ambient');
    if (keepChan !== 'music') stopAudio('music');
    state.currentAmbientPrompt = ''; state.currentMusicPrompt = '';
    state.lastGenerateTime = 0; state.messageCounter = 0;
    state.ambientLibIndex = -1; state.musicLibIndex = -1;
    updateStatus('idle'); $('#am_amb_name').text('—'); $('#am_mus_name').text('—');
    updateLibraryUI();

    if (!S().enabled || amSlayOwnsScreen()) return;

    /* RESUME FIRST, generate second — and the deciding fact is the LIBRARY, not
       the message counter (fix 2026-08-08). Message count answers "has the user
       written here", which is NOT the same question as "has this chat been
       scored". A chat created, scored, and left unwritten stays at chat.length
       <= 1 forever, so `isFreshChat` was permanently true for it: its saved
       tracks were never resumed on reopen, and every reopen instead burned an
       analyseAudio call plus a full ACE Step render on a duplicate track. */
    var s = S();
    var ambList = s.libraryEnabled ? getChatTracks('ambient') : null;
    var musList = s.libraryEnabled ? getChatTracks('music') : null;
    var resumed = false;

    /* keepChan is the host's carried boot score — it OWNS that channel through
       this switch (see the carry above), so a resume must not stomp it. */
    if (s.ambientEnabled && keepChan !== 'ambient' && ambList && ambList.length) {
        state.ambientLibIndex = ambList.length - 1;
        playFromLibrary('ambient', ambList[ambList.length - 1]);
        resumed = true;
    }
    if (s.musicEnabled && keepChan !== 'music' && musList && musList.length) {
        state.musicLibIndex = musList.length - 1;
        playFromLibrary('music', musList[musList.length - 1]);
        resumed = true;
    }
    if (resumed) return;

    /* Nothing saved for this chat. Generating on open is for a chat that has no
       history either — a chat the user has been writing in is scored by the
       per-message pass, not on open (unchanged behaviour). */
    var ctx = getContext();
    var chatLen = (ctx && ctx.chat) ? ctx.chat.length : 0;
    if (chatLen > 1) return;            // history but no tracks → stay silent, as before
    if (!S().generateOnChatStart) return;

    var delay = (S().startDelay || 8) * 1000;
    setTimeout(function () {
        if (amSlayOwnsScreen()) return;
        /* the host already scored THIS chat (Character Library hands the
           campaign's opener score straight to playBrief): generating
           again would be a duplicate track AND a wasted analyseAudio
           call. Checked inside the timer — the host's kick may land
           during the delay. */
        if (state.hostScoredChat && state.hostScoredChat === getChatKey()) return;
        var text = getRecentText(S().contextMessages || 5);
        if (text && text.trim().length > 20) {
            state.currentAmbientPrompt = '';
            state.currentMusicPrompt = '';
            processSceneChange(true);
        }
    }, delay);
}

/* ============ EXTERNAL BRIDGE (window.AutoMusicAPI) ============ */
// Additive facade for sibling extensions (Character Library's campaign boot
// et al.): accepts a ONE-SENTENCE mood brief and routes it STRAIGHT through
// the existing generateAudioQueued() seam — ZERO LLM calls (analyseAudio is
// bypassed; ACE Step self-randomizes bpm/keyscale/timesig when musicParams
// is null). Nothing internal calls these functions; with the master switch
// off every call is a cheap refusal, so behavior is unchanged when unused.

// True when the master switch is on and at least one channel can play.
function amApiIsReady() {
    try {
        var s = S();
        return !!(s && s.enabled && (s.musicEnabled || s.ambientEnabled));
    } catch (e) { return false; }
}

// amApiPlayBrief(brief, opts) -> boolean.
// opts.channel: 'music' (default) | 'ambient'. Returns true when the brief
// was ACCEPTED (generation queued — audio follows minutes later), false on
// any refusal (disabled, locked channel, empty brief). Fire-and-forget by
// design: the caller never waits for ComfyUI.
//
// opts.session (string) marks the request as EPHEMERAL — score for a host's
// boot screens, not a track of any chat:
//   * it is never filed in the library and never added to the gallery;
//   * when the audio finally arrives (ACE Step needs minutes) it is PLAYED
//     ONLY IF that session is still the live one — otherwise it is dropped
//     silently. Without this, a campaign boot's track used to land minutes
//     later in whatever chat happened to be open by then (typically the
//     system chat the user fell back to), start playing out of nowhere and
//     file itself in that chat's library.
// A request WITHOUT opts.session keeps the old behavior (filed under the
// chat open at completion time). No cooldown is burned and no
// own-generation flag is set — this path makes no LLM call.
function amApiPlayBrief(brief, opts) {
    try {
        opts = (opts && typeof opts === 'object') ? opts : {};
        var s = S();
        if (!s || !s.enabled) return false;
        var channel = opts.channel === 'ambient' ? 'ambient' : 'music';
        var refused = (channel === 'ambient')
            ? (!s.ambientEnabled || s.ambientLocked)
            : (!s.musicEnabled || s.musicLocked);
        if (refused) return false;
        var prompt = String(brief == null ? '' : brief).trim().substring(0, 300);
        if (!prompt) return false;
        var session = (typeof opts.session === 'string' && opts.session) ? opts.session : '';
        if (session) state.briefSession = session;
        /* A brief WITHOUT a session is a real track for the chat that is open
           now — remember which chat, so our own on-chat-start pass stands down
           instead of generating a second one over it. Recorded on ACCEPT, not
           on arrival: the point is to beat the startDelay timer, which fires
           long before ACE Step returns. */
        else state.hostScoredChat = getChatKey();
        updateStatus('gen-' + channel);
        generateAudioQueued(channel, prompt, null).then(function (url) {
            if (!url) { updateStatus(state.ambientPlaying || state.musicPlaying ? 'playing' : 'idle'); return; }
            /* the boot screens are long gone — drop the track entirely */
            if (session && state.briefSession !== session) {
                updateStatus(state.ambientPlaying || state.musicPlaying ? 'playing' : 'idle');
                return;
            }
            var live = S();
            if (!session) {
                addToGallery(channel, prompt, url, null);
                if (live.libraryEnabled) addTrackToLibrary(channel, prompt, url, null, getChatKey());
            }
            if (channel === 'ambient') {
                state.currentAmbientPrompt = prompt;
                $('#am_amb_name').text(prompt).attr('title', prompt);
            } else {
                state.currentMusicPrompt = prompt;
                $('#am_mus_name').text(prompt).attr('title', prompt);
            }
            playAudio(channel, url);
            if (session) state.briefTrack = { session: session, channel: channel, url: url };
            toastr.info('🎵 ' + prompt.substring(0, 60), 'AutoMusic', { timeOut: 4000 });
        }).catch(function (e) {
            console.error(L, 'playBrief generation error:', e);
            updateStatus(state.ambientPlaying || state.musicPlaying ? 'playing' : 'idle');
        });
        return true;
    } catch (e) {
        console.error(L, 'playBrief error:', e);
        return false;
    }
}

// amApiEndBrief(session, opts) -> boolean (true = this call ended the session).
// The host calls it when its boot screens are done — whether the user picked
// something or dismissed. Any generation still in flight for that session is
// discarded on arrival, and opts.stop !== false stops the session's track if
// it is the one currently playing. Stale tokens are ignored, so a late call
// can never cut off a newer session's music.
function amApiEndBrief(session, opts) {
    try {
        opts = (opts && typeof opts === 'object') ? opts : {};
        var token = (typeof session === 'string' && session) ? session : '';
        /* a token is REQUIRED: without it a careless caller could silently kill
           another host's live session — the same protection as the stale check */
        if (!token) return false;
        if (state.briefSession && state.briefSession !== token) return false;   /* stale */
        var track = state.briefTrack;
        state.briefSession = null;
        state.briefTrack = null;
        if (opts.stop === false) {
            /* "leave it playing" now means through the chat change the host is
               about to make, not just until it — see onChatChanged's carry. */
            state.carryTrack = track ? { channel: track.channel, url: track.url } : null;
            return true;
        }
        if (!track) return true;
        if (track.session !== token) return true;
        var live = track.channel === 'ambient' ? state.ambientAudio : state.musicAudio;
        /* only silence OUR track — a newer one may already own the channel */
        if (live && live.src && String(live.src).indexOf(track.url) !== -1) stopAudio(track.channel);
        return true;
    } catch (e) {
        console.error(L, 'endBrief error:', e);
        return false;
    }
}

// Promise-based generation seam for applications that need the finished file.
// It deliberately bypasses AutoMusic's LLM analysis: callers provide the final
// English audio-model prompt. The result can optionally be persisted to the ST
// file store and/or added to AutoMusic's normal gallery/library.
async function amApiGenerateTrack(brief, opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    var s = S(), channel = opts.channel === 'ambient' ? 'ambient' : 'music';
    if (!s || !s.enabled) throw new Error('AutoMusic is disabled');
    if (channel === 'ambient' ? (!s.ambientEnabled || s.ambientLocked) : (!s.musicEnabled || s.musicLocked)) {
        throw new Error(channel + ' channel is disabled or locked');
    }
    var prompt = String(brief == null ? '' : brief).trim().substring(0, 1200);
    if (!prompt) throw new Error('Empty music prompt');
    var params = opts.params && typeof opts.params === 'object' ? opts.params : null;
    updateStatus('gen-' + channel);
    var url = await generateAudioQueued(channel, prompt, params);
    if (!url) throw new Error('Audio generation failed');
    var result = {
        id: 'external_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        type: channel, prompt: prompt, url: url, path: null, params: params,
        time: new Date().toISOString(), filename: null,
    };
    if (opts.persist) {
        var saved = await saveAudioToLibrary(channel, prompt, url, params);
        if (saved) {
            result.filename = saved.filename || null;
            result.path = saved.path || null;
            result.url = saved.url || result.url;
        }
    }
    if (opts.gallery !== false) addToGallery(channel, prompt, result.url, params);
    if (opts.library) {
        var entry = addTrackToLibrary(channel, prompt, result.url, params, getChatKey());
        if (entry) result.libraryId = entry.id;
    }
    updateStatus(state.ambientPlaying || state.musicPlaying ? 'playing' : 'idle');
    return result;
}

async function amApiPersistTrack(track) {
    if (!track || !(track.url || track.path)) throw new Error('Track URL is missing');
    var channel = track.type === 'ambient' ? 'ambient' : 'music';
    var source = getTrackPlayUrl(track);
    var saved = await saveAudioToLibrary(channel, track.prompt || track.title || 'Phone track', source, track.params || null);
    if (!saved) throw new Error('Could not persist track');
    return Object.assign({}, track, saved, { url:saved.url || source, type:channel });
}

function amStopTemporaryInternal(resume) {
    var o = state.externalOverride;
    if (!o) return false;
    if (o.audio) { o.audio._stopping = true; o.audio.pause(); o.audio.removeAttribute('src'); o.audio.load(); }
    state.externalOverride = null;
    if (resume !== false) {
        if (o.baseAudio && o.baseWasPlaying && o.baseAudio.src) o.baseAudio.play().catch(function () {});
        if (o.favoriteAudio && o.favoriteWasPlaying && o.favoriteAudio.src) o.favoriteAudio.play().catch(function () {});
    }
    syncPlayerUI(); syncFavPlayerUI();
    updateStatus(state.ambientPlaying || (state.musicAudio && !state.musicAudio.paused) ? 'playing' : 'idle');
    return true;
}

function amApiPlayTemporary(track, opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    var url = typeof track === 'string' ? track : getTrackPlayUrl(track || {});
    if (!url) return null;
    /* Replacing one phone track with another must retain the ORIGINAL music
       resume point. Otherwise the first override is cleared while the base is
       paused, and stopping the second track can no longer resume it. */
    var previous = state.externalOverride;
    var base = previous ? previous.baseAudio : state.musicAudio;
    var fav = previous ? previous.favoriteAudio : (state.fav.music && state.fav.music.audio);
    var baseWasPlaying = previous ? previous.baseWasPlaying : !!(base && !base.paused);
    var favoriteWasPlaying = previous ? previous.favoriteWasPlaying : !!(fav && !fav.paused);
    if (previous) amStopTemporaryInternal(false);
    var token = 'temporary_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    var audio = new Audio(url);
    audio.preload = 'auto'; audio.loop = !!opts.loop;
    audio.volume = typeof opts.volume === 'number' ? Math.max(0, Math.min(1, opts.volume)) : (S().musicMuted ? 0 : (S().musicVolume || 0.3));
    state.externalOverride = {
        token:token, audio:audio,
        baseAudio:base, baseWasPlaying:baseWasPlaying,
        favoriteAudio:fav, favoriteWasPlaying:favoriteWasPlaying,
    };
    if (base && !base.paused) base.pause();
    if (fav && !fav.paused) fav.pause();
    audio.addEventListener('ended', function(){ if (!audio.loop && state.externalOverride && state.externalOverride.token === token) amStopTemporaryInternal(true); });
    audio.addEventListener('error', function(){ if (state.externalOverride && state.externalOverride.token === token) amStopTemporaryInternal(true); });
    audio.play().catch(function () {});
    return token;
}

function amApiStopTemporary(token, opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    if (!state.externalOverride) return false;
    if (token && state.externalOverride.token !== token) return false;
    return amStopTemporaryInternal(opts.resume !== false);
}

function amApiGetTemporaryState() {
    var o = state.externalOverride;
    return o ? { token:o.token, playing:!!(o.audio && !o.audio.paused), currentTime:o.audio ? o.audio.currentTime : 0, duration:o.audio ? o.audio.duration : 0 } : null;
}

function amApiSetTemporaryOptions(opts) {
    var o = state.externalOverride;
    if (!o || !o.audio || !opts || typeof opts !== 'object') return false;
    if (typeof opts.volume === 'number') o.audio.volume = Math.max(0, Math.min(1, opts.volume));
    if (typeof opts.loop === 'boolean') o.audio.loop = opts.loop;
    return true;
}

/* ============ INIT ============ */
jQuery(async function () {
    var tgt = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    tgt.append(buildUI());
    $('#form_sheld').prepend($('<div id="am_quick_anchor" hidden></div>').append(buildQuickPlayerHUD()));
    loadSettings(); settingsToUI(); bindUI();

    // Optional: load the slash-command runner used to switch connection
    // profiles. Wrapped in its own try so a path change in SillyTavern can
    // never break the whole extension — feature degrades gracefully.
    try {
        var sc = await import('../../../slash-commands.js');
        if (typeof sc.executeSlashCommandsWithOptions === 'function') {
            runSlash = sc.executeSlashCommandsWithOptions;
        }
    } catch (e) {
        console.warn(L, 'slash-commands.js not available — Connection Profile switching disabled.', e);
    }

    // After the dropdown is bound, repopulate now that we know whether the
    // Connection Manager extension is actually loaded.
    populateProfileDropdown();

    // External bridge (Tact 0-1 polish): mood-brief -> audio with zero LLM
    // calls. Additive — nothing internal depends on it.
    if (typeof window !== 'undefined') {
        window.AutoMusicAPI = {
            version: AM_VERSION,
            isReady: amApiIsReady,
            playBrief: amApiPlayBrief,
            /* Ephemeral boot score: pass opts.session to playBrief, then end
               it here when the host's boot screens close (either outcome).
               v1.2.0: endBrief(stop:false) now CARRIES the track through the
               host's next chat change, and a session-less brief marks the chat
               as host-scored so our on-chat-start pass stands down. */
            endBrief: amApiEndBrief,
            generateTrack: amApiGenerateTrack,
            persistTrack: amApiPersistTrack,
            playTemporary: amApiPlayTemporary,
            stopTemporary: amApiStopTemporary,
            getTemporaryState: amApiGetTemporaryState,
            setTemporaryOptions: amApiSetTemporaryOptions,
        };
    }

    /* lastChatKey stays NULL here on purpose. It means "a chat we have already
       handled", and at init we have handled nothing — seeding it with whatever
       chat happens to be resolvable at extension-load time made the FIRST
       CHAT_CHANGED early-return whenever ST had already restored a chat by
       then, so a page reload landed in that chat with no resume at all. */
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    if (event_types.CHAT_DELETED) eventSource.on(event_types.CHAT_DELETED, function (data) { onChatDeleted(typeof data === 'string' ? data : (data && (data.id || data.chatId || data.chat_id))); });
    if (event_types.GROUP_DELETED) eventSource.on(event_types.GROUP_DELETED, function (data) { onGroupDeleted(typeof data === 'string' ? data : (data && (data.id || data.groupId || data.group_id))); });

    // Safety net: restore the user's main profile if a previous LLM call was
    // interrupted by a page reload while we were on the analysis profile.
    setTimeout(function () { recoverProfileIfNeeded(); }, 1500);

    // Move ComfyUI-only tracks (favorites + library) onto SillyTavern copies.
    setTimeout(function () { rescueComfyLinks(false).catch(function (e) { console.warn(L, 'rescue failed', e); }); }, 3000);

    console.log(L, 'v' + AM_VERSION + ' loaded');
});
