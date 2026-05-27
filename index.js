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
    currentAmbientPrompt: '', currentMusicPrompt: '',
    lastGenerateTime: 0, generating: false,
    ambientPlaying: false, musicPlaying: false,
    generatedTracks: [],
    queueBusy: false, queueItems: [],
    messageCounter: 0,
    ambientLibIndex: -1, musicLibIndex: -1,
    lastChatKey: null,
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
function getChatStore() {
    var s = S(), key = getChatKey();
    if (!s.savedTracks) s.savedTracks = {};
    if (!s.savedTracks[key]) s.savedTracks[key] = { ambient: [], music: [], name: '' };
    var ctx = getContext();
    if (ctx.characters && ctx.characterId !== undefined && ctx.characters[ctx.characterId]) {
        s.savedTracks[key].name = ctx.characters[ctx.characterId].name || '';
    } else if (ctx.groupId && ctx.groups) {
        var g = ctx.groups.find(function (gr) { return gr.id === ctx.groupId; });
        if (g) s.savedTracks[key].name = g.name || '';
    }
    return s.savedTracks[key];
}
function getChatTracks(type) { return type === 'ambient' ? getChatStore().ambient : getChatStore().music; }

/* ============ FILE DELETION HELPER ============ */
async function deleteTrackFiles(trackList) {
    if (!trackList || !trackList.length) return;
    for (var i = 0; i < trackList.length; i++) {
        var track = trackList[i];
        if (track.path) {
            try {
                await fetch('/api/files/delete', { method: 'POST', headers: Object.assign({}, getRequestHeaders(), { 'Content-Type': 'application/json' }), body: JSON.stringify({ name: track.path }) });
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
async function saveAudioToLibrary(type, prompt, sourceUrl, params) {
    var audioBlob;
    try {
        var resp = await fetch(sourceUrl);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        audioBlob = await resp.blob();
    } catch (e) { return null; }
    var ts = Date.now(), safeName = (prompt || 'track').replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 40).trim().replace(/ /g, '_');
    var filename = type + '_' + ts + '_' + safeName + '.mp3';
    try {
        var reader = new FileReader();
        var b64 = await new Promise(function (resolve) { reader.onload = function () { resolve(reader.result.split(',')[1]); }; reader.readAsDataURL(audioBlob); });
        var uploadResp = await fetch('/api/files/upload', {
            method: 'POST', headers: Object.assign({}, getRequestHeaders(), { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name: 'automusic/' + type + '/' + filename, data: b64 }),
        });
        if (uploadResp.ok) return { filename: filename, path: 'automusic/' + type + '/' + filename };
    } catch (e2) { }
    return { filename: filename, path: null, url: sourceUrl };
}
function getTrackPlayUrl(track) {
    if (track.url) return track.url;
    if (track.path) return '/api/files/get?name=' + encodeURIComponent(track.path);
    return null;
}
function addTrackToLibrary(type, prompt, sourceUrl, params) {
    var list = getChatTracks(type), entry = { prompt: prompt || '', url: sourceUrl, params: params || null, time: new Date().toISOString(), id: Date.now() + '_' + Math.random().toString(36).substr(2, 6) };
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
        'lyrics must always be empty string "".\n\n' +
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

    updateStatus('gen-' + type);
    await waitForComfyFree();

    var qr;
    try { qr = await fetch(base + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: obj }) }); }
    catch (e) { return null; }
    if (!qr.ok) {
        var eb; try { eb = await qr.json(); } catch (x) { eb = null; }
        if (eb && eb.error) toastr.error('ComfyUI: ' + (eb.error.message || ''), 'AutoMusic');
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
    audio.loop = loop; audio.preload = 'auto';

    var started = false;
    var start = function () {
        if (started) return; started = true;
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
    setTimeout(function () { if (!started && audio.readyState >= 2) start(); }, 1500);

    // Overlapping crossfade into the next library track (non-looping autoplay).
    attachAutoCrossfade(type, audio);

    // Fallback: if the clip ends without the pre-emptive crossfade having fired
    // (e.g. crossfade disabled, or duration unknown), still advance the library.
    audio.addEventListener('ended', function () {
        if (audio.loop) return;
        if (isAmb) state.ambientPlaying = false; else state.musicPlaying = false;
        syncPlayerUI();
        if (s.libraryEnabled && s.libraryAutoplay && !audio._nextScheduled) {
            audio._nextScheduled = true;
            setTimeout(function () { playNextFromLibrary(type); }, 300);
        }
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
    saveSettingsDebounced();
}

function toggleMute(type) {
    var s = S();
    if (type === 'ambient') { s.ambientMuted = !s.ambientMuted; if (state.ambientAudio) state.ambientAudio.volume = s.ambientMuted ? 0 : s.ambientVolume; }
    else { s.musicMuted = !s.musicMuted; if (state.musicAudio) state.musicAudio.volume = s.musicMuted ? 0 : s.musicVolume; }
    saveSettingsDebounced(); syncPlayerUI();
}

function toggleLock(type) {
    var s = S(); if (type === 'ambient') s.ambientLocked = !s.ambientLocked; else s.musicLocked = !s.musicLocked;
    saveSettingsDebounced(); syncPlayerUI();
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
            '<div class="am-gal-actions"><button class="am-btn-sm am-lib-play" data-type="music" data-idx="' + i + '">▶</button><a class="am-btn-sm am-gal-dl" href="' + esc(t.url || '') + '" download>💾</a><button class="am-btn-sm am-lib-del" data-type="music" data-id="' + esc(t.id) + '" style="color:#ef4444">✕</button></div></div>';
    }
    html += '</div><div class="am-lib-section" data-section="ambient" style="display:none">';
    if (!ambList.length) html += '<div class="am-lib-empty">No ambient tracks.</div>';
    else for (var j = ambList.length - 1; j >= 0; j--) {
        var a = ambList[j];
        html += '<div class="am-lib-item"><div class="am-gal-info"><span class="am-gal-type">🔊</span><div class="am-gal-text"><span class="am-gal-prompt">' + esc(a.prompt) + '</span></div><span class="am-gal-time">' + esc(new Date(a.time).toLocaleDateString()) + '</span></div>' +
            '<div class="am-gal-actions"><button class="am-btn-sm am-lib-play" data-type="ambient" data-idx="' + j + '">▶</button><a class="am-btn-sm am-gal-dl" href="' + esc(a.url || '') + '" download>💾</a><button class="am-btn-sm am-lib-del" data-type="ambient" data-id="' + esc(a.id) + '" style="color:#ef4444">✕</button></div></div>';
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
    ov.find('#am_lib_autoplay_dlg').on('change', function () { s.libraryAutoplay = $(this).prop('checked'); saveSettingsDebounced(); });
    ov.find('.am-lib-play').on('click', function () {
        var type = $(this).data('type'), idx = parseInt($(this).data('idx')), list = getChatTracks(type), track = list[idx]; if (!track) return;
        playFromLibrary(type, track); toastr.info((type === 'ambient' ? '🔊 ' : '🎵 ') + track.prompt.substring(0, 40), 'Library');
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
                    state.currentAmbientPrompt = analysis.ambient.prompt; playAudio('ambient', ambUrl);
                    $('#am_amb_name').text(analysis.ambient.prompt).attr('title', analysis.ambient.prompt);
                    addToGallery('ambient', analysis.ambient.prompt, ambUrl, null);
                    if (s.libraryEnabled) addTrackToLibrary('ambient', analysis.ambient.prompt, ambUrl, null);
                    toastr.info('🔊 ' + analysis.ambient.prompt.substring(0, 50), 'AutoMusic', { timeOut: 4000 });
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
                    state.currentMusicPrompt = analysis.music.prompt; playAudio('music', musUrl);
                    var infoText = analysis.music.prompt + ' [' + musicParams.bpm + ' BPM, ' + musicParams.keyscale + ']';
                    $('#am_mus_name').text(infoText).attr('title', infoText);
                    addToGallery('music', analysis.music.prompt, musUrl, musicParams);
                    if (s.libraryEnabled) addTrackToLibrary('music', analysis.music.prompt, musUrl, musicParams);
                    toastr.info('🎵 ' + infoText.substring(0, 60), 'AutoMusic', { timeOut: 4000 });
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
}

function bindUI() {
    var s = S();
    $('#am_on').on('change', function () { s.enabled = $(this).prop('checked'); saveSettingsDebounced(); if (!s.enabled) { stopAudio('ambient'); stopAudio('music'); updateStatus('idle'); } });
    $('#am_ambient_on').on('change', function () { s.ambientEnabled = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_music_on').on('change', function () { s.musicEnabled = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_gen_start').on('change', function () { s.generateOnChatStart = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_llm_params').on('change', function () { s.llmMusicParams = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_show_gal').on('change', function () { s.showGallery = $(this).prop('checked'); $('[data-gal]').toggle(s.showGallery); saveSettingsDebounced(); });
    $('#am_lib_on').on('change', function () { s.libraryEnabled = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_lib_shuffle').on('change', function () { s.libraryShuffle = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_lib_autoplay').on('change', function () { s.libraryAutoplay = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_auto_delete').on('change', function () { s.autoDeleteOnChatRemove = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#am_every_n').on('change', function () { s.checkEveryN = Math.max(1, parseInt($(this).val()) || 1); $(this).val(s.checkEveryN); saveSettingsDebounced(); });
    $('#am_amb_loop').on('change', function () { s.ambientLoop = $(this).prop('checked'); if (state.ambientAudio) state.ambientAudio.loop = s.ambientLoop; saveSettingsDebounced(); });
    $('#am_mus_loop').on('change', function () { s.musicLoop = $(this).prop('checked'); if (state.musicAudio) state.musicAudio.loop = s.musicLoop; saveSettingsDebounced(); });

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
        stopAudio('ambient'); stopAudio('music'); state.currentAmbientPrompt = ''; state.currentMusicPrompt = ''; updateStatus('idle');
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
}

/* ============ EVENTS ============ */
function onMessage() {
    if (!S().enabled) return;
    state.messageCounter++; var every = S().checkEveryN || 1;
    if (state.messageCounter % every !== 0) return;
    setTimeout(processSceneChange, 2000);
}
function onChatChanged() {
    var newChatKey = getChatKey();
    if (newChatKey === state.lastChatKey && state.lastChatKey !== null) { updateLibraryUI(); return; }
    state.lastChatKey = newChatKey;

    stopAudio('ambient'); stopAudio('music');
    state.currentAmbientPrompt = ''; state.currentMusicPrompt = '';
    state.lastGenerateTime = 0; state.messageCounter = 0;
    state.ambientLibIndex = -1; state.musicLibIndex = -1;
    updateStatus('idle'); $('#am_amb_name').text('—'); $('#am_mus_name').text('—');
    updateLibraryUI();

    if (!S().enabled) return;

    // Determine whether this is a brand-new chat (only the greeting is present)
    // or a chat with existing history that the user is re-opening.
    var ctx = getContext();
    var chatLen = (ctx && ctx.chat) ? ctx.chat.length : 0;
    var isFreshChat = chatLen <= 1; // only the greeting → fresh chat

    if (isFreshChat) {
        // Fresh chat: generate from the greeting if "Generate on chat start" is enabled.
        if (S().generateOnChatStart) {
            var delay = (S().startDelay || 8) * 1000;
            setTimeout(function () {
                var text = getRecentText(S().contextMessages || 5);
                if (text && text.trim().length > 20) {
                    state.currentAmbientPrompt = '';
                    state.currentMusicPrompt = '';
                    processSceneChange(true);
                }
            }, delay);
        }
        return;
    }

    // Existing chat with history: do NOT generate. Instead resume the last saved
    // track(s) for this chat from the library, if available.
    if (!S().libraryEnabled) return;

    var ambList = getChatTracks('ambient');
    var musList = getChatTracks('music');

    if (S().ambientEnabled && ambList && ambList.length) {
        var lastAmb = ambList[ambList.length - 1];
        state.ambientLibIndex = ambList.length - 1;
        playFromLibrary('ambient', lastAmb);
    }
    if (S().musicEnabled && musList && musList.length) {
        var lastMus = musList[musList.length - 1];
        state.musicLibIndex = musList.length - 1;
        playFromLibrary('music', lastMus);
    }
}

/* ============ INIT ============ */
jQuery(async function () {
    var tgt = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    tgt.append(buildUI());
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

    state.lastChatKey = getChatKey();
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    if (event_types.CHAT_DELETED) eventSource.on(event_types.CHAT_DELETED, function (data) { onChatDeleted(typeof data === 'string' ? data : (data && (data.id || data.chatId || data.chat_id))); });
    if (event_types.GROUP_DELETED) eventSource.on(event_types.GROUP_DELETED, function (data) { onGroupDeleted(typeof data === 'string' ? data : (data && (data.id || data.groupId || data.group_id))); });

    // Safety net: restore the user's main profile if a previous LLM call was
    // interrupted by a page reload while we were on the analysis profile.
    setTimeout(function () { recoverProfileIfNeeded(); }, 1500);

    console.log(L, 'v1.9.3 loaded — fresh-chat gating + resume last library track on existing chats');
});
